from __future__ import annotations

from datetime import datetime, timedelta, date
from functools import wraps
from importlib import import_module
from typing import Any, Dict

from flask import Blueprint, jsonify, request, g, current_app

from config import config
from extensions import db
from models import APIKey, APIRateLimit, CalendarEvent, ClassConfig, ClassState
from public_api_tiers import (
    TIER2_MIN_DAILY_REQUESTS,
    get_limits_for_tier,
)


public_api_bp = Blueprint("public_api", __name__, url_prefix="/public")

STALE_MINUTES = 5
HEADER_NAME = "Dimicheck-API-Key"


def _json_error(status: int, message: str):
    return (
        jsonify({"error": {"code": str(status), "message": message}}),
        status,
    )


def _resolve_api_key(header_value: str | None) -> APIKey | None:
    if not header_value:
        return None
    return APIKey.query.filter_by(key=header_value).first()


def _update_streak(api_key: APIKey, evaluated_day: date | None, daily_count: int) -> None:
    if not evaluated_day:
        return
    if daily_count >= TIER2_MIN_DAILY_REQUESTS:
        if api_key.streak_last_date == evaluated_day:
            return
        if api_key.streak_last_date == evaluated_day - timedelta(days=1):
            api_key.streak_days = (api_key.streak_days or 0) + 1
        else:
            api_key.streak_days = 1
        api_key.streak_last_date = evaluated_day
    else:
        if api_key.streak_last_date != evaluated_day:
            api_key.streak_days = 0
            api_key.streak_last_date = evaluated_day


def require_api_key(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        api_key_value = request.headers.get(HEADER_NAME)
        if not api_key_value:
            return _json_error(401, "missing API key")

        api_key = _resolve_api_key(api_key_value)
        if not api_key:
            return _json_error(401, "invalid API key")
        if not api_key.is_active:
            return _json_error(403, "API key inactive")
        g.api_key = api_key
        return func(*args, **kwargs)

    return wrapper


def enforce_rate_limit(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        api_key: APIKey | None = getattr(g, "api_key", None)
        if api_key is None:
            return _json_error(500, "API key missing from request context")

        now = datetime.utcnow()
        minute_window = now.replace(second=0, microsecond=0)
        today = now.date()
        minute_cap, daily_cap = get_limits_for_tier(api_key.tier)

        limits = APIRateLimit.query.filter_by(api_key_id=api_key.id).first()
        if not limits:
            limits = APIRateLimit(
                api_key_id=api_key.id,
                minute_window_start=minute_window,
                day=today,
            )
            db.session.add(limits)

        if limits.minute_window_start != minute_window:
            limits.minute_window_start = minute_window
            limits.minute_count = 0

        if limits.minute_count is None:
            limits.minute_count = 0

        if limits.day != today:
            previous_day = limits.day
            previous_day_count = limits.day_count or 0
            _update_streak(api_key, previous_day, previous_day_count)
            limits.day = today
            limits.day_count = 0

        if limits.day_count is None:
            limits.day_count = 0

        minute_projection = (limits.minute_count or 0) + 1
        daily_projection = (limits.day_count or 0) + 1

        if minute_projection > minute_cap or daily_projection > daily_cap:
            db.session.rollback()
            return _json_error(429, "rate limit exceeded")

        limits.minute_count = minute_projection
        limits.day_count = daily_projection
        limits.updated_at = now
        api_key.last_used_at = now
        db.session.commit()

        return func(*args, **kwargs)

    return wrapper


def _import_class_configs() -> dict[tuple[int, int], dict[str, Any]]:
    try:
        app_module = import_module("app")
        return getattr(app_module, "CLASS_CONFIGS", {})
    except Exception:
        return {}


def _iter_class_configs():
    configs = _import_class_configs()
    if configs:
        for (grade, section), payload in configs.items():
            yield grade, section, payload or {}
        return

    for row in ClassConfig.query.order_by(ClassConfig.grade, ClassConfig.section).all():
        yield row.grade, row.section, {}


def _resolve_status(grade: int, section: int, fallback: dict[str, Any]) -> str:
    if isinstance(fallback, dict) and fallback.get("status"):
        return str(fallback["status"])

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    if not state or not state.updated_at:
        return "unknown"

    delta = datetime.utcnow() - state.updated_at
    if delta > timedelta(minutes=STALE_MINUTES):
        return "stale"
    return "active"


def _build_class_snapshot(grade: int, section: int, config_snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "grade": grade,
        "class": section,
        "status": _resolve_status(grade, section, config_snapshot or {}),
    }


def broadcast_public_status_update(grade: int, section: int) -> None:
    snapshot = _build_class_snapshot(grade, section, {})
    try:
        app_obj = current_app._get_current_object()
    except RuntimeError:
        return
    socketio = app_obj.extensions.get("socketio")
    if not socketio:
        return
    socketio.emit(
        "status_update",
        {
            "type": "status_update",
            "class": f"{grade}-{section}",
            "status": snapshot["status"],
        },
        namespace="/ws/public-status",
    )


@public_api_bp.get("/api/version")
@require_api_key
@enforce_rate_limit
def api_version():
    return jsonify({"version": config.ASSET_VERSION})


@public_api_bp.get("/api/class/<int:grade>-<int:section>/status")
@require_api_key
@enforce_rate_limit
def class_status(grade: int, section: int):
    configs = _import_class_configs()
    snapshot = configs.get((grade, section)) if configs else None
    if snapshot is None:
        exists = ClassConfig.query.filter_by(grade=grade, section=section).first()
        if not exists:
            return _json_error(404, "class not found")
        snapshot = {}
    payload = _build_class_snapshot(grade, section, snapshot or {})
    return jsonify(payload)


@public_api_bp.get("/api/status/overview")
@require_api_key
@enforce_rate_limit
def status_overview():
    overview: Dict[str, Dict[str, Any]] = {}
    for grade, section, payload in _iter_class_configs():
        snapshot = _build_class_snapshot(grade, section, payload)
        overview[f"{grade}-{section}"] = {
            "status": snapshot["status"],
        }
    if not overview:
        return _json_error(404, "no classes configured")
    return jsonify(overview)


@public_api_bp.get("/api/class/<int:grade>-<int:section>/calendar/events")
@require_api_key
@enforce_rate_limit
def class_calendar_events(grade: int, section: int):
    """Retrieve calendar events for a specific class."""
    exists = ClassConfig.query.filter_by(grade=grade, section=section).first()
    if not exists:
        return _json_error(404, "class not found")

    month = request.args.get("month", type=int)
    year = request.args.get("year", type=int)

    query = CalendarEvent.query.filter_by(grade=grade, section=section)
    if month and year:
        if month < 1 or month > 12:
            return _json_error(400, "invalid month")
        try:
            from calendar import monthrange

            _, last_day = monthrange(year, month)
        except ValueError:
            return _json_error(400, "invalid date range")
        start_date = date(year, month, 1)
        end_date = date(year, month, last_day)
        query = query.filter(CalendarEvent.event_date >= start_date, CalendarEvent.event_date <= end_date)

    events = query.order_by(CalendarEvent.event_date).limit(500).all()
    payload = []
    for event in events:
        payload.append(
            {
                "id": event.id,
                "title": event.title,
                "description": event.description,
                "date": event.event_date.isoformat(),
                "createdBy": event.created_by,
                "createdAt": event.created_at.isoformat(),
                "updatedAt": event.updated_at.isoformat() if event.updated_at else None,
            }
        )

    return jsonify({"events": payload})
