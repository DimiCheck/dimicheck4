
## app.py
from __future__ import annotations

import json
import secrets
from typing import Any
from dotenv import load_dotenv

# .env 파일 로드 (환경 변수)
load_dotenv()

from flask import Flask, jsonify, redirect, render_template, request, send_from_directory, session, url_for
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
from public_api import public_api_bp
from developer_routes import blueprint as developer_bp
from oauth import blueprint as oauth_bp
from account import blueprint as account_bp
from config import config
from extensions import db
from models import ClassConfig, ClassPin
from config_loader import load_class_config
from utils import (
    after_request,
    before_request,
    clear_teacher_session,
    is_teacher_session_active,
    mark_teacher_session,
    metrics,
    setup_logging,
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
app.add_url_rule("/metrics", "metrics", metrics)

db.init_app(app)
socketio = SocketIO(app, cors_allowed_origins=config.FRONTEND_ORIGIN, async_mode="threading")
CORS(app, origins=[config.FRONTEND_ORIGIN], supports_credentials=True)
for ns in namespaces:
    socketio.on_namespace(ns)

app.before_request(before_request)
app.after_request(after_request)


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


def _fallback_qrng(length: int, qtype: str) -> dict[str, Any]:
    if qtype == "uint16":
        data = [secrets.randbits(16) for _ in range(length)]
    elif qtype == "hex16":
        data = [f"{secrets.randbits(16):04x}" for _ in range(length)]
    else:  # default uint8
        data = list(secrets.token_bytes(length))

    return {"success": True, "data": data, "source": "fallback"}


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

    if request.method == "POST":
        pin = request.form.get("pin")
        if str(config["pin"]) == pin:
            session[f"board_verified_{grade}_{section}"] = True
            return render_template("index.html")
        return send_from_directory(".", "enter_pin.html")

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

    if request.method == "POST":
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
            return redirect(url_for("teacher_dashboard"))
        else:
            error = "PIN이 올바르지 않습니다. 다시 시도해주세요."

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
