from __future__ import annotations

from datetime import datetime
from enum import Enum

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

