from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request, session

from extensions import db
from models import ClassState, ClassRoutine
from config_loader import load_class_config
from utils import is_board_session_active, is_teacher_session_active

blueprint = Blueprint("classes", __name__, url_prefix="/api/classes")


def _normalize_class_value(value: int | str | None) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_first(mapping: dict, *keys: str) -> int | str | None:
    for key in keys:
        if key in mapping:
            return mapping.get(key)
    return None


def _split_student_identifier(value: int | str | None) -> tuple[int | None, int | None, int | None]:
    if value is None:
        return None, None, None

    digits = "".join(ch for ch in str(value) if ch.isdigit())
    if not digits:
        return None, None, None

    if len(digits) >= 3:
        grade = _normalize_class_value(digits[0])
        number = _normalize_class_value(digits[-2:])
        section_digits = digits[1:-2]
        section = _normalize_class_value(section_digits) if section_digits else None
        return grade, section, number

    return None, None, _normalize_class_value(digits)


def _get_student_session_info() -> tuple[int | None, int | None, int | None]:
    user = session.get("user") or {}
    user_type = str(user.get("type", "")).lower()
    if user_type != "student":
        return None, None, None

    grade = _normalize_class_value(_extract_first(user, "grade", "grade_no", "gradeNo"))
    section = _normalize_class_value(
        _extract_first(
            user,
            "class",
            "class_no",
            "classNo",
            "classroom",
            "section",
            "section_no",
            "sectionNo",
        )
    )

    identifier = _extract_first(
        user,
        "number",
        "student_number",
        "studentNumber",
        "student_no",
        "studentNo",
    )
    derived_grade, derived_section, derived_number = _split_student_identifier(identifier)
    if grade is None:
        grade = derived_grade
    if section is None:
        section = derived_section

    number = derived_number
    if number is None:
        _, _, number = _split_student_identifier(
            _extract_first(user, "seat_number", "seatNumber", "number_only")
        )

    return grade, section, number


def _student_matches(grade: int | None, section: int | None) -> bool:
    if grade is None or section is None:
        return False

    session_grade, session_section, _ = _get_student_session_info()
    if session_grade is None or session_section is None:
        return False

    return session_grade == grade and session_section == section


def _is_authorized(grade: int | None, section: int | None) -> bool:
    return (
        is_teacher_session_active()
        or is_board_session_active(grade, section)
        or _student_matches(grade, section)
    )


def _teacher_only() -> bool:
    return is_teacher_session_active()

@blueprint.post("/state/save")
def save_state():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade/section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json() or {}
    incoming_magnets = payload.get("magnets", {})
    normalized_magnets = {str(key): value for key, value in incoming_magnets.items()}

    session_grade, session_section, session_number = _get_student_session_info()
    if (
        session_grade == grade
        and session_section == section
        and session_number is not None
    ):
        allowed_key = str(session_number)
        allowed_value = None
        for candidate in (allowed_key, allowed_key.zfill(2)):
            if candidate in normalized_magnets:
                allowed_value = normalized_magnets[candidate]
                break

        if allowed_value is None and session_number in normalized_magnets:
            allowed_value = normalized_magnets[session_number]

        if allowed_value is None:
            return jsonify({"error": "invalid payload"}), 400

        normalized_magnets = {allowed_key: allowed_value}

    new_magnets = normalized_magnets

    state = ClassState.query.filter_by(grade=grade, section=section).first()

    # ✅ 기존 데이터 유지
    if state and state.data:
        magnets = json.loads(state.data).get("magnets", {})
    else:
        magnets = {}

    # ✅ 기존 + 새로운 데이터 병합
    for num, data in new_magnets.items():
        magnets[str(num)] = data   # 같은 번호면 갱신, 없으면 추가

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


def _load_state_payload(state: ClassState | None) -> dict[str, dict[str, object]]:
    if not state or not state.data:
        return {"magnets": {}}

    try:
        raw = json.loads(state.data)
    except json.JSONDecodeError:
        return {"magnets": {}}

    if not isinstance(raw, dict):
        return {"magnets": {}}

    magnets = raw.get("magnets")
    if not isinstance(magnets, dict):
        magnets = {}

    return {"magnets": magnets}


@blueprint.post("/thought")
def upsert_thought():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    session_grade, session_section, session_number = _get_student_session_info()
    is_teacher = is_teacher_session_active()

    if session_grade != grade or session_section != section or session_number is None:
        if not is_teacher:
            return jsonify({"error": "forbidden"}), 403

    target_number = session_number
    if is_teacher:
        target_number = request.args.get("number", type=int)
    if target_number is None:
        return jsonify({"error": "missing target number"}), 400

    payload = request.get_json(silent=True) or {}
    thought_text = (payload.get("thought") or "").strip()
    duration_value = payload.get("duration")
    try:
        duration_seconds = int(duration_value)
    except (TypeError, ValueError):
        duration_seconds = 5
    duration_seconds = max(1, min(duration_seconds, 60))

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    created_state = False
    if not state:
        state = ClassState(grade=grade, section=section, data=json.dumps({"magnets": {}}))
        db.session.add(state)
        created_state = True

    state_payload = _load_state_payload(state)
    magnets = state_payload["magnets"]
    key = str(target_number)
    current = magnets.get(key)
    if not isinstance(current, dict):
        current = {}

    now = datetime.now(timezone.utc)
    response_payload: dict[str, object] = {"ok": True, "number": target_number}

    if thought_text:
        max_length = 140
        if len(thought_text) > max_length:
            thought_text = thought_text[:max_length]

        posted_at = now.isoformat()
        expires_at = (now + timedelta(seconds=duration_seconds)).isoformat()
        current.update({
            "thought": thought_text,
            "thoughtPostedAt": posted_at,
            "thoughtExpiresAt": expires_at,
        })
        response_payload.update({
            "thought": thought_text,
            "thoughtExpiresAt": expires_at,
            "thoughtPostedAt": posted_at,
        })
    else:
        for field in ("thought", "thoughtPostedAt", "thoughtExpiresAt"):
            current.pop(field, None)
        response_payload["thought"] = None

    magnets[key] = current
    state.data = json.dumps({"magnets": magnets})
    db.session.commit()

    if created_state:
        response_payload["created"] = True

    return jsonify(response_payload)

@blueprint.get("/state/load")
def load_class_state():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    state = ClassState.query.filter_by(grade=grade, section=section).first()
    if not state:
        return jsonify({"magnets": {}})
    return jsonify(json.loads(state.data))



@blueprint.get("/routine")
def get_routine():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    routine = ClassRoutine.query.filter_by(grade=grade, section=section).first()
    if not routine:
        # 빈 구조 반환
        return jsonify({"afterschool": {}, "changdong": {}})

    return jsonify(routine.to_dict())


def _normalize_participant_map(data):
    allowed = ["Mon", "Tue", "Wed", "Thu", "Fri"]
    if not isinstance(data, dict):
        if isinstance(data, list):
            # 레거시: 요일 리스트만 내려온 경우 → 빈 배열 매핑
            data = {day: [] for day in data if day in allowed}
        else:
            return {}

    normalized = {}
    for day, numbers in data.items():
        if day not in allowed:
            continue
        items = numbers if isinstance(numbers, (list, tuple)) else [numbers]
        cleaned = []
        for item in items:
            try:
                value = int(item)
            except (TypeError, ValueError):
                continue
            if 1 <= value <= 99 and value not in cleaned:
                cleaned.append(value)
        if cleaned:
            normalized[day] = sorted(cleaned)

    return normalized


ALLOWED_ROUTINE_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]


@blueprint.post("/routine")
def save_routine():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)
    if grade is None or section is None:
        return jsonify({"error": "missing grade or section"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json(silent=True) or {}
    afterschool = payload.get("afterschool") or {}
    changdong = payload.get("changdong") or {}

    afterschool_map = _normalize_participant_map(afterschool)
    changdong_map = _normalize_participant_map(changdong)

    routine = ClassRoutine.query.filter_by(grade=grade, section=section).first()
    if not routine:
        routine = ClassRoutine(grade=grade, section=section)
        db.session.add(routine)

    is_teacher = _teacher_only()
    is_board = is_board_session_active(grade, section)

    if is_teacher or is_board:
        routine.set_afterschool_map(afterschool_map)
        routine.set_changdong_map(changdong_map)
    else:
        session_grade, session_section, session_number = _get_student_session_info()
        if (
            session_grade != grade
            or session_section != section
            or session_number is None
        ):
            return jsonify({"error": "forbidden"}), 403

        existing_afterschool = routine.get_afterschool_map()
        existing_changdong = routine.get_changdong_map()

        updated_afterschool = {
            day: list(numbers) for day, numbers in existing_afterschool.items()
        }

        requested_afterschool_days = {
            day
            for day, numbers in afterschool_map.items()
            if session_number in numbers
        }

        for day in ALLOWED_ROUTINE_DAYS:
            members = list(updated_afterschool.get(day, []))
            if day in requested_afterschool_days:
                if session_number not in members:
                    members.append(session_number)
                members.sort()
                updated_afterschool[day] = members
            else:
                if session_number in members:
                    members = [num for num in members if num != session_number]
                    if members:
                        updated_afterschool[day] = members
                    else:
                        updated_afterschool.pop(day, None)

        updated_changdong = {
            day: list(numbers) for day, numbers in existing_changdong.items()
        }

        requested_changdong_days = [
            day
            for day, numbers in changdong_map.items()
            if session_number in numbers
        ]

        selected_changdong_day = requested_changdong_days[0] if requested_changdong_days else None

        for day in list(updated_changdong.keys()):
            members = [num for num in updated_changdong[day] if num != session_number]
            if members:
                updated_changdong[day] = members
            else:
                updated_changdong.pop(day)

        if selected_changdong_day is not None and selected_changdong_day in ALLOWED_ROUTINE_DAYS:
            members = updated_changdong.get(selected_changdong_day, [])
            if session_number not in members:
                members.append(session_number)
            members.sort()
            updated_changdong[selected_changdong_day] = members

        routine.set_afterschool_map(updated_afterschool)
        routine.set_changdong_map(updated_changdong)

    db.session.commit()

    return jsonify(routine.to_dict())

@blueprint.get("/config")
def class_config():
    grade = request.args.get("grade", type=int)
    section = request.args.get("section", type=int)

    if grade is None or section is None:
        return jsonify({"error": "grade and section required"}), 400

    if not _is_authorized(grade, section):
        return jsonify({"error": "forbidden"}), 403

    config = load_class_config().get((grade, section))

    if not config:
        config = {"end": 30, "skip_numbers": []}

    return jsonify({
        "end": config["end"],
        "skipNumbers": config["skip_numbers"]
    })
