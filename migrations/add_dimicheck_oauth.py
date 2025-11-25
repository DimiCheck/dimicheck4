"""
	Add DIMICheck OAuth/remember-me tables and user columns
"""

from sqlalchemy import text

import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from extensions import db  # noqa: E402
from models import (  # noqa: E402
    OAuthAuthorizationCode,
    OAuthClient,
    OAuthRefreshToken,
    RememberedSession,
    User,
)


def migrate():
    print("Ensuring DIMICheck OAuth tables exist...")
    OAuthClient.__table__.create(db.engine, checkfirst=True)
    OAuthAuthorizationCode.__table__.create(db.engine, checkfirst=True)
    OAuthRefreshToken.__table__.create(db.engine, checkfirst=True)
    RememberedSession.__table__.create(db.engine, checkfirst=True)

    with db.engine.connect() as conn:
        result = conn.execute(text("PRAGMA table_info('user')")).fetchall()
        existing = {row[1] for row in result}
        if "email" not in existing:
            print("Adding email column to user table...")
            conn.execute(text("ALTER TABLE user ADD COLUMN email VARCHAR(320)"))
        if "last_profile_update" not in existing:
            print("Adding last_profile_update column to user table...")
            conn.execute(text("ALTER TABLE user ADD COLUMN last_profile_update DATETIME"))

    print("DIMICheck OAuth migration complete.")


if __name__ == "__main__":
    from app import app

    with app.app_context():
        migrate()
