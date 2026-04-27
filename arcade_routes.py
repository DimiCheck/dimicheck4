from __future__ import annotations

import json
import random
import re
import secrets
import string
import threading
import time
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from flask import Blueprint, jsonify, redirect, render_template, request
from flask_socketio import Namespace, emit, join_room, leave_room

from config import config
from utils import is_board_session_active, is_teacher_session_active

blueprint = Blueprint("arcade", __name__)

ARCADE_NAMESPACE = "/ws/arcade"
GRID_WIDTH = 28
GRID_HEIGHT = 16
WAIT_SECONDS = 15
COUNTDOWN_SECONDS = 5
RESULT_SECONDS = 10
MAX_GAME_SECONDS = 90
END_BUFFER_SECONDS = 5 * 60
MIN_START_WINDOW_SECONDS = WAIT_SECONDS + COUNTDOWN_SECONDS + 30
SESSION_CLEANUP_INTERVAL_SECONDS = 30
ITEM_EXPIRE_SECONDS = 9
STAR_INTERVAL_SECONDS = 7
SPEED_INTERVAL_SECONDS = 12
BOMB_INTERVAL_SECONDS = 18
FEVER_SECONDS = 10
SPEED_BOOST_SECONDS = 4
ROOM_PREFIX = "arcade:"
KST = ZoneInfo("Asia/Seoul")
VALID_DIRECTIONS = {"up", "down", "left", "right"}
DIR_DELTA = {
    "up": (0, -1),
    "down": (0, 1),
    "left": (-1, 0),
    "right": (1, 0),
}
TEAM_ORDER = ("red", "blue")
TEAM_LABELS = {"red": "딸기팀", "blue": "소다팀"}
AVATAR_COUNT = 12
INITIAL_RED_CELLS = (GRID_WIDTH // 2) * GRID_HEIGHT
INITIAL_BLUE_CELLS = (GRID_WIDTH - GRID_WIDTH // 2) * GRID_HEIGHT
ITEM_LABELS = {
    "star": "별사탕",
    "bomb": "페인트 폭탄",
    "speed": "스피드 젤리",
}
ITEM_RADIUS = {
    "star": 1,
    "bomb": 2,
}
PARTY_WAIT_SECONDS = 3
PARTY_INTRO_SECONDS = 2
PARTY_RESULT_SECONDS = 3
PARTY_MAX_ROUNDS = 6
PARTY_ROOM_PREFIX = "arcade:party:"
TURTLE_WAIT_SECONDS = 5
TURTLE_RACE_SECONDS = 40
TURTLE_TAP_PROGRESS = 0.007
TURTLE_MAX_TAPS_PER_EVENT = 12
TURTLE_MIN_RACERS = 2
TURTLE_SABOTEUR_VOTE_SECONDS = 5
TURTLE_ROOM_PREFIX = "arcade:turtle:"
TURTLE_SKINS = ("turtle-01.png", "turtle-02.png", "turtle-03.png")
TURTLE_SABOTAGE_ITEMS: tuple[dict[str, str], ...] = (
    {"id": "banana", "label": "바나나", "description": "뒤로 미끄러짐"},
    {"id": "swap_last", "label": "꼴지와 교체", "description": "꼴지와 위치 바꾸기"},
    {"id": "shrink", "label": "작아져라", "description": "2초간 버튼이 작아지고 도망감"},
    {"id": "fake_reset", "label": "초기화 함정", "description": "빨간 초기화 버튼으로 방해"},
)
PARTY_MINIGAMES: tuple[dict[str, Any], ...] = (
    {
        "id": "reaction_green",
        "engine": "reaction",
        "title": "반응 버튼",
        "instruction": "초록 신호가 뜨면 가장 빨리 누르세요.",
        "minPlayers": 1,
        "duration": 4,
        "config": {"signal": "초록"},
    },
    {
        "id": "reaction_fake",
        "engine": "reaction",
        "title": "거짓 신호",
        "instruction": "진짜 신호가 뜰 때만 누르세요.",
        "minPlayers": 1,
        "duration": 4,
        "config": {"signal": "진짜", "fake": True},
    },
    {
        "id": "late_tap",
        "engine": "reaction",
        "title": "늦게 누르기",
        "instruction": "시간 안에서 가장 늦게 누르면 높은 점수입니다.",
        "minPlayers": 1,
        "duration": 4,
        "config": {"late": True},
    },
    {
        "id": "center_stop",
        "engine": "timing",
        "title": "중앙 정지",
        "instruction": "움직이는 바가 목표 지점에 가까울 때 멈추세요.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"targetMs": 3600, "toleranceMs": 2200},
    },
    {
        "id": "five_seconds",
        "engine": "timing",
        "title": "목표 시간",
        "instruction": "감으로 목표 시간에 맞춰 멈추세요.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"targetMs": 5000, "toleranceMs": 2500},
    },
    {
        "id": "closing_bell",
        "engine": "timing",
        "title": "종례 카운트다운",
        "instruction": "카운트다운의 끝에 가장 가깝게 누르세요.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"targetMs": 4800, "toleranceMs": 1800},
    },
    {
        "id": "hold_release",
        "engine": "timing",
        "title": "홀드 앤 릴리즈",
        "instruction": "버튼을 누르고 있다가 목표 구간에서 떼세요.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"targetMs": 4200, "toleranceMs": 2000, "hold": True},
    },
    {
        "id": "lunch_rush",
        "engine": "mash",
        "title": "급식 러시",
        "instruction": "제한 시간 동안 버튼을 최대한 많이 눌러 급식 줄을 뚫으세요.",
        "minPlayers": 1,
        "duration": 4,
        "config": {"label": "달리기"},
    },
    {
        "id": "balloon_pop",
        "engine": "mash",
        "title": "풍선 터뜨리기",
        "instruction": "빠르게 연타해서 풍선을 먼저 터뜨리세요.",
        "minPlayers": 1,
        "duration": 4,
        "config": {"label": "펑!"},
    },
    {
        "id": "star_catch",
        "engine": "target",
        "title": "별사탕 캐치",
        "instruction": "반짝이는 칸이 바뀔 때마다 정확히 눌러 점수를 모으세요.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"cells": 9, "stepMs": 760, "label": "별"},
    },
    {
        "id": "bomb_dodge",
        "engine": "target",
        "title": "폭탄 피하기",
        "instruction": "안전한 칸만 빠르게 누르세요. 폭탄 칸은 감점입니다.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"cells": 9, "stepMs": 700, "label": "안전"},
    },
    {
        "id": "perfect_position",
        "engine": "slider",
        "title": "눈대중 슬라이더",
        "instruction": "목표 위치에 최대한 가깝게 슬라이더를 맞추세요.",
        "minPlayers": 1,
        "duration": 6,
        "config": {"label": "위치", "unit": "%"},
    },
    {
        "id": "volume_match",
        "engine": "slider",
        "title": "볼륨 맞추기",
        "instruction": "전자칠판의 목표 볼륨과 가장 비슷하게 맞추세요.",
        "minPlayers": 1,
        "duration": 6,
        "config": {"label": "볼륨", "unit": "%"},
    },
    {
        "id": "height_order",
        "engine": "order",
        "title": "줄 세우기",
        "instruction": "낮은 숫자부터 차례대로 눌러 순서를 완성하세요.",
        "minPlayers": 1,
        "duration": 7,
        "config": {"items": ["142", "156", "163", "171"], "direction": "asc", "label": "작은 숫자부터"},
    },
    {
        "id": "lunch_order",
        "engine": "order",
        "title": "급식 순서",
        "instruction": "급식판에 올릴 순서를 기억해 차례대로 누르세요.",
        "minPlayers": 1,
        "duration": 7,
        "config": {"items": ["밥", "국", "반찬", "후식"], "direction": "given", "label": "왼쪽부터"},
    },
    {
        "id": "color_memory",
        "engine": "memory",
        "title": "색 순서 기억",
        "instruction": "잠깐 보이는 색 순서를 기억해 입력하세요.",
        "minPlayers": 1,
        "duration": 7,
        "config": {"kind": "colors", "length": 7},
    },
    {
        "id": "direction_memory",
        "engine": "memory",
        "title": "방향 기억",
        "instruction": "잠깐 보이는 방향 순서를 기억해 누르세요.",
        "minPlayers": 1,
        "duration": 7,
        "config": {"kind": "directions", "length": 7},
    },
    {
        "id": "number_memory",
        "engine": "memory",
        "title": "숫자 기억",
        "instruction": "잠깐 보이는 숫자열을 기억해 입력하세요.",
        "minPlayers": 1,
        "duration": 7,
        "config": {"kind": "numbers", "length": 8},
    },
    {
        "id": "forbidden_color",
        "engine": "choice",
        "title": "금지 색 피하기",
        "instruction": "화면에 표시된 금지 색만 피하세요. 금지 색이 아닌 아무 색이나 누르면 됩니다.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"options": ["빨강", "파랑", "노랑", "초록"], "forbidden": "빨강"},
    },
    {
        "id": "stroop",
        "engine": "choice",
        "title": "글자색 고르기",
        "instruction": "글자가 무슨 색이라고 쓰여 있는지는 무시하고, 실제로 칠해진 색을 누르세요.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"options": ["빨강", "파랑", "노랑", "초록"], "correct": "파랑", "cue": "빨강", "cueColor": "파랑"},
    },
    {
        "id": "minority_vote",
        "engine": "majority",
        "title": "다수결 함정",
        "instruction": "사람이 적게 고른 쪽이 이깁니다.",
        "minPlayers": 3,
        "duration": 5,
        "config": {"options": ["A", "B"]},
    },
    {
        "id": "unique_number",
        "engine": "majority",
        "title": "눈치게임",
        "instruction": "겹치지 않는 숫자를 고르면 점수입니다.",
        "minPlayers": 2,
        "duration": 5,
        "config": {"options": ["1", "2", "3", "4", "5"], "unique": True},
    },
    {
        "id": "lucky_door",
        "engine": "luck",
        "title": "운명의 문",
        "instruction": "문 하나를 고르세요. 결과는 열어 봐야 압니다.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"options": ["1번 문", "2번 문", "3번 문"]},
    },
    {
        "id": "treasure_box",
        "engine": "luck",
        "title": "보물상자",
        "instruction": "상자 하나를 열어 보세요.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"options": ["빨강 상자", "파랑 상자", "노랑 상자", "초록 상자"]},
    },
    {
        "id": "danger_bridge",
        "engine": "risk",
        "title": "위험한 다리",
        "instruction": "안전한 길은 적은 점수, 위험한 길은 큰 점수입니다.",
        "minPlayers": 1,
        "duration": 5,
        "config": {"options": ["안전한 길", "흔들리는 길", "수상한 지름길"]},
    },
)


def _now() -> float:
    return time.time()


def _room(code: str) -> str:
    return f"{ROOM_PREFIX}{code}"


def _party_room(code: str) -> str:
    return f"{PARTY_ROOM_PREFIX}{code}"


def _turtle_room(code: str) -> str:
    return f"{TURTLE_ROOM_PREFIX}{code}"


def _sanitize_nickname(value: Any) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"[\x00-\x1f\x7f<>]", "", text)
    if len(text) > 8:
        text = text[:8]
    return text


def _parse_hhmm(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    if text == "24:00":
        return 24 * 60
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", text)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour < 0 or hour > 24 or minute < 0 or minute >= 60:
        return None
    return hour * 60 + minute


def _load_phase_config() -> dict[str, Any]:
    path = Path(__file__).with_name("timetable-phases.json")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _phases_for_grade(grade: int, now_dt: datetime) -> list[dict[str, Any]]:
    data = _load_phase_config()
    grade_map = ((data.get("grades") or {}).get(str(grade)) or {})
    default_map = data.get("default") or {}
    key = "sunday" if now_dt.weekday() == 6 else "weekday"
    raw = grade_map.get(key) or default_map.get(key) or []
    phases: list[dict[str, Any]] = []
    for item in raw:
        start = _parse_hhmm(item.get("startMin"))
        end = _parse_hhmm(item.get("endMin"))
        label = str(item.get("label") or "")
        if start is None or end is None or end <= start:
            continue
        phases.append({"label": label, "start": start, "end": end})
    return phases


def _is_arcade_phase(label: str) -> bool:
    normalized = str(label or "")
    return any(token in normalized for token in ("쉬는", "점심", "저녁", "중식", "석식", "휴식"))


def _initial_grid() -> list[list[str]]:
    midpoint = GRID_WIDTH // 2
    return [["red" if x < midpoint else "blue" for x in range(GRID_WIDTH)] for _ in range(GRID_HEIGHT)]


def _play_window(grade: int, now_ts: float | None = None) -> dict[str, Any]:
    now_ts = now_ts or _now()
    now_dt = datetime.fromtimestamp(now_ts, KST)
    minute = now_dt.hour * 60 + now_dt.minute
    second_of_day = minute * 60 + now_dt.second
    day_start = now_dt.replace(hour=0, minute=0, second=0, microsecond=0)

    for phase in _phases_for_grade(grade, now_dt):
        if phase["start"] <= minute < phase["end"]:
            phase_end_ts = day_start.timestamp() + phase["end"] * 60
            safe_end_ts = phase_end_ts - END_BUFFER_SECONDS
            remaining_safe_seconds = int(safe_end_ts - now_ts)
            allowed = _is_arcade_phase(phase["label"]) and remaining_safe_seconds >= MIN_START_WINDOW_SECONDS
            starts_in = 0
            return {
                "allowed": allowed,
                "label": phase["label"],
                "safeEndAt": safe_end_ts,
                "phaseEndAt": phase_end_ts,
                "remainingSafeSeconds": max(0, remaining_safe_seconds),
                "startsInSeconds": starts_in,
                "reason": "" if allowed else "다음 일정 준비 시간이 가까워 Arcade를 시작할 수 없습니다.",
            }

    next_arcade = None
    for phase in _phases_for_grade(grade, now_dt):
        start_seconds = phase["start"] * 60
        if start_seconds <= second_of_day or not _is_arcade_phase(phase["label"]):
            continue
        next_arcade = phase
        break
    return {
        "allowed": False,
        "label": "",
        "safeEndAt": None,
        "phaseEndAt": None,
        "remainingSafeSeconds": 0,
        "startsInSeconds": max(0, (next_arcade["start"] * 60 - second_of_day)) if next_arcade else None,
        "reason": "지금은 Arcade를 시작할 수 있는 시간이 아닙니다.",
    }


@dataclass
class ArcadePlayer:
    id: str
    nickname: str
    team: str
    avatar: int
    x: int
    y: int
    direction: str = "right"
    pending_direction: str = "right"
    contribution: int = 0
    connected: bool = True
    joined_at: float = field(default_factory=_now)
    last_input_at: float = 0.0
    speed_until: float = 0.0

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "nickname": self.nickname,
            "team": self.team,
            "teamLabel": TEAM_LABELS.get(self.team, self.team),
            "avatar": self.avatar,
            "x": self.x,
            "y": self.y,
            "direction": self.direction,
            "contribution": self.contribution,
            "connected": self.connected,
            "boosted": self.speed_until > _now(),
        }


@dataclass
class ArcadeItem:
    id: str
    type: str
    x: int
    y: int
    spawned_at: float
    expires_at: float

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "label": ITEM_LABELS.get(self.type, self.type),
            "x": self.x,
            "y": self.y,
            "expiresAt": int(self.expires_at * 1000),
        }


@dataclass
class ArcadeSession:
    code: str
    grade: int
    section: int
    status: str
    created_at: float
    scheduled_start_at: float
    starts_at: float
    ends_at: float
    phase_label: str
    grid: list[list[str | None]]
    players: dict[str, ArcadePlayer] = field(default_factory=dict)
    items: dict[str, ArcadeItem] = field(default_factory=dict)
    scores: dict[str, int] = field(default_factory=lambda: {"red": 0, "blue": 0})
    tick_running: bool = False
    ended_at: float | None = None
    next_star_at: float = 0.0
    next_speed_at: float = 0.0
    next_bomb_at: float = 0.0
    recent_events: list[dict[str, Any]] = field(default_factory=list)


class ArcadeSessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, ArcadeSession] = {}
        self._lock = threading.RLock()
        self._socketio = None
        self._last_cleanup = 0.0

    def bind_socketio(self, socketio: Any) -> None:
        self._socketio = socketio

    def _has_enough_players_locked(self, session_obj: ArcadeSession) -> bool:
        return len(session_obj.players) >= max(1, config.ARCADE_MIN_PLAYERS)

    def create_session(self, grade: int, section: int, allow_any_time: bool = False) -> tuple[ArcadeSession | None, str | None]:
        if not config.ARCADE_ENABLED:
            return None, "Arcade가 비활성화되어 있습니다."
        window = _play_window(grade) if not allow_any_time else {
            "allowed": True,
            "label": "테스트 모드",
            "safeEndAt": _now() + WAIT_SECONDS + COUNTDOWN_SECONDS + MAX_GAME_SECONDS,
            "phaseEndAt": _now() + WAIT_SECONDS + COUNTDOWN_SECONDS + MAX_GAME_SECONDS,
            "remainingSafeSeconds": WAIT_SECONDS + COUNTDOWN_SECONDS + MAX_GAME_SECONDS,
            "startsInSeconds": 0,
            "reason": "",
        }
        if not window["allowed"]:
            return None, window["reason"]

        with self._lock:
            self._cleanup_locked()
            active = [s for s in self._sessions.values() if s.status != "ended"]
            for existing in active:
                if existing.grade == grade and existing.section == section:
                    return existing, None
            if len(active) >= config.ARCADE_MAX_ACTIVE_SESSIONS:
                return None, "현재 열린 Arcade가 너무 많습니다."
            code = self._new_code_locked()
            now_ts = _now()
            scheduled_start_at = now_ts + WAIT_SECONDS
            starts_at = scheduled_start_at + COUNTDOWN_SECONDS
            game_end_at = min(starts_at + MAX_GAME_SECONDS, float(window["safeEndAt"]))
            if game_end_at - starts_at < 30:
                return None, "게임을 진행하기에 시간이 부족합니다."
            session_obj = ArcadeSession(
                code=code,
                grade=grade,
                section=section,
                status="waiting",
                created_at=now_ts,
                scheduled_start_at=scheduled_start_at,
                starts_at=starts_at,
                ends_at=game_end_at,
                phase_label=str(window["label"] or "Arcade"),
                grid=_initial_grid(),
                scores={"red": INITIAL_RED_CELLS, "blue": INITIAL_BLUE_CELLS},
                next_star_at=starts_at + 2,
                next_speed_at=starts_at + 4,
                next_bomb_at=starts_at + 8,
            )
            self._sessions[code] = session_obj
            return session_obj, None

    def get(self, code: str) -> ArcadeSession | None:
        with self._lock:
            self._cleanup_locked()
            return self._sessions.get(str(code or "").upper())

    def join_player(self, code: str, player_id: str, nickname: str, avatar: int) -> tuple[ArcadePlayer | None, str | None]:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj:
                return None, "존재하지 않는 Arcade입니다."
            if session_obj.status == "ended":
                return None, "이미 종료된 Arcade입니다."
            if player_id in session_obj.players:
                player = session_obj.players[player_id]
                player.connected = True
                return player, None
            if len(session_obj.players) >= config.ARCADE_MAX_PLAYERS:
                return None, "참가 인원이 가득 찼습니다."
            clean_name = _sanitize_nickname(nickname)
            if len(clean_name) < 2:
                return None, "닉네임은 2자 이상이어야 합니다."
            clean_name = self._dedupe_nickname_locked(session_obj, clean_name)
            team = self._next_team_locked(session_obj)
            avatar_id = int(avatar) if isinstance(avatar, int) or str(avatar).isdigit() else random.randrange(AVATAR_COUNT)
            x, y = self._spawn_position_locked(session_obj, team)
            player = ArcadePlayer(
                id=player_id,
                nickname=clean_name,
                team=team,
                avatar=avatar_id % AVATAR_COUNT,
                x=x,
                y=y,
                direction="right" if team == "red" else "left",
                pending_direction="right" if team == "red" else "left",
            )
            session_obj.players[player_id] = player
            self._claim_cell_locked(session_obj, player.x, player.y, player.team, player)
            return player, None

    def mark_connected(self, code: str, player_id: str | None, connected: bool) -> None:
        if not player_id:
            return
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if session_obj and player_id in session_obj.players:
                session_obj.players[player_id].connected = connected

    def set_input(self, code: str, player_id: str, direction: str) -> bool:
        if direction not in VALID_DIRECTIONS:
            return False
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj or session_obj.status not in {"countdown", "running"}:
                return False
            player = session_obj.players.get(player_id)
            if not player:
                return False
            now_ts = _now()
            if now_ts - player.last_input_at < 0.09:
                return False
            player.pending_direction = direction
            player.last_input_at = now_ts
            return True

    def start_now(self, code: str) -> ArcadeSession | None:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj or session_obj.status == "ended":
                return None
            if not self._has_enough_players_locked(session_obj):
                return None
            now_ts = _now()
            session_obj.scheduled_start_at = now_ts
            session_obj.starts_at = now_ts + COUNTDOWN_SECONDS
            return session_obj

    def end_session(self, code: str) -> ArcadeSession | None:
        normalized_code = str(code or "").upper()
        with self._lock:
            session_obj = self._sessions.get(normalized_code)
            if not session_obj:
                return None
            self._end_locked(session_obj)
            snapshot = self._snapshot_locked(session_obj)
        self._emit("arcade:state", snapshot, normalized_code)
        self._emit("arcade:ended", snapshot, normalized_code)
        return session_obj

    def snapshot(self, session_obj: ArcadeSession, full_grid: bool = True) -> dict[str, Any]:
        with self._lock:
            return self._snapshot_locked(session_obj, full_grid=full_grid)

    def tick(self, code: str) -> None:
        with self._lock:
            session_obj = self._sessions.get(code)
            if not session_obj or session_obj.tick_running:
                return
            session_obj.tick_running = True
        try:
            while True:
                with self._lock:
                    session_obj = self._sessions.get(code)
                    if not session_obj or session_obj.status == "ended":
                        return
                    changed_cells = self._advance_locked(session_obj)
                    snapshot = self._snapshot_locked(session_obj, full_grid=False, changed_cells=changed_cells)
                    should_end = session_obj.status == "ended"
                self._emit("arcade:state", snapshot, code)
                if should_end:
                    self._emit("arcade:ended", self.snapshot(session_obj), code)
                    return
                time.sleep(config.ARCADE_TICK_MS / 1000)
        finally:
            with self._lock:
                session_obj = self._sessions.get(code)
                if session_obj:
                    session_obj.tick_running = False

    def _emit(self, event: str, payload: dict[str, Any], code: str) -> None:
        if not self._socketio:
            return
        self._socketio.emit(event, payload, namespace=ARCADE_NAMESPACE, room=_room(code))

    def _new_code_locked(self) -> str:
        alphabet = string.ascii_uppercase + string.digits
        while True:
            code = "".join(secrets.choice(alphabet) for _ in range(5))
            if code not in self._sessions:
                return code

    def _cleanup_locked(self) -> None:
        now_ts = _now()
        if now_ts - self._last_cleanup < SESSION_CLEANUP_INTERVAL_SECONDS:
            return
        self._last_cleanup = now_ts
        expired = []
        for code, session_obj in self._sessions.items():
            ttl_expired = now_ts - session_obj.created_at > config.ARCADE_SESSION_TTL_SECONDS
            ended_expired = session_obj.status == "ended" and session_obj.ended_at and now_ts - session_obj.ended_at > 120
            if ttl_expired or ended_expired:
                expired.append(code)
        for code in expired:
            self._sessions.pop(code, None)

    def _dedupe_nickname_locked(self, session_obj: ArcadeSession, nickname: str) -> str:
        existing = {player.nickname for player in session_obj.players.values()}
        if nickname not in existing:
            return nickname
        base = nickname[:6]
        idx = 2
        while f"{base}#{idx}" in existing:
            idx += 1
        return f"{base}#{idx}"

    def _next_team_locked(self, session_obj: ArcadeSession) -> str:
        counts = {team: 0 for team in TEAM_ORDER}
        for player in session_obj.players.values():
            counts[player.team] = counts.get(player.team, 0) + 1
        return min(TEAM_ORDER, key=lambda team: counts.get(team, 0))

    def _spawn_position_locked(self, session_obj: ArcadeSession, team: str) -> tuple[int, int]:
        count = sum(1 for player in session_obj.players.values() if player.team == team)
        if team == "red":
            base_x = 2
            base_y = 2 + count * 2
        else:
            base_x = GRID_WIDTH - 3
            base_y = GRID_HEIGHT - 3 - count * 2
        return max(0, min(GRID_WIDTH - 1, base_x)), base_y % GRID_HEIGHT

    def _spawn_item_locked(self, session_obj: ArcadeSession, item_type: str, now_ts: float) -> ArcadeItem | None:
        if len(session_obj.items) >= 6:
            return None
        occupied = {(player.x, player.y) for player in session_obj.players.values()}
        occupied.update((item.x, item.y) for item in session_obj.items.values())
        for _ in range(40):
            x = random.randrange(2, GRID_WIDTH - 2)
            y = random.randrange(1, GRID_HEIGHT - 1)
            if (x, y) in occupied:
                continue
            item = ArcadeItem(
                id=f"{item_type}-{secrets.token_hex(4)}",
                type=item_type,
                x=x,
                y=y,
                spawned_at=now_ts,
                expires_at=now_ts + ITEM_EXPIRE_SECONDS,
            )
            session_obj.items[item.id] = item
            self._record_event_locked(session_obj, "spawn", item_type, f"{ITEM_LABELS.get(item_type, item_type)} 등장")
            return item
        return None

    def _maybe_spawn_items_locked(self, session_obj: ArcadeSession, now_ts: float) -> None:
        fever = self._is_fever_locked(session_obj, now_ts)
        star_interval = 4 if fever else STAR_INTERVAL_SECONDS
        if now_ts >= session_obj.next_star_at:
            self._spawn_item_locked(session_obj, "star", now_ts)
            session_obj.next_star_at = now_ts + star_interval
        if now_ts >= session_obj.next_speed_at:
            self._spawn_item_locked(session_obj, "speed", now_ts)
            session_obj.next_speed_at = now_ts + SPEED_INTERVAL_SECONDS
        if now_ts >= session_obj.next_bomb_at:
            if fever or random.random() < 0.45:
                self._spawn_item_locked(session_obj, "bomb", now_ts)
            session_obj.next_bomb_at = now_ts + BOMB_INTERVAL_SECONDS

    def _expire_items_locked(self, session_obj: ArcadeSession, now_ts: float) -> None:
        expired = [item_id for item_id, item in session_obj.items.items() if item.expires_at <= now_ts]
        for item_id in expired:
            session_obj.items.pop(item_id, None)

    def _claim_cell_locked(self, session_obj: ArcadeSession, x: int, y: int, team: str, player: ArcadePlayer | None = None) -> bool:
        if x < 0 or y < 0 or x >= GRID_WIDTH or y >= GRID_HEIGHT:
            return False
        previous = session_obj.grid[y][x]
        if previous == team:
            return False
        session_obj.grid[y][x] = team
        if previous in session_obj.scores:
            session_obj.scores[previous] = max(0, session_obj.scores.get(previous, 0) - 1)
        session_obj.scores[team] = session_obj.scores.get(team, 0) + 1
        if player:
            player.contribution += 1
        return True

    def _claim_area_locked(
        self,
        session_obj: ArcadeSession,
        center_x: int,
        center_y: int,
        radius: int,
        team: str,
        player: ArcadePlayer | None,
    ) -> list[list[Any]]:
        changed: list[list[Any]] = []
        for y in range(center_y - radius, center_y + radius + 1):
            for x in range(center_x - radius, center_x + radius + 1):
                if self._claim_cell_locked(session_obj, x, y, team, player):
                    changed.append([x, y, team])
        return changed

    def _consume_item_locked(self, session_obj: ArcadeSession, player: ArcadePlayer, changed: list[list[Any]], now_ts: float) -> None:
        consumed = None
        for item_id, item in session_obj.items.items():
            if item.x == player.x and item.y == player.y:
                consumed = item_id
                break
        if not consumed:
            return
        item = session_obj.items.pop(consumed)
        if item.type == "speed":
            player.speed_until = now_ts + SPEED_BOOST_SECONDS
            self._record_event_locked(session_obj, "pickup", item.type, f"{player.nickname} 스피드 업")
            return
        radius = ITEM_RADIUS.get(item.type)
        if radius is None:
            return
        changed.extend(self._claim_area_locked(session_obj, item.x, item.y, radius, player.team, player))
        self._record_event_locked(
            session_obj,
            "pickup",
            item.type,
            f"{player.nickname} {ITEM_LABELS.get(item.type, item.type)}",
            player.team,
        )

    def _record_event_locked(
        self,
        session_obj: ArcadeSession,
        event_type: str,
        item_type: str,
        message: str,
        team: str | None = None,
    ) -> None:
        session_obj.recent_events.append(
            {
                "type": event_type,
                "itemType": item_type,
                "label": ITEM_LABELS.get(item_type, item_type),
                "message": message,
                "team": team,
                "at": int(_now() * 1000),
            }
        )
        if len(session_obj.recent_events) > 6:
            del session_obj.recent_events[:-6]

    def _is_fever_locked(self, session_obj: ArcadeSession, now_ts: float) -> bool:
        return session_obj.status == "running" and session_obj.ends_at - now_ts <= FEVER_SECONDS

    def _recompute_scores_locked(self, session_obj: ArcadeSession) -> None:
        scores = {"red": 0, "blue": 0}
        for row in session_obj.grid:
            for cell in row:
                if cell in scores:
                    scores[cell] += 1
        session_obj.scores = scores

    def _advance_locked(self, session_obj: ArcadeSession) -> list[list[Any]]:
        now_ts = _now()
        if (
            session_obj.status == "waiting"
            and now_ts >= session_obj.scheduled_start_at
            and self._has_enough_players_locked(session_obj)
        ):
            session_obj.status = "countdown"
        if session_obj.status == "countdown" and now_ts >= session_obj.starts_at:
            session_obj.status = "running"
        if now_ts >= session_obj.ends_at:
            self._end_locked(session_obj)
            return []
        if session_obj.status != "running":
            return []

        self._expire_items_locked(session_obj, now_ts)
        self._maybe_spawn_items_locked(session_obj, now_ts)
        changed: list[list[Any]] = []
        for player in session_obj.players.values():
            move_steps = 2 if player.speed_until > now_ts else 1
            for _ in range(move_steps):
                direction = player.pending_direction if player.pending_direction in VALID_DIRECTIONS else player.direction
                dx, dy = DIR_DELTA[direction]
                nx = player.x + dx
                ny = player.y + dy
                if nx < 0 or ny < 0 or nx >= GRID_WIDTH or ny >= GRID_HEIGHT:
                    break
                player.direction = direction
                player.x = nx
                player.y = ny
                if self._claim_cell_locked(session_obj, nx, ny, player.team, player):
                    changed.append([nx, ny, player.team])
                self._consume_item_locked(session_obj, player, changed, now_ts)
        return changed

    def _end_locked(self, session_obj: ArcadeSession) -> None:
        if session_obj.status == "ended":
            return
        session_obj.status = "ended"
        session_obj.ended_at = _now()
        self._recompute_scores_locked(session_obj)

    def _snapshot_locked(
        self,
        session_obj: ArcadeSession,
        full_grid: bool = True,
        changed_cells: list[list[Any]] | None = None,
    ) -> dict[str, Any]:
        now_ts = _now()
        winner = None
        if session_obj.status == "ended":
            red = session_obj.scores.get("red", 0)
            blue = session_obj.scores.get("blue", 0)
            winner = "draw" if red == blue else ("red" if red > blue else "blue")
        payload = {
            "code": session_obj.code,
            "grade": session_obj.grade,
            "section": session_obj.section,
            "status": session_obj.status,
            "phaseLabel": session_obj.phase_label,
            "gridWidth": GRID_WIDTH,
            "gridHeight": GRID_HEIGHT,
            "scheduledStartAt": int(session_obj.scheduled_start_at * 1000),
            "startsAt": int(session_obj.starts_at * 1000),
            "endsAt": int(session_obj.ends_at * 1000),
            "now": int(now_ts * 1000),
            "scores": deepcopy(session_obj.scores),
            "players": [player.public() for player in session_obj.players.values()],
            "items": [item.public() for item in session_obj.items.values()],
            "events": deepcopy(session_obj.recent_events),
            "fever": self._is_fever_locked(session_obj, now_ts),
            "winner": winner,
            "winnerLabel": TEAM_LABELS.get(winner, "무승부") if winner else None,
            "resultSeconds": RESULT_SECONDS,
        }
        if full_grid:
            payload["grid"] = deepcopy(session_obj.grid)
        if changed_cells is not None:
            payload["changedCells"] = changed_cells
        return payload


arcade_manager = ArcadeSessionManager()


@dataclass
class PartyPlayer:
    id: str
    nickname: str
    avatar: int
    connected: bool = True
    joined_at: float = field(default_factory=_now)
    score: int = 0
    rounds_played: int = 0
    last_seen_at: float = field(default_factory=_now)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "nickname": self.nickname,
            "avatar": self.avatar,
            "connected": self.connected,
            "score": self.score,
            "roundsPlayed": self.rounds_played,
            "averageScore": round(self.score / self.rounds_played, 1) if self.rounds_played else 0,
        }


@dataclass
class PartyRound:
    id: str
    index: int
    definition: dict[str, Any]
    status: str
    intro_at: float
    starts_at: float
    ends_at: float
    result_at: float
    participants: list[str]
    prompt: dict[str, Any]
    submissions: dict[str, dict[str, Any]] = field(default_factory=dict)
    results: list[dict[str, Any]] = field(default_factory=list)

    def public(self, include_answer: bool = False) -> dict[str, Any]:
        prompt = deepcopy(self.prompt)
        if not include_answer:
            prompt.pop("answer", None)
            prompt.pop("answers", None)
            if self.status != "round_result":
                prompt.pop("outcomes", None)
        return {
            "id": self.id,
            "index": self.index,
            "gameId": self.definition["id"],
            "engine": self.definition["engine"],
            "title": self.definition["title"],
            "instruction": self.definition["instruction"],
            "status": self.status,
            "introAt": int(self.intro_at * 1000),
            "startsAt": int(self.starts_at * 1000),
            "endsAt": int(self.ends_at * 1000),
            "resultAt": int(self.result_at * 1000),
            "participants": list(self.participants),
            "submittedCount": len(self.submissions),
            "prompt": prompt,
            "results": deepcopy(self.results),
        }


@dataclass
class PartySession:
    code: str
    grade: int
    section: int
    status: str
    created_at: float
    ends_at: float
    phase_label: str
    round_count: int = PARTY_MAX_ROUNDS
    current_round_index: int = 0
    next_transition_at: float = 0.0
    players: dict[str, PartyPlayer] = field(default_factory=dict)
    current_round: PartyRound | None = None
    ended_at: float | None = None
    loop_running: bool = False
    recent_game_ids: list[str] = field(default_factory=list)


class PartySessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, PartySession] = {}
        self._lock = threading.RLock()
        self._socketio = None
        self._last_cleanup = 0.0

    def bind_socketio(self, socketio: Any) -> None:
        self._socketio = socketio

    def create_session(self, grade: int, section: int, allow_any_time: bool = False) -> tuple[PartySession | None, str | None]:
        if not config.ARCADE_ENABLED:
            return None, "Arcade가 비활성화되어 있습니다."
        window = _play_window(grade) if not allow_any_time else {
            "allowed": True,
            "label": "테스트 모드",
            "safeEndAt": _now() + 420,
            "phaseEndAt": _now() + 420,
            "remainingSafeSeconds": 420,
            "startsInSeconds": 0,
            "reason": "",
        }
        if not window["allowed"]:
            return None, window["reason"]

        with self._lock:
            self._cleanup_locked()
            active = [s for s in self._sessions.values() if s.status != "ended"]
            for existing in active:
                if existing.grade == grade and existing.section == section:
                    return existing, None
            if len(active) >= config.ARCADE_MAX_ACTIVE_SESSIONS:
                return None, "현재 열린 Arcade가 너무 많습니다."
            code = self._new_code_locked()
            now_ts = _now()
            safe_end = float(window["safeEndAt"])
            session_obj = PartySession(
                code=code,
                grade=grade,
                section=section,
                status="lobby",
                created_at=now_ts,
                ends_at=safe_end,
                phase_label=str(window["label"] or "Party"),
            )
            self._sessions[code] = session_obj
            return session_obj, None

    def get(self, code: str) -> PartySession | None:
        with self._lock:
            self._cleanup_locked()
            return self._sessions.get(str(code or "").upper())

    def join_player(self, code: str, player_id: str, nickname: str, avatar: int) -> tuple[PartyPlayer | None, str | None]:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj:
                return None, "존재하지 않는 Party입니다."
            if session_obj.status == "ended":
                return None, "이미 종료된 Party입니다."
            if player_id in session_obj.players:
                player = session_obj.players[player_id]
                player.connected = True
                player.last_seen_at = _now()
                return player, None
            if len(session_obj.players) >= config.ARCADE_MAX_PLAYERS:
                return None, "참가 인원이 가득 찼습니다."
            clean_name = _sanitize_nickname(nickname)
            if len(clean_name) < 2:
                return None, "닉네임은 2자 이상이어야 합니다."
            clean_name = self._dedupe_nickname_locked(session_obj, clean_name)
            avatar_id = int(avatar) if isinstance(avatar, int) or str(avatar).isdigit() else random.randrange(AVATAR_COUNT)
            player = PartyPlayer(id=player_id, nickname=clean_name, avatar=avatar_id % AVATAR_COUNT)
            session_obj.players[player_id] = player
            return player, None

    def mark_connected(self, code: str, player_id: str | None, connected: bool) -> None:
        if not player_id:
            return
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if session_obj and player_id in session_obj.players:
                session_obj.players[player_id].connected = connected
                session_obj.players[player_id].last_seen_at = _now()

    def start_now(self, code: str) -> tuple[PartySession | None, str | None]:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj or session_obj.status == "ended":
                return None, "not found"
            if not self._connected_players_locked(session_obj):
                return None, "참가자가 1명 이상 필요합니다."
            if session_obj.current_round_index >= session_obj.round_count:
                self._end_locked(session_obj)
                return session_obj, None
            if not self._has_round_time_locked(session_obj):
                self._end_locked(session_obj)
                return session_obj, "남은 시간이 부족합니다."
            now_ts = _now()
            session_obj.status = "countdown"
            session_obj.next_transition_at = now_ts + PARTY_WAIT_SECONDS
            return session_obj, None

    def submit(self, code: str, player_id: str, value: Any, round_id: str | None = None) -> tuple[PartySession | None, str | None]:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj:
                return None, "지금은 제출할 수 없습니다."
            round_obj = session_obj.current_round
            if not round_obj:
                return session_obj, None
            if round_id and str(round_id) != round_obj.id:
                return session_obj, None
            if session_obj.status != "playing":
                return session_obj, None
            if player_id not in round_obj.participants:
                return None, "다음 라운드부터 참여할 수 있습니다."
            if player_id in round_obj.submissions:
                return session_obj, None
            round_obj.submissions[player_id] = {
                "value": value,
                "submittedAt": _now(),
            }
            if len(round_obj.submissions) >= len(round_obj.participants):
                self._finish_round_locked(session_obj)
            return session_obj, None

    def end_session(self, code: str) -> PartySession | None:
        normalized_code = str(code or "").upper()
        with self._lock:
            session_obj = self._sessions.get(normalized_code)
            if not session_obj:
                return None
            self._end_locked(session_obj)
            snapshot = self._snapshot_locked(session_obj)
        self._emit("party:state", snapshot, normalized_code)
        self._emit("party:ended", snapshot, normalized_code)
        return session_obj

    def snapshot(self, session_obj: PartySession) -> dict[str, Any]:
        with self._lock:
            return self._snapshot_locked(session_obj)

    def run_loop(self, code: str) -> None:
        with self._lock:
            session_obj = self._sessions.get(code)
            if not session_obj or session_obj.loop_running:
                return
            session_obj.loop_running = True
        try:
            while True:
                should_emit = False
                ended = False
                with self._lock:
                    session_obj = self._sessions.get(code)
                    if not session_obj or session_obj.status == "ended":
                        return
                    should_emit = self._advance_locked(session_obj)
                    ended = session_obj.status == "ended"
                    snapshot = self._snapshot_locked(session_obj)
                if should_emit:
                    self._emit("party:state", snapshot, code)
                    if ended:
                        self._emit("party:ended", snapshot, code)
                        return
                time.sleep(0.35)
        finally:
            with self._lock:
                session_obj = self._sessions.get(code)
                if session_obj:
                    session_obj.loop_running = False

    def _emit(self, event: str, payload: dict[str, Any], code: str) -> None:
        if self._socketio:
            self._socketio.emit(event, payload, namespace=ARCADE_NAMESPACE, room=_party_room(code))

    def _new_code_locked(self) -> str:
        alphabet = string.ascii_uppercase + string.digits
        while True:
            code = "".join(secrets.choice(alphabet) for _ in range(5))
            if code not in self._sessions and not arcade_manager.get(code):
                return code

    def _cleanup_locked(self) -> None:
        now_ts = _now()
        if now_ts - self._last_cleanup < SESSION_CLEANUP_INTERVAL_SECONDS:
            return
        self._last_cleanup = now_ts
        expired = []
        for code, session_obj in self._sessions.items():
            ttl_expired = now_ts - session_obj.created_at > config.ARCADE_SESSION_TTL_SECONDS
            ended_expired = session_obj.status == "ended" and session_obj.ended_at and now_ts - session_obj.ended_at > 120
            if ttl_expired or ended_expired:
                expired.append(code)
        for code in expired:
            self._sessions.pop(code, None)

    def _dedupe_nickname_locked(self, session_obj: PartySession, nickname: str) -> str:
        existing = {player.nickname for player in session_obj.players.values()}
        if nickname not in existing:
            return nickname
        base = nickname[:6]
        idx = 2
        while f"{base}#{idx}" in existing:
            idx += 1
        return f"{base}#{idx}"

    def _connected_players_locked(self, session_obj: PartySession) -> list[PartyPlayer]:
        return [player for player in session_obj.players.values() if player.connected]

    def _has_round_time_locked(self, session_obj: PartySession) -> bool:
        return session_obj.ends_at - _now() >= PARTY_WAIT_SECONDS + PARTY_INTRO_SECONDS + PARTY_RESULT_SECONDS + 5

    def _advance_locked(self, session_obj: PartySession) -> bool:
        now_ts = _now()
        if now_ts >= session_obj.ends_at:
            self._end_locked(session_obj)
            return True
        if session_obj.status == "countdown" and now_ts >= session_obj.next_transition_at:
            self._begin_round_locked(session_obj)
            return True
        if session_obj.status == "round_intro" and session_obj.current_round and now_ts >= session_obj.current_round.starts_at:
            session_obj.status = "playing"
            session_obj.current_round.status = "playing"
            return True
        if session_obj.status == "playing" and session_obj.current_round and now_ts >= session_obj.current_round.ends_at:
            self._finish_round_locked(session_obj)
            return True
        if session_obj.status == "round_result" and now_ts >= session_obj.next_transition_at:
            if session_obj.current_round_index >= session_obj.round_count or not self._has_round_time_locked(session_obj):
                self._end_locked(session_obj)
            else:
                session_obj.status = "countdown"
                session_obj.next_transition_at = now_ts + PARTY_WAIT_SECONDS
            return True
        return False

    def _begin_round_locked(self, session_obj: PartySession) -> None:
        participants = [player.id for player in self._connected_players_locked(session_obj)]
        if not participants:
            session_obj.status = "lobby"
            return
        definition = self._select_game_locked(session_obj, len(participants))
        now_ts = _now()
        intro_at = now_ts
        starts_at = now_ts + PARTY_INTRO_SECONDS
        ends_at = starts_at + int(definition["duration"])
        result_at = ends_at + PARTY_RESULT_SECONDS
        session_obj.current_round_index += 1
        session_obj.current_round = PartyRound(
            id=f"r{session_obj.current_round_index}-{secrets.token_hex(3)}",
            index=session_obj.current_round_index,
            definition=definition,
            status="round_intro",
            intro_at=intro_at,
            starts_at=starts_at,
            ends_at=min(ends_at, session_obj.ends_at),
            result_at=min(result_at, session_obj.ends_at),
            participants=participants,
            prompt=self._make_prompt(definition, starts_at, ends_at),
        )
        session_obj.status = "round_intro"
        session_obj.recent_game_ids.append(definition["id"])
        del session_obj.recent_game_ids[:-3]

    def _select_game_locked(self, session_obj: PartySession, player_count: int) -> dict[str, Any]:
        recent_engines = {
            definition["engine"]
            for recent_id in session_obj.recent_game_ids[-3:]
            for definition in PARTY_MINIGAMES
            if definition["id"] == recent_id
        }
        candidates = [
            definition
            for definition in PARTY_MINIGAMES
            if player_count >= int(definition.get("minPlayers") or 1)
            and definition["id"] not in session_obj.recent_game_ids
            and definition["engine"] not in recent_engines
        ]
        if not candidates:
            candidates = [definition for definition in PARTY_MINIGAMES if player_count >= int(definition.get("minPlayers") or 1)]
        return deepcopy(random.choice(candidates or list(PARTY_MINIGAMES)))

    def _make_prompt(self, definition: dict[str, Any], starts_at: float, ends_at: float) -> dict[str, Any]:
        config_data = definition.get("config") or {}
        engine = definition["engine"]
        prompt: dict[str, Any] = {
            "engine": engine,
            "durationMs": int((ends_at - starts_at) * 1000),
        }
        if engine == "reaction":
            arm_at = starts_at + random.uniform(1.1, max(1.2, (ends_at - starts_at) - 1.0))
            prompt.update({"signalAt": int(arm_at * 1000), "late": bool(config_data.get("late")), "label": config_data.get("signal") or "신호"})
            if config_data.get("fake"):
                fake_at = starts_at + max(0.45, (arm_at - starts_at) * 0.48)
                prompt["fakeAt"] = int(fake_at * 1000)
        elif engine == "timing":
            prompt.update({"targetMs": int(config_data.get("targetMs") or 4000), "hold": bool(config_data.get("hold"))})
        elif engine == "memory":
            prompt["sequence"] = self._make_memory_sequence(config_data)
            prompt["hideAfterMs"] = int(config_data.get("hideAfterMs") or 2200)
        elif engine == "choice":
            options = list(config_data.get("options") or ["A", "B", "C", "D"])
            correct = config_data.get("correct")
            if not correct and config_data.get("forbidden") in options:
                correct_options = [option for option in options if option != config_data["forbidden"]]
            else:
                correct_options = [correct or random.choice(options)]
            prompt.update({
                "options": options,
                "cue": config_data.get("cue"),
                "cueColor": config_data.get("cueColor"),
                "forbidden": config_data.get("forbidden"),
                "answers": correct_options,
            })
        elif engine == "majority":
            prompt.update({"options": list(config_data.get("options") or ["A", "B"]), "unique": bool(config_data.get("unique"))})
        elif engine == "luck":
            options = list(config_data.get("options") or ["A", "B", "C"])
            scores = [0, 30, 60, 100]
            random.shuffle(scores)
            prompt.update({"options": options, "outcomes": {option: scores[index % len(scores)] for index, option in enumerate(options)}})
        elif engine == "mash":
            prompt.update({"label": config_data.get("label") or "연타"})
        elif engine == "target":
            cells = max(4, min(int(config_data.get("cells") or 9), 16))
            step_ms = max(450, min(int(config_data.get("stepMs") or 750), 1200))
            duration_ms = int((ends_at - starts_at) * 1000)
            slots = []
            previous = -1
            for at_ms in range(0, duration_ms, step_ms):
                cell = random.randrange(cells)
                if cells > 1 and cell == previous:
                    cell = (cell + random.randrange(1, cells)) % cells
                previous = cell
                slots.append({"atMs": at_ms, "cell": cell})
            prompt.update({"cells": cells, "stepMs": step_ms, "label": config_data.get("label") or "목표", "targets": slots})
        elif engine == "risk":
            options = list(config_data.get("options") or ["안전", "도전", "위험"])
            shuffled_scores = random.sample([35, 65, 100], k=min(3, len(options)))
            if len(options) > len(shuffled_scores):
                shuffled_scores.extend(random.choice([0, 45, 75, 100]) for _ in range(len(options) - len(shuffled_scores)))
            prompt.update({"options": options, "outcomes": dict(zip(options, shuffled_scores, strict=False))})
        elif engine == "slider":
            target = int(config_data.get("target") or random.randrange(15, 86))
            prompt.update({"target": target, "label": config_data.get("label") or "목표", "unit": config_data.get("unit") or ""})
        elif engine == "order":
            answer = [str(item) for item in config_data.get("items") or ["1", "2", "3", "4"]]
            if config_data.get("direction") == "asc":
                answer = sorted(answer, key=lambda item: int(item) if item.isdigit() else item)
            options = answer[:]
            random.shuffle(options)
            prompt.update({"options": options, "answer": answer, "label": config_data.get("label") or "순서대로"})
        return prompt

    def _make_memory_sequence(self, config_data: dict[str, Any]) -> list[str]:
        pools = {
            "colors": ["빨강", "파랑", "노랑", "초록"],
            "directions": ["위", "아래", "왼쪽", "오른쪽"],
            "numbers": list("0123456789"),
        }
        pool = pools.get(str(config_data.get("kind") or "colors"), pools["colors"])
        length = int(config_data.get("length") or 5)
        return [random.choice(pool) for _ in range(length)]

    def _finish_round_locked(self, session_obj: PartySession) -> None:
        round_obj = session_obj.current_round
        if not round_obj or round_obj.status == "round_result":
            return
        round_obj.results = self._score_round_locked(session_obj, round_obj)
        for result in round_obj.results:
            player = session_obj.players.get(result["playerId"])
            if not player:
                continue
            player.score += int(result["score"])
            player.rounds_played += 1
        round_obj.status = "round_result"
        session_obj.status = "round_result"
        session_obj.next_transition_at = min(_now() + PARTY_RESULT_SECONDS, session_obj.ends_at)

    def _score_round_locked(self, session_obj: PartySession, round_obj: PartyRound) -> list[dict[str, Any]]:
        engine = round_obj.definition["engine"]
        scores: list[dict[str, Any]] = []
        counts: dict[str, int] = {}
        if engine == "majority":
            for submission in round_obj.submissions.values():
                value = str(submission.get("value") or "")
                counts[value] = counts.get(value, 0) + 1
        if engine == "mash":
            max_count = 0
            for submission in round_obj.submissions.values():
                try:
                    max_count = max(max_count, int(submission.get("value") or 0))
                except (TypeError, ValueError):
                    continue
            counts["__max__"] = max_count
        if engine == "target":
            max_net = 0
            for submission in round_obj.submissions.values():
                raw_value = submission.get("value") or {}
                if not isinstance(raw_value, dict):
                    continue
                try:
                    net = max(0, int(raw_value.get("hits") or 0) - int(raw_value.get("misses") or 0))
                    max_net = max(max_net, net)
                except (TypeError, ValueError):
                    continue
            counts["__max_net__"] = max_net
        for player_id in round_obj.participants:
            player = session_obj.players.get(player_id)
            submission = round_obj.submissions.get(player_id)
            score, note = self._score_submission(engine, round_obj, submission, counts)
            scores.append({
                "playerId": player_id,
                "nickname": player.nickname if player else "Unknown",
                "score": int(max(0, min(100, score))),
                "note": note,
                "submitted": bool(submission),
            })
        scores.sort(key=lambda item: item["score"], reverse=True)
        return scores

    def _score_submission(
        self,
        engine: str,
        round_obj: PartyRound,
        submission: dict[str, Any] | None,
        counts: dict[str, int],
    ) -> tuple[int, str]:
        if not submission:
            return 0, "미제출"
        value = submission.get("value")
        prompt = round_obj.prompt
        submitted_at_ms = int(float(submission["submittedAt"]) * 1000)
        if engine == "reaction":
            signal_at = int(prompt["signalAt"])
            if submitted_at_ms < signal_at:
                return 0, "너무 빨랐음"
            if prompt.get("late"):
                diff = max(0, int(round_obj.ends_at * 1000) - submitted_at_ms)
                return max(0, 100 - int(diff / 45)), "늦을수록 고득점"
            reaction = submitted_at_ms - signal_at
            return max(0, 100 - int(reaction / 18)), f"{reaction}ms"
        if engine == "timing":
            try:
                value_ms = int(value)
            except (TypeError, ValueError):
                value_ms = submitted_at_ms - int(round_obj.starts_at * 1000)
            target = int(prompt["targetMs"])
            diff = abs(value_ms - target)
            return max(0, 100 - int(diff / 22)), f"{diff}ms 차이"
        if engine == "memory":
            answer = [str(item) for item in prompt.get("sequence", [])]
            given = [str(item) for item in (value if isinstance(value, list) else [])]
            correct = sum(1 for idx, item in enumerate(answer) if idx < len(given) and given[idx] == item)
            return int((correct / max(1, len(answer))) * 100), f"{correct}/{len(answer)}"
        if engine == "choice":
            answers = {str(item) for item in prompt.get("answers", [])}
            return (100, "정답") if str(value) in answers else (0, "오답")
        if engine == "majority":
            choice = str(value)
            if not choice:
                return 0, "미선택"
            if prompt.get("unique"):
                return (100, "유일 선택") if counts.get(choice, 0) == 1 else (25, "겹침")
            min_count = min(counts.values()) if counts else 0
            return (100, "소수 선택") if counts.get(choice, 0) == min_count else (25, "다수 선택")
        if engine == "luck":
            outcomes = prompt.get("outcomes") or {}
            score = int(outcomes.get(str(value), 0))
            return score, f"{score}점"
        if engine == "mash":
            try:
                count = max(0, int(value))
            except (TypeError, ValueError):
                count = 0
            max_count = max(1, int(counts.get("__max__") or count or 1))
            return int((count / max_count) * 100), f"{count}회"
        if engine == "target":
            raw_value = value if isinstance(value, dict) else {}
            try:
                hits = max(0, int(raw_value.get("hits") or 0))
                misses = max(0, int(raw_value.get("misses") or 0))
            except (TypeError, ValueError):
                hits = 0
                misses = 0
            net = max(0, hits - misses)
            max_net = max(1, int(counts.get("__max_net__") or net or 1))
            return int((net / max_net) * 100), f"{hits}회 성공 · {misses}회 실수"
        if engine == "risk":
            outcomes = prompt.get("outcomes") or {}
            score = int(outcomes.get(str(value), 0))
            return score, f"{score}점 선택"
        if engine == "slider":
            try:
                selected = int(value)
            except (TypeError, ValueError):
                selected = 0
            diff = abs(selected - int(prompt.get("target") or 0))
            return max(0, 100 - diff * 3), f"{diff} 차이"
        if engine == "order":
            answer = [str(item) for item in prompt.get("answer", [])]
            given = [str(item) for item in (value if isinstance(value, list) else [])]
            correct = sum(1 for idx, item in enumerate(answer) if idx < len(given) and given[idx] == item)
            return int((correct / max(1, len(answer))) * 100), f"{correct}/{len(answer)}"
        return 0, "채점 불가"

    def _end_locked(self, session_obj: PartySession) -> None:
        if session_obj.status == "ended":
            return
        session_obj.status = "ended"
        session_obj.ended_at = _now()

    def _snapshot_locked(self, session_obj: PartySession) -> dict[str, Any]:
        now_ts = _now()
        players = [player.public() for player in session_obj.players.values()]
        total_ranking = sorted(players, key=lambda item: item["score"], reverse=True)
        average_ranking = sorted(players, key=lambda item: (item["averageScore"], item["roundsPlayed"]), reverse=True)
        return {
            "mode": "party",
            "code": session_obj.code,
            "grade": session_obj.grade,
            "section": session_obj.section,
            "status": session_obj.status,
            "phaseLabel": session_obj.phase_label,
            "roundIndex": session_obj.current_round_index,
            "roundCount": session_obj.round_count,
            "endsAt": int(session_obj.ends_at * 1000),
            "nextTransitionAt": int(session_obj.next_transition_at * 1000),
            "now": int(now_ts * 1000),
            "players": players,
            "currentRound": session_obj.current_round.public() if session_obj.current_round else None,
            "rankings": {
                "total": total_ranking,
                "average": average_ranking,
            },
            "resultSeconds": PARTY_RESULT_SECONDS,
        }


party_manager = PartySessionManager()


@dataclass
class TurtlePlayer:
    id: str
    nickname: str
    avatar: int
    lane: int
    skin: str
    role: str = "player"
    progress: float = 0.0
    taps: int = 0
    connected: bool = True
    joined_at: float = field(default_factory=_now)
    last_seen_at: float = field(default_factory=_now)
    finished_at: float | None = None
    rank: int | None = None
    shrink_until: float = 0.0
    fake_reset_until: float = 0.0

    def public(self) -> dict[str, Any]:
        now_ts = _now()
        effects = {
            "shrink": max(0, int(self.shrink_until * 1000)) if self.shrink_until > now_ts else 0,
            "fakeReset": max(0, int(self.fake_reset_until * 1000)) if self.fake_reset_until > now_ts else 0,
        }
        return {
            "id": self.id,
            "nickname": self.nickname,
            "avatar": self.avatar,
            "skin": self.skin,
            "role": self.role,
            "lane": self.lane,
            "progress": round(max(0.0, min(1.0, self.progress)), 4),
            "progressPercent": round(max(0.0, min(1.0, self.progress)) * 100, 1),
            "taps": self.taps,
            "connected": self.connected,
            "finished": self.finished_at is not None,
            "finishedAt": int(self.finished_at * 1000) if self.finished_at else None,
            "rank": self.rank,
            "effects": effects,
        }


@dataclass
class TurtleSession:
    code: str
    grade: int
    section: int
    status: str
    created_at: float
    starts_at: float
    ends_at: float
    safe_end_at: float
    phase_label: str
    players: dict[str, TurtlePlayer] = field(default_factory=dict)
    loop_running: bool = False
    ended_at: float | None = None
    sabotage_vote_id: int = 0
    sabotage_vote_started_at: float = 0.0
    sabotage_vote_ends_at: float = 0.0
    sabotage_votes: dict[str, dict[str, str]] = field(default_factory=dict)
    recent_events: list[dict[str, Any]] = field(default_factory=list)


class TurtleRaceSessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, TurtleSession] = {}
        self._lock = threading.RLock()
        self._socketio = None
        self._last_cleanup = 0.0

    def bind_socketio(self, socketio: Any) -> None:
        self._socketio = socketio

    def create_session(self, grade: int, section: int, allow_any_time: bool = False) -> tuple[TurtleSession | None, str | None]:
        if not config.ARCADE_ENABLED:
            return None, "Arcade가 비활성화되어 있습니다."
        window = _play_window(grade) if not allow_any_time else {
            "allowed": True,
            "label": "테스트 모드",
            "safeEndAt": _now() + TURTLE_WAIT_SECONDS + TURTLE_RACE_SECONDS + 30,
            "phaseEndAt": _now() + TURTLE_WAIT_SECONDS + TURTLE_RACE_SECONDS + 30,
            "remainingSafeSeconds": TURTLE_WAIT_SECONDS + TURTLE_RACE_SECONDS + 30,
            "startsInSeconds": 0,
            "reason": "",
        }
        if not window["allowed"]:
            return None, window["reason"]

        with self._lock:
            self._cleanup_locked()
            now_ts = _now()
            for existing in self._sessions.values():
                self._expire_elapsed_locked(existing, now_ts)
            active = [s for s in self._sessions.values() if s.status != "ended"]
            for existing in active:
                if existing.grade == grade and existing.section == section:
                    return existing, None
            if len(active) >= config.ARCADE_MAX_ACTIVE_SESSIONS:
                return None, "현재 열린 Arcade가 너무 많습니다."
            starts_at = now_ts + TURTLE_WAIT_SECONDS
            ends_at = min(starts_at + TURTLE_RACE_SECONDS, float(window["safeEndAt"]))
            if ends_at - starts_at < TURTLE_RACE_SECONDS - 0.05:
                return None, "경주를 진행하기에 시간이 부족합니다."
            code = self._new_code_locked()
            session_obj = TurtleSession(
                code=code,
                grade=grade,
                section=section,
                status="lobby",
                created_at=now_ts,
                starts_at=starts_at,
                ends_at=ends_at,
                safe_end_at=float(window["safeEndAt"]),
                phase_label=str(window["label"] or "거북이 경주"),
            )
            self._sessions[code] = session_obj
            return session_obj, None

    def get(self, code: str) -> TurtleSession | None:
        with self._lock:
            self._cleanup_locked()
            session_obj = self._sessions.get(str(code or "").upper())
            if session_obj:
                self._expire_elapsed_locked(session_obj, _now())
            return session_obj

    def join_player(
        self,
        code: str,
        player_id: str,
        nickname: str,
        avatar: int,
        skin: Any = None,
        role: Any = None,
    ) -> tuple[TurtlePlayer | None, str | None]:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj:
                return None, "존재하지 않는 경주입니다."
            self._expire_elapsed_locked(session_obj, _now())
            if session_obj.status == "ended":
                return None, "이미 종료된 경주입니다."
            normalized_role = self._normalize_role(role)
            if player_id in session_obj.players:
                player = session_obj.players[player_id]
                player.connected = True
                player.last_seen_at = _now()
                normalized_skin = self._normalize_skin(skin)
                if normalized_skin and player.role == "player" and session_obj.status in {"lobby", "countdown"}:
                    player.skin = normalized_skin
                return player, None
            if len(session_obj.players) >= config.ARCADE_MAX_PLAYERS:
                return None, "참가 인원이 가득 찼습니다."
            if normalized_role == "player" and session_obj.status not in {"lobby", "countdown"}:
                return None, "경주 참가자는 시작 전에만 들어갈 수 있습니다."
            clean_name = _sanitize_nickname(nickname)
            if len(clean_name) < 2:
                return None, "닉네임은 2자 이상이어야 합니다."
            clean_name = self._dedupe_nickname_locked(session_obj, clean_name)
            avatar_id = int(avatar) if isinstance(avatar, int) or str(avatar).isdigit() else random.randrange(AVATAR_COUNT)
            lane = sum(1 for player in session_obj.players.values() if player.role == "player") if normalized_role == "player" else -1
            player = TurtlePlayer(
                id=player_id,
                nickname=clean_name,
                avatar=avatar_id % AVATAR_COUNT,
                lane=lane,
                skin=self._normalize_skin(skin) or random.choice(TURTLE_SKINS),
                role=normalized_role,
            )
            session_obj.players[player_id] = player
            return player, None

    def select_skin(self, code: str, player_id: str, skin: Any) -> tuple[TurtleSession | None, str | None]:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj:
                return None, "세션을 찾을 수 없습니다."
            self._expire_elapsed_locked(session_obj, _now())
            if session_obj.status not in {"lobby", "countdown"}:
                return session_obj, "시작 후에는 거북이를 바꿀 수 없습니다."
            player = session_obj.players.get(str(player_id or "").strip())
            if not player:
                return None, "참가자를 찾을 수 없습니다."
            if player.role != "player":
                return session_obj, "플레이어만 거북이를 고를 수 있습니다."
            normalized_skin = self._normalize_skin(skin)
            if not normalized_skin:
                return session_obj, "알 수 없는 거북이입니다."
            player.skin = normalized_skin
            player.last_seen_at = _now()
            return session_obj, None

    def submit_sabotage_vote(
        self,
        code: str,
        player_id: str,
        target_id: Any,
        item_id: Any,
    ) -> tuple[TurtleSession | None, str | None]:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj:
                return None, "세션을 찾을 수 없습니다."
            if session_obj.status != "racing":
                return session_obj, None
            voter = session_obj.players.get(str(player_id or "").strip())
            if not voter or voter.role != "saboteur":
                return None, "훼방꾼만 투표할 수 있습니다."
            target = session_obj.players.get(str(target_id or "").strip())
            if not target or target.role != "player" or target.finished_at is not None:
                return session_obj, "대상을 찾을 수 없습니다."
            normalized_item = self._normalize_sabotage_item(item_id)
            if not normalized_item:
                return session_obj, "알 수 없는 아이템입니다."
            now_ts = _now()
            if session_obj.sabotage_vote_ends_at and now_ts >= session_obj.sabotage_vote_ends_at:
                self._resolve_sabotage_vote_locked(session_obj, now_ts)
                self._reset_sabotage_vote_locked(session_obj, now_ts)
            session_obj.sabotage_votes[voter.id] = {"targetId": target.id, "itemId": normalized_item}
            voter.last_seen_at = now_ts
            return session_obj, None

    def mark_connected(self, code: str, player_id: str | None, connected: bool) -> None:
        if not player_id:
            return
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if session_obj and player_id in session_obj.players:
                session_obj.players[player_id].connected = connected
                session_obj.players[player_id].last_seen_at = _now()

    def start_now(self, code: str) -> tuple[TurtleSession | None, str | None]:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj or session_obj.status == "ended":
                return None, "not found"
            if self._expire_elapsed_locked(session_obj, _now()):
                return session_obj, "이미 종료된 경주입니다."
            if session_obj.status != "lobby":
                return session_obj, "이미 진행 중인 경주입니다."
            connected_racers = [player for player in session_obj.players.values() if player.role == "player" and player.connected]
            if len(connected_racers) < TURTLE_MIN_RACERS:
                return None, "플레이어가 2명 이상 필요합니다."
            now_ts = _now()
            starts_at = now_ts + TURTLE_WAIT_SECONDS
            ends_at = min(starts_at + TURTLE_RACE_SECONDS, session_obj.safe_end_at)
            if ends_at - starts_at < TURTLE_RACE_SECONDS - 0.05:
                return session_obj, "남은 시간이 부족합니다."
            session_obj.status = "countdown"
            session_obj.starts_at = starts_at
            session_obj.ends_at = ends_at
            session_obj.recent_events = []
            session_obj.sabotage_vote_id = 0
            session_obj.sabotage_votes = {}
            session_obj.sabotage_vote_started_at = 0.0
            session_obj.sabotage_vote_ends_at = 0.0
            for player in session_obj.players.values():
                player.progress = 0.0
                player.taps = 0
                player.finished_at = None
                player.rank = None
                player.shrink_until = 0.0
                player.fake_reset_until = 0.0
            return session_obj, None

    def add_taps(self, code: str, player_id: str, count: Any) -> tuple[TurtleSession | None, str | None]:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj:
                return None, "세션을 찾을 수 없습니다."
            if session_obj.status != "racing":
                return session_obj, None
            player = session_obj.players.get(player_id)
            if not player or player.role != "player" or player.finished_at is not None:
                return session_obj, None
            now_ts = _now()
            try:
                requested = int(count)
            except (TypeError, ValueError):
                requested = 1
            requested = max(1, min(requested, TURTLE_MAX_TAPS_PER_EVENT))
            accepted = requested
            player.taps += accepted
            player.progress = min(1.0, player.progress + accepted * TURTLE_TAP_PROGRESS)
            player.last_seen_at = now_ts
            if player.progress >= 1.0 and player.finished_at is None:
                player.finished_at = now_ts
                player.rank = 1 + sum(1 for other in session_obj.players.values() if other.finished_at is not None and other.id != player.id)
                if all(other.finished_at is not None for other in session_obj.players.values() if other.connected and other.role == "player"):
                    self._end_locked(session_obj)
            return session_obj, None

    def end_session(self, code: str) -> TurtleSession | None:
        normalized_code = str(code or "").upper()
        with self._lock:
            session_obj = self._sessions.get(normalized_code)
            if not session_obj:
                return None
            self._end_locked(session_obj)
            snapshot = self._snapshot_locked(session_obj)
        self._emit("turtle:state", snapshot, normalized_code)
        self._emit("turtle:ended", snapshot, normalized_code)
        return session_obj

    def snapshot(self, session_obj: TurtleSession) -> dict[str, Any]:
        with self._lock:
            self._expire_elapsed_locked(session_obj, _now())
            return self._snapshot_locked(session_obj)

    def run_loop(self, code: str) -> None:
        with self._lock:
            session_obj = self._sessions.get(str(code or "").upper())
            if not session_obj or session_obj.loop_running:
                return
            session_obj.loop_running = True
        try:
            while True:
                with self._lock:
                    session_obj = self._sessions.get(str(code or "").upper())
                    if not session_obj:
                        return
                    changed = self._advance_locked(session_obj)
                    snapshot = self._snapshot_locked(session_obj)
                    ended = session_obj.status == "ended"
                if changed:
                    self._emit("turtle:state", snapshot, code)
                    if ended:
                        self._emit("turtle:ended", snapshot, code)
                if ended:
                    return
                time.sleep(0.25)
        finally:
            with self._lock:
                session_obj = self._sessions.get(str(code or "").upper())
                if session_obj:
                    session_obj.loop_running = False

    def _advance_locked(self, session_obj: TurtleSession) -> bool:
        now_ts = _now()
        if session_obj.status == "countdown" and now_ts >= session_obj.starts_at:
            session_obj.status = "racing"
            self._reset_sabotage_vote_locked(session_obj, now_ts)
            return True
        if session_obj.status == "racing" and now_ts >= session_obj.ends_at:
            self._end_locked(session_obj)
            return True
        if session_obj.status == "racing" and session_obj.sabotage_vote_ends_at and now_ts >= session_obj.sabotage_vote_ends_at:
            self._resolve_sabotage_vote_locked(session_obj, now_ts)
            self._reset_sabotage_vote_locked(session_obj, now_ts)
            return True
        return False

    def _expire_elapsed_locked(self, session_obj: TurtleSession, now_ts: float) -> bool:
        if session_obj.status == "ended":
            return False
        if session_obj.status in {"countdown", "racing"} and now_ts >= session_obj.ends_at:
            self._end_locked(session_obj)
            return True
        return False

    def _end_locked(self, session_obj: TurtleSession) -> None:
        if session_obj.status == "ended":
            return
        session_obj.status = "ended"
        session_obj.ended_at = _now()
        session_obj.sabotage_votes = {}
        ranked = self._rankings_locked(session_obj)
        for index, item in enumerate(ranked, start=1):
            player = session_obj.players.get(item["id"])
            if player and player.rank is None:
                player.rank = index

    def _snapshot_locked(self, session_obj: TurtleSession) -> dict[str, Any]:
        now_ts = _now()
        players = [
            player.public()
            for player in sorted(
                session_obj.players.values(),
                key=lambda item: (0 if item.role == "player" else 1, item.lane if item.lane >= 0 else 999, item.joined_at),
            )
        ]
        connected_racers = [player for player in session_obj.players.values() if player.role == "player" and player.connected]
        connected_saboteurs = [player for player in session_obj.players.values() if player.role == "saboteur" and player.connected]
        return {
            "mode": "turtle",
            "code": session_obj.code,
            "grade": session_obj.grade,
            "section": session_obj.section,
            "status": session_obj.status,
            "phaseLabel": session_obj.phase_label,
            "startsAt": int(session_obj.starts_at * 1000),
            "endsAt": int(session_obj.ends_at * 1000),
            "now": int(now_ts * 1000),
            "players": players,
            "rankings": self._rankings_locked(session_obj),
            "recentEvents": deepcopy(session_obj.recent_events[-5:]),
            "connectedRacers": len(connected_racers),
            "connectedSaboteurs": len(connected_saboteurs),
            "minRacers": TURTLE_MIN_RACERS,
            "sabotageItems": deepcopy(list(TURTLE_SABOTAGE_ITEMS)),
            "sabotageVote": {
                "id": session_obj.sabotage_vote_id,
                "startedAt": int(session_obj.sabotage_vote_started_at * 1000) if session_obj.sabotage_vote_started_at else None,
                "endsAt": int(session_obj.sabotage_vote_ends_at * 1000) if session_obj.sabotage_vote_ends_at else None,
                "votesCount": len(session_obj.sabotage_votes),
                "durationSeconds": TURTLE_SABOTEUR_VOTE_SECONDS,
            },
            "tapProgress": TURTLE_TAP_PROGRESS,
            "raceSeconds": TURTLE_RACE_SECONDS,
        }

    def _rankings_locked(self, session_obj: TurtleSession) -> list[dict[str, Any]]:
        players = [player.public() for player in session_obj.players.values() if player.role == "player"]
        return sorted(
            players,
            key=lambda item: (
                item["finishedAt"] is None,
                item["finishedAt"] or 10**15,
                -float(item["progress"]),
                -int(item["taps"]),
                item["lane"],
            ),
        )

    def _reset_sabotage_vote_locked(self, session_obj: TurtleSession, now_ts: float) -> None:
        session_obj.sabotage_vote_id += 1
        session_obj.sabotage_vote_started_at = now_ts
        session_obj.sabotage_vote_ends_at = min(now_ts + TURTLE_SABOTEUR_VOTE_SECONDS, session_obj.ends_at)
        session_obj.sabotage_votes = {}

    def _resolve_sabotage_vote_locked(self, session_obj: TurtleSession, now_ts: float) -> None:
        if not session_obj.sabotage_votes:
            return
        tallies: dict[tuple[str, str], int] = {}
        for vote in session_obj.sabotage_votes.values():
            key = (vote.get("targetId") or "", vote.get("itemId") or "")
            tallies[key] = tallies.get(key, 0) + 1
        if not tallies:
            return
        top_count = max(tallies.values())
        winners = [key for key, count in tallies.items() if count == top_count]
        target_id, item_id = random.choice(sorted(winners))
        target = session_obj.players.get(target_id)
        if not target or target.role != "player" or target.finished_at is not None:
            return
        self._apply_sabotage_locked(session_obj, target, item_id, now_ts)

    def _apply_sabotage_locked(self, session_obj: TurtleSession, target: TurtlePlayer, item_id: str, now_ts: float) -> None:
        item_label = self._sabotage_label(item_id)
        note = ""
        if item_id == "banana":
            target.progress = max(0.0, target.progress - 0.08)
            note = f"{target.nickname} 바나나 미끄러짐"
        elif item_id == "swap_last":
            racers = [player for player in session_obj.players.values() if player.role == "player" and player.finished_at is None]
            last = min(racers, key=lambda player: (player.progress, -player.taps, -player.lane), default=None)
            if last and last.id != target.id:
                target.progress, last.progress = last.progress, target.progress
                target.taps, last.taps = last.taps, target.taps
                note = f"{target.nickname} 꼴지와 위치 교체"
            else:
                note = f"{target.nickname} 이미 꼴지"
        elif item_id == "shrink":
            target.shrink_until = max(target.shrink_until, now_ts + 2)
            note = f"{target.nickname} 버튼 축소"
        elif item_id == "fake_reset":
            target.fake_reset_until = max(target.fake_reset_until, now_ts + 2)
            note = f"{target.nickname} 초기화 함정"
        else:
            return
        session_obj.recent_events.append({
            "at": int(now_ts * 1000),
            "targetId": target.id,
            "targetNickname": target.nickname,
            "itemId": item_id,
            "itemLabel": item_label,
            "message": note,
        })
        session_obj.recent_events = session_obj.recent_events[-8:]

    def _sabotage_label(self, item_id: str) -> str:
        for item in TURTLE_SABOTAGE_ITEMS:
            if item["id"] == item_id:
                return item["label"]
        return item_id

    def _new_code_locked(self) -> str:
        alphabet = string.ascii_uppercase + string.digits
        while True:
            code = "".join(secrets.choice(alphabet) for _ in range(5))
            if code not in self._sessions:
                return code

    def _cleanup_locked(self) -> None:
        now_ts = _now()
        if now_ts - self._last_cleanup < SESSION_CLEANUP_INTERVAL_SECONDS:
            return
        self._last_cleanup = now_ts
        expired = []
        for code, session_obj in self._sessions.items():
            self._expire_elapsed_locked(session_obj, now_ts)
            ttl_expired = now_ts - session_obj.created_at > config.ARCADE_SESSION_TTL_SECONDS
            ended_expired = session_obj.status == "ended" and session_obj.ended_at and now_ts - session_obj.ended_at > 120
            if ttl_expired or ended_expired:
                expired.append(code)
        for code in expired:
            self._sessions.pop(code, None)

    def _dedupe_nickname_locked(self, session_obj: TurtleSession, nickname: str) -> str:
        existing = {player.nickname for player in session_obj.players.values()}
        if nickname not in existing:
            return nickname
        for index in range(2, 100):
            candidate = f"{nickname}{index}"
            if candidate not in existing:
                return candidate
        return f"{nickname}{random.randrange(100, 999)}"

    def _normalize_skin(self, skin: Any) -> str | None:
        value = str(skin or "").strip().split("/")[-1]
        return value if value in TURTLE_SKINS else None

    def _normalize_role(self, role: Any) -> str:
        value = str(role or "player").strip().lower()
        return "saboteur" if value in {"saboteur", "hinder", "disturber", "훼방꾼"} else "player"

    def _normalize_sabotage_item(self, item_id: Any) -> str | None:
        value = str(item_id or "").strip()
        valid = {item["id"] for item in TURTLE_SABOTAGE_ITEMS}
        return value if value in valid else None

    def _emit(self, event: str, payload: dict[str, Any], code: str) -> None:
        if self._socketio:
            self._socketio.emit(event, payload, namespace=ARCADE_NAMESPACE, room=_turtle_room(code))


turtle_manager = TurtleRaceSessionManager()


def _host_allowed(grade: int, section: int) -> bool:
    return is_teacher_session_active() or is_board_session_active(grade, section)


def _availability_payload(grade: int, section: int) -> dict[str, Any]:
    if not config.ARCADE_ENABLED:
        return {
            "allowed": False,
            "reason": "Arcade가 비활성화되어 있습니다.",
            "debugOverride": False,
        }
    if config.ARCADE_DEBUG_ALLOW_ANY_TIME:
        return {
            "allowed": True,
            "reason": "테스트 모드",
            "debugOverride": True,
        }
    window = _play_window(grade)
    return {
        "allowed": bool(window.get("allowed")),
        "reason": window.get("reason") or "",
        "label": window.get("label") or "",
        "startsInSeconds": window.get("startsInSeconds"),
        "remainingSafeSeconds": window.get("remainingSafeSeconds"),
        "debugOverride": False,
    }


@blueprint.get("/api/arcade/availability")
def arcade_availability():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if not grade or not section or not _host_allowed(grade, section):
        response = jsonify({"allowed": False, "reason": "not allowed", "debugOverride": False})
        response.headers["Cache-Control"] = "no-store"
        return response, 403
    response = jsonify(_availability_payload(grade, section))
    response.headers["Cache-Control"] = "no-store"
    return response


@blueprint.get("/arcade/host")
def arcade_host():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    query = []
    if grade:
        query.append(f"grade={grade}")
    if section:
        query.append(f"section={section}")
    suffix = f"?{'&'.join(query)}" if query else ""
    return redirect(f"/arcade/turf/host{suffix}", code=302)


@blueprint.get("/arcade")
def arcade_home():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    host_allowed = bool(grade and section and _host_allowed(grade, section))
    board_url = f"/board?grade={grade}&section={section}" if grade and section else "/"
    turf_url = f"/arcade/turf/host?grade={grade}&section={section}" if grade and section else ""
    party_url = f"/arcade/party/host?grade={grade}&section={section}" if grade and section else ""
    turtle_url = f"/arcade/turtle/host?grade={grade}&section={section}" if grade and section else ""
    return render_template(
        "arcade_home.html",
        arcade_enabled=config.ARCADE_ENABLED,
        host_allowed=host_allowed,
        grade=grade,
        section=section,
        board_url=board_url,
        turf_url=turf_url,
        party_url=party_url,
        turtle_url=turtle_url,
    )


@blueprint.get("/arcade/turf/host")
def arcade_turf_host():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if not grade or not section or not _host_allowed(grade, section):
        return render_template(
            "arcade_host.html",
            arcade_enabled=False,
            arcade_debug_allow_any_time=config.ARCADE_DEBUG_ALLOW_ANY_TIME,
            grade=grade,
            section=section,
        )
    return render_template(
        "arcade_host.html",
        arcade_enabled=config.ARCADE_ENABLED,
        arcade_debug_allow_any_time=config.ARCADE_DEBUG_ALLOW_ANY_TIME,
        grade=grade,
        section=section,
    )


@blueprint.get("/arcade/join/<code>")
def arcade_join(code: str):
    return render_template("arcade_join.html", code=str(code or "").upper(), arcade_enabled=config.ARCADE_ENABLED)


@blueprint.get("/arcade/party/host")
def arcade_party_host():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if not grade or not section or not _host_allowed(grade, section):
        return render_template(
            "arcade_party_host.html",
            arcade_enabled=False,
            arcade_debug_allow_any_time=config.ARCADE_DEBUG_ALLOW_ANY_TIME,
            grade=grade,
            section=section,
        )
    return render_template(
        "arcade_party_host.html",
        arcade_enabled=config.ARCADE_ENABLED,
        arcade_debug_allow_any_time=config.ARCADE_DEBUG_ALLOW_ANY_TIME,
        grade=grade,
        section=section,
    )


@blueprint.get("/arcade/party/join/<code>")
def arcade_party_join(code: str):
    return render_template("arcade_party_join.html", code=str(code or "").upper(), arcade_enabled=config.ARCADE_ENABLED)


@blueprint.get("/arcade/turtle/host")
def arcade_turtle_host():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if not grade or not section or not _host_allowed(grade, section):
        return render_template(
            "arcade_turtle_host.html",
            arcade_enabled=False,
            arcade_debug_allow_any_time=config.ARCADE_DEBUG_ALLOW_ANY_TIME,
            grade=grade,
            section=section,
        )
    return render_template(
        "arcade_turtle_host.html",
        arcade_enabled=config.ARCADE_ENABLED,
        arcade_debug_allow_any_time=config.ARCADE_DEBUG_ALLOW_ANY_TIME,
        grade=grade,
        section=section,
    )


@blueprint.get("/arcade/turtle/join/<code>")
def arcade_turtle_join(code: str):
    return render_template("arcade_turtle_join.html", code=str(code or "").upper(), arcade_enabled=config.ARCADE_ENABLED)


@blueprint.post("/api/arcade/sessions")
def create_arcade_session():
    payload = request.get_json(silent=True) or {}
    grade = int(payload.get("grade") or 0)
    section = int(payload.get("section") or 0)
    if not grade or not section or not _host_allowed(grade, section):
        return jsonify({"error": "not allowed"}), 403
    if bool(payload.get("debugAllowAnyTime")) and not config.ARCADE_DEBUG_ALLOW_ANY_TIME:
        return jsonify({"error": "서버의 Arcade 테스트 우회 모드가 꺼져 있습니다. ARCADE_DEBUG_ALLOW_ANY_TIME=1로 실행해야 합니다."}), 400
    allow_any_time = bool(payload.get("debugAllowAnyTime")) and config.ARCADE_DEBUG_ALLOW_ANY_TIME
    session_obj, error = arcade_manager.create_session(grade, section, allow_any_time=allow_any_time)
    if error or not session_obj:
        return jsonify({"error": error or "failed"}), 400
    return jsonify(arcade_manager.snapshot(session_obj))


@blueprint.get("/api/arcade/sessions/<code>")
def get_arcade_session(code: str):
    session_obj = arcade_manager.get(code)
    if not session_obj:
        return jsonify({"error": "not found"}), 404
    return jsonify(arcade_manager.snapshot(session_obj))


@blueprint.post("/api/arcade/sessions/<code>/start")
def start_arcade_session(code: str):
    session_obj = arcade_manager.get(code)
    if not session_obj or not _host_allowed(session_obj.grade, session_obj.section):
        return jsonify({"error": "not allowed"}), 403
    updated = arcade_manager.start_now(code)
    if not updated:
        return jsonify({"error": f"최소 {config.ARCADE_MIN_PLAYERS}명이 필요합니다."}), 400
    return jsonify(arcade_manager.snapshot(updated))


@blueprint.post("/api/arcade/sessions/<code>/end")
def end_arcade_session(code: str):
    session_obj = arcade_manager.get(code)
    if not session_obj or not _host_allowed(session_obj.grade, session_obj.section):
        return jsonify({"error": "not allowed"}), 403
    ended = arcade_manager.end_session(code)
    return jsonify(arcade_manager.snapshot(ended)) if ended else (jsonify({"error": "not found"}), 404)


@blueprint.post("/api/arcade/party/sessions")
def create_party_session():
    payload = request.get_json(silent=True) or {}
    grade = int(payload.get("grade") or 0)
    section = int(payload.get("section") or 0)
    if not grade or not section or not _host_allowed(grade, section):
        return jsonify({"error": "not allowed"}), 403
    if bool(payload.get("debugAllowAnyTime")) and not config.ARCADE_DEBUG_ALLOW_ANY_TIME:
        return jsonify({"error": "서버의 Arcade 테스트 우회 모드가 꺼져 있습니다. ARCADE_DEBUG_ALLOW_ANY_TIME=1로 실행해야 합니다."}), 400
    allow_any_time = bool(payload.get("debugAllowAnyTime")) and config.ARCADE_DEBUG_ALLOW_ANY_TIME
    session_obj, error = party_manager.create_session(grade, section, allow_any_time=allow_any_time)
    if error or not session_obj:
        return jsonify({"error": error or "failed"}), 400
    return jsonify(party_manager.snapshot(session_obj))


@blueprint.get("/api/arcade/party/sessions/<code>")
def get_party_session(code: str):
    session_obj = party_manager.get(code)
    if not session_obj:
        return jsonify({"error": "not found"}), 404
    return jsonify(party_manager.snapshot(session_obj))


@blueprint.post("/api/arcade/party/sessions/<code>/start")
def start_party_session(code: str):
    session_obj = party_manager.get(code)
    if not session_obj or not _host_allowed(session_obj.grade, session_obj.section):
        return jsonify({"error": "not allowed"}), 403
    updated, error = party_manager.start_now(code)
    if error and not updated:
        return jsonify({"error": error}), 400
    snapshot = party_manager.snapshot(updated)
    party_manager._emit("party:state", snapshot, str(code or "").upper())
    return jsonify(snapshot)


@blueprint.post("/api/arcade/party/sessions/<code>/end")
def end_party_session(code: str):
    session_obj = party_manager.get(code)
    if not session_obj or not _host_allowed(session_obj.grade, session_obj.section):
        return jsonify({"error": "not allowed"}), 403
    ended = party_manager.end_session(code)
    return jsonify(party_manager.snapshot(ended)) if ended else (jsonify({"error": "not found"}), 404)


@blueprint.post("/api/arcade/turtle/sessions")
def create_turtle_session():
    payload = request.get_json(silent=True) or {}
    grade = int(payload.get("grade") or 0)
    section = int(payload.get("section") or 0)
    if not grade or not section or not _host_allowed(grade, section):
        return jsonify({"error": "not allowed"}), 403
    if bool(payload.get("debugAllowAnyTime")) and not config.ARCADE_DEBUG_ALLOW_ANY_TIME:
        return jsonify({"error": "서버의 Arcade 테스트 우회 모드가 꺼져 있습니다. ARCADE_DEBUG_ALLOW_ANY_TIME=1로 실행해야 합니다."}), 400
    allow_any_time = bool(payload.get("debugAllowAnyTime")) and config.ARCADE_DEBUG_ALLOW_ANY_TIME
    session_obj, error = turtle_manager.create_session(grade, section, allow_any_time=allow_any_time)
    if error or not session_obj:
        return jsonify({"error": error or "failed"}), 400
    return jsonify(turtle_manager.snapshot(session_obj))


@blueprint.get("/api/arcade/turtle/sessions/<code>")
def get_turtle_session(code: str):
    session_obj = turtle_manager.get(code)
    if not session_obj:
        return jsonify({"error": "not found"}), 404
    return jsonify(turtle_manager.snapshot(session_obj))


@blueprint.post("/api/arcade/turtle/sessions/<code>/start")
def start_turtle_session(code: str):
    session_obj = turtle_manager.get(code)
    if not session_obj or not _host_allowed(session_obj.grade, session_obj.section):
        return jsonify({"error": "not allowed"}), 403
    updated, error = turtle_manager.start_now(code)
    if error:
        payload = {"error": error}
        if updated:
            payload["session"] = turtle_manager.snapshot(updated)
        return jsonify(payload), 400
    snapshot = turtle_manager.snapshot(updated)
    turtle_manager._emit("turtle:state", snapshot, str(code or "").upper())
    return jsonify(snapshot)


@blueprint.post("/api/arcade/turtle/sessions/<code>/end")
def end_turtle_session(code: str):
    session_obj = turtle_manager.get(code)
    if not session_obj or not _host_allowed(session_obj.grade, session_obj.section):
        return jsonify({"error": "not allowed"}), 403
    ended = turtle_manager.end_session(code)
    return jsonify(turtle_manager.snapshot(ended)) if ended else (jsonify({"error": "not found"}), 404)


class ArcadeNamespace(Namespace):
    def on_connect(self):  # type: ignore[override]
        emit("arcade:connected", {"ok": True})

    def on_disconnect(self):  # type: ignore[override]
        code = request.args.get("code")
        player_id = request.args.get("playerId")
        arcade_manager.mark_connected(str(code or "").upper(), player_id, False)
        party_manager.mark_connected(str(code or "").upper(), player_id, False)
        turtle_manager.mark_connected(str(code or "").upper(), player_id, False)

    def on_join_host(self, data):  # type: ignore[override]
        code = str((data or {}).get("code") or "").upper()
        session_obj = arcade_manager.get(code)
        if not session_obj:
            emit("arcade:error", {"message": "세션을 찾을 수 없습니다."})
            return
        join_room(_room(code))
        emit("arcade:state", arcade_manager.snapshot(session_obj))
        self._ensure_tick(code)

    def on_join_player(self, data):  # type: ignore[override]
        payload = data or {}
        code = str(payload.get("code") or "").upper()
        player_id = str(payload.get("playerId") or "").strip()
        if not player_id:
            emit("arcade:error", {"message": "playerId가 없습니다."})
            return
        player, error = arcade_manager.join_player(
            code,
            player_id,
            payload.get("nickname") or "",
            payload.get("avatar") or 0,
        )
        if error or not player:
            emit("arcade:error", {"message": error or "입장할 수 없습니다."})
            return
        join_room(_room(code))
        session_obj = arcade_manager.get(code)
        if not session_obj:
            emit("arcade:error", {"message": "세션을 찾을 수 없습니다."})
            return
        emit("arcade:joined", {"player": player.public(), "session": arcade_manager.snapshot(session_obj)})
        arcade_manager._emit("arcade:state", arcade_manager.snapshot(session_obj), code)
        self._ensure_tick(code)

    def on_player_input(self, data):  # type: ignore[override]
        payload = data or {}
        code = str(payload.get("code") or "").upper()
        player_id = str(payload.get("playerId") or "").strip()
        direction = str(payload.get("direction") or "")
        arcade_manager.set_input(code, player_id, direction)

    def on_leave(self, data):  # type: ignore[override]
        code = str((data or {}).get("code") or "").upper()
        leave_room(_room(code))

    def on_party_join_host(self, data):  # type: ignore[override]
        code = str((data or {}).get("code") or "").upper()
        session_obj = party_manager.get(code)
        if not session_obj:
            emit("party:error", {"message": "세션을 찾을 수 없습니다."})
            return
        join_room(_party_room(code))
        emit("party:state", party_manager.snapshot(session_obj))
        self._ensure_party_loop(code)

    def on_party_join_player(self, data):  # type: ignore[override]
        payload = data or {}
        code = str(payload.get("code") or "").upper()
        player_id = str(payload.get("playerId") or "").strip()
        if not player_id:
            emit("party:error", {"message": "playerId가 없습니다."})
            return
        player, error = party_manager.join_player(
            code,
            player_id,
            payload.get("nickname") or "",
            payload.get("avatar") or 0,
        )
        if error or not player:
            emit("party:error", {"message": error or "입장할 수 없습니다."})
            return
        join_room(_party_room(code))
        session_obj = party_manager.get(code)
        if not session_obj:
            emit("party:error", {"message": "세션을 찾을 수 없습니다."})
            return
        snapshot = party_manager.snapshot(session_obj)
        emit("party:joined", {"player": player.public(), "session": snapshot})
        party_manager._emit("party:state", snapshot, code)
        self._ensure_party_loop(code)

    def on_party_submit(self, data):  # type: ignore[override]
        payload = data or {}
        code = str(payload.get("code") or "").upper()
        player_id = str(payload.get("playerId") or "").strip()
        session_obj, error = party_manager.submit(code, player_id, payload.get("value"), str(payload.get("roundId") or ""))
        if error and not session_obj:
            emit("party:error", {"message": error})
            return
        if session_obj:
            snapshot = party_manager.snapshot(session_obj)
            emit("party:submitted", {"ok": True, "session": snapshot})
            party_manager._emit("party:state", snapshot, code)

    def on_party_leave(self, data):  # type: ignore[override]
        code = str((data or {}).get("code") or "").upper()
        leave_room(_party_room(code))

    def on_turtle_join_host(self, data):  # type: ignore[override]
        code = str((data or {}).get("code") or "").upper()
        session_obj = turtle_manager.get(code)
        if not session_obj:
            emit("turtle:error", {"message": "세션을 찾을 수 없습니다."})
            return
        join_room(_turtle_room(code))
        emit("turtle:state", turtle_manager.snapshot(session_obj))
        self._ensure_turtle_loop(code)

    def on_turtle_join_player(self, data):  # type: ignore[override]
        payload = data or {}
        code = str(payload.get("code") or "").upper()
        player_id = str(payload.get("playerId") or "").strip()
        if not player_id:
            emit("turtle:error", {"message": "playerId가 없습니다."})
            return
        player, error = turtle_manager.join_player(
            code,
            player_id,
            payload.get("nickname") or "",
            payload.get("avatar") or 0,
            payload.get("skin"),
            payload.get("role"),
        )
        if error or not player:
            emit("turtle:error", {"message": error or "입장할 수 없습니다."})
            return
        join_room(_turtle_room(code))
        session_obj = turtle_manager.get(code)
        if not session_obj:
            emit("turtle:error", {"message": "세션을 찾을 수 없습니다."})
            return
        snapshot = turtle_manager.snapshot(session_obj)
        emit("turtle:joined", {"player": player.public(), "session": snapshot})
        turtle_manager._emit("turtle:state", snapshot, code)
        self._ensure_turtle_loop(code)

    def on_turtle_select_skin(self, data):  # type: ignore[override]
        payload = data or {}
        code = str(payload.get("code") or "").upper()
        player_id = str(payload.get("playerId") or "").strip()
        session_obj, error = turtle_manager.select_skin(code, player_id, payload.get("skin"))
        if error:
            emit("turtle:error", {"message": error})
        if error and not session_obj:
            return
        if session_obj:
            snapshot = turtle_manager.snapshot(session_obj)
            emit("turtle:submitted", {"ok": not error, "session": snapshot})
            turtle_manager._emit("turtle:state", snapshot, code)

    def on_turtle_sabotage_vote(self, data):  # type: ignore[override]
        payload = data or {}
        code = str(payload.get("code") or "").upper()
        player_id = str(payload.get("playerId") or "").strip()
        session_obj, error = turtle_manager.submit_sabotage_vote(
            code,
            player_id,
            payload.get("targetId"),
            payload.get("itemId"),
        )
        if error:
            emit("turtle:error", {"message": error})
        if error and not session_obj:
            return
        if session_obj:
            snapshot = turtle_manager.snapshot(session_obj)
            emit("turtle:submitted", {"ok": not error, "session": snapshot})
            turtle_manager._emit("turtle:state", snapshot, code)

    def on_turtle_tap(self, data):  # type: ignore[override]
        payload = data or {}
        code = str(payload.get("code") or "").upper()
        player_id = str(payload.get("playerId") or "").strip()
        session_obj, error = turtle_manager.add_taps(code, player_id, payload.get("count") or 1)
        if error and not session_obj:
            emit("turtle:error", {"message": error})
            return
        if session_obj:
            snapshot = turtle_manager.snapshot(session_obj)
            emit("turtle:submitted", {"ok": True, "session": snapshot})
            turtle_manager._emit("turtle:state", snapshot, code)

    def on_turtle_leave(self, data):  # type: ignore[override]
        code = str((data or {}).get("code") or "").upper()
        leave_room(_turtle_room(code))

    def _ensure_tick(self, code: str) -> None:
        socketio = arcade_manager._socketio
        if socketio:
            socketio.start_background_task(arcade_manager.tick, code)

    def _ensure_party_loop(self, code: str) -> None:
        socketio = party_manager._socketio
        if socketio:
            socketio.start_background_task(party_manager.run_loop, code)

    def _ensure_turtle_loop(self, code: str) -> None:
        socketio = turtle_manager._socketio
        if socketio:
            socketio.start_background_task(turtle_manager.run_loop, code)


def init_arcade_socketio(socketio: Any) -> None:
    arcade_manager.bind_socketio(socketio)
    party_manager.bind_socketio(socketio)
    turtle_manager.bind_socketio(socketio)
    socketio.on_namespace(ArcadeNamespace(ARCADE_NAMESPACE))
