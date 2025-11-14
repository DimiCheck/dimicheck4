from __future__ import annotations

from datetime import datetime, timezone, timedelta

from flask import Blueprint, jsonify, request, session

from extensions import db
from models import ChatMessage
from utils import is_board_session_active, is_teacher_session_active

blueprint = Blueprint("chat", __name__, url_prefix="/api/classes/chat")


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


@blueprint.get("/today")
def get_today_messages():
    """Get today's chat messages for a specific class"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    # Get messages from today (UTC, DB stores in UTC)
    now_utc = datetime.utcnow()
    # Calculate KST today start in UTC (KST is UTC+9, so subtract 9 hours)
    kst_now = now_utc + timedelta(hours=9)
    today_start_kst = datetime(kst_now.year, kst_now.month, kst_now.day, 0, 0, 0)
    today_start_utc = today_start_kst - timedelta(hours=9)

    messages = ChatMessage.query.filter(
        ChatMessage.grade == grade,
        ChatMessage.section == section,
        ChatMessage.created_at >= today_start_utc
    ).order_by(ChatMessage.created_at.asc()).all()

    return jsonify({
        "messages": [
            {
                "id": msg.id,
                "studentNumber": msg.student_number,
                "message": msg.message,
                "timestamp": msg.created_at.isoformat()
            }
            for msg in messages
        ]
    })


@blueprint.post("/send")
def send_message():
    """Send a chat message"""
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    session_grade, session_section, session_number = _get_student_session_info()

    # Only students from the same class can send messages
    if session_grade != grade or session_section != section or session_number is None:
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json() or {}
    message_text = (payload.get("message") or "").strip()

    if not message_text:
        return jsonify({"error": "message is required"}), 400

    # Limit message length
    max_length = 500
    if len(message_text) > max_length:
        message_text = message_text[:max_length]

    new_message = ChatMessage(
        grade=grade,
        section=section,
        student_number=session_number,
        message=message_text
    )

    db.session.add(new_message)
    db.session.commit()

    return jsonify({
        "ok": True,
        "message": {
            "id": new_message.id,
            "studentNumber": new_message.student_number,
            "message": new_message.message,
            "timestamp": new_message.created_at.isoformat()
        }
    })
