
## app.py
from __future__ import annotations

import json
import secrets
from typing import Any
from dotenv import load_dotenv

# .env 파일 로드 (환경 변수)
load_dotenv()

from flask import Flask, jsonify, redirect, render_template, request, send_from_directory, session, url_for, make_response, abort
from flask_cors import CORS, cross_origin
from flask_smorest import Api
from flask_socketio import SocketIO
import requests

from auth import blueprint as auth_bp
from auth.sessions import load_remembered_user
from class_routes import blueprint as class_bp
from exports_routes import blueprint as export_bp
from chat_routes import blueprint as chat_bp
from vote_routes import blueprint as vote_bp
from public_api import public_api_bp, broadcast_public_status_update
from developer_routes import blueprint as developer_bp
from oauth import blueprint as oauth_bp
from account import blueprint as account_bp
from mcp_routes import blueprint as mcp_bp
from config import config
from extensions import db
from models import ClassConfig, ClassPin, ClassState
from config_loader import load_class_config
from utils import (
    after_request,
    before_request,
    clear_teacher_session,
    is_teacher_session_active,
    mark_teacher_session,
    metrics,
    pin_guard_key,
    pin_guard_register_failure,
    pin_guard_reset,
    pin_guard_status,
    setup_logging,
    verify_csrf,
)
from ws import namespaces

import gspread

app = Flask(__name__, static_folder=".", static_url_path="")
app.config.from_object(config)
setup_logging(config.LOG_LEVEL)

app.register_blueprint(auth_bp)
app.register_blueprint(class_bp)
app.register_blueprint(export_bp)
app.register_blueprint(chat_bp)
app.register_blueprint(vote_bp)
app.register_blueprint(public_api_bp)
app.register_blueprint(developer_bp)
app.register_blueprint(oauth_bp)
app.register_blueprint(account_bp)
app.register_blueprint(mcp_bp)
app.add_url_rule("/metrics", "metrics", metrics)

db.init_app(app)
socketio = SocketIO(app, cors_allowed_origins=config.FRONTEND_ORIGIN, async_mode="threading")
CORS(
    app,
    resources={
        r"/public/*": {"origins": "*", "supports_credentials": False},
        r"/*": {"origins": [config.FRONTEND_ORIGIN], "supports_credentials": True},
    },
)
for ns in namespaces:
    socketio.on_namespace(ns)

app.before_request(before_request)
app.after_request(after_request)
app.before_request(verify_csrf)


_SENSITIVE_PREFIXES = {
    ".env",
    "dimicheck-471412-85491c7985df.json",
    "instance",
    ".git",
    ".venv",
    "app.db",
}


@app.before_request
def _block_sensitive_files():
    path = (request.path or "").lstrip("/")
    lowered = path.lower()
    for prefix in _SENSITIVE_PREFIXES:
        prefix_lower = prefix.lower().rstrip("/")
        if lowered == prefix_lower or lowered.startswith(f"{prefix_lower}/") or f"/{prefix_lower}" in f"/{lowered}":
            abort(404)


@app.context_processor
def inject_asset_version():
    """Inject asset version for cache busting"""
    return {'asset_version': config.ASSET_VERSION}


@app.before_request
def _inject_remembered_session():
    load_remembered_user()


@app.before_request
def _refresh_user_session() -> None:
    if session.get("user"):
        session.permanent = True

@app.errorhandler(400)
@app.errorhandler(401)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(409)
def handle_error(err):
    code = getattr(err, "code", 500)
    message = getattr(err, "description", str(err))

    # JSON 요청 (예: fetch, axios) → JSON 반환
    if request.accept_mimetypes.best == "application/json" or request.is_json:
        return jsonify({"error": {"code": str(code), "message": message}}), code

    # 일반 브라우저 접근 → HTML 페이지
    return send_from_directory(".", "404.html"), code

@app.get("/healthz")
@cross_origin(origins=["https://checstat.netlify.app"])
def health() -> Any:
    return {"status": "ok"}


@app.get("/me")
def me() -> Any:
    user = session.get("user")
    if not user:
        return jsonify({"error": {"code": "unauthorized", "message": "login required"}}), 401
    token = session.get("csrf_token")
    if not token:
        import secrets

        token = secrets.token_hex(16)
        session["csrf_token"] = token
    user_data = {k: v for k, v in user.items() if k in {"id", "email", "name", "type", "grade", "class", "number"}}
    user_data["csrf_token"] = token
    return jsonify(user_data)

# Swagger UI
api_spec = {
    "title": "Presence API",
    "version": "1.0",
    "openapi_version": "3.0.2",
    "components": {"securitySchemes": {}},
    "name": "dimicheck-openapi"
}
api = Api(app, spec_kwargs=api_spec)

CLASS_CONFIGS = load_class_config()
QRNG_ENDPOINT = "https://qrng.anu.edu.au/API/jsonI.php"
QRNG_ALLOWED_TYPES = {"uint8", "uint16", "hex16"}
QRNG_MAX_LENGTH = 1024
DEFAULT_CHAT_CHANNEL = "home"

# 단축 상태 코드 → 내부 상태 키 매핑
STATUS_ALIASES = {
    "class": "section",
    "classroom": "section",
    "room": "section",
    "section": "section",
    "교실": "section",
    "toilet": "toilet",
    "화장실": "toilet",
    "bathroom": "toilet",
    "hallway": "hallway",
    "복도": "hallway",
    "club": "club",
    "동아리": "club",
    "afterschool": "afterschool",
    "after-school": "afterschool",
    "방과후": "afterschool",
    "project": "project",
    "프로젝트": "project",
    "early": "early",
    "조기입실": "early",
    "etc": "etc",
    "기타": "etc",
    "absence": "absence",
    "absent": "absence",
    "결석": "absence",
    "조퇴": "absence",
}

STATUS_LABELS = {
    "section": "교실",
    "toilet": "화장실",
    "hallway": "복도",
    "club": "동아리",
    "afterschool": "방과후",
    "project": "프로젝트",
    "early": "조기입실",
    "etc": "기타",
    "absence": "결석(조퇴)",
}

PRESERVE_STATE_FIELDS = [
    "reaction",
    "reactionPostedAt",
    "reactionExpiresAt",
    "thought",
    "thoughtPostedAt",
    "thoughtExpiresAt",
]


def _fallback_qrng(length: int, qtype: str) -> dict[str, Any]:
    if qtype == "uint16":
        data = [secrets.randbits(16) for _ in range(length)]
    elif qtype == "hex16":
        data = [f"{secrets.randbits(16):04x}" for _ in range(length)]
    else:  # default uint8
        data = list(secrets.token_bytes(length))

    return {"success": True, "data": data, "source": "fallback"}


def _coerce_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _split_student_identifier(value: Any) -> tuple[int | None, int | None, int | None]:
    if value is None:
        return None, None, None
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    if not digits:
        return None, None, None
    if len(digits) >= 3:
        grade = _coerce_int(digits[0])
        seat = _coerce_int(digits[-2:])
        section_digits = digits[1:-2]
        section = _coerce_int(section_digits) if section_digits else None
        return grade, section, seat
    return None, None, _coerce_int(digits)


def _derive_student_session() -> tuple[int | None, int | None, int | None]:
    user = session.get("user") or {}
    if str(user.get("type", "")).lower() != "student":
        return None, None, None

    grade = _coerce_int(user.get("grade") or user.get("grade_no") or user.get("gradeNo"))
    section = _coerce_int(
        user.get("class")
        or user.get("class_no")
        or user.get("classNo")
        or user.get("section")
        or user.get("section_no")
        or user.get("sectionNo")
    )
    identifier = (
        user.get("number")
        or user.get("student_number")
        or user.get("studentNumber")
        or user.get("student_no")
        or user.get("studentNo")
    )
    derived_grade, derived_section, seat = _split_student_identifier(identifier)
    if grade is None:
        grade = derived_grade
    if section is None:
        section = derived_section
    if seat is None:
        _, _, seat = _split_student_identifier(user.get("seat_number") or user.get("seatNumber") or user.get("number_only"))
    return grade, section, seat


def _normalize_status_param(raw_status: str | None) -> str | None:
    if not raw_status:
        return None
    cleaned = str(raw_status).strip().strip('"\'').lower()
    canonical = STATUS_ALIASES.get(cleaned, cleaned)
    if canonical in STATUS_LABELS:
        return canonical
    return None


def _normalize_channels(channels_raw) -> list[str]:
    channels = channels_raw if isinstance(channels_raw, list) else []
    normalized: list[str] = []
    seen = set()

    for ch in channels:
        if not isinstance(ch, str):
            continue
        name = ch.strip()
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(name[:30])

    if DEFAULT_CHAT_CHANNEL.casefold() not in seen:
        normalized.insert(0, DEFAULT_CHAT_CHANNEL)
    return normalized


def _normalize_channel_memberships(raw_memberships, channels: list[str], grade: int | None = None, section: int | None = None) -> dict[str, list[dict]]:
    memberships = raw_memberships if isinstance(raw_memberships, dict) else {}
    result: dict[str, list[dict]] = {}
    for ch in channels:
        entries = []
        seen = set()
        raw_entries = memberships.get(ch) if isinstance(memberships.get(ch), list) else []
        for entry in raw_entries:
            if not isinstance(entry, dict):
                continue
            g = _coerce_int(entry.get("grade"))
            s = _coerce_int(entry.get("section"))
            if g is None or s is None:
                continue
            key = f"{g}-{s}"
            if key in seen:
                continue
            seen.add(key)
            entries.append({"grade": g, "section": s})
        if grade is not None and section is not None:
            key = f"{grade}-{section}"
            if key not in seen:
                entries.append({"grade": grade, "section": section})
        result[ch] = entries
    return result


def _load_magnet_payload(state: ClassState | None) -> dict[str, dict[str, object]]:
    if not state or not state.data:
        return {"magnets": {}, "channels": [DEFAULT_CHAT_CHANNEL], "channelMemberships": {DEFAULT_CHAT_CHANNEL: []}}
    try:
        raw = json.loads(state.data)
    except json.JSONDecodeError:
        return {"magnets": {}, "channels": [DEFAULT_CHAT_CHANNEL], "channelMemberships": {DEFAULT_CHAT_CHANNEL: []}}
    if not isinstance(raw, dict):
        return {"magnets": {}, "channels": [DEFAULT_CHAT_CHANNEL], "channelMemberships": {DEFAULT_CHAT_CHANNEL: []}}
    magnets = raw.get("magnets")
    if not isinstance(magnets, dict):
        magnets = {}
    channels = _normalize_channels(raw.get("channels"))
    memberships = _normalize_channel_memberships(
        raw.get("channelMemberships"),
        channels,
        getattr(state, "grade", None),
        getattr(state, "section", None),
    )
    return {"magnets": magnets, "channels": channels, "channelMemberships": memberships}


def _persist_magnet_state(state: ClassState | None, grade: int, section: int, payload: dict[str, object]) -> ClassState:
    if not state:
        state = ClassState(grade=grade, section=section, data="")
        db.session.add(state)
    state.data = json.dumps(payload, ensure_ascii=False)
    db.session.commit()
    return state


def _upsert_student_status(
    magnets: dict[str, dict[str, object]],
    student_number: int,
    status_code: str,
    reason: str | None,
) -> dict[str, dict[str, object]]:
    normalized_reason = reason.strip() if reason else None
    payload: dict[str, object] = {"attachedTo": status_code}
    if status_code == "etc" and normalized_reason:
        payload["reason"] = normalized_reason
    elif status_code != "etc":
        payload.pop("reason", None)

    key = str(student_number)
    existing = magnets.get(key, {}) if isinstance(magnets, dict) else {}
    for field in PRESERVE_STATE_FIELDS:
        if field in existing and field not in payload:
            payload[field] = existing[field]

    magnets[key] = payload
    return magnets


@app.get("/api/qrng")
@cross_origin(origins=[config.FRONTEND_ORIGIN, "https://churchofquantum.netlify.app"])
def qrng_proxy():
    length = request.args.get("length", default=128, type=int)
    qtype = request.args.get("type", default="uint8")

    if not length or length < 1 or length > QRNG_MAX_LENGTH:
        return (
            jsonify(
                {
                    "success": False,
                    "error": "invalid_length",
                    "message": f"length must be between 1 and {QRNG_MAX_LENGTH}",
                }
            ),
            400,
        )

    if qtype not in QRNG_ALLOWED_TYPES:
        qtype = "uint8"

    try:
        upstream = requests.get(
            QRNG_ENDPOINT,
            params={"length": length, "type": qtype},
            timeout=5,
        )
        upstream.raise_for_status()
        data = upstream.json()
        if data.get("success"):
            return jsonify(data)
        app.logger.warning("QRNG upstream responded without success flag: %s", data)
    except requests.RequestException as exc:
        app.logger.warning("QRNG upstream error: %s", exc)
    except ValueError:
        app.logger.warning("QRNG upstream returned invalid JSON")

    fallback = _fallback_qrng(length, qtype)
    return jsonify(fallback), 200

@app.route("/board", methods=["GET", "POST"])
def board():
    CLASS_CONFIGS = load_class_config()

    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    config = CLASS_CONFIGS.get((grade, section))
    if not config:
        return send_from_directory(".", "404.html")

    guard_key = pin_guard_key(f"board:{grade}:{section}")

    if request.method == "POST":
        allowed, _, locked_for = pin_guard_status(guard_key, max_attempts=5, window_seconds=300, lock_seconds=900)
        if not allowed:
            return make_response("Too many attempts. 잠시 후 다시 시도해주세요.", 429)

        pin = request.form.get("pin")
        if str(config["pin"]) == pin:
            session[f"board_verified_{grade}_{section}"] = True
            pin_guard_reset(guard_key)
            return render_template("index.html")

        attempts_left, lock_remaining = pin_guard_register_failure(
            guard_key, max_attempts=5, window_seconds=300, lock_seconds=900
        )
        status_code = 429 if lock_remaining else 401
        return make_response("잘못된 PIN 입니다.", status_code)

    if session.get(f"board_verified_{grade}_{section}"):
        return render_template("index.html")

    return send_from_directory(".", "enter_pin.html")


def _validate_teacher_pin(pin: str) -> bool:
    allowed = config.TEACHER_PINS
    if not allowed:
        return False
    return pin in allowed


def _teacher_session_valid() -> bool:
    if is_teacher_session_active():
        return True
    clear_teacher_session()
    return False


@app.route("/teacher", methods=["GET", "POST"])
def teacher_dashboard():
    if _teacher_session_valid():
        return render_template("teacher.html")

    error = None
    guard_key = pin_guard_key("teacher")

    if request.method == "POST":
        allowed, attempts_left, locked_for = pin_guard_status(guard_key, max_attempts=5, window_seconds=300, lock_seconds=900)
        if not allowed:
            error = f"시도가 잠겼어요. {locked_for}초 후 다시 시도하세요."
            return render_template(
                "teacher_pin.html",
                error=error,
                has_pin=bool(config.TEACHER_PINS),
            )

        pin = (request.form.get("pin") or "").strip()
        remember = request.form.get("remember") == "on"

        if not config.TEACHER_PINS:
            error = "교사용 PIN이 설정되지 않았습니다. 관리자에게 문의하세요."
        elif _validate_teacher_pin(pin):
            duration = (
                config.TEACHER_SESSION_REMEMBER_SECONDS
                if remember
                else config.TEACHER_SESSION_DURATION_SECONDS
            )
            mark_teacher_session(duration_seconds=duration, remember=remember)
            pin_guard_reset(guard_key)
            return redirect(url_for("teacher_dashboard"))
        else:
            attempts_left, lock_remaining = pin_guard_register_failure(
                guard_key, max_attempts=5, window_seconds=300, lock_seconds=900
            )
            if lock_remaining:
                error = f"PIN이 여러 번 틀렸어요. {lock_remaining}초 후 다시 시도하세요."
            elif attempts_left > 0:
                error = f"PIN이 올바르지 않습니다. 다시 시도해주세요. (남은 시도 {attempts_left}회)"
            else:
                error = "PIN이 올바르지 않습니다. 잠시 후 다시 시도해주세요."

    return render_template(
        "teacher_pin.html",
        error=error,
        has_pin=bool(config.TEACHER_PINS),
    )


@app.get("/teacher.html")
def teacher_legacy_redirect():
    return redirect(url_for("teacher_dashboard"))

@app.route("/", methods=["GET", "POST"])
def index():  # type: ignore[override]
    user = session.get("user")
    if user:
        user_type = str(user.get("type", "")).lower()
        if user_type == "teacher":
            return redirect(url_for("teacher_dashboard"))
        if user_type == "student":
            return redirect("/user.html")

    return send_from_directory(".", "login.html") 

@app.get("/privacy")
def privacy():
    return send_from_directory(".", "privacy.html")


@app.get("/set")
def quick_apply_status():
    raw_status = request.args.get("status")
    reason = (request.args.get("reason") or "").strip() or None
    status_code = _normalize_status_param(raw_status)
    allowed_codes = sorted(STATUS_LABELS.keys())

    if not status_code:
        return (
            render_template(
                "set_status.html",
                success=False,
                status_code=raw_status,
                status_label=None,
                allowed_codes=allowed_codes,
                labels=STATUS_LABELS,
                error="invalid_status",
            ),
            400,
        )

    user = session.get("user")
    if not user:
        return redirect(url_for("auth.login", next=request.url))

    if str(user.get("type", "")).lower() != "student":
        return (
            render_template(
                "set_status.html",
                success=False,
                status_code=status_code,
                status_label=None,
                allowed_codes=allowed_codes,
                labels=STATUS_LABELS,
                error="unsupported_user",
            ),
            403,
        )

    grade, section, seat = _derive_student_session()
    if grade is None or section is None or seat is None:
        return (
            render_template(
                "set_status.html",
                success=False,
                status_code=status_code,
                status_label=None,
                allowed_codes=allowed_codes,
                labels=STATUS_LABELS,
                error="missing_profile",
            ),
            400,
        )

    try:
        state = ClassState.query.filter_by(grade=grade, section=section).first()
        payload = _load_magnet_payload(state)
        magnets = payload.get("magnets", {})
        channels = _normalize_channels(payload.get("channels"))
        payload["channels"] = channels
        _upsert_student_status(magnets, seat, status_code, reason)
        payload["magnets"] = magnets
        state = _persist_magnet_state(state, grade, section, payload)
    except Exception as exc:
        db.session.rollback()
        app.logger.exception("Failed to apply status via /set: %s", exc)
        return (
            render_template(
                "set_status.html",
                success=False,
                status_code=status_code,
                status_label=None,
                allowed_codes=allowed_codes,
                labels=STATUS_LABELS,
                error="save_failed",
            ),
            500,
        )

    try:
        if socketio:
            socketio.emit(
                "state_updated",
                {"grade": grade, "section": section, "magnets": magnets},
                namespace=f"/ws/classes/{grade}/{section}",
            )
    except Exception as exc:
        app.logger.warning("Websocket broadcast failed for /set: %s", exc)

    try:
        broadcast_public_status_update(grade, section)
    except Exception as exc:
        app.logger.warning("Public status broadcast failed for /set: %s", exc)

    status_label = STATUS_LABELS.get(status_code, status_code)
    return render_template(
        "set_status.html",
        success=True,
        status_code=status_code,
        status_label=status_label,
        reason=reason if status_code == "etc" else None,
        allowed_codes=allowed_codes,
        labels=STATUS_LABELS,
        grade=grade,
        section=section,
    )


@app.route("/reload-configs")
def reload_configs():
    global CLASS_CONFIGS
    CLASS_CONFIGS = load_class_config(force_refresh=True)
    return jsonify({"status": "reloaded"})


@app.route("/api/version")
def get_version():
    """Get current asset version for cache busting"""
    return jsonify({"version": config.ASSET_VERSION})

@app.route("/sitemap.xml")
def sitemap():
    return send_from_directory(".", "sitemap.xml", mimetype="application/xml")

@app.route("/robots.txt")
def robots():
    return send_from_directory(".", "robots.txt", mimetype="text/plain")

if __name__ == "__main__":
    with app.app_context():
        db.create_all()

        # 스케줄러 시작 (2월 28일 데이터 초기화)
        from scheduler import start_scheduler
        start_scheduler()

    socketio.run(app, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True, debug=True)
