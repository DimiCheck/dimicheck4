from __future__ import annotations

import json

from flask import Blueprint, jsonify, request

from extensions import db
from models import ClassState
from config_loader import load_class_config

blueprint = Blueprint("classes", __name__, url_prefix="/api/classes")

@blueprint.post("/state/save")
def save_state():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade/section"}), 400

    payload = request.get_json() or {}
    new_magnets = payload.get("magnets", {})

    state = ClassState.query.filter_by(grade=grade, section=section).first()

    # ✅ 기존 데이터 유지
    if state and state.data:
        magnets = json.loads(state.data).get("magnets", {})
    else:
        magnets = {}

    # ✅ 기존 + 새로운 데이터 병합
    for num, data in new_magnets.items():
        magnets[num] = data   # 같은 번호면 갱신, 없으면 추가

    if not state:
        state = ClassState(
            grade=grade,
            section=section,
            data=json.dumps({"magnets": magnets})
        )
        db.session.add(state)
    else:
        state.data = json.dumps({"magnets": magnets})

    db.session.commit()
    return jsonify({"ok": True, "magnets": magnets})

@blueprint.get("/state/load")
def load_class_state():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    if not state:
        return jsonify({"magnets": {}})
    return jsonify(json.loads(state.data))

@blueprint.get("/config")
def class_config():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    if grade is None or section is None:
        return jsonify({"error": "grade and section required"}), 400

    config = load_class_config().get((grade, section))

    if not config:
        config = {"end": 30, "skip_numbers": []}

    return jsonify({
        "end": config["end"],
        "skipNumbers": config["skip_numbers"]
    })
