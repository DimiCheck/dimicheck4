from __future__ import annotations

from datetime import datetime, timedelta, date
from functools import wraps
from importlib import import_module
import re
import threading
from typing import Any, Dict

from flask import Blueprint, jsonify, request, g, current_app

from config import config
from extensions import db
from models import APIKey, APIRateLimit, APIUsageStat, CalendarEvent, ClassConfig, ClassState, Counter
from public_api_tiers import (
    DEFAULT_TIER,
    UNIT_SCALE,
    determine_highest_tier,
    get_limits_for_tier,
)


public_api_bp = Blueprint("public_api", __name__, url_prefix="/public")

STALE_MINUTES = 5
HEADER_NAME = "Dimicheck-API-Key"
MIN_COUNTER_VALUE = -9_000_000_000_000_000
MAX_COUNTER_VALUE = 9_000_000_000_000_000
MAX_CONCURRENT_REQUESTS = 5
MAX_QUEUE_DEPTH = 50
QUEUE_WAIT_TIMEOUT = 10.0

_concurrency_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)
_queue_depth = 0
_queue_lock = threading.Lock()


def _json_error(status: int, message: str):
    return (
        jsonify({"error": {"code": str(status), "message": message}}),
        status,
    )


def _resolve_api_key(header_value: str | None) -> APIKey | None:
    if not header_value:
        return None
    return APIKey.query.filter_by(key=header_value).first()


def _determine_account_tier(keys: list[APIKey]) -> str:
    if not keys:
        return DEFAULT_TIER
    tier_candidates = [key.tier or DEFAULT_TIER for key in keys]
    return determine_highest_tier(tier_candidates)


def _ensure_usage_table() -> None:
    try:
        inspector = db.inspect(db.engine)
        if not inspector.has_table("api_usage_stats"):
            db.create_all()
        else:
            cols = {col["name"] for col in inspector.get_columns("api_usage_stats")}
            if "count_requests" not in cols:
                with db.engine.connect() as conn:
                    conn.execute(db.text("ALTER TABLE api_usage_stats ADD COLUMN count_requests INTEGER DEFAULT 0"))
                    conn.commit()
    except Exception:
        current_app.logger.exception("Failed to ensure api_usage_stats table exists")
        raise


def with_cost(units: float):
    scaled = int(round(units * UNIT_SCALE))

    def decorator(func):
        setattr(func, "_cost_units", max(1, scaled))
        return func

    return decorator


def _acquire_concurrency_slot():
    global _queue_depth
    with _queue_lock:
        if _queue_depth >= MAX_QUEUE_DEPTH:
            return False
        _queue_depth += 1
    acquired = _concurrency_semaphore.acquire(timeout=QUEUE_WAIT_TIMEOUT)
    with _queue_lock:
        _queue_depth = max(0, _queue_depth - 1)
    return acquired


def limit_concurrency(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        acquired = _acquire_concurrency_slot()
        if not acquired:
            return _json_error(503, "server busy, try again soon")
        try:
            return func(*args, **kwargs)
        finally:
            _concurrency_semaphore.release()

    return wrapper


def _ensure_counter_table() -> None:
    """Safeguard for deployments that didn't run migrations."""
    try:
        inspector = db.inspect(db.engine)
        if inspector.has_table("counters"):
            return
        db.create_all()
    except Exception:
        current_app.logger.exception("Failed to ensure counters table exists")
        raise


def _serialize_counter(counter: Counter) -> dict[str, Any]:
    return {
        "id": counter.id,
        "name": counter.name,
        "value": int(counter.value or 0),
        "updated_at": counter.updated_at.isoformat() if counter.updated_at else None,
        "created_at": counter.created_at.isoformat() if counter.created_at else None,
    }


def _bump_usage_hour(user_id: int, now: datetime, cost_units: int = 1) -> None:
    _ensure_usage_table()
    hour_window = now.replace(minute=0, second=0, microsecond=0)
    stat = APIUsageStat.query.filter_by(user_id=user_id, hour_window_start=hour_window).first()
    if not stat:
        stat = APIUsageStat(user_id=user_id, hour_window_start=hour_window, count=0, count_requests=0)
        db.session.add(stat)
    stat.count = (stat.count or 0) + cost_units
    stat.count_requests = (stat.count_requests or 0) + 1
    stat.updated_at = now
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()


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

        cost_units = getattr(func, "_cost_units", 1)
        if not isinstance(cost_units, int) or cost_units < 1:
            cost_units = 1

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

        minute_projection = aggregated_minute + cost_units
        daily_projection = aggregated_day + cost_units

        if minute_projection > minute_cap or daily_projection > daily_cap:
            db.session.rollback()
            return _json_error(429, "rate limit exceeded")

        limits.minute_count += cost_units
        limits.day_count += cost_units
        limits.updated_at = now
        api_key.last_used_at = now
        db.session.commit()
        _bump_usage_hour(api_key.user_id, now, cost_units)

        return func(*args, **kwargs)

    return wrapper


def _validate_counter_name(name: str) -> str | None:
    if not name:
        return "name is required"
    cleaned = name.strip()
    if len(cleaned) < 3 or len(cleaned) > 80:
        return "name must be 3-80 characters"
    if not re.match(r"^[A-Za-z0-9_-]+$", cleaned):
        return "name must contain only letters, numbers, hyphen or underscore"
    return None


def _validate_counter_value(value: Any) -> tuple[int | None, str | None]:
    try:
        casted = int(value)
    except (TypeError, ValueError):
        return None, "value must be an integer"
    if casted < MIN_COUNTER_VALUE or casted > MAX_COUNTER_VALUE:
        return None, f"value must be between {MIN_COUNTER_VALUE} and {MAX_COUNTER_VALUE}"
    return casted, None


def _get_counter_for_user(counter_id: int, user_id: int) -> Counter | None:
    return Counter.query.filter_by(id=counter_id, user_id=user_id).first()


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
@with_cost(0.1)
@limit_concurrency
@require_api_key
@enforce_rate_limit
def api_version():
    return jsonify({"version": config.ASSET_VERSION})


@public_api_bp.get("/api/class/<int:grade>-<int:section>/status")
@with_cost(0.7)
@limit_concurrency
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
@with_cost(5.0)
@limit_concurrency
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
@with_cost(1.0)
@limit_concurrency
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


@public_api_bp.post("/api/counters")
@with_cost(3.0)
@limit_concurrency
@require_api_key
@enforce_rate_limit
def create_counter():
    _ensure_counter_table()
    payload = request.get_json(silent=True) or {}
    raw_name = payload.get("name") or ""
    name_error = _validate_counter_name(raw_name)
    if name_error:
        return _json_error(400, name_error)

    initial_value, value_error = _validate_counter_value(payload.get("initial", 0))
    if value_error:
        return _json_error(400, value_error)

    existing = Counter.query.filter_by(user_id=g.api_key.user_id, name=raw_name.strip()).first()
    if existing:
        return _json_error(409, "counter already exists")

    counter = Counter(
        user_id=g.api_key.user_id,
        name=raw_name.strip(),
        value=initial_value or 0,
    )
    db.session.add(counter)
    db.session.commit()
    return jsonify({"counter": _serialize_counter(counter)}), 201


@public_api_bp.get("/api/counters/<int:counter_id>")
@with_cost(1.5)
@limit_concurrency
@require_api_key
@enforce_rate_limit
def get_counter(counter_id: int):
    _ensure_counter_table()
    counter = _get_counter_for_user(counter_id, g.api_key.user_id)
    if not counter:
        return _json_error(404, "counter not found")
    return jsonify({"counter": _serialize_counter(counter)})


def _apply_counter_delta(counter_id: int, delta: int):
    _ensure_counter_table()
    counter = _get_counter_for_user(counter_id, g.api_key.user_id)
    if not counter:
        return None, _json_error(404, "counter not found")

    current_value = counter.value or 0
    new_value = current_value + delta
    if new_value < MIN_COUNTER_VALUE or new_value > MAX_COUNTER_VALUE:
        return None, _json_error(400, f"value must stay between {MIN_COUNTER_VALUE} and {MAX_COUNTER_VALUE}")

    counter.value = new_value
    counter.updated_at = datetime.utcnow()
    db.session.commit()
    return counter, None


def _set_counter_value(counter_id: int, value: int):
    _ensure_counter_table()
    counter = _get_counter_for_user(counter_id, g.api_key.user_id)
    if not counter:
        return None, _json_error(404, "counter not found")
    if value < MIN_COUNTER_VALUE or value > MAX_COUNTER_VALUE:
        return None, _json_error(400, f"value must be between {MIN_COUNTER_VALUE} and {MAX_COUNTER_VALUE}")
    counter.value = value
    counter.updated_at = datetime.utcnow()
    db.session.commit()
    return counter, None


@public_api_bp.post("/api/counters/<int:counter_id>/increment")
@with_cost(2.5)
@limit_concurrency
@require_api_key
@enforce_rate_limit
def increment_counter(counter_id: int):
    counter, error = _apply_counter_delta(counter_id, 1)
    if error:
        return error
    return jsonify({"counter": _serialize_counter(counter)})


@public_api_bp.post("/api/counters/<int:counter_id>/decrement")
@with_cost(2.5)
@limit_concurrency
@require_api_key
@enforce_rate_limit
def decrement_counter(counter_id: int):
    counter, error = _apply_counter_delta(counter_id, -1)
    if error:
        return error
    return jsonify({"counter": _serialize_counter(counter)})


@public_api_bp.post("/api/counters/<int:counter_id>/add")
@with_cost(3.0)
@limit_concurrency
@require_api_key
@enforce_rate_limit
def add_to_counter(counter_id: int):
    payload = request.get_json(silent=True) or {}
    delta, error = _validate_counter_value(payload.get("value"))
    if error:
        return _json_error(400, error)
    counter, apply_error = _apply_counter_delta(counter_id, delta or 0)
    if apply_error:
        return apply_error
    return jsonify({"counter": _serialize_counter(counter)})


@public_api_bp.post("/api/counters/<int:counter_id>/set")
@with_cost(3.0)
@limit_concurrency
@require_api_key
@enforce_rate_limit
def set_counter(counter_id: int):
    payload = request.get_json(silent=True) or {}
    value, error = _validate_counter_value(payload.get("value"))
    if error:
        return _json_error(400, error)
    counter, apply_error = _set_counter_value(counter_id, value or 0)
    if apply_error:
        return apply_error
    return jsonify({"counter": _serialize_counter(counter)})


@public_api_bp.post("/api/counters/<int:counter_id>/reset")
@with_cost(2.5)
@limit_concurrency
@require_api_key
@enforce_rate_limit
def reset_counter(counter_id: int):
    counter, apply_error = _set_counter_value(counter_id, 0)
    if apply_error:
        return apply_error
    return jsonify({"counter": _serialize_counter(counter)})


@public_api_bp.delete("/api/counters/<int:counter_id>")
@with_cost(2.5)
@limit_concurrency
@require_api_key
@enforce_rate_limit
def delete_counter(counter_id: int):
    counter = _get_counter_for_user(counter_id, g.api_key.user_id)
    if not counter:
        return _json_error(404, "counter not found")
    db.session.delete(counter)
    db.session.commit()
    return jsonify({"deleted": True, "id": counter_id})
