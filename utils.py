from __future__ import annotations

import logging
import time
import uuid

from flask import Response, g, request, session
from prometheus_client import Counter, Histogram, generate_latest

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
    return response


def metrics() -> Response:
    return Response(generate_latest(), mimetype="text/plain")


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
