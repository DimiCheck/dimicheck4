from __future__ import annotations

from typing import Any, Dict

import requests
from flask import Blueprint, jsonify, redirect, request, session
from jose import jwt as jose_jwt
from jose.exceptions import JWTError

from config import config
from extensions import db
from models import User, UserType

blueprint = Blueprint("auth", __name__, url_prefix="/auth")


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
    session["user"] = user_data
    ensure_user(user_data)

    # 역할에 따라 리디렉션
    role = user_data.get("type")
    if role == "teacher":
        return redirect("/teacher.html")
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
