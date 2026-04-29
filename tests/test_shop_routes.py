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
def shop_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'shop.db'}")
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


def test_shop_me_creates_wallet_and_returns_free_items(shop_app):
    from models import StudentCosmeticEquipment, StudentWallet

    user_id = _create_student(shop_app, email="student1@example.com", grade=2, section=4, number=7)
    client = shop_app.test_client()
    _login_student(client, user_id, grade=2, section=4, number=7)

    response = client.get("/api/shop/me")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["wallet"] == {"coins": 0, "xp": 0, "level": 1}
    assert "move_basic_spark" in payload["owned"]
    assert "drag_soft_trail" in payload["owned"]
    assert payload["equipment"] == {
        "move_effect": None,
        "drag_effect": None,
        "aura_effect": None,
    }

    with shop_app.app_context():
        assert StudentWallet.query.filter_by(user_id=user_id).count() == 1
        assert StudentCosmeticEquipment.query.filter_by(user_id=user_id).count() == 1


def test_shop_buy_requires_enough_coins(shop_app):
    user_id = _create_student(shop_app, email="student2@example.com", grade=2, section=4, number=8)
    client = shop_app.test_client()
    _login_student(client, user_id, grade=2, section=4, number=8)
    client.get("/api/shop/me")

    response = client.post(
        "/api/shop/buy",
        json={"itemKey": "move_stardust"},
        headers={"X-CSRF-Token": "csrf-token"},
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "not enough coins"


def test_shop_buy_and_equip_emits_cosmetic_update(shop_app, monkeypatch):
    from extensions import db
    from models import StudentCosmeticEquipment, StudentCosmeticItem, StudentWallet, WalletTransaction

    user_id = _create_student(shop_app, email="student3@example.com", grade=2, section=4, number=9)
    emitted = []
    with shop_app.app_context():
        socketio = shop_app.extensions["socketio"]
        monkeypatch.setattr(
            socketio,
            "emit",
            lambda event, payload, namespace=None: emitted.append((event, payload, namespace)),
        )

    client = shop_app.test_client()
    _login_student(client, user_id, grade=2, section=4, number=9)
    client.get("/api/shop/me")

    with shop_app.app_context():
        wallet = StudentWallet.query.filter_by(user_id=user_id).first()
        wallet.coins = 500
        db.session.commit()

    buy_response = client.post(
        "/api/shop/buy",
        json={"itemKey": "move_stardust"},
        headers={"X-CSRF-Token": "csrf-token"},
    )
    assert buy_response.status_code == 200
    assert buy_response.get_json()["wallet"]["coins"] == 200

    equip_response = client.post(
        "/api/shop/equip",
        json={"slot": "move_effect", "itemKey": "move_stardust"},
        headers={"X-CSRF-Token": "csrf-token"},
    )
    assert equip_response.status_code == 200
    assert equip_response.get_json()["equipment"]["move_effect"] == "move_stardust"

    with shop_app.app_context():
        assert StudentCosmeticItem.query.filter_by(user_id=user_id, item_key="move_stardust").count() == 1
        assert WalletTransaction.query.filter_by(user_id=user_id, source="shop_purchase").count() == 1
        assert StudentCosmeticEquipment.query.filter_by(user_id=user_id).first().move_effect == "move_stardust"

    assert emitted == [
        (
            "cosmetics_updated",
            {
                "grade": 2,
                "section": 4,
                "studentNumber": 9,
                "equipment": {
                    "move_effect": "move_stardust",
                    "drag_effect": None,
                    "aura_effect": None,
                },
            },
            "/ws/classes/2/4",
        )
    ]


def test_shop_cannot_equip_unowned_paid_item(shop_app):
    user_id = _create_student(shop_app, email="student4@example.com", grade=2, section=4, number=10)
    client = shop_app.test_client()
    _login_student(client, user_id, grade=2, section=4, number=10)
    client.get("/api/shop/me")

    response = client.post(
        "/api/shop/equip",
        json={"slot": "aura_effect", "itemKey": "aura_soft_glow"},
        headers={"X-CSRF-Token": "csrf-token"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "item not owned"


def test_class_cosmetics_requires_board_session_and_filters_class(shop_app):
    from extensions import db
    from models import StudentCosmeticEquipment

    user_one_id = _create_student(shop_app, email="student5@example.com", grade=2, section=4, number=11)
    user_two_id = _create_student(shop_app, email="student6@example.com", grade=2, section=5, number=11)

    with shop_app.app_context():
        db.session.add(
            StudentCosmeticEquipment(
                user_id=user_one_id,
                grade=2,
                section=4,
                student_number=11,
                move_effect="move_stardust",
                drag_effect="drag_fire_trail",
            )
        )
        db.session.add(
            StudentCosmeticEquipment(
                user_id=user_two_id,
                grade=2,
                section=5,
                student_number=11,
                move_effect="move_blue_swirl",
            )
        )
        db.session.commit()

    forbidden_client = shop_app.test_client()
    forbidden = forbidden_client.get("/api/classes/cosmetics?grade=2&section=4")
    assert forbidden.status_code == 403

    board_client = shop_app.test_client()
    with board_client.session_transaction() as session_state:
        session_state["board_verified_2_4"] = True

    response = board_client.get("/api/classes/cosmetics?grade=2&section=4")

    assert response.status_code == 200
    assert response.get_json() == {
        "grade": 2,
        "section": 4,
        "cosmetics": {
            "11": {
                "move_effect": "move_stardust",
                "drag_effect": "drag_fire_trail",
                "aura_effect": None,
            }
        },
    }
