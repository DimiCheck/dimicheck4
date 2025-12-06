from __future__ import annotations

from flask import jsonify, request

from models import User
from oauth.utils import decode_access_token, split_scopes


def register_userinfo_routes(bp):
    @bp.get("/userinfo")
    def userinfo():
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "invalid_token"}), 401
        token = auth_header.split(" ", 1)[1].strip()
        try:
            claims = decode_access_token(token)
        except Exception:  # pylint: disable=broad-except
            return jsonify({"error": "invalid_token"}), 401
        user_id = claims.get("sub")
        user = User.query.get(user_id)
        if not user:
            return jsonify({"error": "user_not_found"}), 404
        scopes = split_scopes(claims.get("scope"))
        payload = {}
        if "basic" in scopes:
            payload.update({"user_id": user.id, "email": user.email})
        if "profile" in scopes:
            pass  # 이름은 포함하지 않음 (개인정보 최소화)
        if "student_info" in scopes:
            payload.update({"grade": user.grade, "class": user.class_no, "number": user.number})
        return jsonify(payload)
