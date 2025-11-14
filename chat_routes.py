from __future__ import annotations

from datetime import datetime, timezone, timedelta

from flask import Blueprint, jsonify, request, session

from extensions import db
from models import ChatMessage, UserNickname
from utils import is_board_session_active, is_teacher_session_active
import re

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
        ChatMessage.created_at >= today_start_utc,
        ChatMessage.deleted_at == None  # Filter out deleted messages
    ).order_by(ChatMessage.created_at.asc()).all()

    return jsonify({
        "messages": [
            {
                "id": msg.id,
                "studentNumber": msg.student_number,
                "message": msg.message,
                "timestamp": msg.created_at.isoformat(),
                "imageUrl": msg.image_url,
                "replyToId": msg.reply_to_id,
                "nickname": msg.nickname
            }
            for msg in messages
        ]
    })


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
    message_text = (payload.get("message") or "").strip()
    image_url = (payload.get("imageUrl") or "").strip()
    reply_to_id = payload.get("replyToId")

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
        student_number=session_number,
        message=message_text if message_text else None,
        image_url=image_url if image_url else None,
        reply_to_id=reply_to_id,
        nickname=current_nickname
    )

    db.session.add(new_message)
    db.session.commit()

    return jsonify({
        "ok": True,
        "message": {
            "id": new_message.id,
            "studentNumber": new_message.student_number,
            "message": new_message.message,
            "timestamp": new_message.created_at.isoformat(),
            "imageUrl": new_message.image_url,
            "replyToId": new_message.reply_to_id,
            "nickname": new_message.nickname
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
