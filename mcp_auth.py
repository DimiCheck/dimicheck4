from __future__ import annotations

from typing import Optional

from mcp.server.auth.provider import AccessToken, TokenVerifier


class DimicheckTokenVerifier(TokenVerifier):
    """
    Verify Dimicheck OAuth access tokens by reusing the existing Flask app config/DB.
    """

    def __init__(self):
        from app import app as flask_app  # Lazy import to avoid side effects on module load

        self.app = flask_app

    async def verify_token(self, token: str) -> Optional[AccessToken]:
        from oauth.utils import decode_access_token

        with self.app.app_context():
            try:
                claims = decode_access_token(token)
            except Exception as exc:
                try:
                    self.app.logger.warning("[mcp.auth] token decode failed: %s", exc)
                except Exception:
                    pass
                try:
                    print(f"[mcp.auth] token decode failed: {exc}")
                except Exception:
                    pass
                return None

        scope_str = claims.get("scope") or ""
        scopes = [s for s in scope_str.split() if s.strip()]
        exp = claims.get("exp")
        try:
            exp_int = int(exp) if exp is not None else None
        except Exception:
            exp_int = None
        client_id = claims.get("aud") or ""
        msg = f"[mcp.auth] token ok: aud={client_id} scopes={scopes} exp={exp_int}"
        try:
            self.app.logger.info(msg)
        except Exception:
            pass
        try:
            print(msg)
        except Exception:
            pass
        return AccessToken(token=token, client_id=str(client_id), scopes=scopes, expires_at=exp_int)
