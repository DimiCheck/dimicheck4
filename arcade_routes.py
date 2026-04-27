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

from flask import Blueprint, jsonify, render_template, request
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


def _now() -> float:
    return time.time()


def _room(code: str) -> str:
    return f"{ROOM_PREFIX}{code}"


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


def _is_class_phase(label: str) -> bool:
    return "수업" in str(label or "")


def _class_break_window(
    phase: dict[str, Any],
    now_ts: float,
    second_of_day: int,
    day_start_ts: float,
) -> dict[str, Any] | None:
    if not _is_class_phase(str(phase.get("label") or "")):
        return None
    phase_start = int(phase["start"]) * 60
    phase_end = int(phase["end"]) * 60
    lesson_seconds = 50 * 60
    break_seconds = 10 * 60
    cursor = phase_start
    while cursor + lesson_seconds + break_seconds <= phase_end:
        break_start = cursor + lesson_seconds
        break_end = break_start + break_seconds
        if break_start <= second_of_day < break_end:
            phase_end_ts = day_start_ts + break_end
            safe_end_ts = phase_end_ts - END_BUFFER_SECONDS
            remaining_safe_seconds = int(safe_end_ts - now_ts)
            allowed = remaining_safe_seconds >= MIN_START_WINDOW_SECONDS
            return {
                "allowed": allowed,
                "label": "쉬는 시간",
                "safeEndAt": safe_end_ts,
                "phaseEndAt": phase_end_ts,
                "remainingSafeSeconds": max(0, remaining_safe_seconds),
                "startsInSeconds": 0,
                "reason": "" if allowed else "다음 수업 준비 시간이 가까워 Arcade를 시작할 수 없습니다.",
            }
        cursor += lesson_seconds + break_seconds
    return None


def _play_window(grade: int, now_ts: float | None = None) -> dict[str, Any]:
    now_ts = now_ts or _now()
    now_dt = datetime.fromtimestamp(now_ts, KST)
    minute = now_dt.hour * 60 + now_dt.minute
    second_of_day = minute * 60 + now_dt.second
    day_start = now_dt.replace(hour=0, minute=0, second=0, microsecond=0)

    for phase in _phases_for_grade(grade, now_dt):
        if phase["start"] <= minute < phase["end"]:
            class_break = _class_break_window(phase, now_ts, second_of_day, day_start.timestamp())
            if class_break:
                return class_break
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
    scores: dict[str, int] = field(default_factory=lambda: {"red": 0, "blue": 0})
    tick_running: bool = False
    ended_at: float | None = None


class ArcadeSessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, ArcadeSession] = {}
        self._lock = threading.RLock()
        self._socketio = None
        self._last_cleanup = 0.0

    def bind_socketio(self, socketio: Any) -> None:
        self._socketio = socketio

    def create_session(self, grade: int, section: int) -> tuple[ArcadeSession | None, str | None]:
        if not config.ARCADE_ENABLED:
            return None, "Arcade가 비활성화되어 있습니다."
        window = _play_window(grade)
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
                grid=[[None for _ in range(GRID_WIDTH)] for _ in range(GRID_HEIGHT)],
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

    def _recompute_scores_locked(self, session_obj: ArcadeSession) -> None:
        scores = {"red": 0, "blue": 0}
        for row in session_obj.grid:
            for cell in row:
                if cell in scores:
                    scores[cell] += 1
        session_obj.scores = scores

    def _advance_locked(self, session_obj: ArcadeSession) -> list[list[Any]]:
        now_ts = _now()
        if session_obj.status == "waiting" and now_ts >= session_obj.scheduled_start_at:
            session_obj.status = "countdown"
        if session_obj.status == "countdown" and now_ts >= session_obj.starts_at:
            session_obj.status = "running"
        if now_ts >= session_obj.ends_at:
            self._end_locked(session_obj)
            return []
        if session_obj.status != "running":
            return []

        changed: list[list[Any]] = []
        for player in session_obj.players.values():
            direction = player.pending_direction if player.pending_direction in VALID_DIRECTIONS else player.direction
            dx, dy = DIR_DELTA[direction]
            nx = player.x + dx
            ny = player.y + dy
            if nx < 0 or ny < 0 or nx >= GRID_WIDTH or ny >= GRID_HEIGHT:
                continue
            player.direction = direction
            player.x = nx
            player.y = ny
            if self._claim_cell_locked(session_obj, nx, ny, player.team, player):
                changed.append([nx, ny, player.team])
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


def _host_allowed(grade: int, section: int) -> bool:
    return is_teacher_session_active() or is_board_session_active(grade, section)


@blueprint.get("/arcade/host")
def arcade_host():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if not grade or not section or not _host_allowed(grade, section):
        return render_template("arcade_host.html", arcade_enabled=False, grade=grade, section=section)
    return render_template("arcade_host.html", arcade_enabled=config.ARCADE_ENABLED, grade=grade, section=section)


@blueprint.get("/arcade/join/<code>")
def arcade_join(code: str):
    return render_template("arcade_join.html", code=str(code or "").upper(), arcade_enabled=config.ARCADE_ENABLED)


@blueprint.post("/api/arcade/sessions")
def create_arcade_session():
    payload = request.get_json(silent=True) or {}
    grade = int(payload.get("grade") or 0)
    section = int(payload.get("section") or 0)
    if not grade or not section or not _host_allowed(grade, section):
        return jsonify({"error": "not allowed"}), 403
    session_obj, error = arcade_manager.create_session(grade, section)
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
        return jsonify({"error": "not found"}), 404
    return jsonify(arcade_manager.snapshot(updated))


@blueprint.post("/api/arcade/sessions/<code>/end")
def end_arcade_session(code: str):
    session_obj = arcade_manager.get(code)
    if not session_obj or not _host_allowed(session_obj.grade, session_obj.section):
        return jsonify({"error": "not allowed"}), 403
    ended = arcade_manager.end_session(code)
    return jsonify(arcade_manager.snapshot(ended)) if ended else (jsonify({"error": "not found"}), 404)


class ArcadeNamespace(Namespace):
    def on_connect(self):  # type: ignore[override]
        emit("arcade:connected", {"ok": True})

    def on_disconnect(self):  # type: ignore[override]
        code = request.args.get("code")
        player_id = request.args.get("playerId")
        arcade_manager.mark_connected(str(code or "").upper(), player_id, False)

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

    def _ensure_tick(self, code: str) -> None:
        socketio = arcade_manager._socketio
        if socketio:
            socketio.start_background_task(arcade_manager.tick, code)


def init_arcade_socketio(socketio: Any) -> None:
    arcade_manager.bind_socketio(socketio)
    socketio.on_namespace(ArcadeNamespace(ARCADE_NAMESPACE))
