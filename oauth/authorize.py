from __future__ import annotations

from urllib.parse import urlencode

from flask import jsonify, redirect, request, session

from models import OAuthClient, User
from oauth.utils import (
    client_allowed_scopes,
    client_redirect_uris,
    ensure_scopes_subset,
    generate_authorization_code,
    split_scopes,
)

DEFAULT_SCOPE = ["basic"]


def register_authorize_routes(bp):
    @bp.get("/authorize")
    def authorize():
        user_session = session.get("user")
        if not user_session:
            return jsonify({"error": "login_required"}), 401
        response_type = request.args.get("response_type", "code")
        if response_type != "code":
            return jsonify({"error": "unsupported_response_type"}), 400
        client_id = request.args.get("client_id")
        redirect_uri = request.args.get("redirect_uri")
        state = request.args.get("state")
        scope_param = request.args.get("scope")
        client = OAuthClient.query.filter_by(client_id=client_id).first()
        if not client:
            return jsonify({"error": "invalid_client"}), 400
        allowed_redirects = client_redirect_uris(client)
        if not redirect_uri or redirect_uri not in allowed_redirects:
            return jsonify({"error": "invalid_redirect_uri"}), 400
        requested_scopes = split_scopes(scope_param) or DEFAULT_SCOPE
        allowed_scopes = client_allowed_scopes(client) or DEFAULT_SCOPE
        if not ensure_scopes_subset(requested_scopes, allowed_scopes):
            return jsonify({"error": "invalid_scope"}), 400
        user = User.query.get(user_session["id"])
        if not user:
            return jsonify({"error": "user_not_found"}), 400
        code_record = generate_authorization_code(
            user_id=user.id,
            client=client,
            redirect_uri=redirect_uri,
            scopes=requested_scopes,
        )
        params = {"code": code_record.code}
        if state:
            params["state"] = state
        return redirect(f"{redirect_uri}?{urlencode(params)}")
