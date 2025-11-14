from __future__ import annotations

from datetime import datetime
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
    grade = db.Column(db.Integer, nullable=True)
    class_no = db.Column(db.Integer, nullable=True)
    number = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

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

    __table_args__ = (
        db.Index("idx_chat_grade_section_created", "grade", "section", "created_at"),
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

