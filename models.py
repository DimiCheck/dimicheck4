from __future__ import annotations

from datetime import datetime, date
from enum import Enum
import json

from sqlalchemy import UniqueConstraint
from extensions import db


class UserType(str, Enum):
    TEACHER = "teacher"
    STUDENT = "student"


class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    type = db.Column(db.Enum(UserType), nullable=False)
    email = db.Column(db.String(320), nullable=True, unique=True)
    grade = db.Column(db.Integer, nullable=True)
    class_no = db.Column(db.Integer, nullable=True)
    number = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    last_profile_update = db.Column(db.DateTime, nullable=True)

    def is_teacher(self) -> bool:
        return self.type == UserType.TEACHER

    def is_student(self) -> bool:
        return self.type == UserType.STUDENT


class PresenceStatus(str, Enum):
    CLASSROOM = "CLASSROOM"
    OUT = "OUT"
    NURSE = "NURSE"
    OTHER = "OTHER"


class PresenceState(db.Model):
    __table_args__ = (
        UniqueConstraint("grade", "class_no", "number", name="uix_student"),
    )

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    class_no = db.Column(db.Integer, nullable=False)
    number = db.Column(db.Integer, nullable=False)
    status = db.Column(db.Enum(PresenceStatus), default=PresenceStatus.CLASSROOM, nullable=False)
    reason = db.Column(db.String(255), nullable=True)
    version = db.Column(db.Integer, default=1, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)


class PresenceLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    class_no = db.Column(db.Integer, nullable=False)
    number = db.Column(db.Integer, nullable=False)
    status = db.Column(db.Enum(PresenceStatus), nullable=False)
    reason = db.Column(db.String(255), nullable=True)
    actor_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

class ClassState(db.Model):
    __tablename__ = "class_states"
    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    section = db.Column(db.Integer, nullable=False)
    data = db.Column(db.Text, nullable=False)  # JSON 직렬화
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        db.UniqueConstraint("grade", "section", name="uniq_class_state"),
    )


class ClassRoutine(db.Model):
    __tablename__ = "class_routines"

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    section = db.Column(db.Integer, nullable=False)
    afterschool_days = db.Column(db.Text, default="[]", nullable=False)
    changdong_day = db.Column(db.String(16), nullable=True)
    afterschool_data = db.Column(db.Text, default="{}", nullable=False)
    changdong_data = db.Column(db.Text, default="{}", nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        db.UniqueConstraint("grade", "section", name="uniq_class_routine"),
    )

    def _parse_payload(self, payload, fallback):
        try:
            data = json.loads(payload or "{}")
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
        return fallback()

    def _normalize_map(self, raw_map):
        if not isinstance(raw_map, dict):
            return {}
        normalized = {}
        for day, numbers in raw_map.items():
            day_str = str(day)
            if day_str not in {"Mon", "Tue", "Wed", "Thu", "Fri"}:
                continue
            if not isinstance(numbers, (list, tuple)):
                numbers = [numbers]
            cleaned = []
            for num in numbers:
                try:
                    val = int(num)
                except (TypeError, ValueError):
                    continue
                if 1 <= val <= 99 and val not in cleaned:
                    cleaned.append(val)
            if cleaned:
                normalized[day_str] = sorted(cleaned)
        return normalized

    def get_afterschool_map(self):
        legacy = self._parse_payload(self.afterschool_data, dict)
        if not legacy:
            try:
                legacy_list = json.loads(self.afterschool_days or "[]")
                if isinstance(legacy_list, list):
                    legacy = {day: [] for day in legacy_list if isinstance(day, str)}
            except json.JSONDecodeError:
                legacy = {}
        if legacy:
            return self._normalize_map(legacy)
        return {}

    def set_afterschool_map(self, mapping):
        normalized = self._normalize_map(mapping)
        self.afterschool_data = json.dumps(normalized)
        self.afterschool_days = json.dumps(sorted(normalized.keys())) if normalized else json.dumps([])

    def get_changdong_map(self):
        legacy = self._parse_payload(self.changdong_data, dict)
        if not legacy and self.changdong_day:
            legacy = {self.changdong_day: []}
        return self._normalize_map(legacy)

    def set_changdong_map(self, mapping):
        normalized = self._normalize_map(mapping)
        self.changdong_data = json.dumps(normalized)
        first_day = next(iter(sorted(normalized.keys())), None)
        self.changdong_day = first_day

    def to_dict(self):
        return {
            "afterschool": self.get_afterschool_map(),
            "changdong": self.get_changdong_map()
        }


class ClassConfig(db.Model):
    __tablename__ = "class_configs"

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)  # 학년
    section = db.Column(db.Integer, nullable=False)  # 반
    end = db.Column(db.Integer, nullable=False)  # 마지막 번호
    skip_numbers = db.Column(db.Text, default="[]")  # JSON 문자열로 저장

    __table_args__ = (
        db.UniqueConstraint("grade", "section", name="uniq_class_config"),
    )

class ClassPin(db.Model):
    __tablename__ = "class_pins"

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    section = db.Column(db.Integer, nullable=False)
    pin = db.Column(db.String(20), nullable=False)  # PIN (숫자/문자 모두 가능)

    # grade+section은 고유 조합
    __table_args__ = (db.UniqueConstraint("grade", "section", name="uq_class_section"),)


class ChatMessage(db.Model):
    __tablename__ = "chat_messages"

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    section = db.Column(db.Integer, nullable=False)
    student_number = db.Column(db.Integer, nullable=False)
    message = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    # New fields for enhanced chat features
    image_url = db.Column(db.String(500), nullable=True)  # Image URL only (no uploads)
    reply_to_id = db.Column(db.Integer, db.ForeignKey("chat_messages.id"), nullable=True)  # Reply thread
    nickname = db.Column(db.String(50), nullable=True)  # Cached nickname at send time
    deleted_at = db.Column(db.DateTime, nullable=True)  # Soft delete

    __table_args__ = (
        db.Index("idx_chat_grade_section_created", "grade", "section", "created_at"),
        db.Index("idx_chat_reply", "reply_to_id"),
    )


class APIKey(db.Model):
    __tablename__ = "api_keys"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    label = db.Column(db.String(100), nullable=True)
    key = db.Column(db.String(128), unique=True, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    last_used_at = db.Column(db.DateTime, nullable=True)
    tier = db.Column(db.String(20), default="tier1", nullable=False)
    tier_requested_at = db.Column(db.DateTime, nullable=True)
    tier_upgraded_at = db.Column(db.DateTime, nullable=True)
    streak_days = db.Column(db.Integer, default=0, nullable=False)
    streak_last_date = db.Column(db.Date, nullable=True)


class APIRateLimit(db.Model):
    __tablename__ = "api_rate_limits"

    id = db.Column(db.Integer, primary_key=True)
    api_key_id = db.Column(db.Integer, db.ForeignKey("api_keys.id"), nullable=False, unique=True)
    minute_window_start = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    minute_count = db.Column(db.Integer, default=0, nullable=False)
    day = db.Column(db.Date, default=date.today, nullable=False)
    day_count = db.Column(db.Integer, default=0, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    api_key = db.relationship(
        "APIKey",
        backref=db.backref("rate_limit", uselist=False, cascade="all, delete-orphan"),
    )

class UserNickname(db.Model):
    __tablename__ = "user_nicknames"

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    section = db.Column(db.Integer, nullable=False)
    student_number = db.Column(db.Integer, nullable=False)
    nickname = db.Column(db.String(50), nullable=False)  # Max 20 chars enforced in backend
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        db.UniqueConstraint("grade", "section", "student_number", name="uq_user_nickname"),
    )


class Vote(db.Model):
    __tablename__ = "votes"

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    section = db.Column(db.Integer, nullable=False)
    question = db.Column(db.Text, nullable=False)
    options = db.Column(db.Text, nullable=False)  # JSON array of options
    created_by = db.Column(db.Integer, nullable=False)  # student number who created
    expires_at = db.Column(db.DateTime, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        db.Index("idx_vote_grade_section_active", "grade", "section", "is_active"),
    )


class VoteResponse(db.Model):
    __tablename__ = "vote_responses"

    id = db.Column(db.Integer, primary_key=True)
    vote_id = db.Column(db.Integer, db.ForeignKey("votes.id"), nullable=False)
    student_number = db.Column(db.Integer, nullable=False)
    option_index = db.Column(db.Integer, nullable=False)  # Index of the chosen option
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        db.UniqueConstraint("vote_id", "student_number", name="uq_vote_response"),
    )


class MealVote(db.Model):
    __tablename__ = "meal_votes"

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    section = db.Column(db.Integer, nullable=False)
    student_number = db.Column(db.Integer, nullable=False)
    date = db.Column(db.Date, nullable=False)  # 투표한 급식 날짜
    is_positive = db.Column(db.Boolean, nullable=False)  # True = 👍, False = 👎
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        db.UniqueConstraint("grade", "section", "student_number", "date", name="uq_meal_vote"),
        db.Index("idx_meal_vote_date", "date"),
    )


class CalendarEvent(db.Model):
    __tablename__ = "calendar_events"

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    section = db.Column(db.Integer, nullable=False)
    title = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=True)
    event_date = db.Column(db.Date, nullable=False)
    created_by = db.Column(db.Integer, nullable=False)  # student number who created
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        db.Index("idx_calendar_grade_section_date", "grade", "section", "event_date"),
    )


class OAuthClient(db.Model):
    __tablename__ = "oauth_clients"

    id = db.Column(db.Integer, primary_key=True)
    client_id = db.Column(db.String(128), unique=True, nullable=False)
    client_secret = db.Column(db.String(128), nullable=False)
    name = db.Column(db.String(120), nullable=False)
    redirect_uris = db.Column(db.Text, nullable=False, default="")
    scopes = db.Column(db.Text, nullable=False, default="")
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class OAuthAuthorizationCode(db.Model):
    __tablename__ = "oauth_authorization_codes"

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(128), unique=True, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    client_id = db.Column(db.Integer, db.ForeignKey("oauth_clients.id"), nullable=False)
    redirect_uri = db.Column(db.String(1024), nullable=False)
    scope = db.Column(db.String(255), nullable=False)
    expires_at = db.Column(db.DateTime, nullable=False)
    used = db.Column(db.Boolean, default=False, nullable=False)


class OAuthRefreshToken(db.Model):
    __tablename__ = "oauth_refresh_tokens"

    id = db.Column(db.Integer, primary_key=True)
    token = db.Column(db.String(128), unique=True, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    client_id = db.Column(db.Integer, db.ForeignKey("oauth_clients.id"), nullable=False)
    scope = db.Column(db.String(255), nullable=False)
    expires_at = db.Column(db.DateTime, nullable=False)
    revoked = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)


class RememberedSession(db.Model):
    __tablename__ = "remembered_sessions"

    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.String(64), unique=True, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    device_info = db.Column(db.String(512), nullable=True)
    expires_at = db.Column(db.DateTime, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    user = db.relationship("User", backref=db.backref("remembered_sessions", lazy="dynamic"))


class ChatReaction(db.Model):
    """채팅 메시지에 대한 반응 (이모지)"""
    __tablename__ = "chat_reactions"

    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey("chat_messages.id"), nullable=False)
    student_number = db.Column(db.Integer, nullable=False)
    emoji = db.Column(db.String(10), nullable=False)  # 이모지 (👍, ❤️, 😂 등)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        db.UniqueConstraint("message_id", "student_number", "emoji", name="uq_chat_reaction"),
        db.Index("idx_chat_reaction_message", "message_id"),
    )


class UserAvatar(db.Model):
    """사용자 아바타 커스터마이징 정보"""
    __tablename__ = "user_avatars"

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    section = db.Column(db.Integer, nullable=False)
    student_number = db.Column(db.Integer, nullable=False)
    avatar_data = db.Column(db.Text, nullable=False)  # JSON: {"bgColor": "#667eea", "textColor": "#fff", "emoji": "😀"}
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        db.UniqueConstraint("grade", "section", "student_number", name="uq_user_avatar"),
    )


class ClassEmoji(db.Model):
    """반 공용 커스텀 이모티콘"""
    __tablename__ = "class_emojis"

    id = db.Column(db.Integer, primary_key=True)
    grade = db.Column(db.Integer, nullable=False)
    section = db.Column(db.Integer, nullable=False)
    name = db.Column(db.String(50), nullable=False)  # 이모티콘 이름
    image_url = db.Column(db.String(500), nullable=False)  # Imgur에 업로드된 PNG URL
    uploaded_by = db.Column(db.Integer, nullable=False)  # 업로드한 학생 번호
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        db.Index("idx_class_emoji_grade_section", "grade", "section"),
        db.Index("idx_class_emoji_uploader", "uploaded_by"),
    )
