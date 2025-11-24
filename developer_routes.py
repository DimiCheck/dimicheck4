from __future__ import annotations

import secrets
from datetime import date, datetime

from flask import Blueprint, jsonify, request, session, abort, make_response

from config import config
from extensions import db
from models import APIKey
from public_api_tiers import (
    DEFAULT_TIER,
    GOOGLE_FORM_URL,
    TIER2_STREAK_DAYS,
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


def _calculate_minute_snapshot(limits) -> tuple[int, str | None]:
    if not limits or not limits.minute_window_start:
        return 0, None
    now_window = datetime.utcnow().replace(second=0, microsecond=0)
    minute_window_start = limits.minute_window_start.replace(second=0, microsecond=0)
    if minute_window_start == now_window:
        return (limits.minute_count or 0), limits.minute_window_start.isoformat()
    return 0, limits.minute_window_start.isoformat()


def _resolve_account_tier(keys: list[APIKey]) -> str:
    if not keys:
        return DEFAULT_TIER
    tier_candidates = [key.tier or DEFAULT_TIER for key in keys]
    return determine_highest_tier(tier_candidates)


def _serialize_key(api_key: APIKey) -> dict:
    limits = api_key.rate_limit
    minute_count, minute_window_iso = _calculate_minute_snapshot(limits)
    today = date.today()
    day_count = limits.day_count if limits and limits.day == today else 0
    minute_limit, daily_limit = get_limits_for_tier(api_key.tier)
    tier_label = TIER_LIMITS.get(api_key.tier or DEFAULT_TIER, {}).get("label", api_key.tier)
    eligible_for_upgrade = (
        api_key.tier == DEFAULT_TIER and (api_key.streak_days or 0) >= TIER2_STREAK_DAYS
    )
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
            "streak_days": api_key.streak_days or 0,
            "streak_goal": TIER2_STREAK_DAYS,
            "eligible_for_upgrade": eligible_for_upgrade,
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
            "can_request": eligible_for_upgrade,
            "form_url": GOOGLE_FORM_URL,
        },
    }


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
    minute_limit, daily_limit = get_limits_for_tier(tier)
    tier_label = TIER_LIMITS.get(tier, {}).get("label", tier)
    streak_days = 0
    latest_last_date = None
    for key in keys:
        sd = key.streak_days or 0
        if sd > streak_days:
            streak_days = sd
        if key.streak_last_date:
            if not latest_last_date or key.streak_last_date > latest_last_date:
                latest_last_date = key.streak_last_date

    eligible_for_upgrade = tier == DEFAULT_TIER and streak_days >= TIER2_STREAK_DAYS
    return {
        "tier": tier,
        "tier_label": tier_label,
        "minute_limit": minute_limit,
        "daily_limit": daily_limit,
        "minute_count": minute_count,
        "day_count": day_count,
        "minute_window_start": now_window.isoformat(),
        "streak_days": streak_days,
        "streak_last_date": latest_last_date.isoformat() if latest_last_date else None,
        "eligible_for_upgrade": eligible_for_upgrade,
    }


def _get_user_key(user_id: int, key_id: int) -> APIKey:
    api_key = APIKey.query.filter_by(id=key_id, user_id=user_id).first()
    if not api_key:
        _json_abort(404, "API key not found")
    return api_key


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


@blueprint.post("/api-keys/<int:key_id>/tier-upgrade")
def upgrade_api_key_tier(key_id: int):
    user = _require_user()
    api_key = _get_user_key(user["id"], key_id)
    if api_key.tier != DEFAULT_TIER:
        _json_abort(400, "only Tier 1 keys can be upgraded")
    if (api_key.streak_days or 0) < TIER2_STREAK_DAYS:
        _json_abort(400, "usage streak requirement not met")

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
    summary = []
    today = date.today()
    for key in keys:
        limits = key.rate_limit
        minute_count, minute_window = _calculate_minute_snapshot(limits)
        minute_limit, daily_limit = get_limits_for_tier(key.tier)
        day_count = limits.day_count if limits and limits.day == today else 0
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
                "eligible_for_upgrade": (
                    key.tier == DEFAULT_TIER and (key.streak_days or 0) >= TIER2_STREAK_DAYS
                ),
            }
        )

    account_usage = _aggregate_account_usage(keys)
    return jsonify(
        {
            "summary": {
                "total_keys": len(keys),
                "requests_today": account_usage["day_count"],
                "per_account_daily_limit": account_usage["daily_limit"],
                "per_account_minute_limit": account_usage["minute_limit"],
                "account_minute_count": account_usage["minute_count"],
                "account_minute_window_start": account_usage["minute_window_start"],
                "tiers": TIER_LIMITS,
                "upgrade_goal_days": TIER2_STREAK_DAYS,
                "upgrade_form_url": GOOGLE_FORM_URL,
                "account_tier": account_usage["tier"],
                "account_tier_label": account_usage["tier_label"],
                "account_eligible_for_upgrade": account_usage["eligible_for_upgrade"],
                "account_streak_days": account_usage["streak_days"],
                "account_streak_last_date": account_usage["streak_last_date"],
            },
            "account": account_usage,
            "keys": summary,
        }
    )
