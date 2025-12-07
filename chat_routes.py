from __future__ import annotations

from datetime import datetime, timezone, timedelta
import json

from flask import Blueprint, jsonify, request, session

from extensions import db
from models import ChatMessage, UserNickname, ClassState, ChatReaction, UserAvatar, ClassEmoji, ChatMessageRead, ChatConsent
from utils import is_board_session_active, is_teacher_session_active
import re
from sqlalchemy import or_, and_, func
from sqlalchemy.exc import IntegrityError

blueprint = Blueprint("chat", __name__, url_prefix="/api/classes/chat")

DEFAULT_CHANNEL = "home"
MAX_CHANNEL_NAME_LENGTH = 30
MAX_CHANNELS_PER_CLASS = 20
CHANNEL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9가-힣 _\\-]+$")
CHAT_CONSENT_VERSION = "v1"


def _is_valid_channel_name(name: str) -> bool:
    return bool(name) and bool(CHANNEL_NAME_PATTERN.match(name))


def _normalize_channel_memberships(raw_memberships, channels: list[str], default_grade: int | None, default_section: int | None) -> dict[str, list[dict]]:
    memberships = raw_memberships if isinstance(raw_memberships, dict) else {}
    result: dict[str, list[dict]] = {}

    for ch in channels:
        entries = []
        seen_keys = set()
        raw_entries = memberships.get(ch) if isinstance(memberships.get(ch), list) else []
        for entry in raw_entries:
            if not isinstance(entry, dict):
                continue
            g = _normalize_class_value(entry.get("grade"))
            s = _normalize_class_value(entry.get("section"))
            if g is None or s is None:
                continue
            key = f"{g}-{s}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            entries.append({"grade": g, "section": s})

        if default_grade is not None and default_section is not None:
            default_key = f"{default_grade}-{default_section}"
            if default_key not in seen_keys:
                entries.append({"grade": default_grade, "section": default_section})

        result[ch] = entries

    return result


def _normalize_channel_owners(raw_owners, channels: list[str]) -> dict[str, list[dict]]:
    owners = raw_owners if isinstance(raw_owners, dict) else {}
    result: dict[str, list[dict]] = {}

    for ch in channels:
        entries = []
        seen = set()
        raw_entries = owners.get(ch) if isinstance(owners.get(ch), list) else []
        for entry in raw_entries:
            if not isinstance(entry, dict):
                continue
            g = _normalize_class_value(entry.get("grade"))
            s = _normalize_class_value(entry.get("section"))
            n = _normalize_class_value(entry.get("studentNumber"))
            if g is None or s is None or n is None:
                continue
            key = f"{g}-{s}-{n}"
            if key in seen:
                continue
            seen.add(key)
            entries.append({"grade": g, "section": s, "studentNumber": n})
        result[ch] = entries

    return result


def _is_channel_owner(grade: int | None, section: int | None, number: int | None, owners: dict, channel: str) -> bool:
    if grade is None or section is None or number is None:
        return False
    for entry in owners.get(channel, []):
        if (
            _normalize_class_value(entry.get("grade")) == grade
            and _normalize_class_value(entry.get("section")) == section
            and _normalize_class_value(entry.get("studentNumber")) == number
        ):
            return True
    return False


def _normalize_class_value(value: int | str | None) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_first(mapping: dict, *keys: str) -> int | str | None:
    for key in keys:
        if key in mapping:
            return mapping.get(key)
    return None


def _split_student_identifier(value: int | str | None) -> tuple[int | None, int | None, int | None]:
    if value is None:
        return None, None, None

    digits = "".join(ch for ch in str(value) if ch.isdigit())
    if not digits:
        return None, None, None

    if len(digits) >= 3:
        grade = _normalize_class_value(digits[0])
        number = _normalize_class_value(digits[-2:])
        section_digits = digits[1:-2]
        section = _normalize_class_value(section_digits) if section_digits else None
        return grade, section, number

    return None, None, _normalize_class_value(digits)


def _normalize_channel_name(value: str | None) -> str:
    name = (value or "").strip()
    if not name:
        return DEFAULT_CHANNEL

    # Collapse repeated spaces and clamp length
    name = re.sub(r"\s+", " ", name)
    if len(name) > MAX_CHANNEL_NAME_LENGTH:
        name = name[:MAX_CHANNEL_NAME_LENGTH]
    return name


def _normalize_channel_list(raw_list) -> list[str]:
    channels = raw_list if isinstance(raw_list, list) else []
    normalized: list[str] = []
    seen = set()

    for ch in channels:
        if not isinstance(ch, str):
            continue
        name = _normalize_channel_name(ch)
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(name)

    if DEFAULT_CHANNEL.casefold() not in seen:
        normalized.insert(0, DEFAULT_CHANNEL)
    return normalized


def _channel_exists(channels: list[str], name: str) -> bool:
    target = name.casefold()
    return any(ch.casefold() == target for ch in channels)


def _serialize_channels_for_class(channels: list[str], memberships: dict, owners: dict, grade: int, section: int, session_info: tuple[int | None, int | None, int | None] | None = None) -> list[dict]:
    sg = ss = sn = None
    if session_info:
        sg, ss, sn = session_info
    serialized = []
    for ch in channels:
        if any(
            _normalize_class_value(m.get("grade")) == grade and _normalize_class_value(m.get("section")) == section
            for m in memberships.get(ch, [])
        ):
            can_delete = False
            if ch != DEFAULT_CHANNEL:
                can_delete = (
                    is_teacher_session_active()
                    or is_board_session_active(grade, section)
                    or _is_channel_owner(sg, ss, sn, owners, ch)
                )
            # Latest message id for this channel across member classes
            member_conditions = []
            for m in memberships.get(ch, []):
                g = _normalize_class_value(m.get("grade"))
                s = _normalize_class_value(m.get("section"))
                if g is None or s is None:
                    continue
                member_conditions.append(and_(ChatMessage.grade == g, ChatMessage.section == s))

            latest_id = None
            if member_conditions:
                latest_id = (
                    db.session.query(func.max(ChatMessage.id))
                    .filter(ChatMessage.channel == ch, or_(*member_conditions))
                    .scalar()
                )

            serialized.append({"name": ch, "canDelete": can_delete, "latestMessageId": latest_id})
    return serialized


def _get_student_session_info() -> tuple[int | None, int | None, int | None]:
    user = session.get("user") or {}
    user_type = str(user.get("type", "")).lower()
    if user_type != "student":
        return None, None, None

    grade = _normalize_class_value(_extract_first(user, "grade", "grade_no", "gradeNo"))
    section = _normalize_class_value(
        _extract_first(
            user,
            "class",
            "class_no",
            "classNo",
            "classroom",
            "section",
            "section_no",
            "sectionNo",
        )
    )

    identifier = _extract_first(
        user,
        "number",
        "student_number",
        "studentNumber",
        "student_no",
        "studentNo",
    )
    derived_grade, derived_section, derived_number = _split_student_identifier(identifier)
    if grade is None:
        grade = derived_grade
    if section is None:
        section = derived_section

    number = derived_number
    if number is None:
        _, _, number = _split_student_identifier(
            _extract_first(user, "seat_number", "seatNumber", "number_only")
        )

    return grade, section, number


def _student_matches(grade: int | None, section: int | None) -> bool:
    if grade is None or section is None:
        return False

    session_grade, session_section, _ = _get_student_session_info()
    if session_grade is None or session_section is None:
        return False

    return session_grade == grade and session_section == section


def _is_authorized(grade: int | None, section: int | None) -> bool:
    return (
        is_teacher_session_active()
        or is_board_session_active(grade, section)
        or _student_matches(grade, section)
    )


THOUGHT_PREVIEW_MAX_LENGTH = 140
THOUGHT_PREVIEW_DURATION_SECONDS = 10


def _get_kst_now() -> datetime:
    return datetime.utcnow() + timedelta(hours=9)


def _academic_year_start_utc() -> datetime:
    kst_now = _get_kst_now()
    year = kst_now.year if kst_now.month >= 3 else kst_now.year - 1
    start_kst = datetime(year, 3, 1)
    # Convert back to UTC
    start_utc = start_kst - timedelta(hours=9)
    return start_utc


def _cleanup_expired_messages():
    cutoff = _academic_year_start_utc()
    deleted = (
        db.session.query(ChatMessage)
        .filter(ChatMessage.created_at < cutoff)
        .delete(synchronize_session=False)
    )
    if deleted:
        db.session.commit()


def _today_start_utc() -> datetime:
    """Return today's 00:00 KST in UTC"""
    kst_now = _get_kst_now()
    today_kst = datetime(kst_now.year, kst_now.month, kst_now.day)
    return today_kst - timedelta(hours=9)


def _get_chat_consent(grade: int | None, section: int | None, number: int | None) -> ChatConsent | None:
    if grade is None or section is None or number is None:
        return None
    return ChatConsent.query.filter_by(
        grade=grade,
        section=section,
        student_number=number,
    ).first()


def _load_state_blob(state: ClassState | None) -> dict:
    if not state or not state.data:
        return {
            "magnets": {},
            "channels": [DEFAULT_CHANNEL],
            "channelMemberships": {DEFAULT_CHANNEL: []},
            "channelOwners": {DEFAULT_CHANNEL: []},
        }
    try:
        data = json.loads(state.data)
    except (TypeError, json.JSONDecodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    magnets = data.get("magnets")
    if not isinstance(magnets, dict):
        magnets = {}
    data["magnets"] = magnets
    channels = _normalize_channel_list(data.get("channels"))
    data["channels"] = channels
    data["channelMemberships"] = _normalize_channel_memberships(
        data.get("channelMemberships"),
        channels,
        getattr(state, "grade", None),
        getattr(state, "section", None),
    )
    data["channelOwners"] = _normalize_channel_owners(data.get("channelOwners"), channels)
    return data


def _ensure_class_state(grade: int, section: int) -> tuple[ClassState, dict]:
    state = ClassState.query.filter_by(grade=grade, section=section).first()
    if not state:
        payload = {
            "magnets": {},
            "channels": [DEFAULT_CHANNEL],
            "channelMemberships": {
                DEFAULT_CHANNEL: [{"grade": grade, "section": section}]
            },
            "channelOwners": {DEFAULT_CHANNEL: []},
        }
        state = ClassState(grade=grade, section=section, data=json.dumps(payload, ensure_ascii=False))
        db.session.add(state)
        return state, payload
    return state, _load_state_blob(state)


def _ensure_channels_for_class(grade: int, section: int, *, persist: bool = False) -> tuple[list[str], ClassState, dict, dict, dict]:
    state, payload = _ensure_class_state(grade, section)
    existing = payload.get("channels") if isinstance(payload, dict) else None
    existing_memberships = payload.get("channelMemberships") if isinstance(payload, dict) else None
    existing_owners = payload.get("channelOwners") if isinstance(payload, dict) else None
    channels = _normalize_channel_list(existing)
    payload["channels"] = channels
    memberships = _normalize_channel_memberships(payload.get("channelMemberships"), channels, grade, section)
    payload["channelMemberships"] = memberships
    owners = _normalize_channel_owners(payload.get("channelOwners"), channels)
    payload["channelOwners"] = owners

    if persist and (channels != existing or memberships != existing_memberships or owners != existing_owners):
        state.data = json.dumps(payload, ensure_ascii=False)
        db.session.add(state)
        db.session.commit()

    return channels, state, payload, memberships, owners


def _apply_thought_preview(grade: int, section: int, number: int, text: str | None, duration_seconds: int = THOUGHT_PREVIEW_DURATION_SECONDS) -> None:
    if not text:
        return

    preview = text.strip()
    if not preview:
        return

    if len(preview) > THOUGHT_PREVIEW_MAX_LENGTH:
        preview = preview[:THOUGHT_PREVIEW_MAX_LENGTH]

    try:
        duration = int(duration_seconds)
    except (TypeError, ValueError):
        duration = THOUGHT_PREVIEW_DURATION_SECONDS
    duration = max(1, min(duration, 60))

    state, payload = _ensure_class_state(grade, section)
    magnets = payload.get("magnets", {})

    key = str(number)
    current = magnets.get(key)
    if not isinstance(current, dict):
        current = {}

    now = datetime.now(timezone.utc)
    posted_at = now.isoformat()
    expires_at = (now + timedelta(seconds=duration)).isoformat()

    current.update({
        "thought": preview,
        "thoughtPostedAt": posted_at,
        "thoughtExpiresAt": expires_at,
    })

    magnets[key] = current
    payload["magnets"] = magnets
    state.data = json.dumps(payload, ensure_ascii=False)


@blueprint.get("/today")
def get_today_messages():
    """Get academic-year chat messages for a specific class"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    requested_channel = _normalize_channel_name(request.args.get("channel"))

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    channels, _, _, memberships, owners = _ensure_channels_for_class(grade, section, persist=True)
    channel = requested_channel if _channel_exists(channels, requested_channel) else DEFAULT_CHANNEL
    member_classes = memberships.get(channel) or [{"grade": grade, "section": section}]

    # Get messages from current academic year start (UTC)
    today_start_utc = _academic_year_start_utc()
    today_midnight_utc = _today_start_utc()

    from sqlalchemy import or_, and_
    member_conditions = []
    for m in member_classes:
        g = _normalize_class_value(m.get("grade"))
        s = _normalize_class_value(m.get("section"))
        if g is None or s is None:
            continue
        member_conditions.append(and_(ChatMessage.grade == g, ChatMessage.section == s))

    if not member_conditions:
        return jsonify({"error": "forbidden"}), 403

    messages = (
        ChatMessage.query.filter(
            ChatMessage.channel == channel,
            ChatMessage.created_at >= today_start_utc,
            ChatMessage.deleted_at == None,  # Filter out deleted messages
            or_(*member_conditions)
        )
        .order_by(ChatMessage.created_at.asc())
        .all()
    )

    # 메시지 ID 목록
    message_ids = [msg.id for msg in messages]

    # 모든 메시지의 반응 가져오기
    reactions = ChatReaction.query.filter(ChatReaction.message_id.in_(message_ids)).all() if message_ids else []

    # 메시지 ID별로 반응 그룹화
    reactions_by_message = {}
    for r in reactions:
        if r.message_id not in reactions_by_message:
            reactions_by_message[r.message_id] = {}
        if r.emoji not in reactions_by_message[r.message_id]:
            reactions_by_message[r.message_id][r.emoji] = []
        reactions_by_message[r.message_id][r.emoji].append(r.student_number)

    # 모든 학생의 아바타 정보 가져오기
    student_numbers = list(set(msg.student_number for msg in messages))
    avatars = UserAvatar.query.filter(
        UserAvatar.grade == grade,
        UserAvatar.section == section,
        UserAvatar.student_number.in_(student_numbers)
    ).all() if student_numbers else []

    avatars_by_student = {}
    for av in avatars:
        try:
            avatars_by_student[av.student_number] = json.loads(av.avatar_data)
        except (TypeError, json.JSONDecodeError):
            pass

    # Read counts for messages created today only
    read_counts = {}
    if message_ids:
        todays_ids = [msg.id for msg in messages if msg.created_at >= today_midnight_utc]
        if todays_ids:
            read_rows = (
                db.session.query(ChatMessageRead.message_id, func.count(ChatMessageRead.id))
                .filter(ChatMessageRead.message_id.in_(todays_ids))
                .group_by(ChatMessageRead.message_id)
                .all()
            )
            read_counts = {row[0]: row[1] for row in read_rows}

    return jsonify({
        "messages": [
            {
                "id": msg.id,
                "studentNumber": msg.student_number,
                "message": msg.message,
                "timestamp": msg.created_at.isoformat(),
                "channel": msg.channel or DEFAULT_CHANNEL,
                "imageUrl": msg.image_url,
                "replyToId": msg.reply_to_id,
                "nickname": msg.nickname,
                "avatar": avatars_by_student.get(msg.student_number),
                "readCount": read_counts.get(msg.id) if msg.created_at >= today_midnight_utc else None,
                "reactions": [
                    {
                        "emoji": emoji,
                        "count": len(students),
                        "students": students
                    }
                    for emoji, students in reactions_by_message.get(msg.id, {}).items()
                ]
            }
            for msg in messages
        ]
    })


@blueprint.get("/channels")
def get_channels():
    """List channels for a class"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    session_grade, session_section, session_number = _get_student_session_info()

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    channels, _, _, memberships, owners = _ensure_channels_for_class(grade, section, persist=True)
    serialized = _serialize_channels_for_class(channels, memberships, owners, grade, section, (session_grade, session_section, session_number))
    return jsonify({"channels": serialized})


@blueprint.post("/channels")
def create_channel():
    """Create a new channel for the class"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    payload = request.get_json() or {}
    session_grade, session_section, session_number = _get_student_session_info()

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    raw_name = payload.get("name") or payload.get("channel") or ""
    name = _normalize_channel_name(raw_name)
    if not _is_valid_channel_name(name):
        return jsonify({"error": "invalid channel name"}), 400

    channels, state, state_payload, memberships, owners = _ensure_channels_for_class(grade, section)
    raw_classes = payload.get("classes") or []
    member_tuples = set()
    for item in raw_classes:
        if not isinstance(item, dict):
            continue
        g = _normalize_class_value(item.get("grade"))
        s = _normalize_class_value(item.get("section"))
        if g is None or s is None:
            continue
        member_tuples.add((g, s))
    member_tuples.add((grade, section))

    target_classes = [{"grade": g, "section": s} for g, s in sorted(member_tuples)]
    owner_entry = None
    if session_grade is not None and session_section is not None and session_number is not None:
        owner_entry = {
            "grade": session_grade,
            "section": session_section,
            "studentNumber": session_number
        }

    if _channel_exists(channels, name):
        # Update memberships if necessary
        existing_members = memberships.get(name, [])
        existing_set = {(m.get("grade"), m.get("section")) for m in existing_members if isinstance(m, dict)}
        if not member_tuples.issubset(existing_set):
            memberships[name] = target_classes
            state_payload["channelMemberships"] = memberships
            state_payload["channels"] = channels
            if owner_entry:
                channel_owners = _normalize_channel_owners(state_payload.get("channelOwners"), channels)
                existing_owners = channel_owners.get(name, [])
                existing_owner_keys = {(o.get("grade"), o.get("section"), o.get("studentNumber")) for o in existing_owners}
                key = (owner_entry["grade"], owner_entry["section"], owner_entry["studentNumber"])
                if key not in existing_owner_keys:
                    existing_owners.append(owner_entry)
                channel_owners[name] = existing_owners
                state_payload["channelOwners"] = channel_owners
            state.data = json.dumps(state_payload, ensure_ascii=False)
            db.session.add(state)
            # Propagate to all member classes
            for target in target_classes:
                st, pl = _ensure_class_state(target["grade"], target["section"])
                chs = _normalize_channel_list(pl.get("channels"))
                if name not in chs:
                    chs.append(name)
                mems = _normalize_channel_memberships(pl.get("channelMemberships"), chs, target["grade"], target["section"])
                mems[name] = target_classes
                channel_owners = _normalize_channel_owners(pl.get("channelOwners"), chs)
                if owner_entry:
                    owner_list = channel_owners.get(name, [])
                    owner_keys = {(o.get("grade"), o.get("section"), o.get("studentNumber")) for o in owner_list}
                    key = (owner_entry["grade"], owner_entry["section"], owner_entry["studentNumber"])
                    if key not in owner_keys:
                        owner_list.append(owner_entry)
                    channel_owners[name] = owner_list
                pl["channels"] = chs
                pl["channelMemberships"] = mems
                pl["channelOwners"] = channel_owners
                st.data = json.dumps(pl, ensure_ascii=False)
                db.session.add(st)
            db.session.commit()
        return jsonify({"ok": True, "channel": name, "channels": channels, "created": False})

    if len(channels) >= MAX_CHANNELS_PER_CLASS:
        return jsonify({"error": "channel limit reached"}), 400

    # Apply to all member classes
    def _update_class_state(target_grade: int, target_section: int):
        st, pl = _ensure_class_state(target_grade, target_section)
        chs = _normalize_channel_list(pl.get("channels"))
        if name not in chs:
            chs.append(name)
        mems = _normalize_channel_memberships(pl.get("channelMemberships"), chs, target_grade, target_section)
        mems[name] = target_classes
        channel_owners = _normalize_channel_owners(pl.get("channelOwners"), chs)
        if owner_entry:
            owner_list = channel_owners.get(name, [])
            owner_keys = {(o.get("grade"), o.get("section"), o.get("studentNumber")) for o in owner_list}
            key = (owner_entry["grade"], owner_entry["section"], owner_entry["studentNumber"])
            if key not in owner_keys:
                owner_list.append(owner_entry)
            channel_owners[name] = owner_list
        pl["channels"] = chs
        pl["channelMemberships"] = mems
        pl["channelOwners"] = channel_owners
        st.data = json.dumps(pl, ensure_ascii=False)
        db.session.add(st)
        return chs, mems

    for target in target_classes:
        _update_class_state(target["grade"], target["section"])
    db.session.commit()

    # Return the caller's channel list
    refreshed_channels, _, _, refreshed_mems, refreshed_owners = _ensure_channels_for_class(grade, section, persist=True)
    serialized = _serialize_channels_for_class(
        refreshed_channels,
        refreshed_mems,
        refreshed_owners,
        grade,
        section,
        (session_grade, session_section, session_number)
    )
    return jsonify({"ok": True, "channel": name, "channels": serialized, "members": target_classes, "created": True})


@blueprint.delete("/channels/<path:channel_name>")
def delete_channel(channel_name):
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    channel = _normalize_channel_name(channel_name)
    if channel == DEFAULT_CHANNEL:
        return jsonify({"error": "cannot delete default channel"}), 400
    channels, state, state_payload, memberships, owners = _ensure_channels_for_class(grade, section, persist=True)
    if not _channel_exists(channels, channel):
        return jsonify({"error": "channel not found"}), 404

    member_classes = memberships.get(channel) or [{"grade": grade, "section": section}]

    # Permission: owner or teacher/board
    session_grade, session_section, session_number = _get_student_session_info()
    is_owner = _is_channel_owner(session_grade, session_section, session_number, owners, channel)
    if not (is_owner or is_teacher_session_active() or is_board_session_active(grade, section)):
        return jsonify({"error": "forbidden"}), 403

    # Remove from all member classes
    for m in member_classes:
        g = _normalize_class_value(m.get("grade"))
        s = _normalize_class_value(m.get("section"))
        if g is None or s is None:
            continue
        st, pl = _ensure_class_state(g, s)
        chs = _normalize_channel_list(pl.get("channels"))
        mems = _normalize_channel_memberships(pl.get("channelMemberships"), chs, g, s)
        channel_owners = _normalize_channel_owners(pl.get("channelOwners"), chs)

        if channel in chs:
            chs = [c for c in chs if c.casefold() != channel.casefold()]
        mems.pop(channel, None)
        channel_owners.pop(channel, None)

        pl["channels"] = chs if chs else [DEFAULT_CHANNEL]
        pl["channelMemberships"] = mems
        pl["channelOwners"] = channel_owners
        st.data = json.dumps(pl, ensure_ascii=False)
        db.session.add(st)
    db.session.commit()

    refreshed_channels, _, _, refreshed_mems, refreshed_owners = _ensure_channels_for_class(grade, section, persist=True)
    serialized = _serialize_channels_for_class(
        refreshed_channels,
        refreshed_mems,
        refreshed_owners,
        grade,
        section,
        (session_grade, session_section, session_number)
    )
    return jsonify({"ok": True, "channels": serialized})


@blueprint.post("/send")
def send_message():
    """Send a chat message with optional image URL and reply"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    session_grade, session_section, session_number = _get_student_session_info()

    # Only students from the same class can send messages
    if session_grade != grade or session_section != section or session_number is None:
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json() or {}
    requested_channel = _normalize_channel_name(
        request.args.get("channel") or payload.get("channel")
    )
    if not _is_valid_channel_name(requested_channel):
        requested_channel = DEFAULT_CHANNEL

    target_raw = payload.get("target") or ""
    target = target_raw.lower().strip() if isinstance(target_raw, str) else ""
    board_preview_raw = payload.get("boardPreview")
    send_board_preview = True
    if isinstance(board_preview_raw, bool):
        send_board_preview = board_preview_raw
    elif isinstance(board_preview_raw, (int, float)):
        send_board_preview = bool(board_preview_raw)
    elif isinstance(board_preview_raw, str):
        send_board_preview = board_preview_raw.lower() not in ("false", "0", "no", "off")
    elif target in ("chat", "chat-only", "chat_only"):
        send_board_preview = False

    channels, state, state_payload, memberships, owners = _ensure_channels_for_class(grade, section)
    if not _channel_exists(channels, requested_channel):
        if len(channels) >= MAX_CHANNELS_PER_CLASS:
            return jsonify({"error": "채널을 더 만들 수 없습니다"}), 400
        channels.append(requested_channel)
        state_payload["channels"] = channels
        memberships = _normalize_channel_memberships(
            state_payload.get("channelMemberships"),
            channels,
            grade,
            section,
        )
        state_payload["channelMemberships"] = memberships
        state.data = json.dumps(state_payload, ensure_ascii=False)
        db.session.add(state)
        db.session.commit()
    channel = requested_channel
    member_classes = memberships.get(channel) or [{"grade": grade, "section": section}]
    if not any(_normalize_class_value(m.get("grade")) == grade and _normalize_class_value(m.get("section")) == section for m in member_classes):
        return jsonify({"error": "forbidden"}), 403
    message_text = (payload.get("message") or "").strip()

    image_url = payload.get("imageUrl")
    if not image_url:
        image_url = payload.get("image_url")
    image_url = (image_url or "").strip()

    reply_to_id = payload.get("replyToId")
    if reply_to_id is None:
        reply_to_id = payload.get("reply_to_id")

    # At least message or image URL is required
    if not message_text and not image_url:
        return jsonify({"error": "message or imageUrl is required"}), 400

    # Validate message length
    max_length = 500
    if message_text and len(message_text) > max_length:
        message_text = message_text[:max_length]

    # Validate image URL
    if image_url:
        # Check URL format (https only, common image extensions)
        url_pattern = r'^https?://.+\.(jpg|jpeg|png|gif|webp)$'
        if not re.match(url_pattern, image_url, re.IGNORECASE):
            return jsonify({"error": "invalid image URL format"}), 400

        # Length check
        if len(image_url) > 500:
            return jsonify({"error": "image URL too long"}), 400

    # Validate reply_to_id
    if reply_to_id:
        try:
            reply_to_id = int(reply_to_id)
            # Check if replied message exists
            replied_msg = ChatMessage.query.get(reply_to_id)
            if not replied_msg or replied_msg.deleted_at is not None:
                return jsonify({"error": "replied message not found"}), 400
        except (TypeError, ValueError):
            return jsonify({"error": "invalid replyToId"}), 400

    # Get user's current nickname
    nickname_obj = UserNickname.query.filter_by(
        grade=grade,
        section=section,
        student_number=session_number
    ).first()

    current_nickname = nickname_obj.nickname if nickname_obj else None

    new_message = ChatMessage(
        grade=grade,
        section=section,
        channel=channel,
        student_number=session_number,
        message=message_text if message_text else "",
        image_url=image_url if image_url else None,
        reply_to_id=reply_to_id,
        nickname=current_nickname
    )

    preview_text = message_text or None
    if not preview_text and image_url:
        preview_text = "이미지를 보냈습니다."
    if preview_text and send_board_preview:
        _apply_thought_preview(grade, section, session_number, preview_text)

    db.session.add(new_message)
    db.session.commit()

    # Clean up messages from previous academic years
    _cleanup_expired_messages()

    return jsonify({
        "ok": True,
        "message": {
            "id": new_message.id,
            "studentNumber": new_message.student_number,
            "message": new_message.message,
            "timestamp": new_message.created_at.isoformat(),
            "channel": new_message.channel or DEFAULT_CHANNEL,
            "imageUrl": new_message.image_url,
            "replyToId": new_message.reply_to_id,
            "nickname": new_message.nickname,
            "readCount": None
        }
    })


@blueprint.delete("/delete/<int:message_id>")
def delete_message(message_id):
    """Soft delete a chat message (only own messages)"""
    msg = ChatMessage.query.get(message_id)

    if not msg:
        return jsonify({"error": "message not found"}), 404

    if msg.deleted_at is not None:
        return jsonify({"error": "message already deleted"}), 400

    session_grade, session_section, session_number = _get_student_session_info()

    # Only the author can delete their message
    if (msg.grade != session_grade or
        msg.section != session_section or
        msg.student_number != session_number):
        return jsonify({"error": "forbidden"}), 403

    # Soft delete
    msg.deleted_at = datetime.utcnow()
    db.session.commit()

    return jsonify({"ok": True})


@blueprint.get("/nickname")
def get_nickname():
    """Get current user's nickname"""
    session_grade, session_section, session_number = _get_student_session_info()

    if session_number is None:
        return jsonify({"error": "unauthorized"}), 401

    nickname_obj = UserNickname.query.filter_by(
        grade=session_grade,
        section=session_section,
        student_number=session_number
    ).first()

    return jsonify({
        "nickname": nickname_obj.nickname if nickname_obj else None
    })


@blueprint.post("/nickname")
def set_nickname():
    """Set or update current user's nickname"""
    session_grade, session_section, session_number = _get_student_session_info()

    if session_number is None:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json() or {}
    nickname = (payload.get("nickname") or "").strip()

    if not nickname:
        return jsonify({"error": "nickname is required"}), 400

    # Validate nickname length (max 20 chars)
    max_length = 20
    if len(nickname) > max_length:
        return jsonify({"error": f"nickname too long (max {max_length} chars)"}), 400

    # Validate nickname characters (Korean, English, numbers, spaces)
    if not re.match(r'^[\u3131-\uD79Da-zA-Z0-9\s]+$', nickname):
        return jsonify({"error": "invalid nickname characters"}), 400

    # Update or create nickname
    nickname_obj = UserNickname.query.filter_by(
        grade=session_grade,
        section=session_section,
        student_number=session_number
    ).first()

    if nickname_obj:
        nickname_obj.nickname = nickname
        nickname_obj.updated_at = datetime.utcnow()
    else:
        nickname_obj = UserNickname(
            grade=session_grade,
            section=session_section,
            student_number=session_number,
            nickname=nickname
        )
        db.session.add(nickname_obj)

    db.session.commit()

    return jsonify({
        "ok": True,
        "nickname": nickname_obj.nickname
    })


@blueprint.post("/reactions/<int:message_id>")
def add_reaction(message_id):
    """메시지에 반응(이모지) 추가"""
    session_grade, session_section, session_number = _get_student_session_info()

    if session_number is None:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json() or {}
    emoji = (payload.get("emoji") or "").strip()

    if not emoji:
        return jsonify({"error": "emoji is required"}), 400

    # 이모지 길이 검증 (최대 10자)
    if len(emoji) > 10:
        return jsonify({"error": "emoji too long"}), 400

    # 메시지 존재 여부 확인
    msg = ChatMessage.query.get(message_id)
    if not msg or msg.deleted_at is not None:
        return jsonify({"error": "message not found"}), 404

    # 같은 반 학생만 반응 가능
    if msg.grade != session_grade or msg.section != session_section:
        return jsonify({"error": "forbidden"}), 403

    # 이미 같은 반응이 있는지 확인
    existing = ChatReaction.query.filter_by(
        message_id=message_id,
        student_number=session_number,
        emoji=emoji
    ).first()

    if existing:
        return jsonify({"error": "already reacted"}), 400

    # 반응 추가
    reaction = ChatReaction(
        message_id=message_id,
        student_number=session_number,
        emoji=emoji
    )
    db.session.add(reaction)
    db.session.commit()

    return jsonify({"ok": True})


@blueprint.delete("/reactions/<int:message_id>")
def remove_reaction(message_id):
    """메시지에서 반응 제거"""
    session_grade, session_section, session_number = _get_student_session_info()

    if session_number is None:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json() or {}
    emoji = (payload.get("emoji") or "").strip()

    if not emoji:
        return jsonify({"error": "emoji is required"}), 400

    # 반응 찾기
    reaction = ChatReaction.query.filter_by(
        message_id=message_id,
        student_number=session_number,
        emoji=emoji
    ).first()

    if not reaction:
        return jsonify({"error": "reaction not found"}), 404

    db.session.delete(reaction)
    db.session.commit()

    return jsonify({"ok": True})


@blueprint.get("/reactions/<int:message_id>")
def get_reactions(message_id):
    """메시지의 모든 반응 가져오기"""
    msg = ChatMessage.query.get(message_id)
    if not msg:
        return jsonify({"error": "message not found"}), 404

    reactions = ChatReaction.query.filter_by(message_id=message_id).all()

    # 이모지별로 그룹화
    reaction_counts = {}
    for r in reactions:
        if r.emoji not in reaction_counts:
            reaction_counts[r.emoji] = []
        reaction_counts[r.emoji].append(r.student_number)

    return jsonify({
        "reactions": [
            {
                "emoji": emoji,
                "count": len(students),
                "students": students
            }
            for emoji, students in reaction_counts.items()
        ]
    })


@blueprint.get("/avatar")
def get_avatar():
    """현재 사용자의 아바타 정보 가져오기"""
    session_grade, session_section, session_number = _get_student_session_info()

    if session_number is None:
        return jsonify({"error": "unauthorized"}), 401

    avatar = UserAvatar.query.filter_by(
        grade=session_grade,
        section=session_section,
        student_number=session_number
    ).first()

    if not avatar:
        return jsonify({"avatar": None})

    try:
        avatar_data = json.loads(avatar.avatar_data)
    except (TypeError, json.JSONDecodeError):
        avatar_data = None

    return jsonify({"avatar": avatar_data})


@blueprint.post("/avatar")
def set_avatar():
    """아바타 커스터마이징 설정"""
    session_grade, session_section, session_number = _get_student_session_info()

    if session_number is None:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json() or {}
    avatar_data = payload.get("avatar")

    if not avatar_data or not isinstance(avatar_data, dict):
        return jsonify({"error": "invalid avatar data"}), 400

    # 아바타 데이터 검증
    allowed_keys = {"bgColor", "textColor", "emoji", "borderColor", "style", "imageUrl"}
    if not all(key in allowed_keys for key in avatar_data.keys()):
        return jsonify({"error": "invalid avatar keys"}), 400

    # 업데이트 또는 생성
    avatar = UserAvatar.query.filter_by(
        grade=session_grade,
        section=session_section,
        student_number=session_number
    ).first()

    avatar_json = json.dumps(avatar_data, ensure_ascii=False)

    if avatar:
        avatar.avatar_data = avatar_json
        avatar.updated_at = datetime.utcnow()
    else:
        avatar = UserAvatar(
            grade=session_grade,
            section=session_section,
            student_number=session_number,
            avatar_data=avatar_json
        )
        db.session.add(avatar)

    db.session.commit()

    return jsonify({"ok": True, "avatar": avatar_data})


@blueprint.get("/profile/<int:student_number>")
def get_user_profile(student_number):
    """사용자 프로필 및 메시지 이력 가져오기"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    requested_channel = request.args.get("channel")
    channel_filter = None
    if requested_channel:
        normalized = _normalize_channel_name(requested_channel)
        channels, _, _, memberships, owners = _ensure_channels_for_class(grade, section)
        if _channel_exists(channels, normalized) and any(
            _normalize_class_value(m.get("grade")) == grade and _normalize_class_value(m.get("section")) == section
            for m in memberships.get(normalized, [])
        ):
            channel_filter = normalized

    # 닉네임 가져오기
    nickname_obj = UserNickname.query.filter_by(
        grade=grade,
        section=section,
        student_number=student_number
    ).first()

    # 아바타 가져오기
    avatar_obj = UserAvatar.query.filter_by(
        grade=grade,
        section=section,
        student_number=student_number
    ).first()

    avatar_data = None
    if avatar_obj:
        try:
            avatar_data = json.loads(avatar_obj.avatar_data)
        except (TypeError, json.JSONDecodeError):
            pass

    # 최근 메시지 가져오기 (최대 20개)
    today_start_utc = _academic_year_start_utc()
    message_query = ChatMessage.query.filter(
        ChatMessage.grade == grade,
        ChatMessage.section == section,
        ChatMessage.student_number == student_number,
        ChatMessage.created_at >= today_start_utc,
        ChatMessage.deleted_at == None
    )
    if channel_filter:
        message_query = message_query.filter(ChatMessage.channel == channel_filter)

    messages = message_query.order_by(ChatMessage.created_at.desc()).limit(20).all()

    # 마지막 메시지 정보
    last_message = None
    last_message_at = None
    if messages:
        last_msg = messages[0]
        last_message = last_msg.message
        last_message_at = last_msg.created_at.isoformat()

    return jsonify({
        "studentNumber": student_number,
        "nickname": nickname_obj.nickname if nickname_obj else None,
        "avatar": avatar_data,
        "lastMessage": last_message,
        "lastMessageAt": last_message_at,
        "recentMessages": [
            {
                "id": msg.id,
                "message": msg.message,
                "timestamp": msg.created_at.isoformat(),
                "channel": msg.channel or DEFAULT_CHANNEL,
                "imageUrl": msg.image_url
            }
            for msg in messages
        ]
    })


@blueprint.route("/config", methods=["GET"])
def get_chat_config():
    """채팅 설정 (API 키 등) 조회"""
    from config import config

    return jsonify({
        "klipyApiKey": config.KLIPY_API_KEY,
        "imageUploadUrl": config.IMAGE_UPLOAD_URL
    })


# ============================================================================
# Class Emoji Endpoints
# ============================================================================

@blueprint.route("/emojis", methods=["GET"])
def get_class_emojis():
    """
    현재 반의 커스텀 이모티콘 목록 조회

    Response:
        - emojis: 이모티콘 배열
            - id, name, imageUrl, uploadedBy, createdAt
    """
    # 학생 세션 확인
    grade, section, student_number = _get_student_session_info()
    if grade is None or section is None or student_number is None:
        return jsonify({"error": "학생 로그인이 필요합니다"}), 401

    # 반 이모티콘 조회
    emojis = ClassEmoji.query.filter_by(
        grade=grade,
        section=section
    ).order_by(ClassEmoji.created_at.desc()).all()

    return jsonify({
        "emojis": [
            {
                "id": emoji.id,
                "name": emoji.name,
                "imageUrl": emoji.image_url,
                "uploadedBy": emoji.uploaded_by,
                "createdAt": emoji.created_at.isoformat()
            }
            for emoji in emojis
        ]
    })


@blueprint.route("/emojis", methods=["POST"])
def upload_class_emoji():
    """
    반 커스텀 이모티콘 등록 (클라이언트에서 이미 업로드된 이미지 URL 전달)

    Request (JSON):
        - name: 이모티콘 이름
        - imageUrl: 업로드된 이미지 URL

    Response:
        - emoji: 생성된 이모티콘 정보
    """
    # 학생 세션 확인
    grade, section, student_number = _get_student_session_info()
    if grade is None or section is None or student_number is None:
        return jsonify({"error": "학생 로그인이 필요합니다"}), 401

    # JSON 데이터 파싱
    data = request.get_json()
    if not data:
        return jsonify({"error": "JSON 데이터가 필요합니다"}), 400

    # 이모티콘 이름
    emoji_name = data.get('name', '').strip()
    if not emoji_name:
        return jsonify({"error": "이모티콘 이름을 입력해주세요"}), 400

    # 이름 길이 검증
    if len(emoji_name) > 50:
        return jsonify({"error": "이모티콘 이름은 50자를 초과할 수 없습니다"}), 400

    # 이미지 URL
    image_url = data.get('imageUrl', '').strip()
    if not image_url:
        return jsonify({"error": "이미지 URL이 필요합니다"}), 400

    # URL 길이 검증
    if len(image_url) > 500:
        return jsonify({"error": "이미지 URL이 너무 깁니다"}), 400

    # DB에 저장
    emoji = ClassEmoji(
        grade=grade,
        section=section,
        name=emoji_name,
        image_url=image_url,
        uploaded_by=student_number
    )
    db.session.add(emoji)
    db.session.commit()

    return jsonify({
        "emoji": {
            "id": emoji.id,
            "name": emoji.name,
            "imageUrl": emoji.image_url,
            "uploadedBy": emoji.uploaded_by,
            "createdAt": emoji.created_at.isoformat()
        }
    }), 201


@blueprint.route("/emojis/<int:emoji_id>", methods=["DELETE"])
def delete_class_emoji(emoji_id: int):
    """
    반 커스텀 이모티콘 삭제

    권한: 업로더 본인 또는 관리자(선생님)

    Response:
        - success: True
    """
    # 학생 세션 확인
    grade, section, student_number = _get_student_session_info()
    is_teacher = is_teacher_session_active()

    if grade is None or section is None or (student_number is None and not is_teacher):
        return jsonify({"error": "로그인이 필요합니다"}), 401

    # 이모티콘 조회
    emoji = ClassEmoji.query.get(emoji_id)
    if not emoji:
        return jsonify({"error": "이모티콘을 찾을 수 없습니다"}), 404

    # 권한 확인: 같은 반이면서 (업로더 본인이거나 선생님)
    if not (emoji.grade == grade and emoji.section == section):
        return jsonify({"error": "접근 권한이 없습니다"}), 403

    if not (is_teacher or emoji.uploaded_by == student_number):
        return jsonify({"error": "이모티콘을 삭제할 권한이 없습니다 (업로더 또는 관리자만 가능)"}), 403

    # 삭제
    db.session.delete(emoji)
    db.session.commit()

    return jsonify({"success": True})


@blueprint.post("/read")
def mark_read():
    """Mark messages as read up to a given ID for the current channel (today only)"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    channel = _normalize_channel_name(request.args.get("channel"))
    payload = request.get_json(silent=True) or {}
    last_id = payload.get("lastMessageId")
    if last_id is None:
        last_id = request.args.get("lastMessageId", type=int)

    if grade is None or section is None or last_id is None:
        return jsonify({"error": "missing parameters"}), 400

    # Only students can mark read
    session_grade, session_section, session_number = _get_student_session_info()
    if session_grade != grade or session_section != section or session_number is None:
        return jsonify({"error": "forbidden"}), 403

    channels, _, _, memberships, _ = _ensure_channels_for_class(grade, section, persist=True)
    if not _channel_exists(channels, channel):
        channel = DEFAULT_CHANNEL
    member_classes = memberships.get(channel) or [{"grade": grade, "section": section}]
    if not any(
        _normalize_class_value(m.get("grade")) == grade and _normalize_class_value(m.get("section")) == section
        for m in member_classes
    ):
        return jsonify({"error": "forbidden"}), 403

    today_start = _today_start_utc()

    # Build class conditions
    conditions = []
    for m in member_classes:
        g = _normalize_class_value(m.get("grade"))
        s = _normalize_class_value(m.get("section"))
        if g is None or s is None:
            continue
        conditions.append(and_(ChatMessage.grade == g, ChatMessage.section == s))

    if not conditions:
        return jsonify({"error": "forbidden"}), 403

    message_ids = [
        mid for (mid,) in db.session.query(ChatMessage.id)
        .filter(
            ChatMessage.channel == channel,
            ChatMessage.id <= int(last_id),
            ChatMessage.created_at >= today_start,
            or_(*conditions)
        )
        .all()
    ]

    if not message_ids:
        return jsonify({"ok": True, "count": 0})

    inserted = 0
    for mid in message_ids:
        try:
            db.session.add(ChatMessageRead(
                message_id=mid,
                grade=grade,
                section=section,
                student_number=session_number,
            ))
            db.session.commit()
            inserted += 1
        except IntegrityError:
            db.session.rollback()
        except Exception:
            db.session.rollback()

    return jsonify({"ok": True, "count": inserted})


@blueprint.get("/consent")
def get_chat_consent():
    """Check chat-specific consent for the current student"""
    grade, section, number = _get_student_session_info()
    if grade is None or section is None or number is None:
        return jsonify({"error": "학생 로그인이 필요합니다"}), 401

    consent = _get_chat_consent(grade, section, number)
    if consent and consent.version == CHAT_CONSENT_VERSION:
        return jsonify({
            "consented": True,
            "version": consent.version,
            "agreedAt": consent.agreed_at.isoformat() if consent.agreed_at else None,
        })

    return jsonify({
        "consented": False,
        "version": consent.version if consent else None,
        "requiredVersion": CHAT_CONSENT_VERSION,
    })


@blueprint.post("/consent")
def accept_chat_consent():
    """Persist chat-specific consent for the current student"""
    grade, section, number = _get_student_session_info()
    if grade is None or section is None or number is None:
        return jsonify({"error": "학생 로그인이 필요합니다"}), 401

    payload = request.get_json(silent=True) or {}
    version = payload.get("version") or CHAT_CONSENT_VERSION

    # Force to the latest version even if stale payload is sent
    if version != CHAT_CONSENT_VERSION:
        version = CHAT_CONSENT_VERSION

    consent = _get_chat_consent(grade, section, number)
    now = datetime.utcnow()
    if consent:
        consent.version = version
        consent.agreed_at = now
    else:
        consent = ChatConsent(
            grade=grade,
            section=section,
            student_number=number,
            version=version,
            agreed_at=now,
        )
        db.session.add(consent)

    db.session.commit()

    return jsonify({
        "ok": True,
        "consented": True,
        "version": version,
        "agreedAt": consent.agreed_at.isoformat() if consent.agreed_at else None,
    })
