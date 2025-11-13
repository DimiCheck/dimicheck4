/**
 * chat.js - 채팅 UI 관리
 * 당일 채팅 메시지 표시, 폴링, 전송
 */

class ChatManager {
  constructor() {
    this.grade = null;
    this.section = null;
    this.myNumber = null;
    this.messages = [];
    this.lastMessageId = 0;
    this.lastReadMessageId = 0; // 마지막으로 읽은 메시지 ID
    this.pollingInterval = null;
    this.isOpen = false;
  }

  init(grade, section, myNumber) {
    this.grade = grade;
    this.section = section;
    this.myNumber = myNumber;
    // 백그라운드 폴링 시작 (3초마다)
    this.startBackgroundPolling();
  }

  open() {
    this.isOpen = true;
    // 채팅 열면 즉시 로드하고 빠른 폴링으로 전환
    this.loadMessages();
    this.stopPolling();
    this.startFastPolling();
    // 배지 숨기기
    this.hideBadge();
  }

  close() {
    this.isOpen = false;
    // 마지막 메시지를 읽은 것으로 표시
    this.lastReadMessageId = this.lastMessageId;
    // 느린 폴링으로 전환
    this.stopPolling();
    this.startBackgroundPolling();
  }

  startBackgroundPolling() {
    if (this.pollingInterval) return;
    // 3초마다 백그라운드에서 새 메시지 확인 (UI 렌더링 없이)
    this.pollingInterval = setInterval(() => {
      if (!this.isOpen) {
        this.checkNewMessages();
      }
    }, 3000);
  }

  startFastPolling() {
    if (this.pollingInterval) return;
    // 1초마다 새 메시지 확인 (UI 렌더링 포함)
    this.pollingInterval = setInterval(() => {
      if (this.isOpen) {
        this.loadMessages();
      }
    }, 1000);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  async checkNewMessages() {
    if (!this.grade || !this.section) return;

    try {
      const res = await fetch(`/api/classes/chat/today?grade=${this.grade}&section=${this.section}`);
      if (!res.ok) return;

      const data = await res.json();
      const newMessages = data.messages || [];

      if (newMessages.length > 0) {
        const latestId = Math.max(...newMessages.map(m => m.id));

        // 새 메시지가 있고, 내가 보낸 게 아니면 알림
        if (latestId > this.lastMessageId) {
          const newOnes = newMessages.filter(m => m.id > this.lastMessageId && m.studentNumber !== this.myNumber);

          if (newOnes.length > 0) {
            // 토스트 표시
            this.showToast(`새 메시지 ${newOnes.length}개`);
            // 배지 표시
            this.showBadge();
          }

          this.lastMessageId = latestId;
          this.messages = newMessages;
        }
      }
    } catch (err) {
      console.error('checkNewMessages error:', err);
    }
  }

  async loadMessages() {
    if (!this.grade || !this.section) return;

    try {
      const res = await fetch(`/api/classes/chat/today?grade=${this.grade}&section=${this.section}`);
      if (!res.ok) throw new Error('Failed to load messages');

      const data = await res.json();
      const newMessages = data.messages || [];

      // 새 메시지만 렌더링
      const hasNew = newMessages.some(msg => msg.id > this.lastMessageId);
      if (hasNew) {
        this.messages = newMessages;
        if (this.messages.length > 0) {
          this.lastMessageId = Math.max(...this.messages.map(m => m.id));
          if (this.isOpen) {
            this.lastReadMessageId = this.lastMessageId;
          }
        }
        this.renderMessages();
      }
    } catch (err) {
      console.error('loadMessages error:', err);
    }
  }

  renderMessages() {
    const container = document.getElementById('chatMessages');
    if (!container) return;

    container.innerHTML = '';

    if (this.messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = '아직 메시지가 없어요. 첫 메시지를 보내보세요!';
      container.appendChild(empty);
      return;
    }

    this.messages.forEach(msg => {
      const msgEl = document.createElement('div');
      msgEl.className = 'chat-message';
      if (msg.studentNumber === this.myNumber) {
        msgEl.classList.add('mine');
      }

      const avatar = document.createElement('div');
      avatar.className = 'chat-avatar';
      avatar.textContent = msg.studentNumber;

      // 자석 색상 매칭
      const colorClass = this.getColorClass(msg.studentNumber);
      avatar.classList.add(colorClass);

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';

      const number = document.createElement('div');
      number.className = 'chat-number';
      number.textContent = `${msg.studentNumber}번`;

      const text = document.createElement('div');
      text.className = 'chat-text';
      text.textContent = msg.message;

      const time = document.createElement('div');
      time.className = 'chat-time';
      time.textContent = this.formatTime(msg.postedAt);

      bubble.appendChild(number);
      bubble.appendChild(text);
      bubble.appendChild(time);

      msgEl.appendChild(avatar);
      msgEl.appendChild(bubble);

      container.appendChild(msgEl);
    });

    // 자동 스크롤
    container.scrollTop = container.scrollHeight;
  }

  async sendMessage(text) {
    if (!text || !text.trim()) {
      return { success: false, error: '메시지를 입력해주세요.' };
    }

    if (!this.grade || !this.section) {
      return { success: false, error: '로그인 정보가 없습니다.' };
    }

    try {
      const res = await fetch(`/api/classes/thought?grade=${this.grade}&section=${this.section}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thought: text.trim(), duration: 5 })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'Failed to send message');
      }

      // 즉시 메시지 목록 새로고침
      await this.loadMessages();
      return { success: true };
    } catch (err) {
      console.error('sendMessage error:', err);
      return { success: false, error: '메시지를 보내지 못했어요.' };
    }
  }

  showToast(message) {
    const toast = document.getElementById('chatToast');
    if (!toast) return;

    toast.textContent = message;
    toast.style.display = 'block';

    setTimeout(() => {
      toast.style.display = 'none';
    }, 3000);
  }

  showBadge() {
    const badge = document.getElementById('chatBadge');
    if (badge) {
      badge.style.display = 'block';
    }
  }

  hideBadge() {
    const badge = document.getElementById('chatBadge');
    if (badge) {
      badge.style.display = 'none';
    }
  }

  getColorClass(number) {
    // 번호에 따른 색상 클래스 (magnet.js와 동일한 로직)
    const colors = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
    const index = (number - 1) % colors.length;
    return `color-${colors[index]}`;
  }

  formatTime(isoString) {
    try {
      const date = new Date(isoString);
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    } catch {
      return '';
    }
  }
}

// 전역 인스턴스
window.chatManager = new ChatManager();
