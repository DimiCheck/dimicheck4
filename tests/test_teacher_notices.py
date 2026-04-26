import importlib
import sys
from datetime import datetime, timedelta
from pathlib import Path

import gspread
import pytest
from prometheus_client import REGISTRY

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class _FakeWorksheet:
    def get_all_records(self):
        return []


class _FakeSpreadsheet:
    def worksheet(self, _name):
        return _FakeWorksheet()


class _FakeGSpreadClient:
    def open_by_url(self, _url):
        return _FakeSpreadsheet()


def _load_app(monkeypatch):
    monkeypatch.setattr(gspread, "service_account", lambda _path: _FakeGSpreadClient())
    for collector in list(REGISTRY._collector_to_names):
        names = REGISTRY._collector_to_names.get(collector, ())
        if any(name.startswith("http_request") or name.startswith("http_requests") for name in names):
            REGISTRY.unregister(collector)

    removable_prefixes = (
        "app",
        "config",
        "utils",
        "ws",
        "eventlet",
        "account",
        "auth",
        "class_routes",
        "chat_routes",
        "developer_routes",
        "exports_routes",
        "mcp_routes",
        "oauth",
        "public_api",
        "vote_routes",
    )
    for module_name in list(sys.modules):
        if module_name == "main":
            continue
        if any(module_name == prefix or module_name.startswith(f"{prefix}.") for prefix in removable_prefixes):
            sys.modules.pop(module_name, None)

    app_module = importlib.import_module("app")
    return app_module.app


@pytest.fixture
def notices_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'teacher-notices.db'}")
    app = _load_app(monkeypatch)
    app.config.update(TESTING=True)

    from extensions import db

    with app.app_context():
        db.drop_all()
        db.create_all()

    yield app


def _teacher_client(app):
    client = app.test_client()
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": 1,
            "email": "teacher@example.com",
            "type": "teacher",
        }
        session_state["csrf_token"] = "csrf-token"
    return client


def _student_client(app):
    client = app.test_client()
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": 2,
            "email": "student@example.com",
            "type": "student",
            "grade": 1,
            "section": 1,
            "number": 7,
        }
        session_state["csrf_token"] = "csrf-token"
    return client


def test_teacher_notice_can_have_expiry_without_affecting_default_notices(notices_app):
    client = _teacher_client(notices_app)

    timed = client.post(
        "/api/classes/notices",
        json={
            "teacherName": "Kim",
            "text": "10분 공지",
            "expiresInSeconds": 600,
        },
        headers={"X-CSRF-Token": "csrf-token"},
    )
    assert timed.status_code == 201
    timed_notice = timed.get_json()["notice"]
    assert timed_notice["autoHide"] is True
    assert timed_notice["expiresAt"]
    assert timed_notice["expiresAtMs"] > timed_notice["createdAtMs"]

    persistent = client.post(
        "/api/classes/notices",
        json={"teacherName": "Kim", "text": "계속 표시 공지"},
        headers={"X-CSRF-Token": "csrf-token"},
    )
    assert persistent.status_code == 201
    persistent_notice = persistent.get_json()["notice"]
    assert persistent_notice["autoHide"] is False
    assert persistent_notice["expiresAt"] is None


def test_expired_notices_are_hidden_from_students_but_visible_to_teacher_history(notices_app):
    from extensions import db
    from models import TeacherNotice

    with notices_app.app_context():
        db.session.add(
            TeacherNotice(
                teacher_name="Kim",
                text="이미 지난 공지",
                target_all=True,
                target_classes="[]",
                created_at=datetime.utcnow() - timedelta(hours=2),
                expires_at=datetime.utcnow() - timedelta(hours=1),
            )
        )
        db.session.add(
            TeacherNotice(
                teacher_name="Kim",
                text="계속 보이는 공지",
                target_all=True,
                target_classes="[]",
                created_at=datetime.utcnow(),
                expires_at=None,
            )
        )
        db.session.commit()

    student_response = _student_client(notices_app).get("/api/classes/notices?grade=1&section=1&mode=all")
    assert student_response.status_code == 200
    student_texts = [notice["text"] for notice in student_response.get_json()["notices"]]
    assert "계속 보이는 공지" in student_texts
    assert "이미 지난 공지" not in student_texts

    teacher_response = _teacher_client(notices_app).get("/api/classes/notices?grade=1&section=1&mode=all")
    assert teacher_response.status_code == 200
    teacher_notices = teacher_response.get_json()["notices"]
    teacher_texts = [notice["text"] for notice in teacher_notices]
    assert "계속 보이는 공지" in teacher_texts
    assert "이미 지난 공지" in teacher_texts
    expired_notice = next(notice for notice in teacher_notices if notice["text"] == "이미 지난 공지")
    assert expired_notice["expired"] is True
    assert expired_notice["autoHide"] is True
