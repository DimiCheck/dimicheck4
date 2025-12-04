class MyPageController {
  constructor() {
    this.grade = null;
    this.section = null;
    this.number = null;
    this.nickname = '';
    this.settings = window.preferences?.getSettings?.() || {};
    this.isStandalone = this.checkStandalone();
    this.toastTimer = null;
  }

  init() {
    this.cacheElements();
    this.bindEvents();
    this.renderThemeControls();
    this.renderNotificationCard();
    this.renderNotificationToggles();
    this.loadProfile();

    window.addEventListener('dimicheck:settings-changed', (event) => {
      this.settings = event.detail || {};
      this.renderThemeControls();
      this.renderNotificationToggles();
    });
  }

  cacheElements() {
    this.avatarEl = document.getElementById('studentAvatar');
    this.metaEl = document.getElementById('studentMeta');
    this.themeButtons = document.querySelectorAll('[data-theme-select]');
    this.nicknameInput = document.getElementById('nicknameInput');
    this.nicknameSaveBtn = document.getElementById('nicknameSaveBtn');
    this.nicknameStatus = document.getElementById('nicknameStatus');
    this.avatarBtn = document.getElementById('avatarBtn');
    this.chatToggle = document.getElementById('chatNotificationToggle');
    this.timetableToggle = document.getElementById('timetableNotificationToggle');
    this.browserToggle = document.getElementById('browserNotificationToggle');
    this.browserRow = document.getElementById('browserNotificationRow');
    this.notificationCard = document.getElementById('notificationCard');
    this.notificationDisabled = document.getElementById('notificationUnavailable');
    this.logoutBtn = document.getElementById('logoutBtn');
    this.toast = document.getElementById('myToast');
  }

  bindEvents() {
    this.themeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const theme = button.dataset.themeSelect;
        window.preferences?.setThemePreference?.(theme);
      });
    });

    this.nicknameSaveBtn?.addEventListener('click', () => this.saveNickname());

    this.avatarBtn?.addEventListener('click', () => {
      if (window.avatarModalManager) {
        window.avatarModalManager.open();
      }
    });

    this.chatToggle?.addEventListener('change', (event) => {
      this.handleNotificationToggle('chatNotifications', event.target.checked);
    });

    this.timetableToggle?.addEventListener('change', (event) => {
      this.handleNotificationToggle('timetableNotifications', event.target.checked);
    });

    this.browserToggle?.addEventListener('change', (event) => {
      this.handleNotificationToggle('browserNotifications', event.target.checked, {
        requireServiceWorker: false,
        requireDesktop: true
      });
    });

    this.logoutBtn?.addEventListener('click', () => {
      window.location.href = '/auth/logout';
    });
  }

  checkStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  renderThemeControls() {
    const active = this.settings.theme || 'system';
    this.themeButtons.forEach((btn) => {
      const isActive = btn.dataset.themeSelect === active;
      if (isActive) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  renderNotificationCard() {
    if (!this.notificationCard || !this.notificationDisabled) return;

    if (this.isStandalone && window.notificationManager?.isSupported()) {
      this.notificationCard.hidden = false;
      this.notificationDisabled.hidden = true;
    } else {
      this.notificationCard.hidden = true;
      this.notificationDisabled.hidden = false;
    }

    if (this.browserRow) {
      const isDesktop = window.notificationManager?.isDesktop?.();
      if (isDesktop) {
        this.browserRow.hidden = false;
      } else {
        this.browserRow.hidden = true;
        if (this.browserToggle) {
          this.browserToggle.checked = false;
        }
      }
    }

    if (this.chatToggle) {
      this.chatToggle.disabled = !this.isStandalone;
    }
  }

  renderNotificationToggles() {
    if (this.chatToggle) {
      this.chatToggle.checked = Boolean(this.settings.chatNotifications);
    }
    if (this.timetableToggle) {
      this.timetableToggle.checked = Boolean(this.settings.timetableNotifications);
    }
    if (this.browserToggle) {
      this.browserToggle.checked = Boolean(this.settings.browserNotifications);
    }
  }

  async loadProfile() {
    try {
      const res = await fetch('/auth/status', { credentials: 'include' });
      if (!res.ok) {
        window.location.href = '/login.html';
        return;
      }

      const data = await res.json();
      if (!data.logged_in) {
        window.location.href = '/login.html';
        return;
      }

      // 선호하는 응답 구조(grade/section/number)를 우선 사용하고,
      // 하위 호환을 위해 기존 복합 number 형식도 처리한다.
      const grade = Number(data.grade);
      const section = Number(data.section);
      const number = Number(data.number);

      if (Number.isFinite(grade) && Number.isFinite(section) && Number.isFinite(number)) {
        this.grade = grade;
        this.section = section;
        this.number = number;
      } else {
        const identifier = Number(data.number);
        if (!Number.isFinite(identifier)) {
          window.location.href = '/login.html';
          return;
        }
        this.number = Math.floor(identifier % 100);
        this.section = Math.floor((identifier % 1000) / 100);
        this.grade = Math.floor(identifier / 1000);
      }

      await this.updateProfileCard();
      this.syncClassContext();
      await this.loadNickname();

      // 아바타 매니저 초기화
      if (window.avatarModalManager && this.grade && this.section && this.number) {
        window.avatarModalManager.init(this.grade, this.section, this.number);
        // 아바타 저장 시 프로필 카드 업데이트
        window.avatarModalManager.onAvatarSaved = () => this.updateProfileCard();
      }
    } catch (error) {
      console.error('[MyPage] Failed to load profile.', error);
      window.location.href = '/login.html';
    }
  }

  async updateProfileCard() {
    if (!this.metaEl || !this.avatarEl) return;
    const gradeText = this.grade ? `${this.grade}학년` : '';
    const sectionText = this.section ? `${this.section}반` : '';
    const numberText = this.number ? `${this.number}번` : '';
    this.metaEl.textContent = [gradeText, sectionText, numberText].filter(Boolean).join(' ');

    // 커스텀 아바타 가져오기
    try {
      const res = await fetch('/api/classes/chat/avatar', { credentials: 'include' });
      console.log('[MyPage] Avatar API response status:', res.status);
      if (res.ok) {
        const data = await res.json();
        console.log('[MyPage] Avatar data:', data);
        if (data.avatar) {
          // data.avatar는 이미 객체이므로 JSON.parse 불필요
          console.log('[MyPage] Using avatar data:', data.avatar);
          this.renderCustomAvatar(data.avatar);
        } else {
          console.log('[MyPage] No avatar data, using default');
          this.avatarEl.textContent = this.number?.toString().padStart(2, '0') || '--';
        }
      } else {
        console.warn('[MyPage] Avatar API failed:', res.status);
        this.avatarEl.textContent = this.number?.toString().padStart(2, '0') || '--';
      }
    } catch (error) {
      console.warn('[MyPage] Failed to load avatar.', error);
      this.avatarEl.textContent = this.number?.toString().padStart(2, '0') || '--';
    }
  }

  renderCustomAvatar(avatarData) {
    console.log('[MyPage] renderCustomAvatar called with:', avatarData);
    console.log('[MyPage] avatarEl:', this.avatarEl);

    if (!this.avatarEl) {
      console.error('[MyPage] avatarEl is null!');
      return;
    }

    // 기본 스타일 리셋
    this.avatarEl.style.background = '';
    this.avatarEl.style.backgroundImage = '';
    this.avatarEl.textContent = '';
    this.avatarEl.innerHTML = '';
    this.avatarEl.style.display = 'flex';
    this.avatarEl.style.alignItems = 'center';
    this.avatarEl.style.justifyContent = 'center';
    this.avatarEl.classList.remove('has-image');

    if (avatarData.imageUrl) {
      // 이미지 아바타
      this.avatarEl.style.backgroundImage = `url(${avatarData.imageUrl})`;
      this.avatarEl.style.backgroundSize = 'cover';
      this.avatarEl.style.backgroundPosition = 'center';
      this.avatarEl.classList.add('has-image');

      const numberBadge = document.createElement('span');
      numberBadge.style.position = 'absolute';
      numberBadge.style.bottom = '0px';
      numberBadge.style.right = '0px';
      numberBadge.style.background = 'var(--bg)';
      numberBadge.style.border = '2px solid var(--card)';
      numberBadge.style.borderRadius = '8px';
      numberBadge.style.fontSize = '13px';
      numberBadge.style.fontWeight = '700';
      numberBadge.style.padding = '3px 7px';
      numberBadge.style.lineHeight = '1';
      numberBadge.textContent = this.number?.toString().padStart(2, '0') || '--';
      this.avatarEl.appendChild(numberBadge);

      this.avatarEl.style.position = 'relative';
      console.log('[MyPage] Image avatar rendered successfully');
      return;
    }

    // 배경 색상 적용
    if (avatarData.bgColor) {
      this.avatarEl.style.background = `linear-gradient(135deg, ${avatarData.bgColor}, ${avatarData.bgColor}dd)`;
      console.log('[MyPage] Applied background color:', avatarData.bgColor);
    }

    // 이모지 표시
    if (avatarData.emoji) {
      console.log('[MyPage] Rendering emoji:', avatarData.emoji);
      const emojiSpan = document.createElement('span');
      emojiSpan.style.fontSize = '40px';
      emojiSpan.style.lineHeight = '1';
      emojiSpan.textContent = avatarData.emoji;
      this.avatarEl.appendChild(emojiSpan);

      const numberBadge = document.createElement('span');
      numberBadge.style.position = 'absolute';
      numberBadge.style.bottom = '0px';
      numberBadge.style.right = '0px';
      numberBadge.style.background = 'var(--bg)';
      numberBadge.style.border = '2px solid var(--card)';
      numberBadge.style.borderRadius = '8px';
      numberBadge.style.fontSize = '13px';
      numberBadge.style.fontWeight = '700';
      numberBadge.style.padding = '3px 7px';
      numberBadge.style.lineHeight = '1';
      numberBadge.textContent = this.number?.toString().padStart(2, '0') || '--';
      this.avatarEl.appendChild(numberBadge);

      this.avatarEl.style.position = 'relative';
      console.log('[MyPage] Avatar rendered successfully');
    } else {
      console.log('[MyPage] No emoji, using default display');
      this.avatarEl.style.display = 'grid';
      this.avatarEl.style.placeItems = 'center';
      this.avatarEl.textContent = this.number?.toString().padStart(2, '0') || '--';
    }
  }

  async loadNickname() {
    try {
      const res = await fetch('/api/classes/chat/nickname', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      this.nickname = data.nickname || '';
      if (this.nicknameInput) {
        this.nicknameInput.value = this.nickname;
      }
    } catch (error) {
      console.warn('[MyPage] Failed to load nickname.', error);
    }
  }

  async saveNickname() {
    const value = this.nicknameInput?.value?.trim() || '';
    if (!value) {
      this.showToast('닉네임을 입력해주세요.');
      return;
    }

    if (value === this.nickname) {
      this.showToast('이미 저장된 닉네임입니다.');
      return;
    }

    try {
      const res = await fetch('/api/classes/chat/nickname', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ nickname: value })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '닉네임 저장 실패');
      }

      this.nickname = value;
      this.showToast('닉네임이 저장되었습니다.');
      this.updateNicknameStatus('success', '저장 완료');
    } catch (error) {
      console.error('[MyPage] Failed to save nickname.', error);
      this.updateNicknameStatus('error', error.message);
      this.showToast(error.message);
    }
  }

  updateNicknameStatus(state, message) {
    if (!this.nicknameStatus) return;
    this.nicknameStatus.textContent = message;
    this.nicknameStatus.dataset.state = state;
  }

  syncClassContext() {
    if (!this.grade || !this.section) return;
    window.notificationManager?.setClassContext?.({
      grade: this.grade,
      section: this.section
    });
  }

  async handleNotificationToggle(key, enabled, options = {}) {
    const needsSW = options.requireServiceWorker !== false;
    const notificationAvailable = needsSW
      ? window.notificationManager?.isSupported?.()
      : 'Notification' in window;

    if (!notificationAvailable) {
      this.showToast('알림을 지원하지 않는 환경입니다.');
      this.resetToggle(key);
      return;
    }

    if (enabled) {
      const granted = await window.notificationManager.requestPermission();
      if (!granted) {
        this.showToast('알림 권한이 필요합니다.');
        this.resetToggle(key);
        return;
      }
    }

    window.preferences?.setPreference?.(key, enabled);
  }

  resetToggle(key) {
    if (key === 'chatNotifications' && this.chatToggle) {
      this.chatToggle.checked = Boolean(this.settings.chatNotifications);
    }
    if (key === 'timetableNotifications' && this.timetableToggle) {
      this.timetableToggle.checked = Boolean(this.settings.timetableNotifications);
    }
    if (key === 'browserNotifications' && this.browserToggle) {
      this.browserToggle.checked = Boolean(this.settings.browserNotifications);
    }
  }

  showToast(message) {
    if (!this.toast) return;
    this.toast.textContent = message;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.classList.remove('show');
    }, 2500);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const controller = new MyPageController();
  controller.init();
});
