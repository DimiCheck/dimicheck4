from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from typing import Iterable, List

from flask import current_app
from jose import jwt

from extensions import db
from models import OAuthAuthorizationCode, OAuthClient, OAuthRefreshToken, User

# ChatGPT 커넥터는 토큰 재발급 없이 장기간 재사용하므로 만료 시간을 넉넉히 준다.
# (리스크가 크다면 나중에 줄이고 refresh_token 사용을 강제하세요)
ACCESS_TOKEN_LIFETIME = timedelta(days=90)


def split_scopes(scope_str: str | None) -> List[str]:
    if not scope_str:
        return []
    return sorted({scope.strip() for scope in scope_str.split() if scope.strip()})


def client_allowed_scopes(client: OAuthClient) -> List[str]:
    return split_scopes(client.scopes)


def client_redirect_uris(client: OAuthClient) -> List[str]:
    if not client.redirect_uris:
        return []
    separators = [",", "\n", " "]
    payload = client.redirect_uris
    for sep in separators[:-1]:
        payload = payload.replace(sep, separators[-1])
    return [uri.strip() for uri in payload.split(separators[-1]) if uri.strip()]


def ensure_scopes_subset(requested: Iterable[str], allowed: Iterable[str]) -> bool:
    allowed_set = set(allowed)
    return set(requested).issubset(allowed_set)


def generate_authorization_code(
    user_id: int,
    client: OAuthClient,
    redirect_uri: str,
    scopes: List[str],
    code_challenge: str | None = None,
    code_challenge_method: str | None = None,
) -> OAuthAuthorizationCode:
    code_value = secrets.token_urlsafe(32)
    expires_at = datetime.utcnow() + timedelta(seconds=current_app.config["OAUTH_AUTH_CODE_LIFETIME_SECONDS"])
    record = OAuthAuthorizationCode(
        code=code_value,
        user_id=user_id,
        client_id=client.id,
        redirect_uri=redirect_uri,
        scope=" ".join(scopes),
        expires_at=expires_at,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
    )
    db.session.add(record)
    db.session.commit()
    return record


def _build_claims(user: User, scopes: List[str]) -> dict:
    now = datetime.utcnow()
    exp = now + ACCESS_TOKEN_LIFETIME
    claims: dict = {
        "sub": str(user.id),
        "iss": current_app.config["OAUTH_ISSUER"],
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "scope": " ".join(scopes),
    }
    if "basic" in scopes:
        claims["user_id"] = user.id
        claims["email"] = user.email
    if "profile" in scopes:
        # 이름은 반환하지 않음 (개인정보 최소화)
        pass
    if "student_info" in scopes:
        claims["grade"] = user.grade
        claims["class"] = user.class_no
        claims["number"] = user.number
    return claims


def _resolve_client_secret(client: OAuthClient) -> str:
    # Prefer dedicated JWT secret when set, otherwise use client secret, then fall back to app secret
    return client.jwt_secret or client.client_secret or current_app.config["SECRET_KEY"]


def issue_access_token(user: User, client: OAuthClient, scopes: List[str]) -> tuple[str, int]:
    claims = _build_claims(user, scopes)
    claims["aud"] = client.client_id
    secret = _resolve_client_secret(client)
    token = jwt.encode(claims, secret, algorithm="HS256")
    expires_in = int(ACCESS_TOKEN_LIFETIME.total_seconds())
    return token, expires_in


def decode_access_token(token: str) -> dict:
    # Decode without verification to learn client audience, then verify signature with per-client secret.
    unverified = jwt.get_unverified_claims(token)
    aud = unverified.get("aud")
    secret = current_app.config["SECRET_KEY"]
    client = None
    if aud:
        client = OAuthClient.query.filter_by(client_id=aud).first()
        if client:
            secret = _resolve_client_secret(client)
    try:
        return jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            issuer=current_app.config["OAUTH_ISSUER"],
            audience=aud,
        )
    except Exception:
        # Fail closed on signature/audience errors
        raise


def issue_refresh_token(user: User, client: OAuthClient, scopes: List[str]) -> OAuthRefreshToken:
    token_value = secrets.token_urlsafe(48)
    expires_at = datetime.utcnow() + timedelta(days=current_app.config["OAUTH_REFRESH_TOKEN_DURATION_DAYS"])
    record = OAuthRefreshToken(
        token=token_value,
        user_id=user.id,
        client_id=client.id,
        scope=" ".join(scopes),
        expires_at=expires_at,
    )
    db.session.add(record)
    db.session.commit()
    return record
