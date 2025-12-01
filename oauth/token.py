from __future__ import annotations

import base64
import hashlib
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

    @bp.post("/introspect")
    def introspect():
        client = _authenticate_client()
        if not client:
            return jsonify({"error": "invalid_client"}), 401
        token_value = request.form.get("token")
        if not token_value:
            return jsonify({"active": False})
        hint = (request.form.get("token_type_hint") or "").lower()
        if hint == "refresh_token":
            return jsonify(_introspect_refresh_token(client, token_value))
        if hint == "access_token":
            return jsonify(_introspect_access_token(client, token_value))
        # Try access first, then refresh
        data = _introspect_access_token(client, token_value)
        if not data["active"]:
            data = _introspect_refresh_token(client, token_value)
        return jsonify(data)

    @bp.post("/revoke")
    def revoke():
        client = _authenticate_client()
        if not client:
            return jsonify({"error": "invalid_client"}), 401
        token_value = request.form.get("token")
        if not token_value:
            return jsonify({"revoked": False}), 200
        record = OAuthRefreshToken.query.filter_by(token=token_value, client_id=client.id).first()
        if record and not record.revoked:
            record.revoked = True
            record.revoked_at = datetime.utcnow()
            db.session.commit()
        return jsonify({"revoked": True}), 200


def _authenticate_client() -> OAuthClient | None:
    client_id = request.form.get("client_id")
    client_secret = request.form.get("client_secret")
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Basic "):
        try:
            decoded = base64.b64decode(auth_header.split(" ", 1)[1]).decode()
            client_id, client_secret = decoded.split(":", 1)
        except Exception:
            return None
    if not client_id or not client_secret:
        return None
    client = OAuthClient.query.filter_by(client_id=client_id).first()
    if not client or client.client_secret != client_secret:
        return None
    return client


def _verify_pkce(code, verifier: str | None) -> bool:
    if not code.code_challenge:
        return True  # PKCE was not used for this code
    if not verifier:
        return False
    method = (code.code_challenge_method or "PLAIN").upper()
    if method == "PLAIN":
        return verifier == code.code_challenge
    if method == "S256":
        digest = hashlib.sha256(verifier.encode()).digest()
        challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
        return challenge == code.code_challenge
    return False


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
    if not _verify_pkce(code, request.form.get("code_verifier")):
        return jsonify({"error": "invalid_grant", "error_description": "pkce_verification_failed"}), 400
    user = User.query.get(code.user_id)
    if not user:
        return jsonify({"error": "user_not_found"}), 400
    code.used = True
    db.session.commit()
    scopes = split_scopes(code.scope)
    access_token, expires_in = issue_access_token(user, client, scopes)
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
    access_token, expires_in = issue_access_token(user, client, scopes)
    record.revoked = True
    record.revoked_at = datetime.utcnow()
    new_refresh = issue_refresh_token(user, client, scopes)
    return jsonify(
        {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": expires_in,
            "refresh_token": new_refresh.token,
            "scope": new_refresh.scope,
        }
    )


def _build_introspection_response(active: bool, data: dict | None = None):
    base = {"active": active}
    if not active:
        return base
    base.update(data or {})
    return base


def _introspect_access_token(client: OAuthClient, token_value: str) -> dict:
    from oauth.utils import decode_access_token  # lazy import to avoid cycle

    try:
        claims = decode_access_token(token_value)
    except Exception:
        return _build_introspection_response(False)
    if claims.get("aud") and claims["aud"] != client.client_id:
        return _build_introspection_response(False)
    return _build_introspection_response(
        True,
        {
            "scope": claims.get("scope"),
            "exp": claims.get("exp"),
            "sub": claims.get("sub"),
            "token_type": "access_token",
            "client_id": client.client_id,
        },
    )


def _introspect_refresh_token(client: OAuthClient, token_value: str) -> dict:
    record = OAuthRefreshToken.query.filter_by(token=token_value, client_id=client.id).first()
    if not record or record.revoked or record.expires_at < datetime.utcnow():
        return _build_introspection_response(False)
    return _build_introspection_response(
        True,
        {
            "scope": record.scope,
            "exp": int(record.expires_at.timestamp()),
            "sub": record.user_id,
            "token_type": "refresh_token",
            "client_id": client.client_id,
        },
    )

