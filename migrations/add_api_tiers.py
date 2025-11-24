"""Add tier columns to api_keys"""

from sqlalchemy import text

from extensions import db

COLUMNS = [
    ("tier", "TEXT DEFAULT 'tier1' NOT NULL"),
    ("tier_requested_at", "DATETIME"),
    ("tier_upgraded_at", "DATETIME"),
    ("streak_days", "INTEGER DEFAULT 0 NOT NULL"),
    ("streak_last_date", "DATE"),
]


def migrate():
    conn = db.engine.connect()
    for name, ddl in COLUMNS:
        try:
            conn.execute(text(f"ALTER TABLE api_keys ADD COLUMN {name} {ddl}"))
            print(f"Added column {name}")
        except Exception as exc:  # noqa: BLE001
            if "duplicate column" in str(exc).lower():
                print(f"Column {name} already exists, skipping")
            else:
                raise
    conn.close()


if __name__ == "__main__":
    from app import app

    with app.app_context():
        migrate()
