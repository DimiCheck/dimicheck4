from __future__ import annotations

import json
import os
import logging
from typing import Any, Dict

import requests
from starlette.requests import Request
from starlette.responses import JSONResponse

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import Context, FastMCP

from mcp_auth import DimicheckTokenVerifier

BASE_URL = os.getenv("DIMICHECK_BASE_URL", "https://chec.kro.kr")
DEFAULT_TIMEOUT = float(os.getenv("DIMICHECK_HTTP_TIMEOUT", "30"))
SERVER_PORT = int(os.getenv("DIMICHECK_MCP_PORT", "8787"))
LOG = logging.getLogger("uvicorn.error")


def _resolve_token(ctx: Context | None, token_override: str | None = None) -> str:
    if token_override:
        return token_override
    access = get_access_token()
    if access and access.token:
        return access.token
    token = os.getenv("DIMICHECK_ACCESS_TOKEN")
    if token:
        return token
    # As a last resort, try to read from the current request headers (for stateless HTTP)
    try:
        req = ctx.request_context.request if ctx and ctx.request_context else None
        header = None
        if req:
            header = req.headers.get("Authorization")
        if header and header.startswith("Bearer "):
            return header.split(" ", 1)[1].strip()
    except Exception:
        pass
    raise RuntimeError("Access token is required. Provide Bearer token via OAuth, or set DIMICHECK_ACCESS_TOKEN.")


def _request(
    method: str,
    path: str,
    token: str,
    *,
    json_payload: Dict[str, Any] | None = None,
    params: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    url = f"{BASE_URL.rstrip('/')}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if json_payload is not None:
        headers["Content-Type"] = "application/json"
    try:
        resp = requests.request(method, url, headers=headers, json=json_payload, params=params, timeout=DEFAULT_TIMEOUT)
    except requests.exceptions.RequestException as exc:  # includes timeouts
        raise RuntimeError(f"Upstream request failed: {exc} (url={url})") from exc
    if not resp.ok:
        # Surface upstream error body for easier debugging
        body_preview = resp.text[:500] if resp.text else ""
        try:
            LOG.error("[mcp.upstream] %s %s -> %s %s", method, url, resp.status_code, body_preview)
        except Exception:
            try:
                print(f"[mcp.upstream] {method} {url} -> {resp.status_code} {body_preview}")
            except Exception:
                pass
        raise RuntimeError(
            f"Upstream {method} {url} -> {resp.status_code}: {body_preview}"
        )
    try:
        return resp.json()
    except Exception:
        return {"raw": resp.text}


token_verifier = DimicheckTokenVerifier()

server = FastMCP(
    name="dimicheck-mcp",
    instructions="Use ChatGPT-issued OAuth token (Dimicheck) to call MCP endpoints.",
    website_url="https://chec.kro.kr",
    host="0.0.0.0",
    port=SERVER_PORT,
    streamable_http_path="/mcp",
    auth=AuthSettings(
        issuer_url="https://chec.kro.kr",
        resource_server_url="https://chec.kro.kr/mcp",
        required_scopes=["basic", "student_info"],
    ),
    token_verifier=token_verifier,
)


def _resolve_class_context_from_me(token: str) -> tuple[int | None, int | None, int | None]:
    """
    Try to fetch grade/section/number from /api/mcp/me so callers don't have to pass them.
    Returns (grade, section, number) or (None, None, None) when unavailable.
    """
    try:
        me = _request("GET", "/api/mcp/me", token)
    except Exception:
        return None, None, None
    try:
        LOG.info("[mcp.me] %s", me)
    except Exception:
        pass
    grade = me.get("grade")
    section = me.get("class") or me.get("section")
    number = me.get("number")
    try:
        grade = int(grade) if grade is not None else None
    except Exception:
        grade = None
    try:
        section = int(section) if section is not None else None
    except Exception:
        section = None
    try:
        number = int(number) if number is not None else None
    except Exception:
        number = None
    return grade, section, number


def _oidc_payload() -> dict:
    """
    Shared OIDC discovery payload.
    Issuer matches Flask oauth tokens (OAUTH_ISSUER) and keeps endpoints stable.
    """
    issuer = "https://chec.kro.kr"
    return {
        "issuer": issuer,
        "authorization_endpoint": "https://chec.kro.kr/oauth/authorize",
        "token_endpoint": "https://chec.kro.kr/oauth/token",
        "registration_endpoint": "https://chec.kro.kr/mcp/oauth2/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic", "none"],
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": ["basic", "student_info", "openid"],
        "claims_supported": ["sub", "email", "grade", "class", "number"],
    }


@server.custom_route("/.well-known/openid-configuration", methods=["GET"])
async def oidc_config(_: Request):
    """Expose minimal OIDC config so ChatGPT recognizes OAuth support."""
    return JSONResponse(_oidc_payload())


@server.custom_route("/.well-known/oauth-authorization-server", methods=["GET"])
async def oidc_alt(_: Request):
    """Alias for clients probing the oauth-authorization-server discovery path."""
    return JSONResponse(_oidc_payload())


@server.custom_route("/mcp/.well-known/openid-configuration", methods=["GET"])
async def oidc_config_mcp(_: Request):
    """Serve discovery under the /mcp prefix (ChatGPT probes this first)."""
    return JSONResponse(_oidc_payload())


@server.custom_route("/mcp/.well-known/oauth-authorization-server", methods=["GET"])
async def oidc_alt_mcp(_: Request):
    """Alias under /mcp prefix."""
    return JSONResponse(_oidc_payload())


@server.custom_route("/mcp.well-known/openid-configuration", methods=["GET"])
async def oidc_config_mcp_missing_slash(_: Request):
    """
    Handle clients that probe `/mcp.well-known/*` (missing slash) by returning discovery.
    Seen in ChatGPT connector probes.
    """
    return JSONResponse(_oidc_payload())


@server.custom_route("/mcp.well-known/oauth-authorization-server", methods=["GET"])
async def oidc_alt_mcp_missing_slash(_: Request):
    """Missing-slash alias."""
    return JSONResponse(_oidc_payload())


@server.custom_route("/oauth2/register", methods=["POST"])
@server.custom_route("/mcp/oauth2/register", methods=["POST"])
async def oidc_register(request: Request):
    """
    Simple dynamic registration shim.
    Returns a stub client_id to satisfy clients that probe this endpoint.
    """
    payload = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    redirect_uris = payload.get("redirect_uris") or []
    # Echo back the first redirect or ChatGPT default if none provided
    redirect_uri = redirect_uris[0] if isinstance(redirect_uris, list) and redirect_uris else "https://chat.openai.com/aip/oauth/callback"
    return JSONResponse(
        {
            "client_id": "dimicheck-manual-client",
            "redirect_uris": [redirect_uri],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "application_type": "web",
            "scope": "basic student_info",
        }
    )


@server.resource("resource://me", name="me", title="Current user info")
def resource_me(ctx: Context | None = None) -> str:
    token = _resolve_token(ctx)
    data = _request("GET", "/api/mcp/me", token)
    return json.dumps(data, ensure_ascii=False)


@server.resource("resource://state", name="state", title="Class state")
def resource_state(ctx: Context | None = None) -> str:
    token = _resolve_token(ctx)
    data = _request("GET", "/api/mcp/state", token)
    return json.dumps(data, ensure_ascii=False)


@server.resource("resource://routine", name="routine", title="Class routine")
def resource_routine(ctx: Context | None = None) -> str:
    token = _resolve_token(ctx)
    data = _request("GET", "/api/mcp/routine", token)
    return json.dumps(data, ensure_ascii=False)


@server.resource("resource://timetable/today", name="timetable_today", title="Today timetable")
def resource_timetable_today(ctx: Context | None = None) -> str:
    token = _resolve_token(ctx)
    data = _request("GET", "/api/mcp/timetable", token)
    return json.dumps(data, ensure_ascii=False)


@server.resource("resource://meal/today", name="meal_today", title="Today meal")
def resource_meal_today(ctx: Context | None = None) -> str:
    token = _resolve_token(ctx)
    data = _request("GET", "/api/mcp/meal", token)
    return json.dumps(data, ensure_ascii=False)


@server.resource("resource://calendar/events", name="calendar_events", title="Class calendar events")
def resource_calendar_events(ctx: Context | None = None) -> str:
    token = _resolve_token(ctx)
    data = _request("GET", "/api/mcp/calendar/events", token)
    return json.dumps(data, ensure_ascii=False)


@server.resource("resource://home/target", name="home_target", title="Home target countdown")
def resource_home_target(ctx: Context | None = None) -> str:
    token = _resolve_token(ctx)
    data = _request("GET", "/api/mcp/home/target", token)
    return json.dumps(data, ensure_ascii=False)


@server.tool(
    description=(
        "Update only YOUR magnet (your student number) in class state. "
        "Allowed state values: [\"classroom\", \"toilet\", \"hallway\", \"club\", \"afterschool\", \"project\", \"early\", \"etc\", \"absence\"] YOU MUST USE THE EXACT SAME STRING OF ONE OF THESE. There is no other kind of state value."
        "You can also include other fields like thought/reaction if supported."
    ),
    name="update_state",
)
def update_state(
    magnet: Dict[str, Any] | None = None,
    payload: Dict[str, Any] | None = None,
    token: str | None = None,
    ctx: Context | None = None,
) -> str:
    """
    Accepts a single magnet payload and applies it to the caller's student number.
    grade/section/number are auto-resolved from /api/mcp/me; no need to pass them.
    """
    resolved_token = _resolve_token(ctx, token)
    grade, section, number = _resolve_class_context_from_me(resolved_token)
    if grade is None or section is None or number is None:
        raise RuntimeError("User grade/section/number is missing; ensure the account has class info.")

    # Determine the magnet data from inputs (favor explicit `magnet`, fall back to payload structures)
    magnet_data: Dict[str, Any] | None = None
    if magnet:
        magnet_data = magnet
    elif payload:
        if isinstance(payload, dict):
            if "magnet" in payload and isinstance(payload["magnet"], dict):
                magnet_data = payload["magnet"]
            elif "magnets" in payload and isinstance(payload["magnets"], dict):
                magnets_obj = payload["magnets"]
                # First, try student-number keyed magnets map
                magnet_data = magnets_obj.get(str(number)) or magnets_obj.get(number) or None
                # If not keyed, but looks like a single magnet payload, use it directly
                if magnet_data is None and all(not str(k).isdigit() for k in magnets_obj.keys()):
                    magnet_data = magnets_obj
            else:
                magnet_data = payload
    if not magnet_data:
        raise RuntimeError("magnet payload is required (e.g., {\"state\": \"toilet\"}).")

    payload_to_api = {"magnets": {str(number): magnet_data}}
    query = {"grade": grade, "section": section}
    try:
        data = _request("POST", "/api/mcp/state", resolved_token, json_payload=payload_to_api, params=query)
    except Exception as exc:
        try:
            LOG.error("[mcp.update_state] grade=%s section=%s number=%s magnet=%s error=%s", grade, section, number, magnet_data, exc)
        except Exception:
            pass
        # Surface the upstream error to the caller instead of a bare 400
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    return json.dumps(data, ensure_ascii=False)


@server.tool(description="Update class routine (afterschool/changdong).", name="update_routine")
def update_routine(payload: Dict[str, Any], token: str | None = None, ctx: Context | None = None) -> str:
    resolved_token = _resolve_token(ctx, token)
    data = _request("POST", "/api/mcp/routine", resolved_token, json_payload=payload)
    return json.dumps(data, ensure_ascii=False)


@server.tool(description="Set or update home target datetime (ISO string).", name="set_home_target")
def set_home_target(target_at: str, token: str | None = None, ctx: Context | None = None) -> str:
    resolved_token = _resolve_token(ctx, token)
    data = _request("POST", "/api/mcp/home/target", resolved_token, json_payload={"targetAt": target_at})
    return json.dumps(data, ensure_ascii=False)


@server.tool(description="Send a chat message to your class.", name="send_chat_message")
def send_chat_message(message: str, channel: str | None = None, token: str | None = None, ctx: Context | None = None) -> str:
    resolved_token = _resolve_token(ctx, token)
    payload = {"message": message}
    if channel:
        payload["channel"] = channel
    data = _request("POST", "/api/mcp/chat/send", resolved_token, json_payload=payload)
    return json.dumps(data, ensure_ascii=False)


def main() -> None:
    transport = os.getenv("DIMICHECK_MCP_TRANSPORT", "streamable-http")
    server.run(transport=transport)


if __name__ == "__main__":
    main()
