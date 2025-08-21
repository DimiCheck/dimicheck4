from __future__ import annotations

from typing import Any

from flask import session
from flask_socketio import Namespace, emit

from models import UserType


class ClassNamespace(Namespace):
    def __init__(self, namespace: str, grade: int, class_no: int):
        super().__init__(namespace)
        self.grade = grade
        self.class_no = class_no

    def on_connect(self):  # type: ignore[override]
        user = session.get("user")
        if not user:
            return False
        if user["type"] == UserType.STUDENT.value:
            if user.get("grade") != self.grade or user.get("class") != self.class_no:
                return False
        emit("presence.subscribe", {"message": "connected"})


namespaces = [
    ClassNamespace(f"/ws/classes/{g}/{c}", g, c)
    for g in range(1, 4)
    for c in range(1, 7)
]
