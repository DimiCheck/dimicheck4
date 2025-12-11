from __future__ import annotations

import secrets
from datetime import date, datetime, timedelta
from sqlalchemy import func

from flask import Blueprint, jsonify, request, session, abort, make_response, render_template

from config import config
from extensions import db
from models import APIKey, OAuthClient, APIUsageStat
from public_api_tiers import (
    DEFAULT_TIER,
    GOOGLE_FORM_URL,
    TIER2_DAILY_THRESHOLD,
    TIER2_REQUIRED_DAYS,
    TIER2_REQUIRED_TOTAL,
    UNIT_SCALE,
    TIER_LIMITS,
    determine_highest_tier,
    get_limits_for_tier,
)


blueprint = Blueprint("developer", __name__, url_prefix="/api/dev")

MAX_KEYS_PER_USER = 5


def _json_abort(status: int, message: str) -> None:
    abort(make_response(jsonify({"error": {"code": str(status), "message": message}}), status))


def _require_user() -> dict:
    user = session.get("user")
    if not user:
        _json_abort(401, "login required")
    return user


def _require_teacher_user() -> dict:
    user = _require_user()
    if (user.get("type") or "").lower() != "teacher":
        _json_abort(403, "teacher role required")
    return user


def _calculate_minute_snapshot(limits) -> tuple[int, str | None]:
    if not limits or not limits.minute_window_start:
        return 0, None
    now_window = datetime.utcnow().replace(second=0, microsecond=0)
    minute_window_start = limits.minute_window_start.replace(second=0, microsecond=0)
    if minute_window_start == now_window:
        return (limits.minute_count or 0) / UNIT_SCALE, limits.minute_window_start.isoformat()
    return 0, limits.minute_window_start.isoformat()


def _resolve_account_tier(keys: list[APIKey]) -> str:
    if not keys:
        return DEFAULT_TIER
    tier_candidates = [key.tier or DEFAULT_TIER for key in keys]
    return determine_highest_tier(tier_candidates)


def _ensure_usage_table():
    try:
        inspector = db.inspect(db.engine)
        if inspector.has_table("api_usage_stats"):
            cols = {col["name"] for col in inspector.get_columns("api_usage_stats")}
            if "count_requests" not in cols:
                with db.engine.connect() as conn:
                    conn.execute(db.text("ALTER TABLE api_usage_stats ADD COLUMN count_requests INTEGER DEFAULT 0"))
                    conn.commit()
            return
        db.create_all()
    except Exception:
        current_app.logger.exception("Failed to ensure api_usage_stats exists")
        raise


def _serialize_key(api_key: APIKey) -> dict:
    limits = api_key.rate_limit
    minute_count, minute_window_iso = _calculate_minute_snapshot(limits)
    today = date.today()
    day_count_raw = limits.day_count if limits and limits.day == today else 0
    minute_limit_raw, daily_limit_raw = get_limits_for_tier(api_key.tier)
    day_count = day_count_raw / UNIT_SCALE
    minute_limit = minute_limit_raw / UNIT_SCALE
    daily_limit = daily_limit_raw / UNIT_SCALE
    tier_label = TIER_LIMITS.get(api_key.tier or DEFAULT_TIER, {}).get("label", api_key.tier)
    return {
        "id": api_key.id,
        "label": api_key.label or "미지정 키",
        "key": api_key.key,
        "is_active": api_key.is_active,
        "created_at": api_key.created_at.isoformat() if api_key.created_at else None,
        "last_used_at": api_key.last_used_at.isoformat() if api_key.last_used_at else None,
        "tier": {
            "name": api_key.tier or DEFAULT_TIER,
            "label": tier_label,
            "upgraded_at": api_key.tier_upgraded_at.isoformat() if api_key.tier_upgraded_at else None,
        },
        "usage": {
            "minute_count": minute_count,
            "minute_limit": minute_limit,
            "minute_window_start": minute_window_iso,
            "day_count": day_count,
            "daily_limit": daily_limit,
            "day": limits.day.isoformat() if limits and limits.day else today.isoformat(),
        },
        "upgrade": {
            "can_request": False,
            "form_url": GOOGLE_FORM_URL,
        },
    }


def _serialize_oauth_client(client: OAuthClient) -> dict:
    return {
        "id": client.id,
        "client_id": client.client_id,
        "name": client.name,
        "redirect_uris": client.redirect_uris,
        "scopes": client.scopes,
        "created_at": client.created_at.isoformat() if client.created_at else None,
        "updated_at": client.updated_at.isoformat() if client.updated_at else None,
        "has_jwt_secret": bool(client.jwt_secret),
        "last_secret_rotated_at": client.last_secret_rotated_at.isoformat() if client.last_secret_rotated_at else None,
        "last_jwt_rotated_at": client.last_jwt_rotated_at.isoformat() if client.last_jwt_rotated_at else None,
    }


def _ensure_oauth_rotation_columns():
    # SQLite only: add columns if migration not applied
    from sqlalchemy import text
    with db.engine.connect() as conn:
        result = conn.execute(text("PRAGMA table_info('oauth_clients')")).fetchall()
        cols = {row[1] for row in result}
        if "last_secret_rotated_at" not in cols:
            conn.execute(text("ALTER TABLE oauth_clients ADD COLUMN last_secret_rotated_at DATETIME"))
        if "last_jwt_rotated_at" not in cols:
            conn.execute(text("ALTER TABLE oauth_clients ADD COLUMN last_jwt_rotated_at DATETIME"))


def _aggregate_account_usage(keys: list[APIKey]) -> dict:
    now_window = datetime.utcnow().replace(second=0, microsecond=0)
    today = date.today()
    minute_count = 0
    day_count = 0
    for key in keys:
        limits = key.rate_limit
        if not limits:
            continue
        if limits.minute_window_start:
            window = limits.minute_window_start.replace(second=0, microsecond=0)
            if window == now_window:
                minute_count += limits.minute_count or 0
        if limits.day == today:
            day_count += limits.day_count or 0

    tier = _resolve_account_tier(keys)
    minute_limit_raw, daily_limit_raw = get_limits_for_tier(tier)
    tier_label = TIER_LIMITS.get(tier, {}).get("label", tier)
    return {
        "tier": tier,
        "tier_label": tier_label,
        "minute_limit": minute_limit_raw / UNIT_SCALE,
        "daily_limit": daily_limit_raw / UNIT_SCALE,
        "minute_count": minute_count / UNIT_SCALE,
        "day_count": day_count / UNIT_SCALE,
        "minute_window_start": now_window.isoformat(),
    }


def _get_user_key(user_id: int, key_id: int) -> APIKey:
    api_key = APIKey.query.filter_by(id=key_id, user_id=user_id).first()
    if not api_key:
        _json_abort(404, "API key not found")
    return api_key


def _evaluate_tier2_progress(user_id: int) -> dict:
    now = datetime.utcnow()
    window_start = now - timedelta(days=7)
    recent_stats = (
        APIUsageStat.query.filter(
            APIUsageStat.user_id == user_id,
            APIUsageStat.hour_window_start >= window_start,
        ).all()
    )
    daily_counts: dict[str, int] = {}
    for stat in recent_stats:
        key = stat.hour_window_start.date().isoformat()
        daily_counts[key] = daily_counts.get(key, 0) + (stat.count or 0)
    days_over_threshold = sum(1 for _, cnt in daily_counts.items() if cnt >= TIER2_DAILY_THRESHOLD)
    total_calls_all = db.session.query(func.coalesce(func.sum(APIUsageStat.count), 0)).filter(APIUsageStat.user_id == user_id).scalar() or 0
    eligible = days_over_threshold >= TIER2_REQUIRED_DAYS and total_calls_all >= TIER2_REQUIRED_TOTAL
    return {
        "days_over_threshold": days_over_threshold,
        "required_days": TIER2_REQUIRED_DAYS,
        "daily_threshold": TIER2_DAILY_THRESHOLD,
        "total_calls": total_calls_all,
        "required_total": TIER2_REQUIRED_TOTAL,
        "eligible": eligible,
        "missing_days": max(0, TIER2_REQUIRED_DAYS - days_over_threshold),
        "missing_calls": max(0, TIER2_REQUIRED_TOTAL - total_calls_all),
    }


@blueprint.get("/api-keys")
def list_api_keys():
    user = _require_user()
    keys = (
        APIKey.query.filter_by(user_id=user["id"])
        .order_by(APIKey.created_at.desc())
        .all()
    )
    return jsonify({"keys": [_serialize_key(key) for key in keys]})


@blueprint.post("/api-keys")
def create_api_key():
    user = _require_user()
    existing_count = APIKey.query.filter_by(user_id=user["id"]).count()
    if existing_count >= MAX_KEYS_PER_USER:
        _json_abort(400, "API key limit reached")

    payload = request.get_json(silent=True) or {}
    label = (payload.get("label") or "내 API 키").strip()
    token = secrets.token_urlsafe(32)

    api_key = APIKey(user_id=user["id"], label=label, key=token, tier=DEFAULT_TIER)
    db.session.add(api_key)
    db.session.commit()
    return jsonify({"key": _serialize_key(api_key)}), 201


@blueprint.patch("/api-keys/<int:key_id>")
def update_api_key(key_id: int):
    user = _require_user()
    api_key = _get_user_key(user["id"], key_id)

    payload = request.get_json(silent=True) or {}
    updated = False

    if "label" in payload:
        label = (payload.get("label") or "").strip()
        api_key.label = label or api_key.label
        updated = True

    if "is_active" in payload:
        api_key.is_active = bool(payload.get("is_active"))
        updated = True

    if not updated:
        _json_abort(400, "no changes supplied")

    db.session.commit()
    return jsonify({"key": _serialize_key(api_key)})


@blueprint.delete("/api-keys/<int:key_id>")
def delete_api_key(key_id: int):
    user = _require_user()
    api_key = _get_user_key(user["id"], key_id)
    db.session.delete(api_key)
    db.session.commit()
    return jsonify({"deleted": True, "id": key_id})


@blueprint.get("/oauth/clients")
def list_oauth_clients():
    _ensure_oauth_rotation_columns()
    _require_teacher_user()
    clients = OAuthClient.query.order_by(OAuthClient.created_at.desc()).all()
    return jsonify({"clients": [_serialize_oauth_client(client) for client in clients]})


@blueprint.post("/oauth/clients")
def create_oauth_client():
    _ensure_oauth_rotation_columns()
    _require_user()
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    redirect_uris = (payload.get("redirect_uris") or "").strip()
    scopes = (payload.get("scopes") or "").strip()
    if not scopes:
        scopes = "basic student_info openid"
    elif "openid" not in scopes.split():
        scopes = f"{scopes} openid"
    if not name or not redirect_uris:
        _json_abort(400, "name and redirect_uris are required")
    client = OAuthClient(
        name=name,
        client_id=secrets.token_urlsafe(24),
        client_secret=secrets.token_urlsafe(48),
        jwt_secret=secrets.token_urlsafe(48),
        redirect_uris=redirect_uris,
        scopes=scopes,
        last_secret_rotated_at=datetime.utcnow(),
        last_jwt_rotated_at=datetime.utcnow(),
    )
    db.session.add(client)
    db.session.commit()
    return jsonify({"client": _serialize_oauth_client(client), "client_secret": client.client_secret}), 201


@blueprint.patch("/oauth/clients/<int:client_db_id>")
def update_oauth_client(client_db_id: int):
    _require_teacher_user()
    client = OAuthClient.query.filter_by(id=client_db_id).first()
    if not client:
        _json_abort(404, "client not found")
    payload = request.get_json(silent=True) or {}
    if "name" in payload:
        name = (payload.get("name") or "").strip()
        if name:
            client.name = name
    if "redirect_uris" in payload:
        client.redirect_uris = (payload.get("redirect_uris") or "").strip()
    if "scopes" in payload:
        client.scopes = (payload.get("scopes") or "").strip()
    if payload.get("rotate_secret"):
        client.client_secret = secrets.token_urlsafe(48)
        client.last_secret_rotated_at = datetime.utcnow()
    if payload.get("rotate_jwt_secret"):
        client.jwt_secret = secrets.token_urlsafe(48)
        client.last_jwt_rotated_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"client": _serialize_oauth_client(client)})


@blueprint.delete("/oauth/clients/<int:client_db_id>")
def delete_oauth_client(client_db_id: int):
    _require_teacher_user()
    client = OAuthClient.query.filter_by(id=client_db_id).first()
    if not client:
        _json_abort(404, "client not found")
    db.session.delete(client)
    db.session.commit()
    return jsonify({"deleted": True})


@blueprint.get("/oauth/clients-ui")
def oauth_clients_ui():
    _require_teacher_user()
    return render_template("oauth_clients.html")


@blueprint.post("/api-keys/<int:key_id>/tier-upgrade")
def upgrade_api_key_tier(key_id: int):
    user = _require_user()
    api_key = _get_user_key(user["id"], key_id)
    if api_key.tier != DEFAULT_TIER:
        _json_abort(400, "only Tier 1 keys can be upgraded")
    progress = _evaluate_tier2_progress(user["id"])
    if not progress.get("eligible"):
        _json_abort(
            400,
            "upgrade requirements not met: need 3+ days with 20+ calls in last 7d and total 150+ calls",
        )

    now = datetime.utcnow()
    for key in APIKey.query.filter_by(user_id=user["id"]).all():
        key.tier = "tier2"
        key.tier_requested_at = now
        key.tier_upgraded_at = now
    db.session.commit()
    return jsonify({"key": _serialize_key(api_key)})


@blueprint.get("/usage")
def usage_summary():
    user = _require_user()
    keys = APIKey.query.filter_by(user_id=user["id"]).all()
    window_start = datetime.utcnow().replace(minute=0, second=0, microsecond=0) - timedelta(days=7)
    _ensure_usage_table()
    usage_stats = (
        APIUsageStat.query.filter(
            APIUsageStat.user_id == user["id"],
            APIUsageStat.hour_window_start >= window_start,
        )
        .order_by(APIUsageStat.hour_window_start.asc())
        .all()
    )
    hourly = [
        {"ts": stat.hour_window_start.isoformat(), "units": (stat.count or 0) / UNIT_SCALE, "requests": stat.count_requests or 0}
        for stat in usage_stats
    ]
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    requests_today = 0
    units_today = 0.0
    for stat in usage_stats:
        if stat.hour_window_start >= today_start:
            requests_today += stat.count_requests or 0
            units_today += (stat.count or 0) / UNIT_SCALE
    summary = []
    today = date.today()
    for key in keys:
        limits = key.rate_limit
        minute_count, minute_window = _calculate_minute_snapshot(limits)
        minute_limit_raw, daily_limit_raw = get_limits_for_tier(key.tier)
        minute_limit = minute_limit_raw / UNIT_SCALE
        daily_limit = daily_limit_raw / UNIT_SCALE
        day_count = (limits.day_count if limits and limits.day == today else 0) / UNIT_SCALE
        tier_label = TIER_LIMITS.get(key.tier or DEFAULT_TIER, {}).get("label", key.tier)
        summary.append(
            {
                "id": key.id,
                "label": key.label or "미지정 키",
                "is_active": key.is_active,
                "minute_count": minute_count,
                "minute_limit": minute_limit,
                "minute_window_start": minute_window,
                "day_count": day_count,
                "daily_limit": daily_limit,
                "last_used_at": key.last_used_at.isoformat() if key.last_used_at else None,
                "tier": key.tier,
                "tier_label": tier_label,
                "eligible_for_upgrade": False,  # per-key upgrade handled by tier2_progress
            }
        )

    account_usage = _aggregate_account_usage(keys)
    account_usage["day_count"] = units_today
    tier2_progress = _evaluate_tier2_progress(user["id"])
    tiers_display = {}
    for name, spec in TIER_LIMITS.items():
        tiers_display[name] = {
            **spec,
            "minute": (spec.get("minute") or 0) / UNIT_SCALE,
            "daily": (spec.get("daily") or 0) / UNIT_SCALE,
        }

    return jsonify(
        {
            "summary": {
                "total_keys": len(keys),
                "requests_today": units_today,
                "per_account_daily_limit": account_usage["daily_limit"],
                "per_account_minute_limit": account_usage["minute_limit"],
                "account_minute_count": account_usage["minute_count"],
                "account_minute_window_start": account_usage["minute_window_start"],
                "tiers": tiers_display,
                "upgrade_form_url": GOOGLE_FORM_URL,
                "account_tier": account_usage["tier"],
                "account_tier_label": account_usage["tier_label"],
                "account_eligible_for_upgrade": tier2_progress.get("eligible", False),
                "unit_scale": UNIT_SCALE,
                "requests_today_raw": requests_today,
            },
            "account": account_usage,
            "keys": summary,
            "chart": {"hourly": hourly},
            "tier2_progress": tier2_progress,
        }
    )
