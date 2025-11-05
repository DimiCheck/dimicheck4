from __future__ import annotations

from typing import Any, Dict, Tuple

import requests
from flask import Blueprint, jsonify, redirect, request, session
from jose import jwt as jose_jwt
from jose.exceptions import JWTError

from config import config
from extensions import db
from models import User, UserType

blueprint = Blueprint("auth", __name__, url_prefix="/auth")


def _coerce_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_first(mapping: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping.get(key)
    return None


def _split_student_identifier(value: Any) -> Tuple[int | None, int | None, int | None]:
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


def _normalize_student_payload(data: Dict[str, Any]) -> None:
    user_type = str(data.get("type", "")).lower()
    if user_type != "student":
        return

    grade = _coerce_int(_extract_first(data, "grade", "grade_no", "gradeNo"))
    section = _coerce_int(
        _extract_first(
            data,
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
        data,
        "student_number",
        "studentNumber",
        "number",
        "student_no",
        "studentNo",
    )
    derived_grade, derived_section, seat = _split_student_identifier(identifier)

    if grade is None:
        grade = derived_grade
    if section is None:
        section = derived_section

    if seat is None:
        _, _, seat = _split_student_identifier(
            _extract_first(data, "seat_number", "seatNumber", "number_only")
        )

    composite = None
    if grade is not None and section is not None and seat is not None:
        composite = grade * 1000 + section * 100 + seat

    if grade is not None:
        data["grade"] = grade

    if section is not None:
        data["class"] = section
        data["class_no"] = section
        data["section"] = section

    if seat is not None:
        data["student_number"] = seat
        data["seat_number"] = seat

    if composite is not None:
        data["number"] = composite


def get_public_key() -> str:
    url = "https://auth.dimigo.net/oauth/public"
    resp = requests.get(url, timeout=5)
    resp.raise_for_status()
    return resp.text


def issue_session(payload: Dict[str, Any]) -> None:
    session["user"] = payload


def ensure_user(data: Dict[str, Any]) -> User:
    user = User(
        name=data.get("name", ""),
        type=UserType(data.get("type")),
        grade=data.get("number") // 1000,
        class_no=(data.get("number") % 1000) // 100,
        number=(data.get("number") % 100),
    )

    db.session.add(user)
    db.session.commit()
    return user

@blueprint.get("/login")
def login() -> Any:
    params = {
        "client": config.OAUTH_CLIENT,
        "redirect": config.OAUTH_REDIRECT_URI,
    }
    url = f"https://auth.dimigo.net/oauth?{requests.compat.urlencode(params)}"
    return redirect(url)

@blueprint.get("/callback")
def callback() -> Any:
    token = request.args.get("token")
    if not token:
        return jsonify({"error": {"code": "invalid_token", "message": "token missing"}}), 400

    try:
        public_key = get_public_key()
        payload = jose_jwt.decode(token, public_key, algorithms=["RS256"])
        user_data = payload.get("data", {})
    except JWTError as e:
        return jsonify({"error": {"code": "invalid_token", "message": str(e)}}), 400

    # 세션 저장 및 유저 등록
    _normalize_student_payload(user_data)
    session["user"] = user_data
    ensure_user(user_data)

    # 역할에 따라 리디렉션
    role = user_data.get("type")
    if role == "teacher":
        return redirect("/teacher")
    elif role == "student":
        return redirect("/user.html")
    else:
        # 알 수 없는 역할이면 기본 페이지로
        return redirect("/")


@blueprint.route("/logout", methods=["GET", "POST"])
def logout() -> Any:
    session.clear()
    return redirect("/login.html")


@blueprint.get("/dev-login")
def dev_login() -> Any:
    if not config.ENABLE_DEV_LOGIN:
        return ("", 404)
    role = request.args.get("role", "student")
    payload: Dict[str, Any] = {
        "id": 0,
        "email": f"dev-{role}@example.com",
        "name": "개발계정",
        "type": role,
    }
    if role == "student":
        payload.update(
            {
                "grade": int(request.args.get("grade", 1)),
                "class": int(request.args.get("class", 1)),
                "number": int(request.args.get("number", 1)),
            }
        )
    issue_session(payload)
    ensure_user(payload)
    return redirect("/")

@blueprint.route("/status")
def status():
    user = session.get("user")
    if not user:
        return jsonify({"logged_in": False}), 401

    return jsonify({
        "logged_in": True,
        "role": user["type"],   # "teacher" or "student"
        "grade": user.get("grade"),
        "section": user.get("section"),
        "number": user.get("number"),
    })
