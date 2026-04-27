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
    assert payload["scores"] == {"red": 224, "blue": 224}
    assert all(cell == "red" for row in payload["grid"] for cell in row[:14])
    assert all(cell == "blue" for row in payload["grid"] for cell in row[14:])

    second_response = client.post("/api/arcade/sessions", json={"grade": 2, "section": 4})
    assert second_response.status_code == 200
    assert second_response.get_json()["code"] == payload["code"]

    home = client.get("/arcade?grade=2&section=4")
    assert home.status_code == 200
    assert "땅따먹기 Live".encode() in home.data

    legacy_host = client.get("/arcade/host?grade=2&section=4")
    assert legacy_host.status_code == 302
    assert legacy_host.headers["Location"].endswith("/arcade/turf/host?grade=2&section=4")

    turf_host = client.get("/arcade/turf/host?grade=2&section=4")
    assert turf_host.status_code == 200
    assert b"Arcade" in turf_host.data


def test_arcade_debug_any_time_requires_explicit_server_flag(monkeypatch, tmp_path):
    app_module = _load_app(monkeypatch, tmp_path)
    arcade_routes = importlib.import_module("arcade_routes")
    monkeypatch.setattr(
        arcade_routes,
        "_play_window",
        lambda _grade: {
            "allowed": False,
            "label": "",
            "safeEndAt": None,
            "phaseEndAt": None,
            "remainingSafeSeconds": 0,
            "startsInSeconds": None,
            "reason": "blocked by time",
        },
    )

    client = app_module.app.test_client()
    with client.session_transaction() as session_state:
        session_state["board_verified_2_4"] = True

    blocked = client.post("/api/arcade/sessions", json={"grade": 2, "section": 4, "debugAllowAnyTime": True})
    assert blocked.status_code == 400
    assert blocked.get_json()["error"] == "blocked by time"

    monkeypatch.setattr(arcade_routes.config, "ARCADE_DEBUG_ALLOW_ANY_TIME", True)
    allowed = client.post("/api/arcade/sessions", json={"grade": 2, "section": 4, "debugAllowAnyTime": True})
    assert allowed.status_code == 200
    assert allowed.get_json()["phaseLabel"] == "테스트 모드"


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
    assert session_obj.scores["red"] == 224
    assert session_obj.scores["blue"] == 224
    assert first.contribution == 0
    assert second.contribution == 0
    assert third.contribution == 0


def test_arcade_requires_minimum_players_before_start(monkeypatch):
    arcade_routes = importlib.import_module("arcade_routes")
    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: _allowed_window())

    manager = arcade_routes.ArcadeSessionManager()
    session_obj, _error = manager.create_session(2, 4)
    assert session_obj is not None
    first, _error = manager.join_player(session_obj.code, "p1", "하나", 0)
    assert first is not None

    session_obj.scheduled_start_at = time.time() - 1
    with manager._lock:
        manager._advance_locked(session_obj)
    assert session_obj.status == "waiting"
    assert manager.start_now(session_obj.code) is None

    second, _error = manager.join_player(session_obj.code, "p2", "둘둘", 1)
    assert second is not None
    with manager._lock:
        manager._advance_locked(session_obj)
    assert session_obj.status == "countdown"


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
        session_obj.grid[player.y][player.x + 1] = "blue"
        session_obj.scores["red"] -= 1
        session_obj.scores["blue"] += 1
        changed = manager._advance_locked(session_obj)

    assert player.x == before_x + 1
    assert changed == [[player.x, player.y, "red"]]
    assert player.contribution == 1
    assert session_obj.scores == {"red": 224, "blue": 224}

    ended = manager.end_session(session_obj.code)
    assert ended is session_obj
    assert session_obj.status == "ended"
    assert [event[0] for event in fake_socketio.events[-2:]] == ["arcade:state", "arcade:ended"]


def test_arcade_items_create_area_claims_and_speed_boost(monkeypatch):
    arcade_routes = importlib.import_module("arcade_routes")
    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: _allowed_window())

    manager = arcade_routes.ArcadeSessionManager()
    session_obj, _error = manager.create_session(2, 4)
    assert session_obj is not None
    player, _error = manager.join_player(session_obj.code, "p1", "하나", 0)
    assert player is not None

    session_obj.status = "running"
    session_obj.ends_at = time.time() + 60
    player.x = 13
    player.y = 8
    player.pending_direction = "right"
    session_obj.items["star-test"] = arcade_routes.ArcadeItem(
        id="star-test",
        type="star",
        x=14,
        y=8,
        spawned_at=time.time(),
        expires_at=time.time() + 10,
    )

    with manager._lock:
        changed = manager._advance_locked(session_obj)

    assert "star-test" not in session_obj.items
    assert changed
    assert player.contribution > 1
    assert session_obj.grid[7][15] == "red"
    assert session_obj.recent_events[-1]["itemType"] == "star"

    player.x = 10
    player.y = 8
    player.pending_direction = "right"
    session_obj.items["speed-test"] = arcade_routes.ArcadeItem(
        id="speed-test",
        type="speed",
        x=11,
        y=8,
        spawned_at=time.time(),
        expires_at=time.time() + 10,
    )
    with manager._lock:
        manager._advance_locked(session_obj)
        boosted_until = player.speed_until
        manager._advance_locked(session_obj)

    assert boosted_until > time.time()
    assert player.x == 13


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
