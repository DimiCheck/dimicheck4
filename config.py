import os
from datetime import timedelta

class Config:
    SECRET_KEY: str = os.getenv("SECRET_KEY", "dev-secret")
    SESSION_COOKIE_HTTPONLY: bool = True
    SESSION_COOKIE_SAMESITE: str = "Lax"
    PERMANENT_SESSION_LIFETIME: timedelta = timedelta(days=7)

    # DB
    SQLALCHEMY_DATABASE_URI: str = os.getenv("DATABASE_URL", "sqlite:///app.db")
    SQLALCHEMY_TRACK_MODIFICATIONS: bool = False

    # OAuth (디풀 SSO)
    OAUTH_CLIENT: str = os.getenv("OAUTH_CLIENT", "68a508a281af8e9319919275")
    OAUTH_REDIRECT_URI: str = os.getenv("OAUTH_REDIRECT_URI", "https://chec.kro.kr/auth/callback")
    OAUTH_PUBLIC_KEY_URL: str | None = os.getenv("OAUTH_PUBLIC_KEY_URL")

    # 프론트엔드 도메인 (CORS)
    FRONTEND_ORIGIN: str = os.getenv("FRONTEND_ORIGIN", "https://chec.kro.kr")

    # 개발용 로그인 허용 여부
    ENABLE_DEV_LOGIN: bool = os.getenv("FLASK_ENV", "development") == "development"

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

config = Config()
