/**
 * chat-features.js - 채팅 추가 기능 (반응, 아바타, 프로필)
 */

// 아바타 렌더링 헬퍼
function renderAvatar(studentNumber, avatarData) {
  const avatar = document.createElement('div');
  avatar.className = `message-avatar`;

  if (avatarData && avatarData.imageUrl) {
    avatar.classList.add('has-image');
    avatar.style.backgroundImage = `url(${avatarData.imageUrl})`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
  } else if (avatarData && avatarData.bgColor) {
    avatar.style.background = avatarData.bgColor;
  } else {
    // 기본 그라데이션
    avatar.className += ` avatar-color-${studentNumber % 10}`;
  }

  if (avatarData && avatarData.emoji && !avatarData.imageUrl) {
    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'avatar-emoji';
    emojiSpan.textContent = avatarData.emoji;
    avatar.appendChild(emojiSpan);
  } else if (!avatarData?.imageUrl) {
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
    this.currentImageUrl = null;
    this.studentNumber = null;
    this.grade = null;
    this.section = null;
    this.imageUploadUrl = 'https://img.codz.me/upload';
    this.imageInput = null;
    this.imageUploadBtn = null;
    this.imageRemoveBtn = null;
    this.imageStatusEl = null;
  }

  init(grade, section, studentNumber) {
    this.grade = grade;
    this.section = section;
    this.studentNumber = studentNumber;
    this.modal = document.getElementById('avatarModal');
    this.preview = document.getElementById('avatarPreview');
    this.imageInput = document.getElementById('avatarImageInput');
    this.imageUploadBtn = document.getElementById('avatarImageUploadBtn');
    this.imageRemoveBtn = document.getElementById('avatarImageRemoveBtn');
    this.imageStatusEl = document.getElementById('avatarImageStatus');

    // 이모지 선택
    const emojiButtons = this.modal?.querySelectorAll('[data-avatar-emoji]') || [];
    emojiButtons.forEach(btn => {
      if (btn.dataset.avatarEmojiBound === '1') return;
      btn.dataset.avatarEmojiBound = '1';
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        this.currentEmoji = btn.dataset.avatarEmoji;
        // 이미지 아바타 상태에서는 이모지 선택이 안 먹는 것처럼 보여 자동 해제한다.
        if (this.currentImageUrl) {
          this.currentImageUrl = null;
          this.setUploadStatus('이모지를 선택해 이미지 아바타를 해제했어요.');
        }
        this.updatePreview();
      });
    });

    // 색상 선택
    const colorButtons = this.modal?.querySelectorAll('[data-avatar-color]') || [];
    colorButtons.forEach(btn => {
      if (btn.dataset.avatarColorBound === '1') return;
      btn.dataset.avatarColorBound = '1';
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        this.currentColor = btn.dataset.avatarColor;
        // 색상 선택 시에도 이미지 모드를 해제해 즉시 반영되도록 한다.
        if (this.currentImageUrl) {
          this.currentImageUrl = null;
          this.setUploadStatus('배경 색상을 선택해 이미지 아바타를 해제했어요.');
        }
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

    // 이미지 업로드 버튼
    this.imageUploadBtn?.addEventListener('click', () => {
      this.imageInput?.click();
    });

    // 이미지 제거 버튼
    this.imageRemoveBtn?.addEventListener('click', () => {
      this.currentImageUrl = null;
      this.updatePreview();
      this.setUploadStatus('이미지를 제거했어요.');
    });

    // 파일 선택
    this.imageInput?.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (file) {
        this.handleImageFile(file);
      }
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
          this.currentImageUrl = data.avatar.imageUrl || null;
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
    this.preview.style.backgroundImage = '';
    this.preview.classList.remove('has-image');

    // 이미지가 있으면 우선 적용
    if (this.currentImageUrl) {
      this.preview.style.backgroundImage = `url(${this.currentImageUrl})`;
      this.preview.style.backgroundSize = 'cover';
      this.preview.style.backgroundPosition = 'center';
      this.preview.classList.add('has-image');
    }

    const emojiEl = this.preview.querySelector('.avatar-emoji');
    if (emojiEl) {
      emojiEl.textContent = this.currentEmoji;
      emojiEl.style.display = this.currentImageUrl ? 'none' : 'block';
    } else {
      const newEmoji = document.createElement('span');
      newEmoji.className = 'avatar-emoji';
      newEmoji.textContent = this.currentEmoji;
      newEmoji.style.display = this.currentImageUrl ? 'none' : 'block';
      this.preview.appendChild(newEmoji);
    }

    const numberEl = this.preview.querySelector('.avatar-number');
    if (numberEl && this.studentNumber) {
      numberEl.textContent = String(this.studentNumber).padStart(2, '0');
    }

    this.updateSelectionState();
  }

  updateSelectionState() {
    if (!this.modal) return;

    this.modal.querySelectorAll('[data-avatar-emoji]').forEach((btn) => {
      const selected = btn.dataset.avatarEmoji === this.currentEmoji;
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
      btn.style.outline = selected ? '2px solid var(--primary)' : 'none';
      btn.style.boxShadow = selected ? '0 0 0 3px rgba(208,79,255,0.2)' : '';
    });

    this.modal.querySelectorAll('[data-avatar-color]').forEach((btn) => {
      const selected = btn.dataset.avatarColor === this.currentColor;
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
      btn.style.outline = selected ? '2px solid #fff' : 'none';
      btn.style.boxShadow = selected ? '0 0 0 3px rgba(255,255,255,0.25)' : '';
    });
  }

  async saveAvatar() {
    const avatarData = {
      emoji: this.currentEmoji,
      bgColor: this.currentColor,
      imageUrl: this.currentImageUrl
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

  async handleImageFile(file) {
    if (!file.type.startsWith('image/')) {
      this.setUploadStatus('이미지 파일을 선택해주세요.');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      this.setUploadStatus('5MB 이하 이미지만 업로드할 수 있어요.');
      return;
    }

    try {
      this.setUploadStatus('업로드 중...');
      const formData = new FormData();
      formData.append('image', file);
      const res = await fetch(this.imageUploadUrl, {
        method: 'POST',
        body: formData
      });
      if (!res.ok) {
        throw new Error('이미지 업로드 실패');
      }
      const data = await res.json();
      if (!data.url) {
        throw new Error('업로드 응답이 올바르지 않습니다.');
      }
      this.currentImageUrl = data.url;
      this.updatePreview();
      this.setUploadStatus('업로드 완료!');
    } catch (err) {
      console.error('Avatar image upload failed:', err);
      this.setUploadStatus(err.message || '업로드 실패');
    } finally {
      if (this.imageInput) this.imageInput.value = '';
    }
  }

  setUploadStatus(message) {
    if (!this.imageStatusEl) return;
    this.imageStatusEl.textContent = message || '';
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
      avatarEl.className = 'message-avatar';
      avatarEl.style.width = '80px';
      avatarEl.style.height = '80px';
      avatarEl.style.fontSize = '40px';
      avatarEl.style.margin = '0 auto';
      avatarEl.style.background = '';
      avatarEl.style.backgroundImage = '';
      avatarEl.innerHTML = '';
      avatarEl.classList.remove('has-image');

      const avatarData = profile.avatar || {};
      const imageUrl = avatarData.imageUrl;
      const bgColor = avatarData.bgColor;
      const emoji = avatarData.emoji;

      if (imageUrl) {
        avatarEl.classList.add('has-image');
        avatarEl.style.backgroundImage = `url(${imageUrl})`;
        avatarEl.style.backgroundSize = 'cover';
        avatarEl.style.backgroundPosition = 'center';
      } else if (bgColor) {
        avatarEl.style.background = bgColor;
      } else {
        avatarEl.classList.add(`avatar-color-${profile.studentNumber % 10}`);
      }

      if (emoji && !imageUrl) {
        const emojiEl = document.createElement('span');
        emojiEl.className = 'avatar-emoji';
        emojiEl.textContent = emoji;
        emojiEl.style.fontSize = '40px';
        avatarEl.appendChild(emojiEl);
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
