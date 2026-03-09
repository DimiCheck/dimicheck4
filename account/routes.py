from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from flask import Blueprint, jsonify, render_template, request, session

from auth.sessions import issue_session
from config import config
from extensions import db
from models import User

blueprint = Blueprint("account", __name__, url_prefix="/account", template_folder="templates")
KST = ZoneInfo("Asia/Seoul")


def _require_user() -> User:
    payload = session.get("user")
    if not payload:
        return None
    return User.query.get(payload["id"])


def _current_cycle(today: date) -> tuple[date, date]:
    start = date(today.year, 2, 20)
    if today < start:
        start = date(today.year - 1, 2, 20)
    end = date(start.year + 1, 2, 19)
    return start, end


def _today_kst() -> date:
    return datetime.now(KST).date()


def _to_kst_date(value: datetime) -> date:
    normalized = value
    if normalized.tzinfo is None:
        normalized = normalized.replace(tzinfo=timezone.utc)
    return normalized.astimezone(KST).date()


def _can_edit_profile(user: User) -> bool:
    today = _today_kst()
    start, _ = _current_cycle(today)
    if not user.last_profile_update:
        return True
    return _to_kst_date(user.last_profile_update) < start


def _next_edit_date(user: User) -> date:
    today = _today_kst()
    start, _ = _current_cycle(today)
    if not user.last_profile_update:
        return today
    if _to_kst_date(user.last_profile_update) < start:
        return today
    return date(start.year + 1, 2, 20)


@blueprint.get("")
def account_page():
    user = _require_user()
    if not user:
        return render_template("account.html", error="로그인이 필요합니다.", user=None), 401
    can_edit = _can_edit_profile(user)
    next_change = _next_edit_date(user)
    remember_cookie = request.cookies.get(config.REMEMBER_ME_COOKIE_NAME)
    return render_template(
        "account.html",
        user=user,
        can_edit=can_edit,
        next_change=next_change,
        last_update=user.last_profile_update,
        remember_enabled=bool(remember_cookie),
    )


@blueprint.post("/update")
def account_update():
    user = _require_user()
    if not user:
        return jsonify({"error": "login_required"}), 401
    if not _can_edit_profile(user):
        return jsonify({"error": "edit_window_closed"}), 400
    payload = request.get_json(silent=True) or request.form
    try:
        grade = int(payload.get("grade"))
        class_no = int(payload.get("class"))
        number = int(payload.get("number"))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid_input"}), 400
    user.grade = grade
    user.class_no = class_no
    user.number = number
    # 이름은 저장하지 않음 (개인정보 최소화)
    user.name = ""
    user.last_profile_update = datetime.utcnow()
    db.session.commit()
    issue_session(user)
    can_edit = _can_edit_profile(user)
    return jsonify(
        {
            "grade": user.grade,
            "class": user.class_no,
            "number": user.number,
            "name": user.name,
            "last_profile_update": user.last_profile_update.isoformat(),
            "next_change": _next_edit_date(user).isoformat(),
            "can_edit": can_edit,
        }
    )
