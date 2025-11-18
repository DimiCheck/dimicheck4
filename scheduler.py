"""
스케줄러 - 주기적 작업 관리
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta

from extensions import db
from models import ChatMessage, ChatReaction, UserNickname, UserAvatar


def reset_chat_data_feb_28():
    """매년 2월 28일에 채팅 데이터 및 관련 데이터 초기화"""
    from app import app

    with app.app_context():
        try:
            # 채팅 메시지 삭제
            deleted_messages = ChatMessage.query.delete()

            # 채팅 반응 삭제
            deleted_reactions = ChatReaction.query.delete()

            # 닉네임 삭제
            deleted_nicknames = UserNickname.query.delete()

            # 아바타 삭제
            deleted_avatars = UserAvatar.query.delete()

            db.session.commit()

            app.logger.info(
                f"[Scheduler] Data reset completed: "
                f"{deleted_messages} messages, "
                f"{deleted_reactions} reactions, "
                f"{deleted_nicknames} nicknames, "
                f"{deleted_avatars} avatars deleted"
            )
        except Exception as e:
            db.session.rollback()
            app.logger.error(f"[Scheduler] Data reset failed: {e}")


def check_and_reset_if_feb_28():
    """현재 날짜가 2월 28일인지 확인하고 초기화 수행"""
    now = datetime.now()

    # 2월 28일 체크
    if now.month == 2 and now.day == 28:
        # 이미 오늘 초기화했는지 확인 (파일 기반 체크)
        from pathlib import Path

        last_reset_file = Path("last_reset.txt")
        today_str = now.strftime("%Y-%m-%d")

        if last_reset_file.exists():
            last_reset = last_reset_file.read_text().strip()
            if last_reset == today_str:
                # 이미 오늘 초기화했음
                return

        # 초기화 수행
        reset_chat_data_feb_28()

        # 오늘 날짜 기록
        last_reset_file.write_text(today_str)


def schedule_daily_check():
    """매일 자정에 2월 28일 체크 (백그라운드 스레드)"""

    def run():
        while True:
            try:
                # 현재 시각
                now = datetime.now()

                # 다음 날 자정까지의 시간 계산
                tomorrow = now + timedelta(days=1)
                midnight = datetime(tomorrow.year, tomorrow.month, tomorrow.day, 0, 5, 0)  # 00:05
                sleep_seconds = (midnight - now).total_seconds()

                # 자정까지 대기
                time.sleep(sleep_seconds)

                # 2월 28일 체크 및 초기화
                check_and_reset_if_feb_28()

            except Exception as e:
                # 오류 발생 시 1시간 후 재시도
                import logging

                logging.error(f"[Scheduler] Error in daily check: {e}")
                time.sleep(3600)

    # 데몬 스레드로 실행 (메인 프로세스 종료 시 함께 종료)
    thread = threading.Thread(target=run, daemon=True)
    thread.start()


def start_scheduler():
    """스케줄러 시작"""
    # 앱 시작 시 즉시 한 번 체크
    check_and_reset_if_feb_28()

    # 백그라운드에서 매일 자정 체크
    schedule_daily_check()
