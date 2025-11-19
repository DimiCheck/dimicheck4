from __future__ import annotations

from datetime import datetime, timezone, timedelta
import json

from flask import Blueprint, jsonify, request, session

from extensions import db
from models import ChatMessage, UserNickname, ClassState, ChatReaction, UserAvatar, ClassEmoji
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


def _load_state_blob(state: ClassState | None) -> dict:
    if not state or not state.data:
        return {"magnets": {}}
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
    return data


def _ensure_class_state(grade: int, section: int) -> tuple[ClassState, dict]:
    state = ClassState.query.filter_by(grade=grade, section=section).first()
    if not state:
        state = ClassState(grade=grade, section=section, data=json.dumps({"magnets": {}}))
        db.session.add(state)
        return state, {"magnets": {}}
    return state, _load_state_blob(state)


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

    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    # Get messages from current academic year start (UTC)
    today_start_utc = _academic_year_start_utc()

    messages = ChatMessage.query.filter(
        ChatMessage.grade == grade,
        ChatMessage.section == section,
        ChatMessage.created_at >= today_start_utc,
        ChatMessage.deleted_at == None  # Filter out deleted messages
    ).order_by(ChatMessage.created_at.asc()).all()

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

    return jsonify({
        "messages": [
            {
                "id": msg.id,
                "studentNumber": msg.student_number,
                "message": msg.message,
                "timestamp": msg.created_at.isoformat(),
                "imageUrl": msg.image_url,
                "replyToId": msg.reply_to_id,
                "nickname": msg.nickname,
                "avatar": avatars_by_student.get(msg.student_number),
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
        student_number=session_number,
        message=message_text if message_text else "",
        image_url=image_url if image_url else None,
        reply_to_id=reply_to_id,
        nickname=current_nickname
    )

    preview_text = message_text or None
    if not preview_text and image_url:
        preview_text = "이미지를 보냈습니다."
    if preview_text:
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
    allowed_keys = {"bgColor", "textColor", "emoji", "borderColor", "style"}
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
    messages = ChatMessage.query.filter(
        ChatMessage.grade == grade,
        ChatMessage.section == section,
        ChatMessage.student_number == student_number,
        ChatMessage.created_at >= today_start_utc,
        ChatMessage.deleted_at == None
    ).order_by(ChatMessage.created_at.desc()).limit(20).all()

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
