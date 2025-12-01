from __future__ import annotations

from urllib.parse import urlencode

from flask import jsonify, redirect, render_template, request, session

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
    def _validate_authorize_request(params):
        response_type = params.get("response_type", "code")
        if response_type != "code":
            return None, (jsonify({"error": "unsupported_response_type"}), 400)
        client_id = params.get("client_id")
        redirect_uri = params.get("redirect_uri")
        state = params.get("state")
        scope_param = params.get("scope")
        code_challenge = params.get("code_challenge")
        code_challenge_method = (params.get("code_challenge_method") or "plain").upper()
        client = OAuthClient.query.filter_by(client_id=client_id).first()
        if not client:
            return None, (jsonify({"error": "invalid_client"}), 400)
        allowed_redirects = client_redirect_uris(client)
        if not redirect_uri or redirect_uri not in allowed_redirects:
            return None, (jsonify({"error": "invalid_redirect_uri"}), 400)
        requested_scopes = split_scopes(scope_param) or DEFAULT_SCOPE
        allowed_scopes = client_allowed_scopes(client) or DEFAULT_SCOPE
        if not ensure_scopes_subset(requested_scopes, allowed_scopes):
            return None, (jsonify({"error": "invalid_scope"}), 400)
        if code_challenge and code_challenge_method not in {"PLAIN", "S256"}:
            return None, (jsonify({"error": "invalid_request", "message": "unsupported code_challenge_method"}), 400)
        return {
            "client": client,
            "redirect_uri": redirect_uri,
            "state": state,
            "scopes": requested_scopes,
            "code_challenge": code_challenge,
            "code_challenge_method": code_challenge_method if code_challenge else None,
        }, None

    def _redirect_with_error(redirect_uri: str, state: str | None, error: str):
        params = {"error": error}
        if state:
            params["state"] = state
        return redirect(f"{redirect_uri}?{urlencode(params)}")

    @bp.route("/authorize", methods=["GET", "POST"])
    def authorize():
        user_session = session.get("user")
        if not user_session:
            return jsonify({"error": "login_required"}), 401
        validation = _validate_authorize_request(request.form if request.method == "POST" else request.args)
        data, error = validation
        if error:
            return error
        client = data["client"]
        redirect_uri = data["redirect_uri"]
        state = data["state"]
        scopes = data["scopes"]
        code_challenge = data["code_challenge"]
        code_challenge_method = data["code_challenge_method"]
        user = User.query.get(user_session["id"])
        if not user:
            return jsonify({"error": "user_not_found"}), 400

        if request.method == "GET":
            return render_template(
                "oauth_consent.html",
                client=client,
                scopes=scopes,
                state=state,
                redirect_uri=redirect_uri,
                code_challenge=code_challenge,
                code_challenge_method=code_challenge_method,
                scope_param=request.args.get("scope", ""),
            )

        if request.form.get("decision") != "approve":
            return _redirect_with_error(redirect_uri, state, "access_denied")

        code_record = generate_authorization_code(
            user_id=user.id,
            client=client,
            redirect_uri=redirect_uri,
            scopes=scopes,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
        )
        params = {"code": code_record.code}
        if state:
            params["state"] = state
        return redirect(f"{redirect_uri}?{urlencode(params)}")
