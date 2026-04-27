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
    assert "거북이 경주".encode() in home.data

    legacy_host = client.get("/arcade/host?grade=2&section=4")
    assert legacy_host.status_code == 302
    assert legacy_host.headers["Location"].endswith("/arcade/turf/host?grade=2&section=4")

    turf_host = client.get("/arcade/turf/host?grade=2&section=4")
    assert turf_host.status_code == 200
    assert b"Arcade" in turf_host.data

    party_host = client.get("/arcade/party/host?grade=2&section=4")
    assert party_host.status_code == 200
    assert b"Party Mode" in party_host.data

    turtle_host = client.get("/arcade/turtle/host?grade=2&section=4")
    assert turtle_host.status_code == 200
    assert "거북이 경주".encode() in turtle_host.data


def test_arcade_availability_hides_menu_outside_allowed_window(monkeypatch, tmp_path):
    app_module = _load_app(monkeypatch, tmp_path)
    arcade_routes = importlib.import_module("arcade_routes")
    blocked_window = {
        "allowed": False,
        "label": "",
        "safeEndAt": None,
        "phaseEndAt": None,
        "remainingSafeSeconds": 0,
        "startsInSeconds": 300,
        "reason": "수업 시간에는 Arcade를 열 수 없습니다.",
    }
    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: blocked_window)

    client = app_module.app.test_client()
    forbidden = client.get("/api/arcade/availability?grade=2&section=4")
    assert forbidden.status_code == 403
    assert forbidden.get_json()["allowed"] is False

    with client.session_transaction() as session_state:
        session_state["board_verified_2_4"] = True

    blocked = client.get("/api/arcade/availability?grade=2&section=4")
    assert blocked.status_code == 200
    assert "no-store" in blocked.headers["Cache-Control"]
    assert blocked.get_json() == {
        "allowed": False,
        "debugOverride": False,
        "label": "",
        "reason": "수업 시간에는 Arcade를 열 수 없습니다.",
        "remainingSafeSeconds": 0,
        "startsInSeconds": 300,
    }

    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: _allowed_window())
    allowed = client.get("/api/arcade/availability?grade=2&section=4")
    assert allowed.status_code == 200
    assert allowed.get_json()["allowed"] is True
    assert allowed.get_json()["label"] == "점심시간"

    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: blocked_window)
    monkeypatch.setattr(arcade_routes.config, "ARCADE_DEBUG_ALLOW_ANY_TIME", True)
    debug_allowed = client.get("/api/arcade/availability?grade=2&section=4")
    assert debug_allowed.status_code == 200
    assert debug_allowed.get_json() == {
        "allowed": True,
        "debugOverride": True,
        "reason": "테스트 모드",
    }


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
    assert blocked.get_json()["error"] == "서버의 Arcade 테스트 우회 모드가 꺼져 있습니다. ARCADE_DEBUG_ALLOW_ANY_TIME=1로 실행해야 합니다."

    monkeypatch.setattr(arcade_routes.config, "ARCADE_DEBUG_ALLOW_ANY_TIME", True)
    allowed = client.post("/api/arcade/sessions", json={"grade": 2, "section": 4, "debugAllowAnyTime": True})
    assert allowed.status_code == 200
    assert allowed.get_json()["phaseLabel"] == "테스트 모드"


def test_party_debug_any_time_requires_explicit_server_flag_and_marks_host(monkeypatch, tmp_path):
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

    blocked = client.post("/api/arcade/party/sessions", json={"grade": 2, "section": 4, "debugAllowAnyTime": True})
    assert blocked.status_code == 400
    assert blocked.get_json()["error"] == "서버의 Arcade 테스트 우회 모드가 꺼져 있습니다. ARCADE_DEBUG_ALLOW_ANY_TIME=1로 실행해야 합니다."

    monkeypatch.setattr(arcade_routes.config, "ARCADE_DEBUG_ALLOW_ANY_TIME", True)
    host_page = client.get("/arcade/party/host?grade=2&section=4")
    assert host_page.status_code == 200
    assert b'data-debug-allow-any-time="1"' in host_page.data

    allowed = client.post("/api/arcade/party/sessions", json={"grade": 2, "section": 4, "debugAllowAnyTime": True})
    assert allowed.status_code == 200
    assert allowed.get_json()["phaseLabel"] == "테스트 모드"


def test_party_session_routes_create_and_start_with_one_player(monkeypatch, tmp_path):
    app_module = _load_app(monkeypatch, tmp_path)
    arcade_routes = importlib.import_module("arcade_routes")
    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: _allowed_window())

    client = app_module.app.test_client()
    forbidden = client.post("/api/arcade/party/sessions", json={"grade": 2, "section": 4})
    assert forbidden.status_code == 403

    with client.session_transaction() as session_state:
        session_state["board_verified_2_4"] = True

    response = client.post("/api/arcade/party/sessions", json={"grade": 2, "section": 4})
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["mode"] == "party"
    assert payload["status"] == "lobby"
    assert payload["roundCount"] == 6

    code = payload["code"]
    join_page = client.get(f"/arcade/party/join/{code}")
    assert join_page.status_code == 200
    assert b"Party" in join_page.data

    session_obj = arcade_routes.party_manager.get(code)
    player, error = arcade_routes.party_manager.join_player(code, "p1", "하나", 0)
    assert error is None
    assert player is not None

    started = client.post(f"/api/arcade/party/sessions/{code}/start")
    assert started.status_code == 200
    assert started.get_json()["status"] == "countdown"
    assert session_obj.status == "countdown"


def test_turtle_session_routes_create_join_start_and_rank(monkeypatch, tmp_path):
    app_module = _load_app(monkeypatch, tmp_path)
    arcade_routes = importlib.import_module("arcade_routes")
    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: _allowed_window())

    client = app_module.app.test_client()
    forbidden = client.post("/api/arcade/turtle/sessions", json={"grade": 2, "section": 4})
    assert forbidden.status_code == 403

    with client.session_transaction() as session_state:
        session_state["board_verified_2_4"] = True

    response = client.post("/api/arcade/turtle/sessions", json={"grade": 2, "section": 4})
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["mode"] == "turtle"
    assert payload["status"] == "lobby"
    assert payload["raceSeconds"] == 22

    code = payload["code"]
    join_page = client.get(f"/arcade/turtle/join/{code}")
    assert join_page.status_code == 200
    assert "거북이 경주".encode() in join_page.data

    session_obj = arcade_routes.turtle_manager.get(code)
    first, first_error = arcade_routes.turtle_manager.join_player(code, "p1", "하나", 0)
    second, second_error = arcade_routes.turtle_manager.join_player(code, "p2", "둘둘", 1)
    assert first_error is None
    assert second_error is None
    assert first is not None and first.lane == 0
    assert second is not None and second.lane == 1

    started = client.post(f"/api/arcade/turtle/sessions/{code}/start")
    assert started.status_code == 200
    assert started.get_json()["status"] == "countdown"

    assert session_obj is not None
    with arcade_routes.turtle_manager._lock:
        session_obj.starts_at = time.time() - 1
        assert arcade_routes.turtle_manager._advance_locked(session_obj) is True
        assert session_obj.status == "racing"

    arcade_routes.turtle_manager.add_taps(code, "p1", 12)
    arcade_routes.turtle_manager.add_taps(code, "p2", 2)
    assert session_obj.players["p1"].progress > session_obj.players["p2"].progress

    session_obj.players["p1"].progress = 0.996
    arcade_routes.turtle_manager.add_taps(code, "p1", 1)
    assert session_obj.players["p1"].finished_at is not None
    assert session_obj.players["p1"].rank == 1

    ended = client.post(f"/api/arcade/turtle/sessions/{code}/end")
    assert ended.status_code == 200
    ranking = ended.get_json()["rankings"]
    assert ranking[0]["id"] == "p1"


def test_party_round_scores_and_late_join_waits_for_next_round(monkeypatch):
    arcade_routes = importlib.import_module("arcade_routes")
    monkeypatch.setattr(arcade_routes, "_play_window", lambda _grade: _allowed_window())

    manager = arcade_routes.PartySessionManager()
    session_obj, error = manager.create_session(2, 4)
    assert error is None
    assert session_obj is not None
    manager.join_player(session_obj.code, "p1", "하나", 0)
    manager.join_player(session_obj.code, "p2", "둘둘", 1)

    definition = {
        "id": "choice-test",
        "engine": "choice",
        "title": "테스트 선택",
        "instruction": "정답을 고르세요.",
        "minPlayers": 1,
        "duration": 8,
        "config": {"options": ["A", "B"], "correct": "A"},
    }
    monkeypatch.setattr(manager, "_select_game_locked", lambda _session_obj, _count: definition)

    started, start_error = manager.start_now(session_obj.code)
    assert start_error is None
    assert started is session_obj
    with manager._lock:
        session_obj.next_transition_at = time.time() - 1
        assert manager._advance_locked(session_obj) is True
        assert session_obj.status == "round_intro"
        assert session_obj.current_round is not None
        session_obj.current_round.starts_at = time.time() - 1
        assert manager._advance_locked(session_obj) is True
        assert session_obj.status == "playing"

    late_player, late_error = manager.join_player(session_obj.code, "p3", "셋셋", 2)
    assert late_error is None
    assert late_player is not None
    assert "p3" not in session_obj.current_round.participants

    submitted, submit_error = manager.submit(session_obj.code, "p1", "A")
    assert submit_error is None
    assert submitted is session_obj
    manager.submit(session_obj.code, "p2", "B")

    assert session_obj.status == "round_result"
    scores = {result["playerId"]: result["score"] for result in session_obj.current_round.results}
    assert scores["p1"] == 100
    assert scores["p2"] == 0
    assert session_obj.players["p1"].score == 100
    assert session_obj.players["p2"].rounds_played == 1
    assert session_obj.players["p3"].rounds_played == 0

    with manager._lock:
        session_obj.next_transition_at = time.time() - 1
        assert manager._advance_locked(session_obj) is True
        assert session_obj.status == "countdown"
        session_obj.next_transition_at = time.time() - 1
        assert manager._advance_locked(session_obj) is True
        assert session_obj.current_round is not None
        assert "p3" in session_obj.current_round.participants


def test_party_late_or_stale_submit_is_ignored_without_error():
    arcade_routes = importlib.import_module("arcade_routes")
    manager = arcade_routes.PartySessionManager()
    now = time.time()
    round_obj = arcade_routes.PartyRound(
        id="round-current",
        index=1,
        definition={"id": "mash", "engine": "mash", "title": "mash", "instruction": "mash"},
        status="round_result",
        intro_at=now,
        starts_at=now,
        ends_at=now + 6,
        result_at=now + 11,
        participants=["p1"],
        prompt={},
    )
    session_obj = arcade_routes.PartySession(
        code="STALE",
        grade=2,
        section=4,
        status="round_result",
        created_at=now,
        ends_at=now + 120,
        phase_label="테스트",
        players={"p1": arcade_routes.PartyPlayer(id="p1", nickname="하나", avatar=0)},
        current_round=round_obj,
    )
    manager._sessions[session_obj.code] = session_obj

    ignored, error = manager.submit(session_obj.code, "p1", 12, "round-current")
    assert ignored is session_obj
    assert error is None
    assert round_obj.submissions == {}

    stale, stale_error = manager.submit(session_obj.code, "p1", 12, "round-old")
    assert stale is session_obj
    assert stale_error is None


def test_party_minigame_pack_covers_engine_types():
    arcade_routes = importlib.import_module("arcade_routes")
    games = arcade_routes.PARTY_MINIGAMES
    assert len(games) >= 25
    engines = {game["engine"] for game in games}
    assert {"reaction", "timing", "memory", "choice", "majority", "luck", "mash", "target", "risk", "slider", "order"} <= engines
    assert all(game["title"] and game["instruction"] for game in games)
    assert any(game["id"] == "reaction_fake" and game["config"].get("fake") for game in games)
    assert any(game["id"] == "stroop" and game["config"].get("cueColor") for game in games)
    assert any(game["id"] == "forbidden_color" and game["config"].get("forbidden") for game in games)


def test_party_score_engines_handle_common_round_types():
    arcade_routes = importlib.import_module("arcade_routes")
    manager = arcade_routes.PartySessionManager()
    now = time.time()
    session_obj = arcade_routes.PartySession(
        code="TEST1",
        grade=2,
        section=4,
        status="playing",
        created_at=now,
        ends_at=now + 120,
        phase_label="테스트",
        players={
            "p1": arcade_routes.PartyPlayer(id="p1", nickname="하나", avatar=0),
            "p2": arcade_routes.PartyPlayer(id="p2", nickname="둘둘", avatar=1),
        },
    )

    def make_round(engine, prompt, submissions):
        return arcade_routes.PartyRound(
            id=f"{engine}-round",
            index=1,
            definition={"id": engine, "engine": engine, "title": engine, "instruction": engine},
            status="playing",
            intro_at=now,
            starts_at=now,
            ends_at=now + 10,
            result_at=now + 15,
            participants=["p1", "p2"],
            prompt=prompt,
            submissions=submissions,
        )

    reaction_round = make_round(
        "reaction",
        {"signalAt": int((now + 1) * 1000)},
        {"p1": {"value": "tap", "submittedAt": now + 1.2}, "p2": {"value": "tap", "submittedAt": now + 2.0}},
    )
    assert manager._score_round_locked(session_obj, reaction_round)[0]["playerId"] == "p1"

    timing_round = make_round(
        "timing",
        {"targetMs": 4000},
        {"p1": {"value": 4020, "submittedAt": now + 4}, "p2": {"value": 6200, "submittedAt": now + 6.2}},
    )
    assert manager._score_round_locked(session_obj, timing_round)[0]["score"] > 90

    memory_round = make_round(
        "memory",
        {"sequence": ["빨강", "파랑", "초록"]},
        {"p1": {"value": ["빨강", "파랑", "초록"], "submittedAt": now + 4}, "p2": {"value": ["빨강"], "submittedAt": now + 5}},
    )
    assert manager._score_round_locked(session_obj, memory_round)[0]["score"] == 100

    choice_round = make_round(
        "choice",
        {"answers": ["A"]},
        {"p1": {"value": "A", "submittedAt": now + 4}, "p2": {"value": "B", "submittedAt": now + 5}},
    )
    assert {result["playerId"]: result["score"] for result in manager._score_round_locked(session_obj, choice_round)} == {
        "p1": 100,
        "p2": 0,
    }

    majority_round = make_round(
        "majority",
        {"options": ["A", "B"]},
        {"p1": {"value": "A", "submittedAt": now + 4}, "p2": {"value": "B", "submittedAt": now + 5}},
    )
    assert all(result["score"] == 100 for result in manager._score_round_locked(session_obj, majority_round))

    luck_round = make_round(
        "luck",
        {"outcomes": {"문1": 30, "문2": 100}},
        {"p1": {"value": "문1", "submittedAt": now + 4}, "p2": {"value": "문2", "submittedAt": now + 5}},
    )
    assert manager._score_round_locked(session_obj, luck_round)[0]["playerId"] == "p2"

    mash_round = make_round(
        "mash",
        {},
        {"p1": {"value": 12, "submittedAt": now + 6}, "p2": {"value": 24, "submittedAt": now + 6}},
    )
    mash_scores = {result["playerId"]: result["score"] for result in manager._score_round_locked(session_obj, mash_round)}
    assert mash_scores == {"p1": 50, "p2": 100}

    target_round = make_round(
        "target",
        {},
        {
            "p1": {"value": {"hits": 7, "misses": 1}, "submittedAt": now + 6},
            "p2": {"value": {"hits": 4, "misses": 2}, "submittedAt": now + 6},
        },
    )
    assert manager._score_round_locked(session_obj, target_round)[0]["playerId"] == "p1"

    risk_round = make_round(
        "risk",
        {"outcomes": {"안전": 35, "도전": 100}},
        {"p1": {"value": "안전", "submittedAt": now + 4}, "p2": {"value": "도전", "submittedAt": now + 5}},
    )
    assert manager._score_round_locked(session_obj, risk_round)[0]["playerId"] == "p2"

    slider_round = make_round(
        "slider",
        {"target": 70},
        {"p1": {"value": 72, "submittedAt": now + 4}, "p2": {"value": 40, "submittedAt": now + 5}},
    )
    assert manager._score_round_locked(session_obj, slider_round)[0]["playerId"] == "p1"

    order_round = make_round(
        "order",
        {"answer": ["밥", "국", "반찬"]},
        {"p1": {"value": ["밥", "국", "반찬"], "submittedAt": now + 4}, "p2": {"value": ["국", "밥", "반찬"], "submittedAt": now + 5}},
    )
    assert manager._score_round_locked(session_obj, order_round)[0]["score"] == 100


def test_party_target_prompt_has_moving_schedule():
    arcade_routes = importlib.import_module("arcade_routes")
    manager = arcade_routes.PartySessionManager()
    now = time.time()
    prompt = manager._make_prompt(
        {"id": "target-test", "engine": "target", "config": {"cells": 9, "stepMs": 700, "label": "별"}},
        now,
        now + 8,
    )
    assert prompt["cells"] == 9
    assert prompt["label"] == "별"
    assert len(prompt["targets"]) >= 8
    assert all(0 <= item["cell"] < 9 for item in prompt["targets"])


def test_party_prompt_and_selection_add_varied_input_modes():
    arcade_routes = importlib.import_module("arcade_routes")
    manager = arcade_routes.PartySessionManager()
    now = time.time()

    slider_prompt = manager._make_prompt(
        {"id": "slider-test", "engine": "slider", "config": {"target": 63, "label": "위치", "unit": "%"}},
        now,
        now + 9,
    )
    assert slider_prompt["target"] == 63
    assert slider_prompt["unit"] == "%"

    order_prompt = manager._make_prompt(
        {"id": "order-test", "engine": "order", "config": {"items": ["3", "1", "2"], "direction": "asc"}},
        now,
        now + 9,
    )
    assert order_prompt["answer"] == ["1", "2", "3"]
    assert sorted(order_prompt["options"]) == ["1", "2", "3"]

    session_obj = arcade_routes.PartySession(
        code="VARIE",
        grade=2,
        section=4,
        status="lobby",
        created_at=now,
        ends_at=now + 120,
        phase_label="테스트",
        recent_game_ids=["reaction_green", "reaction_fake", "late_tap"],
    )
    selected = manager._select_game_locked(session_obj, 4)
    assert selected["engine"] != "reaction"


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


def test_arcade_play_window_does_not_infer_regular_class_breaks(monkeypatch):
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
    assert arcade_routes._play_window(2, break_start)["allowed"] is False

    lunch_start = datetime(2026, 4, 27, 12, 50, 10, tzinfo=arcade_routes.KST).timestamp()
    assert arcade_routes._play_window(2, lunch_start)["allowed"] is True
    assert arcade_routes._play_window(2, lunch_start)["label"] == "점심 시간"
