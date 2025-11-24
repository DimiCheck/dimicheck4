"""
데이터베이스 마이그레이션: Public API 키 및 레이트 리밋 테이블 추가
"""

from extensions import db
from models import APIKey, APIRateLimit

def migrate():
    print("Creating tables for public API...")
    APIKey.__table__.create(db.engine, checkfirst=True)
    APIRateLimit.__table__.create(db.engine, checkfirst=True)
    print("Migration completed!")

if __name__ == "__main__":
    from app import app
    with app.app_context():
        migrate()
