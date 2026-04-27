import importlib
import sys
import time
from datetime import datetime
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


class _FakeSocketIO:
    def __init__(self):
        self.events = []

    def emit(self, event, payload, namespace=None, room=None):
        self.events.append((event, payload, namespace, room))


def _load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'arcade.db'}")
    monkeypatch.setattr(gspread, "service_account", lambda _path: _FakeGSpreadClient())
    for collector in list(REGISTRY._collector_to_names):
        names = REGISTRY._collector_to_names.get(collector, ())
        if any(name.startswith("http_request") or name.startswith("http_requests") for name in names):
            REGISTRY.unregister(collector)

    removable_prefixes = (
        "app",
        "arcade_routes",
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
    app_module.app.config.update(TESTING=True)
    return app_module


def _allowed_window():
    return {
        "allowed": True,
        "label": "점심시간",
        "safeEndAt": time.time() + 1200,
        "phaseEndAt": time.time() + 1500,
        "remainingSafeSeconds": 1200,
        "startsInSeconds": 0,
        "reason": "",
    }


def test_arcade_session_routes_require_board_session_and_create(monkeypatch, tmp_path):
    app_module = _load_app(monkeypatch, tmp_path)
    arcade_routes = importlib.import_module("arcade_routes")
    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: _allowed_window())

    client = app_module.app.test_client()
    forbidden = client.post("/api/arcade/sessions", json={"grade": 2, "section": 4})
    assert forbidden.status_code == 403

    with client.session_transaction() as session_state:
        session_state["board_verified_2_4"] = True

    response = client.post("/api/arcade/sessions", json={"grade": 2, "section": 4})
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["grade"] == 2
    assert payload["section"] == 4
    assert payload["status"] == "waiting"
    assert len(payload["code"]) == 5
    assert payload["gridWidth"] == 28
    assert payload["gridHeight"] == 16

    second_response = client.post("/api/arcade/sessions", json={"grade": 2, "section": 4})
    assert second_response.status_code == 200
    assert second_response.get_json()["code"] == payload["code"]

    host = client.get("/arcade/host?grade=2&section=4")
    assert host.status_code == 200
    assert b"Arcade" in host.data


def test_arcade_manager_assigns_balanced_teams_and_claims_spawn_cells(monkeypatch):
    arcade_routes = importlib.import_module("arcade_routes")
    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: _allowed_window())

    manager = arcade_routes.ArcadeSessionManager()
    session_obj, error = manager.create_session(2, 4)
    assert error is None
    assert session_obj is not None

    first, first_error = manager.join_player(session_obj.code, "p1", "하나", 0)
    second, second_error = manager.join_player(session_obj.code, "p2", "둘둘", 1)
    third, third_error = manager.join_player(session_obj.code, "p3", "셋셋", 2)

    assert first_error is None
    assert second_error is None
    assert third_error is None
    assert [first.team, second.team, third.team] == ["red", "blue", "red"]
    assert session_obj.scores["red"] == 2
    assert session_obj.scores["blue"] == 1


def test_arcade_manager_moves_players_and_broadcasts_manual_end(monkeypatch):
    arcade_routes = importlib.import_module("arcade_routes")
    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: _allowed_window())

    manager = arcade_routes.ArcadeSessionManager()
    fake_socketio = _FakeSocketIO()
    manager.bind_socketio(fake_socketio)
    session_obj, _error = manager.create_session(2, 4)
    assert session_obj is not None
    player, _error = manager.join_player(session_obj.code, "p1", "하나", 0)
    assert player is not None

    session_obj.status = "running"
    session_obj.ends_at = time.time() + 60
    before_x = player.x
    assert manager.set_input(session_obj.code, player.id, "right") is True
    with manager._lock:
        changed = manager._advance_locked(session_obj)

    assert player.x == before_x + 1
    assert changed == [[player.x, player.y, "red"]]

    ended = manager.end_session(session_obj.code)
    assert ended is session_obj
    assert session_obj.status == "ended"
    assert [event[0] for event in fake_socketio.events[-2:]] == ["arcade:state", "arcade:ended"]


def test_arcade_play_window_includes_regular_class_breaks(monkeypatch):
    arcade_routes = importlib.import_module("arcade_routes")
    monkeypatch.setattr(
        arcade_routes,
        "_phases_for_grade",
        lambda _grade, _now_dt: [
            {"label": "오전 수업 시간", "start": 9 * 60, "end": 12 * 60 + 50},
            {"label": "점심 시간", "start": 12 * 60 + 50, "end": 13 * 60 + 50},
        ],
    )

    break_start = datetime(2026, 4, 27, 9, 50, 10, tzinfo=arcade_routes.KST).timestamp()
    assert arcade_routes._play_window(2, break_start)["allowed"] is True
    assert arcade_routes._play_window(2, break_start)["label"] == "쉬는 시간"

    too_late = datetime(2026, 4, 27, 9, 55, 1, tzinfo=arcade_routes.KST).timestamp()
    assert arcade_routes._play_window(2, too_late)["allowed"] is False
