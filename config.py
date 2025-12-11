import os
import secrets
import time
from datetime import timedelta


def _env_bool(key: str, default: bool) -> bool:
    value = os.getenv(key)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "t", "yes", "y", "on"}

class Config:
    # Must be provided via env in production; fallback is per-process random to avoid static dev secret
    SECRET_KEY: str = os.getenv("SECRET_KEY") or secrets.token_hex(32)
    SESSION_COOKIE_HTTPONLY: bool = True
    SESSION_COOKIE_SECURE: bool = _env_bool("SESSION_COOKIE_SECURE", True)
    SESSION_COOKIE_SAMESITE: str = os.getenv("SESSION_COOKIE_SAMESITE", "None")
    PERMANENT_SESSION_LIFETIME: timedelta = timedelta(days=30)
    SESSION_REFRESH_EACH_REQUEST: bool = True

    # DB
    SQLALCHEMY_DATABASE_URI: str = os.getenv("DATABASE_URL", "sqlite:///app.db")
    SQLALCHEMY_TRACK_MODIFICATIONS: bool = False

    # OAuth (디풀 SSO or DIMICheck OAuth feature flag)
    OAUTH_CLIENT: str = os.getenv("OAUTH_CLIENT", "68a508a281af8e9319919275")
    OAUTH_REDIRECT_URI: str = os.getenv("OAUTH_REDIRECT_URI", "https://chec.kro.kr/auth/callback")
    OAUTH_PUBLIC_KEY_URL: str | None = os.getenv("OAUTH_PUBLIC_KEY_URL")
    USE_DIMICHECK_OAUTH: bool = _env_bool("USE_DIMICHECK_OAUTH", False)
    GOOGLE_CLIENT_ID: str = os.getenv("GOOGLE_CLIENT_ID", "")
    GOOGLE_CLIENT_SECRET: str = os.getenv("GOOGLE_CLIENT_SECRET", "")
    GOOGLE_REDIRECT_URI: str = os.getenv("GOOGLE_REDIRECT_URI", OAUTH_REDIRECT_URI)
    OAUTH_ISSUER: str = os.getenv("OAUTH_ISSUER", "https://chec.kro.kr")
    REMEMBER_ME_COOKIE_NAME: str = os.getenv("REMEMBER_ME_COOKIE_NAME", "dimicheck_remember")
    REMEMBER_ME_DURATION_DAYS: int = int(os.getenv("REMEMBER_ME_DURATION_DAYS", "30"))
    OAUTH_AUTH_CODE_LIFETIME_SECONDS: int = int(os.getenv("OAUTH_AUTH_CODE_LIFETIME_SECONDS", "300"))
    OAUTH_REFRESH_TOKEN_DURATION_DAYS: int = int(os.getenv("OAUTH_REFRESH_TOKEN_DURATION_DAYS", "90"))
    OAUTH_CLIENT_SECRET_ROTATE_DAYS: int = int(os.getenv("OAUTH_CLIENT_SECRET_ROTATE_DAYS", "90"))
    OAUTH_JWT_SECRET_ROTATE_DAYS: int = int(os.getenv("OAUTH_JWT_SECRET_ROTATE_DAYS", "180"))

    # 프론트엔드 도메인 (CORS)
    FRONTEND_ORIGIN: str = os.getenv("FRONTEND_ORIGIN", "https://chec.kro.kr")

    # 개발용 로그인 허용 여부
    ENABLE_DEV_LOGIN: bool = _env_bool("ENABLE_DEV_LOGIN", False)

    # 로그 레벨
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")

    # Flask-Smorest + OpenAPI 문서 설정
    API_TITLE: str = "Dimicheck 백어드 API"
    API_VERSION: str = "v1"
    OPENAPI_VERSION: str = "3.0.3"
    OPENAPI_URL_PREFIX: str = "/api-docs"  # swagger 문서 URL
    OPENAPI_SWAGGER_UI_PATH: str = "/"  # UI 출력문서 로드
    OPENAPI_SWAGGER_UI_URL: str = "https://cdn.jsdelivr.net/npm/swagger-ui-dist/"

    # GSPREAD
    json_file_path = "dimicheck-471412-85491c7985df.json"
    spreadsheet_url = "https://docs.google.com/spreadsheets/d/1Vm3FJ9I0tm7mmz1NnSndKCnqKFpTiOdc4JmufrFyOMQ/edit?usp=sharing"

    # Teacher dashboard access control
    TEACHER_PINS = [pin.strip() for pin in os.getenv("TEACHER_PINS", "").split(",") if pin.strip()]
    TEACHER_SESSION_DURATION_SECONDS = int(os.getenv("TEACHER_SESSION_DURATION_SECONDS", str(12 * 60 * 60)))
    TEACHER_SESSION_REMEMBER_SECONDS = int(os.getenv("TEACHER_SESSION_REMEMBER_SECONDS", str(30 * 24 * 60 * 60)))

    # External APIs
    NEIS_API_KEY: str | None = os.getenv("NEIS_API_KEY")
    KLIPY_API_KEY: str | None = os.getenv("KLIPY_API_KEY")

    # Image Upload Server
    IMAGE_UPLOAD_URL: str = os.getenv("IMAGE_UPLOAD_URL", "https://img.codz.me/upload")

    # Cache busting - use timestamp or version from env
    ASSET_VERSION: str = os.getenv("ASSET_VERSION", str(int(time.time())))

    # Google Analytics (Measurement Protocol)
    GA4_MEASUREMENT_ID: str | None = os.getenv("GA4_MEASUREMENT_ID")
    GA4_API_SECRET: str | None = os.getenv("GA4_API_SECRET")
    GA4_MEASUREMENT_ENDPOINT: str = os.getenv(
        "GA4_MEASUREMENT_ENDPOINT", "https://www.google-analytics.com/mp/collect"
    )

    # App 전용 로그인
    APP_LOGIN_DEFAULT_REDIRECT: str = os.getenv("APP_LOGIN_DEFAULT_REDIRECT", "dimicheck://auth-callback")
    APP_LOGIN_ALLOWED_SCHEMES: tuple[str, ...] = tuple(
        scheme.strip()
        for scheme in os.getenv("APP_LOGIN_ALLOWED_SCHEMES", "dimicheck").split(",")
        if scheme.strip()
    )
    APP_LOGIN_ALLOWED_WEB_HOSTS: tuple[str, ...] = tuple(
        host.strip().lower()
        for host in os.getenv("APP_LOGIN_ALLOWED_WEB_HOSTS", "").split(",")
        if host.strip()
    )

    # Weather

    # Public API limits
    PUBLIC_API_MINUTE_LIMIT: int = int(os.getenv("PUBLIC_API_MINUTE_LIMIT", "2"))
    PUBLIC_API_DAILY_LIMIT: int = int(os.getenv("PUBLIC_API_DAILY_LIMIT", "30"))

config = Config()
