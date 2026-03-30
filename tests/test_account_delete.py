import importlib
import sys
from datetime import date, datetime
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
def account_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'account-delete.db'}")
    app = _load_app(monkeypatch)
    app.config.update(TESTING=True)

    from extensions import db

    with app.app_context():
        db.drop_all()
        db.create_all()

    yield app


def test_account_delete_requires_confirmation(account_app):
    from extensions import db
    from models import User, UserType

    with account_app.app_context():
        user = User(email="student@example.com", name="", type=UserType.STUDENT, grade=1, class_no=1, number=1)
        db.session.add(user)
        db.session.commit()
        user_id = user.id

    client = account_app.test_client()
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": user_id,
            "email": "student@example.com",
            "type": "student",
            "grade": 1,
            "section": 1,
            "number": 1,
        }
        session_state["csrf_token"] = "csrf-token"

    response = client.post(
        "/account/delete",
        json={"confirmation": "아님"},
        headers={"X-CSRF-Token": "csrf-token"},
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "confirmation_required"


def test_account_page_renders_delete_section(account_app):
    from extensions import db
    from models import User, UserType

    with account_app.app_context():
        user = User(email="student@example.com", name="", type=UserType.STUDENT, grade=1, class_no=1, number=1)
        db.session.add(user)
        db.session.commit()
        user_id = user.id

    client = account_app.test_client()
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": user_id,
            "email": "student@example.com",
            "type": "student",
            "grade": 1,
            "section": 1,
            "number": 1,
        }

    response = client.get("/account")

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "계정 관리" in html
    assert "회원 탈퇴" in html
    assert "deleteConfirmInput" in html
    assert "로그아웃" in html


def test_account_delete_purges_user_and_student_scoped_data(account_app):
    from extensions import db
    from models import (
        APIKey,
        APIRateLimit,
        CalendarEvent,
        ChatConsent,
        ChatMessage,
        ChatMessageRead,
        ChatReaction,
        Counter,
        HomeTarget,
        MealVote,
        RememberedSession,
        TermsConsent,
        User,
        UserAvatar,
        UserNickname,
        UserType,
        Vote,
        VoteResponse,
    )

    with account_app.app_context():
        user = User(email="student@example.com", name="", type=UserType.STUDENT, grade=1, class_no=1, number=1)
        db.session.add(user)
        db.session.commit()

        api_key = APIKey(user_id=user.id, key="api-key", tier="tier1")
        db.session.add(api_key)
        db.session.flush()
        db.session.add(APIRateLimit(api_key_id=api_key.id))

        db.session.add(TermsConsent(user_id=user.id, version="v1"))
        db.session.add(HomeTarget(user_id=user.id))
        db.session.add(Counter(user_id=user.id, name="visits", value=3))
        db.session.add(RememberedSession(session_id="remember-token", user_id=user.id, expires_at=datetime.utcnow()))

        message = ChatMessage(grade=1, section=1, channel="home", student_number=1, message="hello")
        db.session.add(message)
        db.session.flush()
        db.session.add(ChatMessageRead(message_id=message.id, grade=1, section=1, student_number=1))
        db.session.add(ChatReaction(message_id=message.id, student_number=1, emoji="👍"))

        vote = Vote(
            grade=1,
            section=1,
            channel="home",
            question="점심 뭐 먹지?",
            options='["A","B"]',
            created_by=1,
            expires_at=datetime.utcnow(),
        )
        db.session.add(vote)
        db.session.flush()
        db.session.add(VoteResponse(vote_id=vote.id, student_number=1, option_index=0))

        db.session.add(UserNickname(grade=1, section=1, student_number=1, nickname="닉네임"))
        db.session.add(UserAvatar(grade=1, section=1, student_number=1, avatar_data='{"emoji":"😀"}'))
        db.session.add(ChatConsent(grade=1, section=1, student_number=1, version="v1"))
        db.session.add(MealVote(grade=1, section=1, student_number=1, date=date.today(), is_positive=True))
        db.session.add(CalendarEvent(grade=1, section=1, title="시험", description="", event_date=date.today(), created_by=1))
        db.session.commit()
        user_id = user.id

    client = account_app.test_client()
    client.set_cookie("remember_token", "remember-token", domain="localhost")
    with client.session_transaction() as session_state:
        session_state["user"] = {
            "id": user_id,
            "email": "student@example.com",
            "type": "student",
            "grade": 1,
            "section": 1,
            "number": 1,
        }
        session_state["csrf_token"] = "csrf-token"

    response = client.post(
        "/account/delete",
        json={"confirmation": "탈퇴"},
        headers={"X-CSRF-Token": "csrf-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["ok"] is True

    auth_status = client.get("/auth/status")
    assert auth_status.status_code == 401

    with account_app.app_context():
        assert User.query.count() == 0
        assert TermsConsent.query.count() == 0
        assert HomeTarget.query.count() == 0
        assert APIKey.query.count() == 0
        assert APIRateLimit.query.count() == 0
        assert Counter.query.count() == 0
        assert RememberedSession.query.count() == 0
        assert UserNickname.query.count() == 0
        assert UserAvatar.query.count() == 0
        assert ChatConsent.query.count() == 0
        assert ChatMessage.query.count() == 0
        assert ChatMessageRead.query.count() == 0
        assert ChatReaction.query.count() == 0
        assert Vote.query.count() == 0
        assert VoteResponse.query.count() == 0
        assert MealVote.query.count() == 0
        assert CalendarEvent.query.count() == 0
