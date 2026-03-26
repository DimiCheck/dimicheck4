from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
import os
import requests

from flask import Blueprint, current_app, jsonify, request, session
from sqlalchemy import or_

from content_filter import contains_slang
from extensions import db
from config import config
from models import (
    ClassState,
    ClassRoutine,
    ChatMessage,
    ChatConsent,
    MealVote,
    CalendarEvent,
    TeacherNotice,
    TeacherNoticeRead,
)
from config_loader import load_class_config
from utils import is_board_session_active, is_teacher_session_active
from public_api import broadcast_public_status_update

blueprint = Blueprint("classes", __name__, url_prefix="/api/classes")
DEFAULT_CHAT_CHANNEL = "home"


def _normalize_class_value(value: int | str | None) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalize_magnet_number_key(value: int | str | None) -> str | None:
    number = _normalize_class_value(value)
    if number is None or number < 1 or number > 99:
        return None
    return str(number)


def _allowed_class_numbers(class_config: dict | None) -> set[int] | None:
    if not class_config:
        return None
    end = _normalize_class_value(class_config.get("end"))
    if end is None or end < 1:
        return None
    skip_numbers = {
        num for num in (
            _normalize_class_value(value)
            for value in (class_config.get("skip_numbers") or [])
        )
        if num is not None
    }
    return {
        number
        for number in range(1, end + 1)
        if number not in skip_numbers
    }


def _normalize_magnet_number_key_for_class(value: int | str | None, class_config: dict | None) -> str | None:
    normalized_key = _normalize_magnet_number_key(value)
    if normalized_key is None:
        return None
    allowed_numbers = _allowed_class_numbers(class_config)
    if allowed_numbers is not None and int(normalized_key) not in allowed_numbers:
        return None
    return normalized_key


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


def _teacher_only() -> bool:
    return is_teacher_session_active()


def _teacher_or_board_only(grade: int | None, section: int | None) -> bool:
    return is_teacher_session_active() or is_board_session_active(grade, section)


_NOTICE_FRESH_SECONDS = 10
_NOTICE_DOT_SECONDS = 10 * 60
_NOTICE_BURST_WINDOW = timedelta(minutes=10)
_MARQUEE_MAX_AGE = timedelta(minutes=30)


def _ensure_notice_tables() -> bool:
    try:
        TeacherNotice.__table__.create(bind=db.engine, checkfirst=True)
        TeacherNoticeRead.__table__.create(bind=db.engine, checkfirst=True)
        return True
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass
        return False


def _valid_grade_section(grade: int | None, section: int | None) -> bool:
    return bool(grade in {1, 2, 3} and section in {1, 2, 3, 4, 5, 6})


def _to_notice_target_key(grade: int, section: int) -> str:
    return f"{grade}-{section}"


def _parse_notice_target_classes(raw_targets: str | None) -> list[str]:
    try:
        parsed = json.loads(raw_targets or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    normalized: list[str] = []
    seen = set()
    for item in parsed:
        if isinstance(item, dict):
            g = _normalize_class_value(item.get("grade"))
            s = _normalize_class_value(item.get("section"))
            if not _valid_grade_section(g, s):
                continue
            key = _to_notice_target_key(g, s)
        elif isinstance(item, str):
            parts = item.split("-")
            if len(parts) != 2:
                continue
            g = _normalize_class_value(parts[0])
            s = _normalize_class_value(parts[1])
            if not _valid_grade_section(g, s):
                continue
            key = _to_notice_target_key(g, s)
        else:
            continue
        if key in seen:
            continue
        seen.add(key)
        normalized.append(key)
    return normalized


def _normalize_notice_targets(payload: dict) -> tuple[bool, list[str]]:
    raw = payload.get("targetClasses")
    if raw is None:
        raw = payload.get("targets")

    if raw is None:
        return True, []

    targets: list[str] = []
    seen = set()
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                g = _normalize_class_value(item.get("grade"))
                s = _normalize_class_value(item.get("section"))
            elif isinstance(item, str):
                parts = item.split("-")
                g = _normalize_class_value(parts[0]) if len(parts) > 0 else None
                s = _normalize_class_value(parts[1]) if len(parts) > 1 else None
            else:
                g = None
                s = None
            if not _valid_grade_section(g, s):
                continue
            key = _to_notice_target_key(g, s)
            if key in seen:
                continue
            seen.add(key)
            targets.append(key)

    if not targets:
        return True, []
    return False, targets


def _normalize_wallpaper_payload(raw_wallpaper: object) -> dict[str, str] | None:
    if isinstance(raw_wallpaper, str):
        url = raw_wallpaper.strip()
        if not url:
          return None
        return {
            "id": "",
            "name": "",
            "url": url,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }

    if not isinstance(raw_wallpaper, dict):
        return None

    url = str(raw_wallpaper.get("url") or "").strip()
    if not url:
        return None

    updated_at = _parse_payload_datetime(
        raw_wallpaper.get("updatedAt")
        or raw_wallpaper.get("updated_at")
    )

    return {
        "id": str(raw_wallpaper.get("id") or "").strip()[:80],
        "name": str(raw_wallpaper.get("name") or "").strip()[:80],
        "url": url,
        "updatedAt": (updated_at or datetime.now(timezone.utc)).isoformat(),
    }


_PRESENT_SPECIAL_TAGS = {"toilet", "hallway"}


def _filtered_magnets_for_class(
    state: ClassState | None,
    grade: int,
    section: int,
    class_config: dict | None = None,
) -> tuple[dict[str, dict[str, object]], dict | None, dict | None]:
    allowed_numbers = _allowed_class_numbers(class_config)
    data = _load_state_payload(state)
    magnets = data.get("magnets", {})
    filtered_magnets: dict[str, dict[str, object]] = {}
    for num, value in magnets.items():
        normalized_key = _normalize_magnet_number_key(num)
        if normalized_key is None:
            continue
        if allowed_numbers is not None and int(normalized_key) not in allowed_numbers:
            continue
        filtered_magnets[normalized_key] = value
    return filtered_magnets, data.get("marquee"), data.get("wallpaper")


def _serialize_grade_state_section(
    grade: int,
    section: int,
    state: ClassState | None,
    class_config: dict | None,
) -> dict[str, object]:
    magnets, marquee, wallpaper = _filtered_magnets_for_class(state, grade, section, class_config)
    total = len(magnets)
    absence = 0
    for magnet_data in magnets.values():
        category = magnet_data.get("attachedTo")
        is_present_normal = not category or category == "section"
        is_present_special = category in _PRESENT_SPECIAL_TAGS
        if not is_present_normal and not is_present_special:
            absence += 1

    return {
        "section": section,
        "magnets": magnets,
        "marquee": marquee,
        "wallpaper": wallpaper,
        "total": total,
        "absence": absence,
        "present": total - absence,
        "updatedAt": state.updated_at.isoformat() if state and state.updated_at else None,
    }


def _emit_class_state_update(
    grade: int,
    section: int,
    state: ClassState | None = None,
    class_config: dict | None = None,
) -> None:
    socketio = current_app.extensions.get("socketio") if current_app else None
    if not socketio:
        return
    if state is None:
        state = ClassState.query.filter_by(grade=grade, section=section).first()
    if class_config is None:
        class_config = load_class_config().get((grade, section))
    payload = _serialize_grade_state_section(grade, section, state, class_config)
    socketio.emit(
        'state_updated',
        {
            'grade': grade,
            'section': section,
            **payload,
        },
        namespace=f'/ws/classes/{grade}/{section}',
    )


def _notice_matches_class(notice: TeacherNotice, grade: int, section: int) -> bool:
    if notice.target_all:
        return True
    target_key = _to_notice_target_key(grade, section)
    return target_key in _parse_notice_target_classes(notice.target_classes)


def _notice_created_at_utc(notice: TeacherNotice) -> datetime:
    created_at = notice.created_at or datetime.utcnow()
    if created_at.tzinfo is None:
        return created_at.replace(tzinfo=timezone.utc)
    return created_at.astimezone(timezone.utc)


def _parse_payload_datetime(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _serialize_notice(notice: TeacherNotice, *, now_utc: datetime | None = None) -> dict:
    now = now_utc or datetime.now(timezone.utc)
    created_at = _notice_created_at_utc(notice)
    age_seconds = max(0, int((now - created_at).total_seconds()))
    targets = _parse_notice_target_classes(notice.target_classes)
    target_labels = "전체(모든 반)" if notice.target_all or not targets else ", ".join(targets)
    return {
        "id": notice.id,
        "teacherName": notice.teacher_name,
        "text": notice.text,
        "createdAt": created_at.isoformat(),
        "createdAtMs": int(created_at.timestamp() * 1000),
        "ageSeconds": age_seconds,
        "showGlow": age_seconds <= _NOTICE_FRESH_SECONDS,
        "showDot": _NOTICE_FRESH_SECONDS < age_seconds <= _NOTICE_DOT_SECONDS,
        "targetAll": bool(notice.target_all),
        "targetClasses": targets,
        "targetLabel": target_labels,
    }


def _load_targeted_notices(grade: int, section: int, *, limit: int = 100) -> list[TeacherNotice]:
    key = _to_notice_target_key(grade, section)
    candidates = (
        TeacherNotice.query
        .filter(
            or_(
                TeacherNotice.target_all.is_(True),
                TeacherNotice.target_classes.like(f'%"{key}"%'),
            )
        )
        .order_by(TeacherNotice.created_at.desc(), TeacherNotice.id.desc())
        .limit(max(1, limit))
        .all()
    )
    return [notice for notice in candidates if _notice_matches_class(notice, grade, section)]


def _select_board_notices(notices: list[TeacherNotice]) -> list[TeacherNotice]:
    if not notices:
        return []
    now = datetime.now(timezone.utc)
    recent = [notice for notice in notices if now - _notice_created_at_utc(notice) <= _NOTICE_BURST_WINDOW]
    if len(recent) >= 2:
        return recent
    return [notices[0]]


@blueprint.post("/notices")
def create_teacher_notice():
    if not _teacher_only():
        return jsonify({"error": "forbidden"}), 403
    if not _ensure_notice_tables():
        return jsonify({"error": "notice storage unavailable"}), 503

    payload = request.get_json(silent=True) or {}
    teacher_name = str(payload.get("teacherName") or "").strip()
    text = str(payload.get("text") or "").strip()

    if not teacher_name:
        return jsonify({"error": "teacher name is required"}), 400
    if not text:
        return jsonify({"error": "notice text is required"}), 400
    if len(teacher_name) > 80:
        teacher_name = teacher_name[:80]
    if len(text) > 500:
        text = text[:500]

    target_all, target_classes = _normalize_notice_targets(payload)

    notice = TeacherNotice(
        teacher_name=teacher_name,
        text=text,
        target_all=target_all,
        target_classes=json.dumps(target_classes, ensure_ascii=False),
    )
    db.session.add(notice)
    db.session.commit()

    return jsonify({"ok": True, "notice": _serialize_notice(notice)}), 201


@blueprint.get("/notices")
def get_teacher_notices():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    mode = (request.args.get("mode") or "latest").strip().lower()

    if grade is None or section is None:
        return jsonify({"error": "missing grade/section"}), 400
    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403
    if not _ensure_notice_tables():
        return jsonify(
            {
                "grade": grade,
                "section": section,
                "mode": mode,
                "notices": [],
                "hasUnread": False,
                "unreadCount": 0,
                "latestUnread": None,
            }
        )

    fetch_limit = 500 if mode == "all" else 120
    notices = _load_targeted_notices(grade, section, limit=fetch_limit)
    if mode == "board":
        selected = _select_board_notices(notices)
    elif mode == "all":
        selected = notices
    else:
        selected = notices[:1]

    now = datetime.now(timezone.utc)
    serialized = [_serialize_notice(notice, now_utc=now) for notice in selected]

    session_grade, session_section, session_number = _get_student_session_info()
    unread_count = 0
    latest_unread = None
    if (
        session_number is not None
        and session_grade == grade
        and session_section == section
    ):
        notice_ids = [notice.id for notice in notices]
        if notice_ids:
            read_ids = {
                row.notice_id
                for row in TeacherNoticeRead.query.filter(
                    TeacherNoticeRead.notice_id.in_(notice_ids),
                    TeacherNoticeRead.grade == grade,
                    TeacherNoticeRead.section == section,
                    TeacherNoticeRead.student_number == session_number,
                ).all()
            }
            unread_ids = [notice_id for notice_id in notice_ids if notice_id not in read_ids]
            unread_count = len(unread_ids)
            if unread_ids:
                latest_unread = next((n for n in notices if n.id == unread_ids[0]), None)

    return jsonify(
        {
            "grade": grade,
            "section": section,
            "mode": mode,
            "notices": serialized,
            "hasUnread": unread_count > 0,
            "unreadCount": unread_count,
            "latestUnread": _serialize_notice(latest_unread, now_utc=now) if latest_unread else None,
        }
    )


@blueprint.post("/notices/read")
def mark_teacher_notices_read():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade/section"}), 400

    session_grade, session_section, session_number = _get_student_session_info()
    if (
        session_number is None
        or session_grade != grade
        or session_section != section
    ):
        return jsonify({"error": "forbidden"}), 403
    if not _ensure_notice_tables():
        return jsonify({"error": "notice storage unavailable"}), 503

    payload = request.get_json(silent=True) or {}
    mark_all = bool(payload.get("all"))
    requested_ids = payload.get("noticeIds")
    targeted_notices = _load_targeted_notices(grade, section, limit=500)
    targeted_ids = [notice.id for notice in targeted_notices]

    if mark_all:
        notice_ids = targeted_ids
    elif isinstance(requested_ids, list):
        wanted = {int(nid) for nid in requested_ids if _normalize_class_value(nid) is not None}
        notice_ids = [nid for nid in targeted_ids if nid in wanted]
    else:
        notice_ids = []

    if not notice_ids:
        return jsonify({"ok": True, "marked": 0})

    existing = {
        row.notice_id
        for row in TeacherNoticeRead.query.filter(
            TeacherNoticeRead.notice_id.in_(notice_ids),
            TeacherNoticeRead.grade == grade,
            TeacherNoticeRead.section == section,
            TeacherNoticeRead.student_number == session_number,
        ).all()
    }

    created = 0
    for notice_id in notice_ids:
        if notice_id in existing:
            continue
        db.session.add(
            TeacherNoticeRead(
                notice_id=notice_id,
                grade=grade,
                section=section,
                student_number=session_number,
            )
        )
        created += 1

    if created:
        db.session.commit()

    return jsonify({"ok": True, "marked": created})


@blueprint.post("/state/save")
def save_state():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade/section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    class_config = load_class_config().get((grade, section))
    payload = request.get_json() or {}
    incoming_magnets = payload.get("magnets", {})
    normalized_magnets = {}
    if isinstance(incoming_magnets, dict):
        for key, value in incoming_magnets.items():
            normalized_key = _normalize_magnet_number_key_for_class(key, class_config)
            if normalized_key is None:
                continue
            normalized_magnets[normalized_key] = value

    # Students are allowed to move any magnet within their class;
    # payload is no longer restricted to the student's own number.
    new_magnets = normalized_magnets

    for magnet_data in new_magnets.values():
        if not isinstance(magnet_data, dict):
            continue
        for field in ("reason", "thought"):
            value = magnet_data.get(field)
            if isinstance(value, str) and contains_slang(value):
                return jsonify({"error": "text contains prohibited words"}), 400

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    state_payload = _load_state_payload(state)
    magnets = state_payload.get("magnets", {})
    channels = _normalize_channels(state_payload.get("channels"))
    memberships = _normalize_channel_memberships(state_payload.get("channelMemberships"), channels, grade, section)
    owners = _normalize_channel_owners(state_payload.get("channelOwners"), channels)
    marquee = state_payload.get("marquee")
    wallpaper = state_payload.get("wallpaper")

    # ✅ 기존 + 새로운 데이터 병합
    # Preserve special fields (reaction, thought, etc.) when updating magnet position
    for num, data in new_magnets.items():
        existing = magnets.get(str(num), {})
        # Preserve ephemeral fields that shouldn't be overwritten by position updates
        preserve_fields = ['reaction', 'reactionPostedAt', 'reactionExpiresAt',
                          'thought', 'thoughtPostedAt', 'thoughtExpiresAt']
        for field in preserve_fields:
            if field in existing and field not in data:
                data[field] = existing[field]
        magnets[str(num)] = data   # 같은 번호면 갱신, 없으면 추가

    payload_to_save = {
        "magnets": magnets,
        "channels": channels,
        "channelMemberships": memberships,
        "channelOwners": owners,
        "marquee": marquee,
        "wallpaper": wallpaper,
    }

    if not state:
        state = ClassState(
            grade=grade,
            section=section,
            data=json.dumps(payload_to_save, ensure_ascii=False)
        )
        db.session.add(state)
    else:
        state.data = json.dumps(payload_to_save, ensure_ascii=False)

    db.session.commit()

    _emit_class_state_update(grade, section, state, class_config)

    try:
        broadcast_public_status_update(grade, section)
    except Exception as exc:
        print(f"[PublicAPI] Failed to broadcast status: {exc}")

    return jsonify({"ok": True, "magnets": magnets})


def _normalize_channels(channels_raw) -> list[str]:
    channels = channels_raw if isinstance(channels_raw, list) else []
    normalized: list[str] = []
    seen = set()

    for ch in channels:
        if not isinstance(ch, str):
            continue
        name = ch.strip()
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(name[:30])

    if DEFAULT_CHAT_CHANNEL.casefold() not in seen:
        normalized.insert(0, DEFAULT_CHAT_CHANNEL)
    return normalized


def _normalize_channel_memberships(raw_memberships, channels: list[str], grade: int | None, section: int | None) -> dict[str, list[dict]]:
    memberships = raw_memberships if isinstance(raw_memberships, dict) else {}
    result: dict[str, list[dict]] = {}

    for ch in channels:
        entries = []
        seen = set()
        raw_entries = memberships.get(ch) if isinstance(memberships.get(ch), list) else []
        for entry in raw_entries:
            if not isinstance(entry, dict):
                continue
            g = _normalize_class_value(entry.get("grade"))
            s = _normalize_class_value(entry.get("section"))
            if g is None or s is None:
                continue
            key = f"{g}-{s}"
            if key in seen:
                continue
            seen.add(key)
            entries.append({"grade": g, "section": s})

        if grade is not None and section is not None:
            key = f"{grade}-{section}"
            if key not in seen:
                entries.append({"grade": grade, "section": section})
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


def _load_state_payload(state: ClassState | None) -> dict[str, dict[str, object]]:
    if not state or not state.data:
        return {
            "magnets": {},
            "channels": [DEFAULT_CHAT_CHANNEL],
            "channelMemberships": {DEFAULT_CHAT_CHANNEL: []},
            "channelOwners": {DEFAULT_CHAT_CHANNEL: []},
            "marquee": None,
            "wallpaper": None,
        }

    try:
        raw = json.loads(state.data)
    except json.JSONDecodeError:
        return {
            "magnets": {},
            "channels": [DEFAULT_CHAT_CHANNEL],
            "channelMemberships": {DEFAULT_CHAT_CHANNEL: []},
            "channelOwners": {DEFAULT_CHAT_CHANNEL: []},
            "marquee": None,
            "wallpaper": None,
        }

    if not isinstance(raw, dict):
        return {
            "magnets": {},
            "channels": [DEFAULT_CHAT_CHANNEL],
            "channelMemberships": {DEFAULT_CHAT_CHANNEL: []},
            "channelOwners": {DEFAULT_CHAT_CHANNEL: []},
            "marquee": None,
            "wallpaper": None,
        }

    raw_magnets = raw.get("magnets")
    magnets: dict[str, dict[str, object]] = {}
    if isinstance(raw_magnets, dict):
        for num, value in raw_magnets.items():
            normalized_key = _normalize_magnet_number_key(num)
            if normalized_key is None or not isinstance(value, dict):
                continue
            magnets[normalized_key] = value

    channels = _normalize_channels(raw.get("channels"))
    memberships = _normalize_channel_memberships(
        raw.get("channelMemberships"),
        channels,
        getattr(state, "grade", None),
        getattr(state, "section", None)
    )
    owners = _normalize_channel_owners(raw.get("channelOwners"), channels)
    marquee = raw.get("marquee")
    if isinstance(marquee, dict):
        text = str(marquee.get("text") or "").strip()
        if not text:
            marquee = None
        else:
            color = str(marquee.get("color") or "#fdfcff").strip()
            if not color.startswith("#") or len(color) not in {4, 5, 7, 9}:
                color = "#fdfcff"
            updated_at = (
                marquee.get("updatedAt")
                or marquee.get("updated_at")
                or marquee.get("postedAt")
            )
            updated_at_dt = _parse_payload_datetime(updated_at)
            if not updated_at_dt or datetime.now(timezone.utc) - updated_at_dt > _MARQUEE_MAX_AGE:
                marquee = None
            else:
                marquee = {
                    "text": text[:20],
                    "color": color,
                    "updatedAt": updated_at_dt.isoformat(),
                }
    else:
        marquee = None

    wallpaper = _normalize_wallpaper_payload(raw.get("wallpaper"))

    return {
        "magnets": magnets,
        "channels": channels,
        "channelMemberships": memberships,
        "channelOwners": owners,
        "marquee": marquee,
        "wallpaper": wallpaper,
    }


@blueprint.post("/thought")
def upsert_thought():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    session_grade, session_section, session_number = _get_student_session_info()
    is_teacher = is_teacher_session_active()

    # For students, use their own number; for teachers, require number parameter
    if is_teacher:
        target_number = request.args.get("number", type=int)
        if target_number is None:
            return jsonify({"error": "missing target number"}), 400
    else:
        # Student must be from the same class
        if session_grade != grade or session_section != section or session_number is None:
            return jsonify({"error": "forbidden"}), 403
        target_number = session_number

    payload = request.get_json(silent=True) or {}
    thought_text = (payload.get("thought") or "").strip()
    duration_value = payload.get("duration")
    try:
        duration_seconds = int(duration_value)
    except (TypeError, ValueError):
        duration_seconds = 5
    duration_seconds = max(1, min(duration_seconds, 60))
    target_raw = payload.get("target") or ""
    target = target_raw.lower().strip() if isinstance(target_raw, str) else ""
    skip_chat_raw = payload.get("skipChat")
    skip_chat_log = False
    if isinstance(skip_chat_raw, bool):
        skip_chat_log = skip_chat_raw
    elif isinstance(skip_chat_raw, (int, float)):
        skip_chat_log = bool(skip_chat_raw)
    elif isinstance(skip_chat_raw, str):
        skip_chat_log = skip_chat_raw.lower() in ("true", "1", "yes", "y", "on")
    elif target in ("board", "board-only", "board_only"):
        skip_chat_log = True
    if is_teacher:
        skip_chat_log = True

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    created_state = False
    if not state:
        state = ClassState(
            grade=grade,
            section=section,
            data=json.dumps(
                {
                    "magnets": {},
                    "channels": [DEFAULT_CHAT_CHANNEL],
                    "channelMemberships": {DEFAULT_CHAT_CHANNEL: [{"grade": grade, "section": section}]},
                    "channelOwners": {DEFAULT_CHAT_CHANNEL: []},
                    "marquee": None,
                },
                ensure_ascii=False,
            )
        )
        db.session.add(state)
        created_state = True

    state_payload = _load_state_payload(state)
    magnets = state_payload["magnets"]
    channels = _normalize_channels(state_payload.get("channels"))
    memberships = _normalize_channel_memberships(state_payload.get("channelMemberships"), channels, grade, section)
    owners = _normalize_channel_owners(state_payload.get("channelOwners"), channels)
    key = str(target_number)
    current = magnets.get(key)
    if not isinstance(current, dict):
        current = {}

    now = datetime.now(timezone.utc)
    response_payload: dict[str, object] = {"ok": True, "number": target_number}

    if thought_text:
        max_length = 140
        if len(thought_text) > max_length:
            thought_text = thought_text[:max_length]

        posted_at = now.isoformat()
        expires_at = (now + timedelta(seconds=duration_seconds)).isoformat()
        current.update({
            "thought": thought_text,
            "thoughtPostedAt": posted_at,
            "thoughtExpiresAt": expires_at,
        })
        response_payload.update({
            "thought": thought_text,
            "thoughtExpiresAt": expires_at,
            "thoughtPostedAt": posted_at,
        })
    else:
        for field in ("thought", "thoughtPostedAt", "thoughtExpiresAt"):
            current.pop(field, None)
        response_payload["thought"] = None

    magnets[key] = current
    state.data = json.dumps(
        {
            "magnets": magnets,
            "channels": channels,
            "channelMemberships": memberships,
            "channelOwners": owners,
            "marquee": state_payload.get("marquee"),
        },
        ensure_ascii=False,
    )

    # Also save to ChatMessage table for persistent chat
    if thought_text and not skip_chat_log:
        consent = ChatConsent.query.filter_by(
            grade=grade,
            section=section,
            student_number=target_number,
        ).first()
        if not consent or consent.version != "v1":
            return jsonify({"error": "chat consent required", "requiredVersion": "v1"}), 403
        chat_message = ChatMessage(
            grade=grade,
            section=section,
            channel=DEFAULT_CHAT_CHANNEL,
            student_number=target_number,
            message=thought_text
        )
        db.session.add(chat_message)

    db.session.commit()

    if created_state:
        response_payload["created"] = True

    _emit_class_state_update(grade, section, state)

    return jsonify(response_payload)

@blueprint.get("/state/load")
def load_class_state():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    if not state:
        return jsonify({"magnets": {}, "marquee": None, "wallpaper": None})

    try:
        class_config = load_class_config().get((grade, section))
        magnets, marquee, wallpaper = _filtered_magnets_for_class(state, grade, section, class_config)
        return jsonify({"magnets": magnets, "marquee": marquee, "wallpaper": wallpaper})
    except json.JSONDecodeError:
        return jsonify({"magnets": {}, "marquee": None, "wallpaper": None})


@blueprint.get("/grade-state")
def load_grade_state():
    grade = request.args.get("grade", type=int)
    if grade is None:
        return jsonify({"error": "grade required"}), 400
    if not _teacher_only():
        return jsonify({"error": "forbidden"}), 403

    class_configs = load_class_config()
    states_by_section = {
        state.section: state
        for state in ClassState.query.filter_by(grade=grade).all()
    }
    sections = [
        _serialize_grade_state_section(
            grade,
            section,
            states_by_section.get(section),
            class_configs.get((grade, section)),
        )
        for section in range(1, 7)
    ]
    return jsonify({"grade": grade, "sections": sections})


@blueprint.get("/wallpaper")
def get_class_wallpaper():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade/section"}), 400
    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    payload = _load_state_payload(state)
    return jsonify({
        "grade": grade,
        "section": section,
        "wallpaper": payload.get("wallpaper"),
    })


@blueprint.post("/wallpaper")
def set_class_wallpaper():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade/section"}), 400
    if not _teacher_or_board_only(grade, section):
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json(silent=True) or {}
    wallpaper = _normalize_wallpaper_payload(payload.get("wallpaper") or payload)
    if wallpaper is None:
        return jsonify({"error": "invalid wallpaper"}), 400

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    if not state:
        state = ClassState(
            grade=grade,
            section=section,
            data=json.dumps(
                {
                    "magnets": {},
                    "channels": [DEFAULT_CHAT_CHANNEL],
                    "channelMemberships": {DEFAULT_CHAT_CHANNEL: [{"grade": grade, "section": section}]},
                    "channelOwners": {DEFAULT_CHAT_CHANNEL: []},
                    "marquee": None,
                    "wallpaper": None,
                },
                ensure_ascii=False,
            ),
        )
        db.session.add(state)

    state_payload = _load_state_payload(state)
    state_payload["wallpaper"] = wallpaper
    state.data = json.dumps(state_payload, ensure_ascii=False)
    db.session.commit()

    _emit_class_state_update(grade, section, state)
    return jsonify({"ok": True, "wallpaper": wallpaper})


@blueprint.post("/marquee")
def set_marquee():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json(silent=True) or {}
    raw_text = payload.get("text") or payload.get("message") or ""
    text = str(raw_text).strip()
    if len(text) > 20:
        text = text[:20]

    if text and contains_slang(text):
        return jsonify({"error": "marquee contains prohibited words"}), 400

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    if not state:
        state = ClassState(
            grade=grade,
            section=section,
            data=json.dumps(
                {
                    "magnets": {},
                    "channels": [DEFAULT_CHAT_CHANNEL],
                    "channelMemberships": {DEFAULT_CHAT_CHANNEL: [{"grade": grade, "section": section}]},
                    "channelOwners": {DEFAULT_CHAT_CHANNEL: []},
                    "marquee": None,
                },
                ensure_ascii=False,
            ),
        )
        db.session.add(state)

    state_payload = _load_state_payload(state)
    marquee_payload = None
    if text:
        color_raw = str(payload.get("color") or payload.get("colour") or "#fdfcff").strip()
        color = color_raw if color_raw.startswith("#") and len(color_raw) in {4, 5, 7, 9} else "#fdfcff"
        marquee_payload = {
            "text": text,
            "color": color,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
    state_payload["marquee"] = marquee_payload
    state.data = json.dumps(state_payload, ensure_ascii=False)
    db.session.commit()

    _emit_class_state_update(grade, section, state)

    return jsonify({"ok": True, "marquee": marquee_payload})


@blueprint.get("/routine")
def get_routine():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    routine = ClassRoutine.query.filter_by(grade=grade, section=section).first()
    if not routine:
        # 빈 구조 반환
        return jsonify({"afterschool": {}, "changdong": {}})

    return jsonify(routine.to_dict())


def _normalize_participant_map(data):
    allowed = ["Mon", "Tue", "Wed", "Thu", "Fri"]
    if not isinstance(data, dict):
        if isinstance(data, list):
            # 레거시: 요일 리스트만 내려온 경우 → 빈 배열 매핑
            data = {day: [] for day in data if day in allowed}
        else:
            return {}

    normalized = {}
    for day, numbers in data.items():
        if day not in allowed:
            continue
        items = numbers if isinstance(numbers, (list, tuple)) else [numbers]
        cleaned = []
        for item in items:
            try:
                value = int(item)
            except (TypeError, ValueError):
                continue
            if 1 <= value <= 99 and value not in cleaned:
                cleaned.append(value)
        if cleaned:
            normalized[day] = sorted(cleaned)

    return normalized


ALLOWED_ROUTINE_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]


@blueprint.post("/routine")
def save_routine():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json(silent=True) or {}
    afterschool = payload.get("afterschool") or {}
    changdong = payload.get("changdong") or {}

    afterschool_map = _normalize_participant_map(afterschool)
    changdong_map = _normalize_participant_map(changdong)

    routine = ClassRoutine.query.filter_by(grade=grade, section=section).first()
    if not routine:
        routine = ClassRoutine(grade=grade, section=section)
        db.session.add(routine)

    is_teacher = _teacher_only()
    is_board = is_board_session_active(grade, section)

    if is_teacher or is_board:
        routine.set_afterschool_map(afterschool_map)
        routine.set_changdong_map(changdong_map)
    else:
        session_grade, session_section, session_number = _get_student_session_info()
        if (
            session_grade != grade
            or session_section != section
            or session_number is None
        ):
            return jsonify({"error": "forbidden"}), 403

        existing_afterschool = routine.get_afterschool_map()
        existing_changdong = routine.get_changdong_map()

        updated_afterschool = {
            day: list(numbers) for day, numbers in existing_afterschool.items()
        }

        requested_afterschool_days = {
            day
            for day, numbers in afterschool_map.items()
            if session_number in numbers
        }

        for day in ALLOWED_ROUTINE_DAYS:
            members = list(updated_afterschool.get(day, []))
            if day in requested_afterschool_days:
                if session_number not in members:
                    members.append(session_number)
                members.sort()
                updated_afterschool[day] = members
            else:
                if session_number in members:
                    members = [num for num in members if num != session_number]
                    if members:
                        updated_afterschool[day] = members
                    else:
                        updated_afterschool.pop(day, None)

        updated_changdong = {
            day: list(numbers) for day, numbers in existing_changdong.items()
        }

        requested_changdong_days = [
            day
            for day, numbers in changdong_map.items()
            if session_number in numbers
        ]

        selected_changdong_day = requested_changdong_days[0] if requested_changdong_days else None

        for day in list(updated_changdong.keys()):
            members = [num for num in updated_changdong[day] if num != session_number]
            if members:
                updated_changdong[day] = members
            else:
                updated_changdong.pop(day)

        if selected_changdong_day is not None and selected_changdong_day in ALLOWED_ROUTINE_DAYS:
            members = updated_changdong.get(selected_changdong_day, [])
            if session_number not in members:
                members.append(session_number)
            members.sort()
            updated_changdong[selected_changdong_day] = members

        routine.set_afterschool_map(updated_afterschool)
        routine.set_changdong_map(updated_changdong)

    db.session.commit()

    return jsonify(routine.to_dict())

@blueprint.post("/reaction")
def send_reaction():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    session_grade, session_section, session_number = _get_student_session_info()
    is_teacher = is_teacher_session_active()

    # Only students can send reactions (not teachers)
    if is_teacher:
        return jsonify({"error": "teachers cannot send reactions"}), 403

    # Student must be from the same class
    if session_grade != grade or session_section != section or session_number is None:
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json(silent=True) or {}
    emoji = (payload.get("emoji") or "").strip()

    # Validate emoji
    allowed_emojis = [
        "❤️", "😂", "😮", "😢", "🔥", "👍", "👏", "🎉", "🤩", "🥳", "😎", "💯",
        "❄️", "🎄", "🎅", "🧦"
    ]
    if not emoji or emoji not in allowed_emojis:
        return jsonify({"error": "invalid emoji"}), 400

    # Get or create ClassState
    state = ClassState.query.filter_by(grade=grade, section=section).first()
    if not state:
        state = ClassState(
            grade=grade,
            section=section,
            data=json.dumps(
                {
                    "magnets": {},
                    "channels": [DEFAULT_CHAT_CHANNEL],
                    "channelMemberships": {DEFAULT_CHAT_CHANNEL: [{"grade": grade, "section": section}]},
                    "channelOwners": {DEFAULT_CHAT_CHANNEL: []},
                    "marquee": None,
                },
                ensure_ascii=False,
            )
        )
        db.session.add(state)

    # Load existing state
    state_payload = _load_state_payload(state)
    magnets = state_payload["magnets"]
    channels = _normalize_channels(state_payload.get("channels"))
    memberships = _normalize_channel_memberships(state_payload.get("channelMemberships"), channels, grade, section)
    owners = _normalize_channel_owners(state_payload.get("channelOwners"), channels)
    key = str(session_number)
    current = magnets.get(key)
    if not isinstance(current, dict):
        current = {}

    # Set reaction with 5-second expiry
    now = datetime.now(timezone.utc)
    posted_at = now.isoformat()
    expires_at = (now + timedelta(seconds=5)).isoformat()

    current.update({
        "reaction": emoji,
        "reactionPostedAt": posted_at,
        "reactionExpiresAt": expires_at,
    })

    magnets[key] = current
    state.data = json.dumps(
        {
            "magnets": magnets,
            "channels": channels,
            "channelMemberships": memberships,
            "channelOwners": owners,
            "marquee": state_payload.get("marquee"),
        },
        ensure_ascii=False,
    )

    db.session.commit()

    _emit_class_state_update(grade, section, state)

    return jsonify({
        "ok": True,
        "number": session_number,
        "reaction": emoji,
        "reactionPostedAt": posted_at,
        "reactionExpiresAt": expires_at,
    })


@blueprint.get("/config")
def class_config():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    if grade is None or section is None:
        return jsonify({"error": "grade and section required"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    config = load_class_config().get((grade, section))

    if not config:
        config = {"end": 30, "skip_numbers": [], "chat_enabled": False}

    return jsonify({
        "end": config["end"],
        "skipNumbers": config["skip_numbers"],
        "chatEnabled": bool(config.get("chat_enabled")),
    })
# ----------------- Global caching for schoollife data -----------------
_SCHOOLLIFE_CACHE = {
    "weather": {"data": None, "timestamp": None},
    "meal": {"data": None, "timestamp": None},
    "timetable": {},  # keyed by (grade, section)
}

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_MEAL_DISK_CACHE_PATH = os.path.join(_BASE_DIR, "instance", "schoollife_meal_cache.json")

def _get_kst():
    """Get KST timezone (UTC+9)"""
    return timezone(timedelta(hours=9))

def _is_same_day(ts1: datetime | None, ts2: datetime | None) -> bool:
    if not ts1 or not ts2:
        return False
    # Convert to KST for comparison
    kst = _get_kst()
    ts1_kst = ts1.astimezone(kst) if ts1.tzinfo else ts1.replace(tzinfo=timezone.utc).astimezone(kst)
    ts2_kst = ts2.astimezone(kst) if ts2.tzinfo else ts2.replace(tzinfo=timezone.utc).astimezone(kst)
    return ts1_kst.strftime('%Y%m%d') == ts2_kst.strftime('%Y%m%d')

def _get_today_start() -> datetime:
    # Use KST (UTC+9) for Korea
    kst = _get_kst()
    now = datetime.now(kst)
    return datetime(now.year, now.month, now.day, tzinfo=kst)

def _fetch_weather_from_api():
    # Placeholder: replace with actual weather API
    # Using open-meteo sample to avoid secrets
    params = {
        "latitude": 37.3405,
        "longitude": 126.7338,
        "current_weather": True,
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        "timezone": "Asia/Seoul"
    }
    res = requests.get("https://api.open-meteo.com/v1/forecast", params=params, timeout=5)
    res.raise_for_status()
    data = res.json()
    current = data.get("current_weather", {})
    daily = data.get("daily", {})
    weather = {
        "temperature": current.get("temperature"),
        "desc": f"{current.get('weathercode','')}",
        "high": daily.get("temperature_2m_max", [None])[0],
        "low": daily.get("temperature_2m_min", [None])[0],
        "rain": daily.get("precipitation_probability_max", [None])[0],
    }
    return weather

def _fetch_meal_from_api():
    now_kst = datetime.now(_get_kst())
    today = now_kst.strftime('%Y-%m-%d')
    base_url = str(config.MEAL_API_BASE_URL or "https://api.xn--rh3b.net").rstrip("/")
    url = f"{base_url}/{today}"

    res = requests.get(
        url,
        timeout=12,
        headers={"Accept": "application/json"},
    )
    res.raise_for_status()
    payload = res.json()

    def normalize_meal_items(value):
        if not isinstance(value, dict):
            return []
        merged = []
        for key in ("regular", "simple"):
            raw_items = value.get(key)
            if not isinstance(raw_items, list):
                continue
            for item in raw_items:
                text = str(item).strip()
                if text:
                    merged.append(text)
        # keep order while removing duplicates
        return list(dict.fromkeys(merged))

    data = payload.get("data") if isinstance(payload, dict) else {}
    breakfast_items = normalize_meal_items(data.get("breakfast") if isinstance(data, dict) else None)
    lunch_items = normalize_meal_items(data.get("lunch") if isinstance(data, dict) else None)
    dinner_items = normalize_meal_items(data.get("dinner") if isinstance(data, dict) else None)

    date_value = payload.get("date") if isinstance(payload, dict) else None
    date_text = str(date_value).strip() if date_value else today

    return {
        "breakfast": "\n".join(breakfast_items) if breakfast_items else None,
        "lunch": "\n".join(lunch_items) if lunch_items else None,
        "dinner": "\n".join(dinner_items) if dinner_items else None,
        "date": date_text,
    }


def _read_meal_disk_cache():
    try:
        with open(_MEAL_DISK_CACHE_PATH, "r", encoding="utf-8") as f:
            payload = json.load(f)
        if not isinstance(payload, dict):
            return None
        if not isinstance(payload.get("date"), str):
            return None
        if not isinstance(payload.get("data"), dict):
            return None
        return payload
    except (OSError, ValueError, TypeError):
        return None


def _write_meal_disk_cache(date_text: str, data: dict):
    try:
        os.makedirs(os.path.dirname(_MEAL_DISK_CACHE_PATH), exist_ok=True)
        temp_path = f"{_MEAL_DISK_CACHE_PATH}.tmp"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "date": date_text,
                    "savedAt": datetime.now(_get_kst()).isoformat(),
                    "data": data,
                },
                f,
                ensure_ascii=False,
            )
        os.replace(temp_path, _MEAL_DISK_CACHE_PATH)
    except OSError:
        # Non-fatal: memory cache still works.
        pass

def _fetch_timetable_from_api(grade: int, section: int):
    # Use KST for Korea
    print(f"[TIMETABLE] Creating KST timezone...")
    kst = _get_kst()
    print(f"[TIMETABLE] KST timezone created: {kst}")
    now_kst = datetime.now(kst)
    print(f"[TIMETABLE] Current KST time: {now_kst}")
    today = now_kst.strftime('%Y%m%d')
    print(f"[TIMETABLE] Today string: {today}")
    params = {
        "Type": "json",
        "ATPT_OFCDC_SC_CODE": "J10",
        "SD_SCHUL_CODE": "7530560",
        "GRADE": grade,
        "CLASS_NM": section,
        "ALL_TI_YMD": today,
    }
    if config.NEIS_API_KEY:
        params["KEY"] = config.NEIS_API_KEY
    print(f"[TIMETABLE] Making request to NEIS API with params: {params}")
    res = requests.get("https://open.neis.go.kr/hub/hisTimetable", params=params, timeout=15)
    res.raise_for_status()
    data = res.json()
    lessons = []
    try:
        rows = data['hisTimetable'][1]['row']
        for row in rows:
            period = row.get('PERIO') or row.get('PERIOD') or row.get('ITRT_CNTNTSEQ')
            subject = row.get('ITRT_CNTNT') or row.get('SUBJECT') or row.get('SUB_NM')
            if not subject:
                continue
            lessons.append({
                "period": period,
                "subject": subject
            })
    except Exception:
        pass
    return lessons


@blueprint.get('/schoollife/weather')
def get_schoollife_weather():
    now = datetime.now(_get_kst())
    cache_entry = _SCHOOLLIFE_CACHE["weather"]
    if cache_entry["data"] and _is_same_day(cache_entry["timestamp"], now):
        return jsonify(cache_entry["data"])

    try:
        data = _fetch_weather_from_api()
        cache_entry["data"] = data
        cache_entry["timestamp"] = now
    except Exception as e:
        if cache_entry["data"]:
            return jsonify(cache_entry["data"])
        return jsonify({"error": str(e)}), 500

    return jsonify(data)


@blueprint.get('/schoollife/meal')
def get_schoollife_meal():
    now = datetime.now(_get_kst())
    today = now.strftime("%Y-%m-%d")
    cache_entry = _SCHOOLLIFE_CACHE["meal"]
    if cache_entry["data"] and _is_same_day(cache_entry["timestamp"], now):
        return jsonify(cache_entry["data"])

    disk_cache = _read_meal_disk_cache()
    if disk_cache and disk_cache.get("date") == today:
        data = disk_cache.get("data")
        cache_entry["data"] = data
        cache_entry["timestamp"] = now
        return jsonify(data)

    try:
        data = _fetch_meal_from_api()
        cache_entry["data"] = data
        cache_entry["timestamp"] = now
        _write_meal_disk_cache(today, data)
        return jsonify(data)
    except Exception as e:
        if cache_entry["data"]:
            return jsonify(cache_entry["data"])
        if disk_cache and isinstance(disk_cache.get("data"), dict):
            return jsonify(disk_cache.get("data"))
        return jsonify({"error": "meal_fetch_failed", "message": str(e)}), 502


@blueprint.get('/schoollife/timetable')
def get_schoollife_timetable():
    import traceback
    try:
        grade = request.args.get('grade', type=int)
        section = request.args.get('section', type=int)
        if not grade or not section:
            return jsonify({"error": "missing grade or section"}), 400

        now = datetime.now(_get_kst())
        print(f"[TIMETABLE] KST now: {now}, grade: {grade}, section: {section}")
        key = (grade, section)
        cache_entry = _SCHOOLLIFE_CACHE["timetable"].get(key)
        if cache_entry and _is_same_day(cache_entry["timestamp"], now):
            return jsonify(cache_entry["data"])

        try:
            lessons = _fetch_timetable_from_api(grade, section)
            payload = {
                "lessons": lessons,
                "date": datetime.now(_get_kst()).strftime('%Y-%m-%d')
            }
            if not lessons:
                payload["message"] = "오늘 등록된 시간표가 없습니다."
            _SCHOOLLIFE_CACHE["timetable"][key] = {
                "data": payload,
                "timestamp": now
            }
        except Exception as e:
            print(f"[TIMETABLE] API fetch error: {e}")
            print(f"[TIMETABLE] Traceback: {traceback.format_exc()}")
            if cache_entry:
                return jsonify(cache_entry["data"])
            return jsonify({"error": str(e)}), 500

        return jsonify(payload)
    except Exception as e:
        print(f"[TIMETABLE] Endpoint error: {e}")
        print(f"[TIMETABLE] Full traceback: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 500


# ==================== Meal Vote APIs ====================
@blueprint.post('/schoollife/meal/vote')
def vote_meal():
    """Vote on today's meal (thumbs up or down)"""
    grade = request.args.get('grade', type=int)
    section = request.args.get('section', type=int)

    if not grade or not section:
        return jsonify({"error": "missing grade or section"}), 400

    session_grade, session_section, session_number = _get_student_session_info()

    # Only students from the same class can vote
    if session_grade != grade or session_section != section or session_number is None:
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json() or {}
    is_positive = payload.get('isPositive')

    if is_positive is None:
        return jsonify({"error": "isPositive required"}), 400

    # Use KST for Korea
    kst = _get_kst()
    today = datetime.now(kst).date()

    # Check if already voted today
    existing_vote = MealVote.query.filter_by(
        grade=grade,
        section=section,
        student_number=session_number,
        date=today
    ).first()

    if existing_vote:
        # Update existing vote
        existing_vote.is_positive = bool(is_positive)
    else:
        # Create new vote
        new_vote = MealVote(
            grade=grade,
            section=section,
            student_number=session_number,
            date=today,
            is_positive=bool(is_positive)
        )
        db.session.add(new_vote)

    db.session.commit()

    return jsonify({"ok": True})


@blueprint.get('/schoollife/meal/stats')
def get_meal_stats():
    """Get meal vote statistics for today"""
    grade = request.args.get('grade', type=int)
    section = request.args.get('section', type=int)

    if not grade or not section:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    # Use KST for Korea
    kst = _get_kst()
    today = datetime.now(kst).date()

    # Get all votes for today
    votes = MealVote.query.filter_by(
        grade=grade,
        section=section,
        date=today
    ).all()

    positive_count = sum(1 for v in votes if v.is_positive)
    total_count = len(votes)

    percentage = round((positive_count / total_count * 100)) if total_count > 0 else 0

    # Check if current student voted
    session_grade, session_section, session_number = _get_student_session_info()
    my_vote = None
    if session_number is not None:
        my_vote_record = MealVote.query.filter_by(
            grade=grade,
            section=section,
            student_number=session_number,
            date=today
        ).first()
        if my_vote_record:
            my_vote = my_vote_record.is_positive

    return jsonify({
        "positiveCount": positive_count,
        "totalCount": total_count,
        "percentage": percentage,
        "myVote": my_vote
    })


# ==================== Calendar APIs ====================
@blueprint.get('/calendar/events')
def get_calendar_events():
    """Get calendar events for a class"""
    grade = request.args.get('grade', type=int)
    section = request.args.get('section', type=int)
    month = request.args.get('month', type=int)  # Optional: filter by month (1-12)
    year = request.args.get('year', type=int)  # Optional: filter by year

    if not grade or not section:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    query = CalendarEvent.query.filter_by(grade=grade, section=section)

    # Filter by month/year if provided
    if month and year:
        from calendar import monthrange
        _, last_day = monthrange(year, month)
        start_date = datetime(year, month, 1).date()
        end_date = datetime(year, month, last_day).date()
        query = query.filter(CalendarEvent.event_date >= start_date, CalendarEvent.event_date <= end_date)

    events = query.order_by(CalendarEvent.event_date).all()

    result = []
    for event in events:
        result.append({
            "id": event.id,
            "title": event.title,
            "description": event.description,
            "date": event.event_date.isoformat(),
            "createdBy": event.created_by,
            "createdAt": event.created_at.isoformat(),
            "updatedAt": event.updated_at.isoformat()
        })

    return jsonify({"events": result})


@blueprint.post('/calendar/events')
def create_calendar_event():
    """Create a new calendar event"""
    grade = request.args.get('grade', type=int)
    section = request.args.get('section', type=int)

    if not grade or not section:
        return jsonify({"error": "missing grade or section"}), 400

    session_grade, session_section, session_number = _get_student_session_info()
    is_teacher = is_teacher_session_active()
    is_board = is_board_session_active(grade, section)

    # Students can only create events for their own class
    if not is_teacher and not is_board:
        if session_grade != grade or session_section != section or session_number is None:
            return jsonify({"error": "forbidden"}), 403

    payload = request.get_json() or {}
    title = (payload.get('title') or '').strip()
    description = (payload.get('description') or '').strip()
    event_date_str = payload.get('date')

    if not title:
        return jsonify({"error": "title required"}), 400

    if not event_date_str:
        return jsonify({"error": "date required"}), 400

    # Parse date
    try:
        event_date = datetime.fromisoformat(event_date_str.replace('Z', '+00:00')).date()
    except (ValueError, AttributeError):
        return jsonify({"error": "invalid date format"}), 400

    created_by = session_number if session_number is not None else 0

    new_event = CalendarEvent(
        grade=grade,
        section=section,
        title=title,
        description=description,
        event_date=event_date,
        created_by=created_by
    )

    db.session.add(new_event)
    db.session.commit()

    return jsonify({
        "ok": True,
        "event": {
            "id": new_event.id,
            "title": new_event.title,
            "description": new_event.description,
            "date": new_event.event_date.isoformat(),
            "createdBy": new_event.created_by,
            "createdAt": new_event.created_at.isoformat()
        }
    })


@blueprint.put('/calendar/events/<int:event_id>')
def update_calendar_event(event_id):
    """Update an existing calendar event"""
    event = CalendarEvent.query.get(event_id)

    if not event:
        return jsonify({"error": "event not found"}), 404

    session_grade, session_section, session_number = _get_student_session_info()
    is_teacher = is_teacher_session_active()
    is_board = is_board_session_active(event.grade, event.section)

    # Only the creator, teacher, or board can edit
    if not is_teacher and not is_board:
        if (
            session_grade != event.grade
            or session_section != event.section
            or session_number != event.created_by
        ):
            return jsonify({"error": "forbidden"}), 403

    payload = request.get_json() or {}

    if 'title' in payload:
        title = (payload['title'] or '').strip()
        if not title:
            return jsonify({"error": "title cannot be empty"}), 400
        event.title = title

    if 'description' in payload:
        event.description = (payload['description'] or '').strip()

    if 'date' in payload:
        try:
            event.event_date = datetime.fromisoformat(payload['date'].replace('Z', '+00:00')).date()
        except (ValueError, AttributeError):
            return jsonify({"error": "invalid date format"}), 400

    db.session.commit()

    return jsonify({
        "ok": True,
        "event": {
            "id": event.id,
            "title": event.title,
            "description": event.description,
            "date": event.event_date.isoformat(),
            "createdBy": event.created_by,
            "updatedAt": event.updated_at.isoformat()
        }
    })


@blueprint.delete('/calendar/events/<int:event_id>')
def delete_calendar_event(event_id):
    """Delete a calendar event"""
    event = CalendarEvent.query.get(event_id)

    if not event:
        return jsonify({"error": "event not found"}), 404

    session_grade, session_section, session_number = _get_student_session_info()
    is_teacher = is_teacher_session_active()
    is_board = is_board_session_active(event.grade, event.section)

    # Only the creator, teacher, or board can delete
    if not is_teacher and not is_board:
        if (
            session_grade != event.grade
            or session_section != event.section
            or session_number != event.created_by
        ):
            return jsonify({"error": "forbidden"}), 403

    db.session.delete(event)
    db.session.commit()

    return jsonify({"ok": True})
