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
        "arcade_routes",
        "auth",
        "class_routes",
        "chat_routes",
        "developer_routes",
        "event_routes",
        "exports_routes",
        "mcp_routes",
        "oauth",
        "public_api",
        "shop_routes",
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
def event_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'events.db'}")
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


def _login_student(client, user_id, *, grade=2, section=4, number=7):
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": user_id,
            "email": f"student{number}@example.com",
            "type": "student",
            "grade": grade,
            "section": section,
            "number": number,
        }
        session_state["csrf_token"] = "csrf-token"


def _login_teacher(client):
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": 999,
            "email": "teacher@example.com",
            "type": "teacher",
        }
        session_state["csrf_token"] = "csrf-token"


def _create_event(client, **overrides):
    payload = {
        "title": "정보 퀴즈",
        "description": "짧은 이벤트",
        "question": "OSI 7계층의 5계층은?",
        "hint": "연결을 만들고 유지합니다.",
        "answer": "세션",
        "answerAliases": ["세션 계층", "session"],
        "rewardCoins": 30,
        "targetAll": False,
        "targetGrade": 2,
        "targetSection": 4,
        "active": True,
    }
    payload.update(overrides)
    return client.post("/api/events", json=payload, headers={"X-CSRF-Token": "csrf-token"})


def test_teacher_can_create_quiz_event_and_reward_is_bounded(event_app):
    client = event_app.test_client()
    _login_teacher(client)

    bad = _create_event(client, rewardCoins=80)
    assert bad.status_code == 400
    assert bad.get_json()["error"] == "reward must be between 10 and 50"

    response = _create_event(client)
    assert response.status_code == 201
    payload = response.get_json()
    assert payload["event"]["rewardCoins"] == 30
    assert payload["event"]["targetGrade"] == 2
    assert payload["event"]["targetSection"] == 4
    assert "answer" not in payload["event"]

    listing = client.get("/api/events/teacher")
    assert listing.status_code == 200
    assert listing.get_json()["events"][0]["claimCount"] == 0


def test_student_claims_matching_class_quiz_once_and_receives_coins(event_app):
    teacher = event_app.test_client()
    _login_teacher(teacher)
    event_id = _create_event(teacher).get_json()["event"]["id"]

    user_id = _create_student(event_app, email="student@example.com", grade=2, section=4, number=7)
    client = event_app.test_client()
    _login_student(client, user_id, grade=2, section=4, number=7)

    events = client.get("/api/events/me")
    assert events.status_code == 200
    assert events.get_json()["events"][0]["id"] == event_id

    wrong = client.post(
        f"/api/events/{event_id}/claim",
        json={"answer": "표현"},
        headers={"X-CSRF-Token": "csrf-token"},
    )
    assert wrong.status_code == 400
    assert wrong.get_json()["error"] == "incorrect answer"

    response = client.post(
        f"/api/events/{event_id}/claim",
        json={"answer": "세션 계층"},
        headers={"X-CSRF-Token": "csrf-token"},
    )
    assert response.status_code == 200
    assert response.get_json()["wallet"]["coins"] == 30
    assert response.get_json()["dailyRemaining"] == 2

    duplicate = client.post(
        f"/api/events/{event_id}/claim",
        json={"answer": "session"},
        headers={"X-CSRF-Token": "csrf-token"},
    )
    assert duplicate.status_code == 409

    from models import CoinEventAttempt, CoinEventClaim, WalletTransaction

    with event_app.app_context():
        assert CoinEventAttempt.query.filter_by(user_id=user_id).count() == 2
        assert CoinEventClaim.query.filter_by(user_id=user_id, event_id=event_id).count() == 1
        tx = WalletTransaction.query.filter_by(user_id=user_id, source="event_quiz").first()
        assert tx.coin_delta == 30
        assert tx.source_detail == str(event_id)


def test_student_daily_quiz_claim_limit_is_three(event_app):
    teacher = event_app.test_client()
    _login_teacher(teacher)
    event_ids = [
        _create_event(teacher, title=f"퀴즈 {idx}", answer=f"답{idx}", rewardCoins=50).get_json()["event"]["id"]
        for idx in range(4)
    ]

    user_id = _create_student(event_app, email="limit@example.com", grade=2, section=4, number=8)
    client = event_app.test_client()
    _login_student(client, user_id, grade=2, section=4, number=8)

    for idx, event_id in enumerate(event_ids[:3]):
        response = client.post(
            f"/api/events/{event_id}/claim",
            json={"answer": f"답{idx}"},
            headers={"X-CSRF-Token": "csrf-token"},
        )
        assert response.status_code == 200

    limited = client.post(
        f"/api/events/{event_ids[3]}/claim",
        json={"answer": "답3"},
        headers={"X-CSRF-Token": "csrf-token"},
    )
    assert limited.status_code == 429
    assert limited.get_json()["error"] == "daily limit reached"


def test_student_only_sees_targeted_events(event_app):
    teacher = event_app.test_client()
    _login_teacher(teacher)
    _create_event(teacher, title="내 반", targetGrade=2, targetSection=4)
    _create_event(teacher, title="다른 반", targetGrade=2, targetSection=5)
    _create_event(teacher, title="전체", targetAll=True, targetGrade=None, targetSection=None)

    user_id = _create_student(event_app, email="target@example.com", grade=2, section=4, number=9)
    client = event_app.test_client()
    _login_student(client, user_id, grade=2, section=4, number=9)

    response = client.get("/api/events/me")
    assert response.status_code == 200
    titles = [event["title"] for event in response.get_json()["events"]]
    assert "내 반" in titles
    assert "전체" in titles
    assert "다른 반" not in titles
