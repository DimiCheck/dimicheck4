/**
 * chat-features.js - 채팅 추가 기능 (반응, 아바타, 프로필)
 */

// 아바타 렌더링 헬퍼
function renderAvatar(studentNumber, avatarData) {
  const avatar = document.createElement('div');
  avatar.className = `message-avatar`;

  if (avatarData && avatarData.bgColor) {
    avatar.style.background = avatarData.bgColor;
  } else {
    // 기본 그라데이션
    avatar.className += ` avatar-color-${studentNumber % 10}`;
  }

  if (avatarData && avatarData.emoji) {
    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'avatar-emoji';
    emojiSpan.textContent = avatarData.emoji;
    avatar.appendChild(emojiSpan);
  } else {
    avatar.textContent = String(studentNumber).padStart(2, '0');
  }

  const numberBadge = document.createElement('span');
  numberBadge.className = 'avatar-number';
  numberBadge.textContent = String(studentNumber).padStart(2, '0');
  avatar.appendChild(numberBadge);

  return avatar;
}

// 메시지 반응 렌더링
function renderMessageReactions(msg, currentStudentNumber, onReactionClick) {
  if (!msg.reactions || msg.reactions.length === 0) {
    return null;
  }

  const reactionsDiv = document.createElement('div');
  reactionsDiv.className = 'message-reactions';

  msg.reactions.forEach(reaction => {
    const badge = document.createElement('div');
    badge.className = 'reaction-badge';

    // 현재 사용자가 이 반응을 남겼는지 확인
    if (reaction.students && reaction.students.includes(currentStudentNumber)) {
      badge.classList.add('own');
    }

    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'reaction-emoji';
    emojiSpan.textContent = reaction.emoji;

    const countSpan = document.createElement('span');
    countSpan.className = 'reaction-count';
    countSpan.textContent = reaction.count;

    badge.appendChild(emojiSpan);
    badge.appendChild(countSpan);

    badge.addEventListener('click', () => {
      if (onReactionClick) {
        onReactionClick(msg.id, reaction.emoji, reaction.students.includes(currentStudentNumber));
      }
    });

    reactionsDiv.appendChild(badge);
  });

  return reactionsDiv;
}

// 아바타 모달 관리자
class AvatarModalManager {
  constructor() {
    this.modal = null;
    this.preview = null;
    this.currentEmoji = '😀';
    this.currentColor = '#667eea';
    this.studentNumber = null;
    this.grade = null;
    this.section = null;
  }

  init(grade, section, studentNumber) {
    this.grade = grade;
    this.section = section;
    this.studentNumber = studentNumber;
    this.modal = document.getElementById('avatarModal');
    this.preview = document.getElementById('avatarPreview');

    // 이모지 선택
    document.querySelectorAll('[data-avatar-emoji]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentEmoji = btn.dataset.avatarEmoji;
        this.updatePreview();
      });
    });

    // 색상 선택
    document.querySelectorAll('[data-avatar-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentColor = btn.dataset.avatarColor;
        this.updatePreview();
      });
    });

    // 저장 버튼
    document.getElementById('avatarSaveBtn')?.addEventListener('click', () => {
      this.saveAvatar();
    });

    // 취소 버튼
    document.getElementById('avatarCancelBtn')?.addEventListener('click', () => {
      this.close();
    });

    // 현재 아바타 로드
    this.loadCurrentAvatar();
  }

  async loadCurrentAvatar() {
    try {
      const res = await fetch('/api/classes/chat/avatar', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data.avatar) {
          this.currentEmoji = data.avatar.emoji || '😀';
          this.currentColor = data.avatar.bgColor || '#667eea';
          this.updatePreview();
        }
      }
    } catch (err) {
      console.error('Failed to load avatar:', err);
    }
  }

  updatePreview() {
    if (!this.preview) return;

    this.preview.style.background = this.currentColor;
    const emojiEl = this.preview.querySelector('.avatar-emoji');
    if (emojiEl) {
      emojiEl.textContent = this.currentEmoji;
    } else {
      const newEmoji = document.createElement('span');
      newEmoji.className = 'avatar-emoji';
      newEmoji.textContent = this.currentEmoji;
      this.preview.appendChild(newEmoji);
    }

    const numberEl = this.preview.querySelector('.avatar-number');
    if (numberEl && this.studentNumber) {
      numberEl.textContent = String(this.studentNumber).padStart(2, '0');
    }
  }

  async saveAvatar() {
    const avatarData = {
      emoji: this.currentEmoji,
      bgColor: this.currentColor
    };

    try {
      const res = await fetch('/api/classes/chat/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ avatar: avatarData })
      });

      if (res.ok) {
        this.showToast('아바타가 저장되었습니다!');
        this.close();
        // 페이지 새로고침하여 변경사항 반영
        if (window.chatPage) {
          window.chatPage.loadMessages();
        }
        // 콜백 호출 (마이페이지용)
        if (this.onAvatarSaved) {
          this.onAvatarSaved();
        }
      } else {
        throw new Error('Failed to save avatar');
      }
    } catch (err) {
      console.error('Failed to save avatar:', err);
      this.showToast('아바타 저장 실패');
    }
  }

  open() {
    if (this.modal) {
      this.modal.hidden = false;
      this.updatePreview();
    }
  }

  close() {
    if (this.modal) {
      this.modal.hidden = true;
    }
  }

  showToast(message) {
    if (window.chatPage) {
      window.chatPage.showToast(message);
    }
  }
}

// 메시지 반응 모달 관리자
class MessageReactionManager {
  constructor() {
    this.modal = null;
    this.currentMessageId = null;
    this.grade = null;
    this.section = null;
    this.studentNumber = null;
  }

  init(grade, section, studentNumber) {
    this.grade = grade;
    this.section = section;
    this.studentNumber = studentNumber;
    this.modal = document.getElementById('messageReactionModal');

    // 이모지 버튼들에 이벤트 리스너 추가
    document.querySelectorAll('#messageReactionPicker [data-emoji]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const emoji = btn.dataset.emoji;
        if (this.currentMessageId) {
          await this.addReaction(this.currentMessageId, emoji);
        }
      });
    });

    // 닫기 버튼
    document.getElementById('messageReactionCloseBtn')?.addEventListener('click', () => {
      this.close();
    });
  }

  async addReaction(messageId, emoji) {
    try {
      const res = await fetch(`/api/classes/chat/reactions/${messageId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ emoji })
      });

      if (res.ok) {
        this.close();
        // 메시지 목록 새로고침
        if (window.chatPage) {
          await window.chatPage.loadMessages();
        }
      } else {
        const data = await res.json();
        if (data.error === 'already reacted') {
          this.showToast('이미 해당 반응을 남겼습니다');
        } else {
          throw new Error(data.error || 'Failed to add reaction');
        }
      }
    } catch (err) {
      console.error('Failed to add reaction:', err);
      this.showToast('반응 추가 실패');
    }
  }

  async removeReaction(messageId, emoji) {
    try {
      const res = await fetch(`/api/classes/chat/reactions/${messageId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ emoji })
      });

      if (res.ok) {
        // 메시지 목록 새로고침
        if (window.chatPage) {
          await window.chatPage.loadMessages();
        }
      } else {
        throw new Error('Failed to remove reaction');
      }
    } catch (err) {
      console.error('Failed to remove reaction:', err);
      this.showToast('반응 제거 실패');
    }
  }

  open(messageId) {
    this.currentMessageId = messageId;
    if (this.modal) {
      this.modal.hidden = false;
    }
  }

  close() {
    this.currentMessageId = null;
    if (this.modal) {
      this.modal.hidden = true;
    }
  }

  showToast(message) {
    if (window.chatPage) {
      window.chatPage.showToast(message);
    }
  }
}

// 프로필 모달 관리자
class ProfileModalManager {
  constructor() {
    this.modal = null;
    this.grade = null;
    this.section = null;
  }

  init(grade, section) {
    this.grade = grade;
    this.section = section;
    this.modal = document.getElementById('profileModal');

    document.getElementById('profileCloseBtn')?.addEventListener('click', () => {
      this.close();
    });
  }

  async open(studentNumber) {
    if (!this.grade || !this.section) return;

    try {
      const res = await fetch(
        `/api/classes/chat/profile/${studentNumber}?grade=${this.grade}&section=${this.section}`,
        { credentials: 'include' }
      );

      if (!res.ok) throw new Error('Failed to load profile');

      const profile = await res.json();
      this.renderProfile(profile);

      if (this.modal) {
        this.modal.hidden = false;
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
      this.showToast('프로필을 불러올 수 없습니다');
    }
  }

  renderProfile(profile) {
    // 아바타
    const avatarEl = document.getElementById('profileAvatar');
    if (avatarEl) {
      if (profile.avatar && profile.avatar.bgColor) {
        avatarEl.style.background = profile.avatar.bgColor;
      } else {
        avatarEl.className = `message-avatar avatar-color-${profile.studentNumber % 10}`;
        avatarEl.style.width = '80px';
        avatarEl.style.height = '80px';
        avatarEl.style.fontSize = '40px';
        avatarEl.style.margin = '0 auto';
      }

      avatarEl.innerHTML = '';
      if (profile.avatar && profile.avatar.emoji) {
        const emoji = document.createElement('span');
        emoji.className = 'avatar-emoji';
        emoji.textContent = profile.avatar.emoji;
        emoji.style.fontSize = '40px';
        avatarEl.appendChild(emoji);
      }

      const number = document.createElement('span');
      number.className = 'avatar-number';
      number.textContent = String(profile.studentNumber).padStart(2, '0');
      avatarEl.appendChild(number);
    }

    // 닉네임
    const nicknameEl = document.getElementById('profileNickname');
    if (nicknameEl) {
      nicknameEl.textContent = profile.nickname || `${profile.studentNumber}번`;
    }

    // 학번
    const studentNumberEl = document.getElementById('profileStudentNumber');
    if (studentNumberEl) {
      studentNumberEl.textContent = `${profile.studentNumber}번`;
    }

    // 최근 메시지
    const messagesEl = document.getElementById('profileMessages');
    if (messagesEl) {
      messagesEl.innerHTML = '';

      if (!profile.recentMessages || profile.recentMessages.length === 0) {
        messagesEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:20px">최근 메시지가 없습니다</p>';
      } else {
        profile.recentMessages.forEach(msg => {
          const msgDiv = document.createElement('div');
          msgDiv.style.cssText = 'background:var(--card);padding:10px 12px;border-radius:12px';

          const text = document.createElement('p');
          text.style.cssText = 'margin:0 0 4px;font-size:14px;word-wrap:break-word';
          text.textContent = msg.message || '[이미지]';

          const time = document.createElement('small');
          time.style.cssText = 'color:var(--muted);font-size:12px';
          time.textContent = this.formatTime(msg.timestamp);

          msgDiv.appendChild(text);
          msgDiv.appendChild(time);
          messagesEl.appendChild(msgDiv);
        });
      }
    }
  }

  formatTime(isoString) {
    if (window.chatPage) {
      return window.chatPage.formatTime(isoString);
    }
    return '';
  }

  close() {
    if (this.modal) {
      this.modal.hidden = true;
    }
  }

  showToast(message) {
    if (window.chatPage) {
      window.chatPage.showToast(message);
    }
  }
}

// 전역 매니저 인스턴스
window.avatarModalManager = new AvatarModalManager();
window.messageReactionManager = new MessageReactionManager();
window.profileModalManager = new ProfileModalManager();

// 전역 헬퍼 함수 노출
window.renderAvatar = renderAvatar;
window.renderMessageReactions = renderMessageReactions;
