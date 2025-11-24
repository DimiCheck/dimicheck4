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
    DEFAULT_TIER,
    TIER2_MIN_DAILY_REQUESTS,
    determine_highest_tier,
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


def _update_user_streak(keys: list[APIKey], evaluated_day: date | None, daily_count: int) -> None:
    if not evaluated_day or not keys:
        return

    reference = max(
        keys,
        key=lambda key: (
            key.streak_last_date or date.min,
            key.streak_days or 0,
        ),
    )
    current_last_date = reference.streak_last_date
    current_streak_days = reference.streak_days or 0
    target_last_date = current_last_date
    target_streak_days = current_streak_days

    if daily_count >= TIER2_MIN_DAILY_REQUESTS:
        if current_last_date == evaluated_day:
            return
        if current_last_date == evaluated_day - timedelta(days=1):
            target_streak_days = current_streak_days + 1
        else:
            target_streak_days = 1
        target_last_date = evaluated_day
    else:
        if current_last_date == evaluated_day:
            return
        target_streak_days = 0
        target_last_date = evaluated_day

    if target_last_date == current_last_date and target_streak_days == current_streak_days:
        return

    for key in keys:
        key.streak_days = target_streak_days
        key.streak_last_date = target_last_date


def _determine_account_tier(keys: list[APIKey]) -> str:
    if not keys:
        return DEFAULT_TIER
    tier_candidates = [key.tier or DEFAULT_TIER for key in keys]
    return determine_highest_tier(tier_candidates)


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
        yesterday = today - timedelta(days=1)

        user_keys = APIKey.query.filter_by(user_id=api_key.user_id).all()
        account_tier = _determine_account_tier(user_keys)
        minute_cap, daily_cap = get_limits_for_tier(account_tier)

        limits = APIRateLimit.query.filter_by(api_key_id=api_key.id).first()
        if not limits:
            limits = APIRateLimit(
                api_key_id=api_key.id,
                minute_window_start=minute_window,
                day=today,
            )
            db.session.add(limits)

        user_limits = (
            APIRateLimit.query.join(APIKey)
            .filter(APIKey.user_id == api_key.user_id)
            .all()
        )
        aggregated_yesterday = sum(
            (limit.day_count or 0) for limit in user_limits if limit.day == yesterday
        )

        if limits.minute_window_start != minute_window:
            limits.minute_window_start = minute_window
            limits.minute_count = 0

        if limits.minute_count is None:
            limits.minute_count = 0

        if limits.day != today:
            _update_user_streak(user_keys, yesterday, aggregated_yesterday)
            limits.day = today
            limits.day_count = 0

        if limits.day_count is None:
            limits.day_count = 0

        aggregated_minute = sum(
            (limit.minute_count or 0)
            for limit in user_limits
            if limit.minute_window_start == minute_window
        )
        aggregated_day = sum(
            (limit.day_count or 0) for limit in user_limits if limit.day == today
        )

        minute_projection = aggregated_minute + 1
        daily_projection = aggregated_day + 1

        if minute_projection > minute_cap or daily_projection > daily_cap:
            db.session.rollback()
            return _json_error(429, "rate limit exceeded")

        limits.minute_count += 1
        limits.day_count += 1
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
