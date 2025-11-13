#!/usr/bin/env python3
"""
데이터베이스 마이그레이션 스크립트
새로운 테이블 생성: chat_messages, votes, vote_responses
"""

from app import app
from extensions import db
from models import ChatMessage, Vote, VoteResponse

def migrate():
    with app.app_context():
        print("데이터베이스 마이그레이션 시작...")

        # 새 테이블 생성
        db.create_all()

        print("✓ 테이블 생성 완료")
        print("  - chat_messages")
        print("  - votes")
        print("  - vote_responses")
        print("\n마이그레이션 완료!")

if __name__ == "__main__":
    migrate()
