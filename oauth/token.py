from __future__ import annotations

from datetime import datetime

from flask import jsonify, request

from extensions import db
from models import OAuthAuthorizationCode, OAuthClient, OAuthRefreshToken, User
from oauth.utils import (
    issue_access_token,
    issue_refresh_token,
    split_scopes,
)


def register_token_routes(bp):
    @bp.post("/token")
    def token():
        grant_type = request.form.get("grant_type")
        if grant_type == "authorization_code":
            return _handle_authorization_code()
        if grant_type == "refresh_token":
            return _handle_refresh_token()
        return jsonify({"error": "unsupported_grant_type"}), 400


def _authenticate_client() -> OAuthClient | None:
    client_id = request.form.get("client_id")
    client_secret = request.form.get("client_secret")
    if not client_id or not client_secret:
        return None
    client = OAuthClient.query.filter_by(client_id=client_id).first()
    if not client or client.client_secret != client_secret:
        return None
    return client


def _handle_authorization_code():
    client = _authenticate_client()
    if not client:
        return jsonify({"error": "invalid_client"}), 401
    code_value = request.form.get("code")
    redirect_uri = request.form.get("redirect_uri")
    if not code_value or not redirect_uri:
        return jsonify({"error": "invalid_request"}), 400
    code = OAuthAuthorizationCode.query.filter_by(code=code_value).first()
    if not code or code.used or code.client_id != client.id or code.redirect_uri != redirect_uri:
        return jsonify({"error": "invalid_grant"}), 400
    if code.expires_at < datetime.utcnow():
        return jsonify({"error": "expired_code"}), 400
    user = User.query.get(code.user_id)
    if not user:
        return jsonify({"error": "user_not_found"}), 400
    code.used = True
    db.session.commit()
    scopes = split_scopes(code.scope)
    access_token, expires_in = issue_access_token(user, scopes)
    refresh_record = issue_refresh_token(user, client, scopes)
    return jsonify(
        {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": expires_in,
            "refresh_token": refresh_record.token,
            "scope": " ".join(scopes),
        }
    )


def _handle_refresh_token():
    client = _authenticate_client()
    if not client:
        return jsonify({"error": "invalid_client"}), 401
    token_value = request.form.get("refresh_token")
    if not token_value:
        return jsonify({"error": "invalid_request"}), 400
    record = OAuthRefreshToken.query.filter_by(token=token_value, client_id=client.id, revoked=False).first()
    if not record:
        return jsonify({"error": "invalid_grant"}), 400
    if record.expires_at < datetime.utcnow():
        return jsonify({"error": "expired_token"}), 400
    user = User.query.get(record.user_id)
    if not user:
        return jsonify({"error": "user_not_found"}), 400
    scopes = split_scopes(record.scope)
    access_token, expires_in = issue_access_token(user, scopes)
    return jsonify(
        {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": expires_in,
            "refresh_token": record.token,
            "scope": record.scope,
        }
    )
