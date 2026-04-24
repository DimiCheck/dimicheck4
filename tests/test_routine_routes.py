import importlib
import sys
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
def routine_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'routine-routes.db'}")
    app = _load_app(monkeypatch)
    app.config.update(TESTING=True)

    from extensions import db

    with app.app_context():
        db.drop_all()
        db.create_all()

    yield app


def _create_student(app, *, email, grade, section, number):
    from extensions import db
    from models import User, UserType

    with app.app_context():
        user = User(
            email=email,
            name="",
            type=UserType.STUDENT,
            grade=grade,
            class_no=section,
            number=number,
        )
        db.session.add(user)
        db.session.commit()
        return user.id


def test_student_club_routine_allows_multiple_days_and_returns_compat_keys(routine_app):
    user_id = _create_student(routine_app, email="routine-student@example.com", grade=1, section=1, number=7)

    client = routine_app.test_client()
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": user_id,
            "email": "routine-student@example.com",
            "type": "student",
            "grade": 1,
            "section": 1,
            "number": 7,
        }
        session_state["csrf_token"] = "csrf-token"

    response = client.post(
        "/api/classes/routine?grade=1&section=1",
        json={
            "afterschool": {"Mon": [7]},
            "club": {"Tue": [7], "Thu": [7]},
        },
        headers={"X-CSRF-Token": "csrf-token"},
    )

    assert response.status_code == 200
    assert response.get_json() == {
        "afterschool": {"Mon": [7]},
        "club": {"Tue": [7], "Thu": [7]},
        "changdong": {"Tue": [7], "Thu": [7]},
    }

    response = client.get("/api/classes/routine?grade=1&section=1")
    assert response.status_code == 200
    assert response.get_json()["club"] == {"Tue": [7], "Thu": [7]}
    assert response.get_json()["changdong"] == {"Tue": [7], "Thu": [7]}


def test_student_legacy_changdong_payload_still_updates_club_mapping(routine_app):
    user_id = _create_student(routine_app, email="routine-student-legacy@example.com", grade=1, section=1, number=8)

    client = routine_app.test_client()
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": user_id,
            "email": "routine-student-legacy@example.com",
            "type": "student",
            "grade": 1,
            "section": 1,
            "number": 8,
        }
        session_state["csrf_token"] = "csrf-token"

    response = client.post(
        "/api/classes/routine?grade=1&section=1",
        json={"changdong": {"Wed": [8], "Fri": [8]}},
        headers={"X-CSRF-Token": "csrf-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["club"] == {"Wed": [8], "Fri": [8]}
    assert response.get_json()["changdong"] == {"Wed": [8], "Fri": [8]}
