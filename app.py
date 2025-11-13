
## app.py
from __future__ import annotations

import json
from typing import Any

from flask import Flask, jsonify, redirect, render_template, request, send_from_directory, session, url_for
from flask_cors import CORS
from flask_smorest import Api
from flask_socketio import SocketIO

from auth import blueprint as auth_bp
from class_routes import blueprint as class_bp
from exports_routes import blueprint as export_bp
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
app.add_url_rule("/metrics", "metrics", metrics)

db.init_app(app)
socketio = SocketIO(app, cors_allowed_origins=config.FRONTEND_ORIGIN, async_mode="threading")
CORS(app, origins=[config.FRONTEND_ORIGIN], supports_credentials=True)
for ns in namespaces:
    socketio.on_namespace(ns)

app.before_request(before_request)
app.after_request(after_request)

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
        return jsonify({"error": {"code": str(code), "message": message}})

    # 일반 브라우저 접근 → HTML 페이지
    return send_from_directory(".", "404.html", code=code, message=message)

@app.get("/healthz")
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
            return send_from_directory(".", "index.html")
        return send_from_directory(".", "enter_pin.html")

    if session.get(f"board_verified_{grade}_{section}"):
        return send_from_directory(".", "index.html")

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


@app.route("/reload-configs")
def reload_configs():
    global CLASS_CONFIGS
    CLASS_CONFIGS = load_class_config()
    return jsonify({"status": "reloaded"})

@app.route("/sitemap.xml")
def sitemap():
    return send_from_directory(".", "sitemap.xml", mimetype="application/xml")

@app.route("/robots.txt")
def robots():
    return send_from_directory(".", "robots.txt", mimetype="text/plain")

if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    socketio.run(app, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True, debug=True)
