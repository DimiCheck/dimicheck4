
## app.py
from __future__ import annotations

import json
from typing import Any

from flask import Flask, jsonify, request, send_from_directory, session
from flask_cors import CORS
from flask_smorest import Api
from flask_socketio import SocketIO

from auth import blueprint as auth_bp
from class_routes import blueprint as class_bp
from exports_routes import blueprint as export_bp
from config import config
from extensions import db
from models import ClassConfig, ClassPin
from utils import after_request, before_request, metrics, setup_logging
from ws import namespaces

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
        return jsonify({"error": {"code": str(code), "message": message}}), code

    # 일반 브라우저 접근 → HTML 페이지
    return send_from_directory(".", "404.html", code=code, message=message), code


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

@app.route("/board", methods=["GET", "POST"])
def board():  # type: ignore[override]
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    if not grade or not section:
        return send_from_directory(".", "404.html")

    if request.method == "POST":
        pin = request.form.get("pin")

        record = ClassPin.query.filter_by(grade=grade, section=section).first()
        if record and record.pin == pin:
            session[f"board_verified_{grade}_{section}"] = True
            return send_from_directory(".", "index.html")

        return send_from_directory(".", "enter_pin.html")

    if session.get(f"board_verified_{grade}_{section}"):
        return send_from_directory(".", "index.html")

    return send_from_directory(".", "enter_pin.html")

@app.route("/", methods=["GET", "POST"])
def index():  # type: ignore[override]
    return send_from_directory(".", "login.html") 

if __name__ == "__main__":
    with app.app_context():
        db.create_all()

        for grade in range(1, 4):  # 1~3학년
            for section in range(1, 7):  # 1~6반
                exists = ClassConfig.query.filter_by(grade=grade, section=section).first()

                if not exists:
                    if grade == 1 and section == 3:
                        config = ClassConfig(
                            grade=grade,
                            section=section,
                            end=31,  # 기본 31번까지
                            skip_numbers=json.dumps([12]),  # 결번 없음
                        )
                        db.session.add(config)
                        continue

                    config = ClassConfig(
                        grade=grade,
                        section=section,
                        end=30,  # 기본 31번까지
                        skip_numbers=json.dumps([]),  # 결번 없음
                    )
                    db.session.add(config)

                existing_pin = ClassPin.query.filter_by(grade=grade, section=section).first()
                if existing_pin:
                    existing_pin.pin = grade * 10 + section  # 업데이트
                else:
                    pin = ClassPin(grade=grade, section=section, pin=grade * 10 + section)
                    db.session.add(pin)

        db.session.commit()

    socketio.run(app, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True, debug=True)