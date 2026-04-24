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
def favorites_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'class-favorites.db'}")
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


def test_student_can_upsert_and_delete_single_favorite(favorites_app, monkeypatch):
    from models import StudentStatusFavorite

    user_id = _create_student(favorites_app, email="student1@example.com", grade=1, section=1, number=1)
    emitted = []

    with favorites_app.app_context():
        socketio = favorites_app.extensions["socketio"]
        monkeypatch.setattr(
            socketio,
            "emit",
            lambda event, payload, namespace=None: emitted.append((event, payload, namespace)),
        )

    client = favorites_app.test_client()
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": user_id,
            "email": "student1@example.com",
            "type": "student",
            "grade": 1,
            "section": 1,
            "number": 1,
        }
        session_state["csrf_token"] = "csrf-token"

    response = client.put("/api/classes/favorite", json={"statusCode": "project"}, headers={"X-CSRF-Token": "csrf-token"})
    assert response.status_code == 200
    assert response.get_json()["favoriteStatus"] == "project"

    response = client.put("/api/classes/favorite", json={"statusCode": "hallway"}, headers={"X-CSRF-Token": "csrf-token"})
    assert response.status_code == 200
    assert response.get_json()["favoriteStatus"] == "hallway"

    with favorites_app.app_context():
        rows = StudentStatusFavorite.query.all()
        assert len(rows) == 1
        assert rows[0].status_code == "hallway"
        assert rows[0].grade == 1
        assert rows[0].section == 1
        assert rows[0].student_number == 1

    response = client.get("/api/classes/favorite/me")
    assert response.status_code == 200
    assert response.get_json()["favoriteStatus"] == "hallway"

    response = client.put("/api/classes/favorite", json={"statusCode": None}, headers={"X-CSRF-Token": "csrf-token"})
    assert response.status_code == 200
    assert response.get_json()["favoriteStatus"] is None

    with favorites_app.app_context():
        assert StudentStatusFavorite.query.count() == 0

    assert emitted == [
        (
            "favorite_updated",
            {"grade": 1, "section": 1, "studentNumber": 1, "favoriteStatus": "project"},
            "/ws/classes/1/1",
        ),
        (
            "favorite_updated",
            {"grade": 1, "section": 1, "studentNumber": 1, "favoriteStatus": "hallway"},
            "/ws/classes/1/1",
        ),
        (
            "favorite_updated",
            {"grade": 1, "section": 1, "studentNumber": 1, "favoriteStatus": None},
            "/ws/classes/1/1",
        ),
    ]


def test_class_favorites_requires_board_session_and_returns_only_requested_class(favorites_app):
    from extensions import db
    from models import StudentStatusFavorite

    user_one_id = _create_student(favorites_app, email="student1@example.com", grade=1, section=1, number=1)
    user_two_id = _create_student(favorites_app, email="student2@example.com", grade=1, section=1, number=2)
    user_three_id = _create_student(favorites_app, email="student3@example.com", grade=1, section=2, number=1)

    with favorites_app.app_context():
        db.session.add(StudentStatusFavorite(user_id=user_one_id, grade=1, section=1, student_number=1, status_code="project"))
        db.session.add(StudentStatusFavorite(user_id=user_two_id, grade=1, section=1, student_number=2, status_code="toilet"))
        db.session.add(StudentStatusFavorite(user_id=user_three_id, grade=1, section=2, student_number=1, status_code="club"))
        db.session.commit()

    student_client = favorites_app.test_client()
    with student_client.session_transaction() as session_state:
        session_state["user"] = {
            "id": user_one_id,
            "email": "student1@example.com",
            "type": "student",
            "grade": 1,
            "section": 1,
            "number": 1,
        }

    forbidden = student_client.get("/api/classes/favorites?grade=1&section=1")
    assert forbidden.status_code == 403

    board_client = favorites_app.test_client()
    with board_client.session_transaction() as session_state:
        session_state["board_verified_1_1"] = True

    response = board_client.get("/api/classes/favorites?grade=1&section=1")
    assert response.status_code == 200
    assert response.get_json() == {
        "grade": 1,
        "section": 1,
        "favorites": {
            "1": "project",
            "2": "toilet",
        },
    }


def test_favorite_endpoint_rejects_invalid_status(favorites_app):
    user_id = _create_student(favorites_app, email="student4@example.com", grade=1, section=1, number=4)

    client = favorites_app.test_client()
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": user_id,
            "email": "student4@example.com",
            "type": "student",
            "grade": 1,
            "section": 1,
            "number": 4,
        }
        session_state["csrf_token"] = "csrf-token"

    response = client.put("/api/classes/favorite", json={"statusCode": "etc"}, headers={"X-CSRF-Token": "csrf-token"})
    assert response.status_code == 400
    assert response.get_json()["error"] == "invalid favorite status"
