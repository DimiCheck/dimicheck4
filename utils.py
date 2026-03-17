from __future__ import annotations

import logging
import hashlib
import secrets
import time
import uuid
from datetime import datetime, timezone
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
    token = session.get("csrf_token")
    if token:
        response.set_cookie(
            "csrf_token",
            token,
            secure=config.SESSION_COOKIE_SECURE,
            httponly=False,  # allow JS to read if needed
            samesite=config.SESSION_COOKIE_SAMESITE,
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
    "/board",
    "/teacher",
    "/oauth/",
    "/api/mcp",
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
    if not expected:
        session["csrf_token"] = uuid.uuid4().hex
        return jsonify({"error": {"code": "csrf_required", "message": "CSRF token required"}}), 403
    provided = _csrf_token_from_request()
    if not provided:
        return jsonify({"error": {"code": "csrf_required", "message": "CSRF token required"}}), 403
    if provided != expected:
        return jsonify({"error": {"code": "csrf_failed", "message": "invalid CSRF token"}}), 403


TEACHER_SESSION_KEY = "teacher_verified"


def _get_teacher_session() -> dict | None:
    data = session.get(TEACHER_SESSION_KEY)
    return data if isinstance(data, dict) else None


def _teacher_session_user_agent_hash() -> str:
    user_agent = request.headers.get("User-Agent", "")
    return hashlib.sha256(user_agent.encode("utf-8")).hexdigest()


def _purge_expired_teacher_tickets() -> None:
    try:
        from extensions import db
        from models import TeacherSessionTicket

        now = datetime.now(timezone.utc)
        TeacherSessionTicket.query.filter(TeacherSessionTicket.expires_at < now).delete(synchronize_session=False)
        db.session.commit()
    except Exception:
        try:
            from extensions import db
            db.session.rollback()
        except Exception:
            pass
        # Ticket cleanup should never break request flow.
        pass


def _ensure_teacher_ticket_table() -> bool:
    try:
        from extensions import db
        from models import TeacherSessionTicket

        TeacherSessionTicket.__table__.create(bind=db.engine, checkfirst=True)
        return True
    except Exception:
        try:
            from extensions import db
            db.session.rollback()
        except Exception:
            pass
        return False


def clear_teacher_session() -> None:
    data = _get_teacher_session()
    session.pop(TEACHER_SESSION_KEY, None)
    ticket_id = data.get("session_id") if isinstance(data, dict) else None
    if not isinstance(ticket_id, str) or not ticket_id:
        return
    try:
        from extensions import db
        from models import TeacherSessionTicket

        ticket = TeacherSessionTicket.query.filter_by(session_id=ticket_id).first()
        if ticket:
            db.session.delete(ticket)
            db.session.commit()
    except Exception:
        try:
            from extensions import db
            db.session.rollback()
        except Exception:
            pass
        # Session cleanup should be best-effort only.
        pass


def mark_teacher_session(duration_seconds: int, remember: bool) -> None:
    _purge_expired_teacher_tickets()
    now = int(time.time())
    expires_at = now + max(duration_seconds, 60)
    ticket_id = secrets.token_urlsafe(48)
    session_payload = {"issued_at": now, "expires_at": expires_at, "session_id": ticket_id}
    session[TEACHER_SESSION_KEY] = session_payload
    session.permanent = remember
    if not session.get("csrf_token"):
        session["csrf_token"] = uuid.uuid4().hex

    try:
        from extensions import db
        from models import TeacherSessionTicket

        if not _ensure_teacher_ticket_table():
            # 안전한 폴백: 서버 티켓 테이블 생성 실패 시 일단 세션은 유지
            # (로그인 불가 루프 방지)
            session[TEACHER_SESSION_KEY] = {"issued_at": now, "expires_at": expires_at}
            return

        ticket = TeacherSessionTicket(
            session_id=ticket_id,
            user_agent_hash=_teacher_session_user_agent_hash(),
            expires_at=datetime.fromtimestamp(expires_at, tz=timezone.utc),
        )
        db.session.add(ticket)
        db.session.commit()
    except Exception:
        try:
            from extensions import db
            db.session.rollback()
        except Exception:
            pass
        clear_teacher_session()


def is_teacher_session_active() -> bool:
    user = session.get("user")
    if isinstance(user, dict) and str(user.get("type", "")).lower() == "teacher":
        return True

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
    ticket_id = data.get("session_id")
    if not isinstance(ticket_id, str) or not ticket_id:
        clear_teacher_session()
        return False

    _purge_expired_teacher_tickets()
    if not _ensure_teacher_ticket_table():
        # 서버 티켓 저장소 점검 불가 시, 만료시간 기반으로만 허용 (서비스 가용성 우선)
        return True

    try:
        from models import TeacherSessionTicket

        ticket = TeacherSessionTicket.query.filter_by(session_id=ticket_id).first()
    except Exception:
        try:
            from extensions import db
            db.session.rollback()
        except Exception:
            pass
        clear_teacher_session()
        return False
    if not ticket:
        clear_teacher_session()
        return False
    ticket_expires_at = ticket.expires_at
    if not isinstance(ticket_expires_at, datetime):
        clear_teacher_session()
        return False
    if ticket_expires_at.tzinfo is None:
        ticket_expires_at = ticket_expires_at.replace(tzinfo=timezone.utc)
    if ticket_expires_at < datetime.now(timezone.utc):
        clear_teacher_session()
        return False
    expected_hash = _teacher_session_user_agent_hash()
    if ticket.user_agent_hash and ticket.user_agent_hash != expected_hash:
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
