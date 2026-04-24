from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from flask import Blueprint, current_app, jsonify, make_response, render_template, request, session

from auth.sessions import clear_remembered_session, issue_session
from config import config
from extensions import db
from models import (
    APIKey,
    APIRateLimit,
    APIUsageStat,
    CalendarEvent,
    ChatConsent,
    ChatMessage,
    ChatMessageRead,
    ChatReaction,
    ClassEmoji,
    Counter,
    HomeTarget,
    MealVote,
    OAuthAuthorizationCode,
    OAuthRefreshToken,
    PresenceLog,
    PresenceState,
    RememberedSession,
    StudentStatusFavorite,
    TeacherNoticeRead,
    TermsConsent,
    User,
    UserAvatar,
    UserNickname,
    Vote,
    VoteResponse,
)

blueprint = Blueprint("account", __name__, url_prefix="/account", template_folder="templates")
KST = ZoneInfo("Asia/Seoul")


def _require_user() -> User:
    payload = session.get("user")
    if not payload:
        return None
    return User.query.get(payload["id"])


def _identity_scope(user: User) -> tuple[int, int, int] | None:
    if user.grade is None or user.class_no is None or user.number is None:
        return None
    return user.grade, user.class_no, user.number


def _query_ids(model, *conditions) -> list[int]:
    query = db.session.query(model.id)
    if conditions:
        query = query.filter(*conditions)
    return [row[0] for row in query.all()]


def _delete_user_related_records(user: User) -> None:
    StudentStatusFavorite.__table__.create(bind=db.engine, checkfirst=True)
    api_key_ids = _query_ids(APIKey, APIKey.user_id == user.id)
    if api_key_ids:
        APIRateLimit.query.filter(APIRateLimit.api_key_id.in_(api_key_ids)).delete(synchronize_session=False)

    for model in (
        TermsConsent,
        HomeTarget,
        APIUsageStat,
        Counter,
        OAuthAuthorizationCode,
        OAuthRefreshToken,
        RememberedSession,
        APIKey,
        StudentStatusFavorite,
    ):
        model.query.filter_by(user_id=user.id).delete(synchronize_session=False)

    PresenceLog.query.filter(PresenceLog.actor_id == user.id).delete(synchronize_session=False)

    identity_scope = _identity_scope(user)
    if not identity_scope:
        return

    grade, section, number = identity_scope
    class_message_ids = _query_ids(ChatMessage, ChatMessage.grade == grade, ChatMessage.section == section)
    own_message_ids = _query_ids(
        ChatMessage,
        ChatMessage.grade == grade,
        ChatMessage.section == section,
        ChatMessage.student_number == number,
    )
    class_vote_ids = _query_ids(Vote, Vote.grade == grade, Vote.section == section)
    own_vote_ids = _query_ids(
        Vote,
        Vote.grade == grade,
        Vote.section == section,
        Vote.created_by == number,
    )

    if class_message_ids:
        ChatReaction.query.filter(
            ChatReaction.message_id.in_(class_message_ids),
            ChatReaction.student_number == number,
        ).delete(synchronize_session=False)
    if own_message_ids:
        ChatReaction.query.filter(ChatReaction.message_id.in_(own_message_ids)).delete(synchronize_session=False)
        ChatMessageRead.query.filter(ChatMessageRead.message_id.in_(own_message_ids)).delete(synchronize_session=False)
        ChatMessage.query.filter(ChatMessage.id.in_(own_message_ids)).delete(synchronize_session=False)

    if class_vote_ids:
        VoteResponse.query.filter(
            VoteResponse.vote_id.in_(class_vote_ids),
            VoteResponse.student_number == number,
        ).delete(synchronize_session=False)
    if own_vote_ids:
        VoteResponse.query.filter(VoteResponse.vote_id.in_(own_vote_ids)).delete(synchronize_session=False)
        Vote.query.filter(Vote.id.in_(own_vote_ids)).delete(synchronize_session=False)

    PresenceState.query.filter_by(grade=grade, class_no=section, number=number).delete(synchronize_session=False)
    PresenceLog.query.filter_by(grade=grade, class_no=section, number=number).delete(synchronize_session=False)
    UserNickname.query.filter_by(grade=grade, section=section, student_number=number).delete(synchronize_session=False)
    UserAvatar.query.filter_by(grade=grade, section=section, student_number=number).delete(synchronize_session=False)
    ChatConsent.query.filter_by(grade=grade, section=section, student_number=number).delete(synchronize_session=False)
    ChatMessageRead.query.filter_by(grade=grade, section=section, student_number=number).delete(synchronize_session=False)
    MealVote.query.filter_by(grade=grade, section=section, student_number=number).delete(synchronize_session=False)
    CalendarEvent.query.filter_by(grade=grade, section=section, created_by=number).delete(synchronize_session=False)
    TeacherNoticeRead.query.filter_by(grade=grade, section=section, student_number=number).delete(synchronize_session=False)
    ClassEmoji.query.filter_by(grade=grade, section=section, uploaded_by=number).delete(synchronize_session=False)


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


@blueprint.post("/delete")
def account_delete():
    user = _require_user()
    if not user:
        return jsonify({"error": "login_required"}), 401

    payload = request.get_json(silent=True) or request.form
    confirmation = str(payload.get("confirmation") or payload.get("confirm") or "").strip()
    if confirmation != "탈퇴":
        return jsonify({
            "error": "confirmation_required",
            "message": "확인을 위해 '탈퇴'를 입력해주세요.",
        }), 400

    try:
        _delete_user_related_records(user)
        db.session.delete(user)
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception("Failed to delete account for user_id=%s", user.id)
        return jsonify({
            "error": "delete_failed",
            "message": "회원 탈퇴 처리에 실패했습니다. 잠시 후 다시 시도해주세요.",
        }), 500

    session.clear()
    response = make_response(jsonify({
        "ok": True,
        "redirect": "/login.html?deleted=1",
    }))
    clear_remembered_session(response)
    return response
