from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any, Tuple

from flask import Blueprint, jsonify, request, session

from class_routes import (
    ALLOWED_ROUTINE_DAYS,
    _fetch_meal_from_api,
    _fetch_timetable_from_api,
    _get_kst,
    _load_state_payload,
    _normalize_channel_memberships,
    _normalize_channel_owners,
    _normalize_channels,
    _normalize_participant_map,
)
from extensions import db
from models import CalendarEvent, ChatMessage, ClassRoutine, ClassState, HomeTarget, User, UserType
from oauth.utils import decode_access_token

blueprint = Blueprint("mcp_api", __name__, url_prefix="/api/mcp")


def _decode_bearer() -> tuple[User | None, dict[str, Any]]:
    """Decode Authorization bearer token -> user and claims."""
    auth_header = request.headers.get("Authorization", "")
    claims: dict[str, Any] = {}
    if auth_header.startswith("Bearer "):
        token = auth_header.split(" ", 1)[1].strip()
        if token:
            try:
                claims = decode_access_token(token) or {}
                sub = claims.get("sub") or claims.get("user_id") or claims.get("userId")
                if sub is not None:
                    user = User.query.get(int(sub))
                    if user:
                        return user, claims
            except Exception:
                return None, {}
    # Fallback to session-backed login
    session_user = session.get("user")
    if isinstance(session_user, dict) and session_user.get("id") is not None:
        user = User.query.get(int(session_user["id"]))
        return user, claims
    return None, {}


def _require_user() -> tuple[User, dict[str, Any]] | tuple[None, None]:
    user, claims = _decode_bearer()
    if not user:
        return None, None
    return user, claims


def _resolve_class_context(user: User, claims: dict[str, Any]) -> Tuple[int | None, int | None, int | None]:
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    number = request.args.get("number", type=int)
    if grade is None:
        grade = claims.get("grade") if isinstance(claims, dict) else None
    if section is None:
        section = claims.get("class") or claims.get("section")
    if number is None:
        number = claims.get("number")
    if grade is None:
        grade = user.grade
    if section is None:
        section = user.class_no
    if number is None:
        number = user.number
    try:
        grade = int(grade) if grade is not None else None
    except (TypeError, ValueError):
        grade = None
    try:
        section = int(section) if section is not None else None
    except (TypeError, ValueError):
        section = None
    try:
        number = int(number) if number is not None else None
    except (TypeError, ValueError):
        number = None
    return grade, section, number


@blueprint.get("/me")
def mcp_me():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    grade, section, number = _resolve_class_context(user, claims or {})
    return jsonify(
        {
            "id": user.id,
            "email": user.email,
            "grade": grade,
            "class": section,
            "number": number,
            "type": user.type.value if user.type else None,
        }
    )


@blueprint.get("/state")
def mcp_state():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    grade, section, _ = _resolve_class_context(user, claims or {})
    if grade is None or section is None:
        return jsonify({"error": {"code": "bad_request", "message": "grade/section required"}}), 400

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    payload = _load_state_payload(state)
    return jsonify(payload)


@blueprint.post("/state")
def mcp_save_state():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    grade, section, _ = _resolve_class_context(user, claims or {})
    if grade is None or section is None:
        return jsonify({"error": {"code": "bad_request", "message": "grade/section required"}}), 400

    payload = request.get_json(silent=True) or {}
    incoming_magnets = payload.get("magnets", {})
    normalized_magnets = {str(key): value for key, value in incoming_magnets.items()} if isinstance(incoming_magnets, dict) else {}

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    state_payload = _load_state_payload(state)
    magnets = state_payload.get("magnets", {})
    channels = _normalize_channels(state_payload.get("channels"))
    memberships = _normalize_channel_memberships(state_payload.get("channelMemberships"), channels, grade, section)
    owners = _normalize_channel_owners(state_payload.get("channelOwners"), channels)

    for num, data in normalized_magnets.items():
        existing = magnets.get(str(num), {})
        preserve_fields = ["reaction", "reactionPostedAt", "reactionExpiresAt", "thought", "thoughtPostedAt", "thoughtExpiresAt"]
        for field in preserve_fields:
            if field in existing and field not in data:
                data[field] = existing[field]
        magnets[str(num)] = data

    payload_to_save = {"magnets": magnets, "channels": channels, "channelMemberships": memberships, "channelOwners": owners}

    if not state:
        state = ClassState(grade=grade, section=section, data="")
        db.session.add(state)
    state.data = json.dumps(payload_to_save, ensure_ascii=False)
    db.session.commit()

    return jsonify({"ok": True, "magnets": magnets})


@blueprint.get("/routine")
def mcp_routine():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    grade, section, _ = _resolve_class_context(user, claims or {})
    if grade is None or section is None:
        return jsonify({"error": {"code": "bad_request", "message": "grade/section required"}}), 400

    routine = ClassRoutine.query.filter_by(grade=grade, section=section).first()
    if not routine:
        return jsonify({"afterschool": {}, "changdong": {}})
    return jsonify(routine.to_dict())


@blueprint.post("/routine")
def mcp_save_routine():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    grade, section, number = _resolve_class_context(user, claims or {})
    if grade is None or section is None:
        return jsonify({"error": {"code": "bad_request", "message": "grade/section required"}}), 400

    payload = request.get_json(silent=True) or {}
    afterschool = payload.get("afterschool") or {}
    changdong = payload.get("changdong") or {}

    afterschool_map = _normalize_participant_map(afterschool)
    changdong_map = _normalize_participant_map(changdong)

    routine = ClassRoutine.query.filter_by(grade=grade, section=section).first()
    if not routine:
        routine = ClassRoutine(grade=grade, section=section)
        db.session.add(routine)

    if user.type == UserType.TEACHER:
        routine.set_afterschool_map(afterschool_map)
        routine.set_changdong_map(changdong_map)
    else:
        if number is None:
            return jsonify({"error": {"code": "forbidden", "message": "student number missing"}}), 403
        existing_afterschool = routine.get_afterschool_map()
        existing_changdong = routine.get_changdong_map()

        updated_afterschool = {day: list(numbers) for day, numbers in existing_afterschool.items()}
        requested_afterschool_days = {day for day, numbers in afterschool_map.items() if number in numbers}
        for day in ALLOWED_ROUTINE_DAYS:
            members = list(updated_afterschool.get(day, []))
            if day in requested_afterschool_days:
                if number not in members:
                    members.append(number)
                members.sort()
                updated_afterschool[day] = members
            else:
                if number in members:
                    members = [num for num in members if num != number]
                    if members:
                        updated_afterschool[day] = members
                    else:
                        updated_afterschool.pop(day, None)

        updated_changdong = {day: list(numbers) for day, numbers in existing_changdong.items()}
        requested_changdong_days = [day for day, numbers in changdong_map.items() if number in numbers]
        selected_changdong_day = requested_changdong_days[0] if requested_changdong_days else None

        for day in list(updated_changdong.keys()):
            members = [num for num in updated_changdong[day] if num != number]
            if members:
                updated_changdong[day] = members
            else:
                updated_changdong.pop(day)

        if selected_changdong_day is not None and selected_changdong_day in ALLOWED_ROUTINE_DAYS:
            members = updated_changdong.get(selected_changdong_day, [])
            if number not in members:
                members.append(number)
            members.sort()
            updated_changdong[selected_changdong_day] = members

        routine.set_afterschool_map(updated_afterschool)
        routine.set_changdong_map(updated_changdong)

    db.session.commit()
    return jsonify(routine.to_dict())


@blueprint.get("/timetable")
def mcp_timetable():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    grade, section, _ = _resolve_class_context(user, claims or {})
    if not grade or not section:
        return jsonify({"error": {"code": "bad_request", "message": "missing grade or section"}}), 400
    lessons = _fetch_timetable_from_api(grade, section) or []
    return jsonify({"lessons": lessons, "date": datetime.now(_get_kst()).strftime("%Y-%m-%d")})


@blueprint.get("/meal")
def mcp_meal():
    try:
        data = _fetch_meal_from_api()
        return jsonify(data)
    except Exception as exc:  # pylint: disable=broad-except
        return jsonify({"error": {"code": "fetch_failed", "message": str(exc)}}), 500


@blueprint.get("/calendar/events")
def mcp_calendar_events():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    grade, section, _ = _resolve_class_context(user, claims or {})
    if not grade or not section:
        return jsonify({"error": {"code": "bad_request", "message": "missing grade or section"}}), 400
    month = request.args.get("month", type=int)
    year = request.args.get("year", type=int)
    query = CalendarEvent.query.filter_by(grade=grade, section=section)
    if month and year:
        from calendar import monthrange
        _, last_day = monthrange(year, month)
        start_date = datetime(year, month, 1).date()
        end_date = datetime(year, month, last_day).date()
        query = query.filter(CalendarEvent.event_date >= start_date, CalendarEvent.event_date <= end_date)
    events = query.order_by(CalendarEvent.event_date).all()
    result = []
    for event in events:
        result.append(
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
    return jsonify({"events": result})


def _serialize_home_target(target: HomeTarget | None):
    if not target or not target.target_at:
        return {"targetAt": None, "remainingSeconds": None}
    now = datetime.now(timezone.utc)
    delta = target.target_at.replace(tzinfo=timezone.utc) - now
    remaining = int(delta.total_seconds())
    return {"targetAt": target.target_at.isoformat(), "remainingSeconds": remaining}


@blueprint.get("/home/target")
def mcp_home_get():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    target = HomeTarget.query.filter_by(user_id=user.id).first()
    return jsonify(_serialize_home_target(target))


@blueprint.post("/home/target")
def mcp_home_set():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    payload = request.get_json(silent=True) or {}
    target_raw = payload.get("targetAt") or payload.get("target_at")
    if not target_raw:
        return jsonify({"error": {"code": "bad_request", "message": "targetAt required"}}), 400
    target_at = None
    try:
        target_at = datetime.fromisoformat(str(target_raw))
    except Exception:
        return jsonify({"error": {"code": "bad_request", "message": "invalid datetime format"}}), 400
    if target_at.tzinfo is None:
        target_at = target_at.replace(tzinfo=_get_kst())
    target = HomeTarget.query.filter_by(user_id=user.id).first()
    if not target:
        target = HomeTarget(user_id=user.id)
        db.session.add(target)
    target.target_at = target_at.astimezone(timezone.utc).replace(tzinfo=None)
    db.session.commit()
    return jsonify(_serialize_home_target(target))


@blueprint.delete("/home/target")
def mcp_home_clear():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    target = HomeTarget.query.filter_by(user_id=user.id).first()
    if target:
        target.target_at = None
        db.session.commit()
    return jsonify(_serialize_home_target(target))


@blueprint.post("/chat/send")
def mcp_chat_send():
    user, claims = _require_user()
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    grade, section, number = _resolve_class_context(user, claims or {})
    if grade is None or section is None or number is None:
        return jsonify({"error": {"code": "bad_request", "message": "grade/section/number required"}}), 400
    payload = request.get_json(silent=True) or {}
    message_text = (payload.get("message") or "").strip()
    if not message_text:
        return jsonify({"error": {"code": "bad_request", "message": "message required"}}), 400
    if len(message_text) > 500:
        message_text = message_text[:500]
    channel = (payload.get("channel") or "home").strip() or "home"
    chat_message = ChatMessage(
        grade=grade,
        section=section,
        student_number=number,
        message=message_text,
        channel=channel,
    )
    db.session.add(chat_message)
    db.session.commit()
    return jsonify(
        {
            "ok": True,
            "message": {
                "id": chat_message.id,
                "grade": grade,
                "section": section,
                "channel": channel,
                "studentNumber": number,
                "message": message_text,
                "createdAt": chat_message.created_at.isoformat(),
            },
        }
    )
