"""
데이터베이스 마이그레이션: 채팅 기능 추가
- ChatReaction 테이블
- UserAvatar 테이블
"""

from extensions import db
from models import ChatReaction, UserAvatar

def migrate():
    """새로운 테이블 생성"""
    print("Creating new tables for chat features...")

    # 테이블 생성
    db.create_all()

    print("Migration completed successfully!")

if __name__ == "__main__":
    from app import app
    with app.app_context():
        migrate()
