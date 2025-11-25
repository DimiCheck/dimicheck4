from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from typing import Any, Dict

from flask import Response, current_app, request, session

from extensions import db
from models import RememberedSession, User


def _serialize_user(user: User) -> Dict[str, Any]:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "type": user.type.value if user.type else None,
        "grade": user.grade,
        "class": user.class_no,
        "section": user.class_no,
        "number": user.number,
    }


def issue_session(user: User) -> None:
    session.permanent = True
    session["user"] = _serialize_user(user)
    session.modified = True


def load_remembered_user() -> None:
    if session.get("user"):
        return
    cookie_name = current_app.config["REMEMBER_ME_COOKIE_NAME"]
    token = request.cookies.get(cookie_name)
    if not token:
        return
    record = RememberedSession.query.filter_by(session_id=token).first()
    if not record:
        return
    if record.expires_at < datetime.utcnow():
        db.session.delete(record)
        db.session.commit()
        return
    if not record.user:
        db.session.delete(record)
        db.session.commit()
        return
    issue_session(record.user)


def persist_remembered_session(user: User, response: Response, device_info: str | None = None) -> None:
    cookie_name = current_app.config["REMEMBER_ME_COOKIE_NAME"]
    token = secrets.token_hex(32)
    expires_at = datetime.utcnow() + timedelta(days=current_app.config["REMEMBER_ME_DURATION_DAYS"])
    record = RememberedSession(
        session_id=token,
        user_id=user.id,
        device_info=device_info,
        expires_at=expires_at,
    )
    db.session.add(record)
    db.session.commit()

    max_age = int(current_app.config["REMEMBER_ME_DURATION_DAYS"]) * 24 * 60 * 60
    response.set_cookie(
        cookie_name,
        token,
        max_age=max_age,
        secure=True,
        httponly=True,
        samesite="Lax",
    )


def clear_remembered_session(response: Response | None = None) -> None:
    cookie_name = current_app.config["REMEMBER_ME_COOKIE_NAME"]
    token = request.cookies.get(cookie_name)
    if token:
        record = RememberedSession.query.filter_by(session_id=token).first()
        if record:
            db.session.delete(record)
            db.session.commit()
    if response:
        response.delete_cookie(cookie_name)
