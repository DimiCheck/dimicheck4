from __future__ import annotations

import logging
import time
import uuid
from threading import Lock
from typing import Any

import requests
from flask import Response, g, jsonify, request, session
from prometheus_client import Counter, Histogram, generate_latest

from config import config

REQUEST_COUNT = Counter(
    "http_requests_total", "Total HTTP requests", ["method", "endpoint", "http_status"]
)
REQUEST_LATENCY = Histogram(
    "http_request_latency_seconds", "Request latency", ["endpoint"]
)


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=level,
        format="%(message)s",
    )


def before_request() -> None:
    g.request_id = str(uuid.uuid4())
    logging.info(
        {
            "event": "request_start",
            "method": request.method,
            "path": request.path,
            "request_id": g.request_id,
        }
    )


def after_request(response: Response) -> Response:
    REQUEST_COUNT.labels(request.method, request.path, response.status_code).inc()
    REQUEST_LATENCY.labels(request.path).observe(request.elapsed.total_seconds() if hasattr(request, 'elapsed') else 0)
    logging.info(
        {
            "event": "request_end",
            "status": response.status_code,
            "request_id": g.request_id,
        }
    )
    user = session.get("user")
    user_id = str(user.get("id")) if isinstance(user, dict) and user.get("id") is not None else None
    send_ga4_event(
        "backend_request",
        {
            "path": request.path,
            "method": request.method,
            "status": response.status_code,
            "has_user": 1 if user else 0,
        },
        user_id=user_id,
    )
    return response


def metrics() -> Response:
    return Response(generate_latest(), mimetype="text/plain")


# ---------------------------------------------------------------------------
# CSRF protection (session-backed)
# ---------------------------------------------------------------------------
_CSRF_EXEMPT_PREFIXES = (
    "/auth/login",
    "/auth/callback",
    "/auth/logout",
    "/oauth/",
    "/public/",
    "/healthz",
    "/metrics",
    "/api/qrng",
    "/manifest.webmanifest",
    "/service-worker.js",
    "/sitemap.xml",
    "/robots.txt",
    "/api/version",
)
_CSRF_HEADER_CANDIDATES = ("X-CSRF-Token", "X-CSRFToken")


def _csrf_token_from_request() -> str | None:
    for header in _CSRF_HEADER_CANDIDATES:
        value = request.headers.get(header)
        if value:
            return value
    if request.is_json:
        payload = request.get_json(silent=True) or {}
        token = payload.get("csrf_token") or payload.get("csrfToken")
        if token:
            return str(token)
    if request.form:
        token = request.form.get("csrf_token")
        if token:
            return token
    return None


def verify_csrf():
    """Reject state-changing requests without a valid CSRF token."""
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    for prefix in _CSRF_EXEMPT_PREFIXES:
        if request.path.startswith(prefix):
            return
    if not session.get("user") and not session.get(TEACHER_SESSION_KEY):
        return
    expected = session.get("csrf_token")
    provided = _csrf_token_from_request()
    if not expected or not provided or provided != expected:
        return jsonify({"error": {"code": "csrf_failed", "message": "invalid CSRF token"}}), 403


TEACHER_SESSION_KEY = "teacher_verified"


def _get_teacher_session() -> dict | None:
    data = session.get(TEACHER_SESSION_KEY)
    return data if isinstance(data, dict) else None


def clear_teacher_session() -> None:
    session.pop(TEACHER_SESSION_KEY, None)


def mark_teacher_session(duration_seconds: int, remember: bool) -> None:
    now = int(time.time())
    expires_at = now + max(duration_seconds, 60)
    session[TEACHER_SESSION_KEY] = {"issued_at": now, "expires_at": expires_at}
    session.permanent = remember
    if not session.get("csrf_token"):
        session["csrf_token"] = uuid.uuid4().hex


def is_teacher_session_active() -> bool:
    data = _get_teacher_session()
    if not data:
        return False
    expires_at = data.get("expires_at")
    if not isinstance(expires_at, (int, float)):
        clear_teacher_session()
        return False
    if expires_at < time.time():
        clear_teacher_session()
        return False
    return True


def is_board_session_active(grade: int | None, section: int | None) -> bool:
    if grade is None or section is None:
        return False
    return bool(session.get(f"board_verified_{grade}_{section}"))


_GA4_SESSION_KEY = "_ga4_client_id"


def _ga4_enabled() -> bool:
    return bool(config.GA4_MEASUREMENT_ID and config.GA4_API_SECRET)


def _get_ga_client_id() -> str:
    client_id = session.get(_GA4_SESSION_KEY)
    if isinstance(client_id, str) and client_id:
        return client_id
    client_id = str(uuid.uuid4())
    session[_GA4_SESSION_KEY] = client_id
    return client_id


def send_ga4_event(
    name: str,
    params: dict[str, Any] | None = None,
    *,
    client_id: str | None = None,
    user_id: str | None = None,
) -> None:
    if not name or not _ga4_enabled():
        return

    payload: dict[str, Any] = {
        "client_id": client_id or _get_ga_client_id(),
        "events": [{"name": name, "params": params or {}}],
    }
    if user_id:
        payload["user_id"] = user_id

    try:
        response = requests.post(
            config.GA4_MEASUREMENT_ENDPOINT,
            params={
                "measurement_id": config.GA4_MEASUREMENT_ID,
                "api_secret": config.GA4_API_SECRET,
            },
            json=payload,
            timeout=2,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        logging.debug("Failed to send GA4 event: %s", exc)


# ---------------------------------------------------------------------------
# PIN brute-force guard (in-memory, per-client)
# ---------------------------------------------------------------------------
_PIN_GUARD: dict[str, dict[str, float | int]] = {}
_PIN_GUARD_LOCK = Lock()


def _client_identifier() -> str:
    for header in ("CF-Connecting-IP", "X-Real-IP", "X-Forwarded-For"):
        value = request.headers.get(header)
        if value:
            return value.split(",")[0].strip()
    return request.remote_addr or "unknown"


def pin_guard_key(label: str) -> str:
    return f"{label}:{_client_identifier()}"


def pin_guard_status(
    key: str,
    *,
    max_attempts: int = 5,
    window_seconds: int = 300,
    lock_seconds: int = 900,
) -> tuple[bool, int, int]:
    """
    Returns (allowed, attempts_left, lock_remaining_seconds).
    """
    now = time.time()
    with _PIN_GUARD_LOCK:
        entry = _PIN_GUARD.get(key, {"count": 0, "first": now, "locked_until": 0})

        # Reset window if expired
        if now - entry.get("first", now) > window_seconds:
            entry = {"count": 0, "first": now, "locked_until": 0}

        locked_until = entry.get("locked_until", 0) or 0
        if locked_until > now:
            return False, 0, int(locked_until - now)

        attempts_left = max(max_attempts - int(entry.get("count", 0)), 0)
        _PIN_GUARD[key] = entry
        return True, attempts_left, 0


def pin_guard_register_failure(
    key: str,
    *,
    max_attempts: int = 5,
    window_seconds: int = 300,
    lock_seconds: int = 900,
) -> tuple[int, int]:
    """
    Records a failed attempt. Returns (attempts_left_before_lock, lock_remaining_seconds).
    """
    now = time.time()
    with _PIN_GUARD_LOCK:
        entry = _PIN_GUARD.get(key, {"count": 0, "first": now, "locked_until": 0})

        if now - entry.get("first", now) > window_seconds:
            entry = {"count": 0, "first": now, "locked_until": 0}

        # If already locked, keep it
        if entry.get("locked_until", 0) > now:
            return 0, int(entry["locked_until"] - now)

        entry["count"] = int(entry.get("count", 0)) + 1
        attempts_left = max(max_attempts - entry["count"], 0)

        if entry["count"] >= max_attempts:
            entry["locked_until"] = now + lock_seconds
            entry["count"] = 0
            entry["first"] = now
            attempts_left = 0

        _PIN_GUARD[key] = entry
        lock_remaining = max(int(entry.get("locked_until", 0) - now), 0)
        return attempts_left, lock_remaining


def pin_guard_reset(key: str) -> None:
    with _PIN_GUARD_LOCK:
        _PIN_GUARD.pop(key, None)
