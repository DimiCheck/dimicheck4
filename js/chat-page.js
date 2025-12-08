/**
 * chat-page.js - Discord-style Chat Page Manager
 *
 * Features:
 * - Message rendering with avatars and timestamps
 * - Image URL sending and display
 * - Reply to messages
 * - Message deletion (soft delete)
 * - Nickname display
 * - Real-time polling
 * - Settings modal
 */

class ChatPageManager {
  constructor() {
    this.grade = null;
    this.section = null;
    this.studentNumber = null;
    this.messages = [];
    this.voteTimelineEvent = null;
    this.lastMessageId = 0;
    this.pollingInterval = null;

    // Reply state
    this.replyToMessage = null;

    // Image URL state
    this.pendingImageUrl = null;

    // Avatar customization state
    this.currentAvatar = {
      emoji: '😀',
      bgColor: '#667eea'
    };

    // Message reaction state
    this.pendingReactionMessageId = null;

    // DOM elements
    this.messagesList = null;
    this.messagesContainer = null;
    this.chatInput = null;
    this.sendBtn = null;
    this.sendMenu = null;
    this.chatInputContainer = null;
    this.imageUrlBtn = null;
    this.gifBtn = null;
    this.voteBubble = null;

    // Modals
    this.imageUrlModal = null;
    this.imageViewModal = null;

    // Reply indicator
    this.replyIndicator = null;
    this.cancelReplyBtn = null;

    // Image URL modal elements
    this.imageUrlInput = null;
    this.imagePreview = null;
    this.imagePreviewContainer = null;
    this.imageConfirmBtn = null;
    this.imageCancelBtn = null;

    // Toast
    this.toast = null;

    // Channel state
    this.channels = ['home'];
    this.currentChannel = 'home';
    this.channelPermissions = {};
    this.channelLatestMap = {};
    this.channelToggle = null;
    this.channelMenu = null;
    this.channelList = null;
    this.channelCreateBtn = null;
    this.currentChannelLabel = null;
    this.channelModal = null;
    this.channelNameInput = null;
    this.channelClassesInput = null;
    this.channelModalCreateBtn = null;
    this.channelModalCancelBtn = null;
    this.channelDeleteBtn = null;

    // Audio elements
    this.sendAudio = new Audio('/src/send.mp3');
    this.receiveAudio = new Audio('/src/recieve.mp3');

    // Internal state flags
    this.isLoadingMessages = false;
    this.pollingStarted = false;
    this.sendLongPressTimer = null;
    this.longPressTriggered = false;
    this.skipNextSendClick = false;

    // Bindings
    this.handleDocumentClick = this.handleDocumentClick.bind(this);
  }

  init() {
    this.initElements();
    this.attachEventListeners();
    this.closeChannelModal();
    this.loadAuthStatus();
  }

  initElements() {
    // Messages
    this.messagesList = document.getElementById('chatMessagesList');
    this.messagesContainer = document.getElementById('chatMessagesContainer');
    this.chatInput = document.getElementById('chatInput');
    this.sendBtn = document.getElementById('sendBtn');
    this.sendMenu = document.getElementById('sendMenu');
    this.chatInputContainer = document.querySelector('.chat-input-container');
    this.imageUrlBtn = document.getElementById('imageUrlBtn');
    this.gifBtn = document.getElementById('gifBtn');
    this.voteBubble = document.getElementById('voteBubble');

    // Modals
    this.imageUrlModal = document.getElementById('imageUrlModal');
    this.imageViewModal = document.getElementById('imageViewModal');

    // Reply indicator
    this.replyIndicator = document.getElementById('replyIndicator');
    this.cancelReplyBtn = document.getElementById('cancelReplyBtn');

    // Image URL modal
    this.imageUrlInput = document.getElementById('imageUrlInput');
    this.imagePreview = document.getElementById('imagePreview');
    this.imagePreviewContainer = document.getElementById('imagePreviewContainer');
    this.imageConfirmBtn = document.getElementById('imageConfirmBtn');
    this.imageCancelBtn = document.getElementById('imageCancelBtn');

    // Toast
    this.toast = document.getElementById('chatToast');

    // Channels
    this.channelToggle = document.getElementById('channelToggle');
    this.channelMenu = document.getElementById('channelMenu');
    this.channelList = document.getElementById('channelList');
    this.channelCreateBtn = document.getElementById('channelCreateBtn');
    this.currentChannelLabel = document.getElementById('currentChannelLabel');
    this.channelModal = document.getElementById('channelModal');
    this.channelModalOverlay = document.getElementById('channelModalOverlay');
    this.channelNameInput = document.getElementById('channelNameInput');
    this.channelClassCheckboxes = document.querySelectorAll('[data-class-check]');
    this.channelModalCreateBtn = document.getElementById('channelModalCreateBtn');
    this.channelModalCancelBtn = document.getElementById('channelModalCancelBtn');
    this.channelDeleteBtn = document.getElementById('channelDeleteBtn');
    this.channelRefreshTimer = null;

    // Consent
    this.chatConsentOverlay = document.getElementById('chatConsentOverlay');
    this.chatConsentConfirmBtn = document.getElementById('chatConsentConfirmBtn');
    this.chatTermsCheckbox = document.getElementById('chatTermsCheckbox');
    this.chatPrivacyCheckbox = document.getElementById('chatPrivacyCheckbox');
    this.consentGranted = false;
    this.consentVersion = 'v1';
  }

  attachEventListeners() {
    // Send message
    this.sendBtn?.addEventListener('click', (e) => {
      if (this.skipNextSendClick) {
        this.skipNextSendClick = false;
        return;
      }
      if (this.longPressTriggered) {
        this.longPressTriggered = false;
        return;
      }
      this.handleSendMessage();
    });
    this.sendBtn?.addEventListener('pointerdown', (e) => this.startSendLongPress(e));
    this.sendBtn?.addEventListener('pointerup', () => this.cancelSendLongPress(true));
    this.sendBtn?.addEventListener('pointerleave', () => this.cancelSendLongPress(false));
    this.sendBtn?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.skipNextSendClick = true;
      this.openSendMenu();
    });
    this.chatInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSendMessage();
      }
    });

    // Image URL button
    this.imageUrlBtn?.addEventListener('click', () => this.openImageUrlModal());

    // GIF button
    this.gifBtn?.addEventListener('click', () => {
      if (window.gifPickerManager) {
        window.gifPickerManager.open();
      }
    });

    // Image URL modal
    this.imageUrlInput?.addEventListener('input', () => this.handleImageUrlInput());
    this.imageConfirmBtn?.addEventListener('click', () => this.confirmImageUrl());
    this.imageCancelBtn?.addEventListener('click', () => this.closeImageUrlModal());
    document.getElementById('imageOverlay')?.addEventListener('click', () => this.closeImageUrlModal());

    // Image preview load
    this.imagePreview?.addEventListener('load', () => {
      this.imageConfirmBtn.disabled = false;
    });
    this.imagePreview?.addEventListener('error', () => {
      this.imageConfirmBtn.disabled = true;
      this.showToast('이미지를 불러올 수 없습니다');
    });

    // Reply
    this.cancelReplyBtn?.addEventListener('click', () => this.cancelReply());

    // Image view modal
    document.getElementById('closeImageViewBtn')?.addEventListener('click', () => this.closeImageView());
    document.getElementById('imageViewOverlay')?.addEventListener('click', () => this.closeImageView());

    // Channel switcher
    this.channelToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleChannelMenu();
    });

    this.channelCreateBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openChannelModal();
    });

    this.channelModalCreateBtn?.addEventListener('click', () => this.submitChannelModal());
    this.channelModalCancelBtn?.addEventListener('click', () => this.closeChannelModal());
    document.getElementById('channelModalOverlay')?.addEventListener('click', () => this.closeChannelModal());

    this.channelDeleteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteCurrentChannel();
    });

    // Consent
    const syncConsentBtn = () => {
      if (!this.chatConsentConfirmBtn) return;
      const ok = this.chatTermsCheckbox?.checked && this.chatPrivacyCheckbox?.checked;
      this.chatConsentConfirmBtn.disabled = !ok;
    };
    this.chatTermsCheckbox?.addEventListener('change', syncConsentBtn);
    this.chatPrivacyCheckbox?.addEventListener('change', syncConsentBtn);
    this.chatConsentConfirmBtn?.addEventListener('click', async () => {
      const ok = await this.setConsentAccepted();
      if (!ok) {
        return;
      }
      this.closeConsentModal();
      if (!this._consentResolver) {
        this.afterConsentGranted();
      }
    });

    document.addEventListener('click', this.handleDocumentClick);

    this.sendMenu?.addEventListener('click', (event) => {
      const actionBtn = event.target.closest('[data-send-action]');
      if (!actionBtn) return;
      event.stopPropagation();
      const action = actionBtn.dataset.sendAction;
      this.closeSendMenu();
      if (action === 'chat-only') {
        this.handleSendMessage({ boardPreview: false, toastMessage: '채팅에만 전송했어요' });
      } else if (action === 'board-only') {
        this.handleSendBoardOnly();
      }
    });
  }

  async loadAuthStatus() {
    try {
      const res = await fetch('/auth/status', { credentials: 'include' });
      if (!res.ok) {
        window.location.href = '/login.html';
        return;
      }

      const data = await res.json();
      this.resolveClassContext(data);
      if (window.votingManager && this.grade && this.section) {
        window.votingManager.init(this.grade, this.section, this.studentNumber, this.currentChannel);
      }
      if (window.reactionsManager && this.grade && this.section) {
        window.reactionsManager.init(this.grade, this.section, this.studentNumber);
      }
      // 추가 기능 매니저 초기화
      if (window.avatarModalManager && this.grade && this.section && this.studentNumber) {
        window.avatarModalManager.init(this.grade, this.section, this.studentNumber);
      }
      if (window.messageReactionManager && this.grade && this.section && this.studentNumber) {
        window.messageReactionManager.init(this.grade, this.section, this.studentNumber);
      }
      if (window.profileModalManager && this.grade && this.section) {
        window.profileModalManager.init(this.grade, this.section);
      }
      if (window.gifPickerManager && this.grade && this.section && this.studentNumber) {
        await window.gifPickerManager.init(this.grade, this.section, this.studentNumber);
      }
      const consentOk = await this.ensureChatConsent();
      if (!consentOk) return;
      await this.loadChannels();
      await this.loadMessages();
      this.startPolling();
    } catch (err) {
      console.error('Failed to load auth status:', err);
      this.showToast('로그인 정보를 불러오지 못했습니다');
    }
  }

  createDefaultAvatar(studentNumber) {
    const avatar = document.createElement('div');
    avatar.className = `message-avatar avatar-color-${studentNumber % 10}`;
    avatar.textContent = String(studentNumber).padStart(2, '0');
    return avatar;
  }

  resolveClassContext(data) {
    const parseIdentifier = (raw) => {
      if (raw == null) return {};
      const digits = String(raw).replace(/[^\d]/g, '');
      if (!digits) return {};
      if (digits.length >= 3) {
        const grade = Number(digits[0]);
        const sectionDigits = digits.slice(1, -2);
        const section = sectionDigits ? Number(sectionDigits) : undefined;
        const number = Number(digits.slice(-2));
        return {
          grade: Number.isNaN(grade) ? undefined : grade,
          section: Number.isNaN(section) ? undefined : section,
          number: Number.isNaN(number) ? undefined : number
        };
      }
      const number = Number(digits);
      return { number: Number.isNaN(number) ? undefined : number };
    };

    const explicitGrade = data.grade;
    const explicitSection = data.section || data.class || data.class_no;
    const numberInfo = parseIdentifier(data.number);
    const studentNumberInfo = parseIdentifier(data.student_number);

    if (explicitGrade) this.grade = explicitGrade;
    if (!this.grade && numberInfo.grade !== undefined) this.grade = numberInfo.grade;
    if (!this.grade && studentNumberInfo.grade !== undefined) this.grade = studentNumberInfo.grade;

    if (explicitSection) this.section = explicitSection;
    if (!this.section && numberInfo.section !== undefined) this.section = numberInfo.section;
    if (!this.section && studentNumberInfo.section !== undefined) this.section = studentNumberInfo.section;

    if (numberInfo.number !== undefined) {
      this.studentNumber = numberInfo.number;
    } else if (studentNumberInfo.number !== undefined) {
      this.studentNumber = studentNumberInfo.number;
    }
  }

  normalizeChannelName(name) {
    if (!name) return '';
    const cleaned = String(name).trim().replace(/\s+/g, ' ');
    return cleaned.substring(0, 30);
  }

  getConsentStorageKey() {
    return `dimicheck:chat-consent:${this.consentVersion || 'v1'}`;
  }

  readLocalConsent() {
    const key = this.getConsentStorageKey();
    try {
      return localStorage.getItem(key) === 'true';
    } catch (err) {
      console.warn('Failed to read consent from storage', err);
      return false;
    }
  }

  persistLocalConsent() {
    const key = this.getConsentStorageKey();
    try {
      localStorage.setItem(key, 'true');
    } catch (err) {
      console.warn('Failed to persist consent', err);
    }
  }

  async fetchConsentStatus() {
    try {
      const res = await fetch('/api/classes/chat/consent', { credentials: 'include' });
      if (!res.ok) return { consented: false };
      const data = await res.json();
      const ok = !!data.consented && data.version === this.consentVersion;
      return { consented: ok, version: data.version, agreedAt: data.agreedAt };
    } catch (err) {
      console.warn('Failed to fetch consent status', err);
      return { consented: false };
    }
  }

  resolveConsentPromise(result) {
    if (this._consentResolver) {
      this._consentResolver(result);
      this._consentResolver = null;
    }
  }

  async ensureChatConsent() {
    const serverStatus = await this.fetchConsentStatus();
    if (serverStatus.consented) {
      this.consentGranted = true;
      this.persistLocalConsent();
      return true;
    }

    // If client remembered consent but server missing, attempt to sync silently
    if (this.readLocalConsent()) {
      const synced = await this.saveConsentToServer(true);
      if (synced) {
        this.resolveConsentPromise(true);
        return true;
      }
    }

    return new Promise((resolve) => {
      this.consentGranted = false;
      this.openConsentModal();
      this._consentResolver = resolve;
    });
  }

  async saveConsentToServer(silent = false) {
    try {
      const res = await fetch('/api/classes/chat/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ version: this.consentVersion })
      });
      if (!res.ok) {
        throw new Error('동의 저장 실패');
      }
      const data = await res.json().catch(() => ({}));
      if (!data || data.consented !== true) {
        throw new Error('동의 상태를 확인할 수 없습니다');
      }
      this.persistLocalConsent();
      this.consentGranted = true;
      this.resolveConsentPromise(true);
      return true;
    } catch (err) {
      console.warn('Failed to save consent', err);
      if (!silent) {
        this.showToast('동의 저장에 실패했습니다. 다시 시도해주세요.');
      }
      return false;
    }
  }

  async setConsentAccepted() {
    const ok = await this.saveConsentToServer(false);
    if (!ok) return false;
    return true;
  }

  openConsentModal() {
    if (this.chatConsentOverlay) {
      this.chatConsentOverlay.hidden = false;
    }
  }

  closeConsentModal() {
    if (this.chatConsentOverlay) {
      this.chatConsentOverlay.hidden = true;
    }
  }

  afterConsentGranted() {
    // If consent was pending, start loading now
    if (this.pollingStarted) return;
    this.loadChannels().then(() => {
      this.loadMessages();
      this.startPolling();
    });
  }

  normalizeChannels(list) {
    const normalized = [];
    const seen = new Set();
    [...(Array.isArray(list) ? list : []), 'home'].forEach((item) => {
      const name = this.normalizeChannelName(item);
      const key = name.toLowerCase();
      if (!name || seen.has(key)) return;
      seen.add(key);
      normalized.push(name);
    });
    return normalized;
  }

  parseChannelList(items) {
    const names = [];
    const perms = {};
    const latest = {};
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (typeof item === 'string') {
        const name = this.normalizeChannelName(item);
        if (name) names.push(name);
      } else if (item && typeof item === 'object') {
        const name = this.normalizeChannelName(item.name);
        if (!name) return;
        names.push(name);
        if (item.canDelete) {
          perms[name.toLowerCase()] = true;
        }
        if (item.latestMessageId != null) {
          latest[name.toLowerCase()] = Number(item.latestMessageId) || 0;
        }
      }
    });
    return { names: this.normalizeChannels(names), perms, latest };
  }

  getChannelStorageKey() {
    if (!this.grade || !this.section) return null;
    return `dimicheck:chat-channel:${this.grade}-${this.section}`;
  }

  saveChannelPreference(channel) {
    const key = this.getChannelStorageKey();
    if (!key) return;
    try {
      localStorage.setItem(key, channel);
    } catch (err) {
      console.warn('Failed to persist channel preference', err);
    }
  }

  getLastReadKey(channel) {
    if (!this.grade || !this.section) return null;
    const safeChannel = (channel || 'home').toLowerCase();
    return `dimicheck:chat-lastread:${this.grade}-${this.section}:${safeChannel}`;
  }

  markChannelAsRead(channel, latestId) {
    const key = this.getLastReadKey(channel);
    if (!key) return;
    const channelKey = (channel || 'home').toLowerCase();
    const id = Number(latestId) || 0;
    const lastStored = this.getLastReadId(channel);
    const knownLatest = Math.max(id, this.channelLatestMap[channelKey] || 0);
    const nextValue = Math.max(lastStored, knownLatest);
    try {
      localStorage.setItem(key, String(nextValue));
    } catch (err) {
      console.warn('Failed to persist last read', err);
    }
    this.updateNavBadge();
  }

  getLastReadId(channel) {
    const key = this.getLastReadKey(channel);
    if (!key) return 0;
    try {
      const raw = localStorage.getItem(key);
      return raw ? Number(raw) || 0 : 0;
    } catch (err) {
      console.warn('Failed to read last read', err);
      return 0;
    }
  }

  hasUnreadForChannel(channel) {
    const normalized = (channel || 'home').toLowerCase();
    const latest = this.channelLatestMap[normalized] || 0;
    const lastRead = this.getLastReadId(normalized);
    return latest > lastRead;
  }

  async sendReadReceipt(latestId) {
    if (!this.grade || !this.section) return;
    if (!latestId) return;
    try {
      await fetch(
        `/api/classes/chat/read?grade=${this.grade}&section=${this.section}&channel=${encodeURIComponent(this.currentChannel || 'home')}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ lastMessageId: latestId })
        }
      );
    } catch (err) {
      console.warn('Failed to send read receipt', err);
    }
  }

  updateNavBadge() {
    const badge = document.getElementById('navChatBadge');
    if (!badge) return;
    const anyUnread = this.channels.some((ch) => this.hasUnreadForChannel(ch));
    badge.hidden = !anyUnread;
  }

  restoreChannelPreference(channels) {
    const key = this.getChannelStorageKey();
    if (!key) return null;
    try {
      const stored = localStorage.getItem(key);
      if (!stored) return null;
      const target = stored.toLowerCase();
      return channels.find((ch) => ch.toLowerCase() === target) || null;
    } catch (err) {
      console.warn('Failed to read channel preference', err);
      return null;
    }
  }

  updateChannelLabel() {
    if (this.currentChannelLabel) {
      this.currentChannelLabel.textContent = this.currentChannel || 'home';
    }
  }

  async loadChannels() {
    if (!this.grade || !this.section) return;
    try {
      const res = await fetch(
        `/api/classes/chat/channels?grade=${this.grade}&section=${this.section}`,
        { credentials: 'include' }
      );
      if (!res.ok) {
        throw new Error('채널을 불러올 수 없습니다');
      }
      const data = await res.json();
      const { names, perms, latest } = this.parseChannelList(data.channels);
      this.channels = names;
      this.channelPermissions = perms;
      this.channelLatestMap = { ...this.channelLatestMap, ...latest };
    } catch (err) {
      console.error('Failed to load channels:', err);
      this.channels = this.normalizeChannels(this.channels);
    }

    const preferred = this.restoreChannelPreference(this.channels);
    this.currentChannel = preferred || (this.channels[0] || 'home');
    this.updateChannelLabel();
    this.renderChannelMenu();
    if (window.votingManager) {
      window.votingManager.setChannel(this.currentChannel);
    }
    this.updateNavBadge();
  }

  renderChannelMenu() {
    if (!this.channelList) return;
    const channels = this.normalizeChannels(this.channels);
    this.channels = channels;
    this.channelList.innerHTML = '';

    channels.forEach((channel) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'channel-item';
      if (channel.toLowerCase() === (this.currentChannel || 'home').toLowerCase()) {
        btn.classList.add('active');
      }
      const unread = this.hasUnreadForChannel(channel);
      btn.innerHTML = `
        <span class="channel-chip">#</span>
        <span class="channel-name">${channel}</span>
        ${unread ? '<span class="channel-unread-dot" aria-hidden="true"></span>' : ''}
      `;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.switchChannel(channel);
        this.closeChannelMenu();
      });
      this.channelList.appendChild(btn);
    });

    if (this.channelDeleteBtn) {
      const canDelete = !!this.channelPermissions[(this.currentChannel || 'home').toLowerCase()];
      this.channelDeleteBtn.hidden = !canDelete;
    }

    this.updateNavBadge();
  }

  toggleChannelMenu() {
    if (!this.channelMenu) return;
    if (this.channelMenu.hidden) {
      this.openChannelMenu();
    } else {
      this.closeChannelMenu();
    }
  }

  openChannelMenu() {
    if (!this.channelMenu) return;
    this.renderChannelMenu();
    this.channelMenu.hidden = false;
    this.channelToggle?.setAttribute('aria-expanded', 'true');
  }

  closeChannelMenu() {
    if (!this.channelMenu) return;
    this.channelMenu.hidden = true;
    this.channelToggle?.setAttribute('aria-expanded', 'false');
  }

  handleDocumentClick(event) {
    const target = event.target;
    if (this.channelMenu && !this.channelMenu.hidden) {
      if (!this.channelMenu.contains(target) && !this.channelToggle?.contains(target)) {
        this.closeChannelMenu();
      }
    }

    if (this.sendMenu && !this.sendMenu.hidden) {
      if (!this.sendMenu.contains(target) && !this.sendBtn?.contains(target)) {
        this.closeSendMenu();
      }
    }
  }

  switchChannel(channel) {
    const normalized = this.normalizeChannelName(channel);
    if (!normalized) return;
    const exists = this.channels.some((ch) => ch.toLowerCase() === normalized.toLowerCase());
    if (!exists) {
      this.channels = this.normalizeChannels([...this.channels, normalized]);
      this.renderChannelMenu();
    }
    this.currentChannel = normalized;
    this.saveChannelPreference(normalized);
    this.updateChannelLabel();
    this.lastMessageId = 0;
    this.messages = [];
    this.setVoteTimelineEvent(null);
    if (window.votingManager) {
      window.votingManager.setChannel(normalized);
    }
    this.renderMessages();
    this.loadMessages();
    this.scrollToBottom();
    this.markChannelAsRead(normalized, this.lastMessageId);
    this.updateNavBadge();
  }

  openChannelModal() {
    if (!this.channelModal || !this.channelModalOverlay) return;
    this.channelModalOverlay.hidden = false;
    this.channelModal.dataset.open = 'true';
    if (this.channelNameInput) {
      this.channelNameInput.value = '';
      this.channelNameInput.focus();
    }
    this.channelClassCheckboxes?.forEach((cb) => {
      const g = Number(cb.dataset.grade);
      const s = Number(cb.dataset.section);
      const isSelf = g === this.grade && s === this.section;
      cb.checked = isSelf;
      cb.disabled = isSelf;
    });
  }

  closeChannelModal() {
    if (!this.channelModal || !this.channelModalOverlay) return;
    this.channelModalOverlay.hidden = true;
    this.channelModal.dataset.open = 'false';
  }

  parseClassSelection() {
    const classes = [];
    this.channelClassCheckboxes?.forEach((cb) => {
      if (cb.checked) {
        const g = Number(cb.dataset.grade);
        const s = Number(cb.dataset.section);
        if (Number.isInteger(g) && Number.isInteger(s)) {
          classes.push({ grade: g, section: s });
        }
      }
    });
    return classes;
  }

  async submitChannelModal() {
    if (!this.grade || !this.section) return;
    const name = this.normalizeChannelName(this.channelNameInput?.value);
    if (!name) {
      this.showToast('채널 이름을 입력해주세요');
      return;
    }
    const classes = this.parseClassSelection();

    try {
      const res = await fetch(
        `/api/classes/chat/channels?grade=${this.grade}&section=${this.section}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name, classes })
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || '채널을 만들 수 없어요');
      }
      const { names, perms, latest } = this.parseChannelList(data.channels);
      this.channels = names.length ? names : this.channels;
      this.channelPermissions = { ...this.channelPermissions, ...perms };
      this.channelLatestMap = { ...this.channelLatestMap, ...latest };
      this.closeChannelModal();
      this.switchChannel(name);
      this.renderChannelMenu();
    } catch (err) {
      console.error('Failed to create channel:', err);
      this.showToast(err.message || '채널 생성에 실패했어요');
    }
  }

  async deleteCurrentChannel() {
    if (!this.grade || !this.section) return;
    const channel = this.currentChannel || 'home';
    if (channel.toLowerCase() === 'home') {
      this.showToast('홈 채널은 삭제할 수 없습니다');
      return;
    }
    if (!confirm(`#${channel} 채널을 삭제할까요?`)) return;

    try {
      const res = await fetch(
        `/api/classes/chat/channels/${encodeURIComponent(channel)}?grade=${this.grade}&section=${this.section}`,
        {
          method: 'DELETE',
          credentials: 'include'
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || '채널을 삭제할 수 없어요');
      }
      const { names, perms, latest } = this.parseChannelList(data.channels);
      this.channels = names;
      this.channelPermissions = perms;
      this.channelLatestMap = { ...latest };
      this.currentChannel = this.channels[0] || 'home';
      this.saveChannelPreference(this.currentChannel);
      this.closeChannelMenu();
      this.updateChannelLabel();
      this.lastMessageId = 0;
      this.messages = [];
      this.loadMessages();
    } catch (err) {
      console.error('Failed to delete channel:', err);
      this.showToast(err.message || '채널 삭제에 실패했어요');
    }
  }

  startPolling() {
    if (this.pollingStarted) return;
    this.pollingStarted = true;
    // Poll every 2 seconds
    this.pollingInterval = setInterval(() => {
      this.loadMessages();
    }, 2000);
    // Refresh channels every 15 seconds for unread indicators
    this.channelRefreshTimer = setInterval(() => {
      this.loadChannels();
    }, 15000);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.channelRefreshTimer) {
      clearInterval(this.channelRefreshTimer);
      this.channelRefreshTimer = null;
    }
  }

  async loadMessages() {
    if (!this.grade || !this.section) return;
    if (!this.consentGranted) return;
    if (this.isLoadingMessages) return;

    const channel = this.currentChannel || this.channels[0] || 'home';
    this.currentChannel = channel;

    this.isLoadingMessages = true;
    try {
      const res = await fetch(
        `/api/classes/chat/today?grade=${this.grade}&section=${this.section}&channel=${encodeURIComponent(channel)}`,
        { credentials: 'include' }
      );

      if (!res.ok) throw new Error('Failed to load messages');

      const data = await res.json();
      const newMessages = data.messages || [];
      const previousLastId = this.lastMessageId;
      const channelKey = (this.currentChannel || 'home').toLowerCase();
      const latestIdInChannel = newMessages.length ? Math.max(...newMessages.map((m) => m.id || 0)) : 0;
      this.channelLatestMap[channelKey] = Math.max(this.channelLatestMap[channelKey] || 0, latestIdInChannel);

      // Check for actual changes in messages
      const hasNew = newMessages.some(msg => msg.id > this.lastMessageId);
      const hasChanges = this.hasMessageChanges(this.messages, newMessages);

      if (hasNew || hasChanges) {
        const freshMessages = newMessages.filter(
          (msg) =>
            msg.id > previousLastId &&
            msg.studentNumber !== this.studentNumber &&
            !msg.deletedAt
        );
        this.messages = newMessages;
        const latestFromMessages = this.messages.length ? Math.max(...this.messages.map(m => m.id)) : 0;
        this.lastMessageId = Math.max(previousLastId, latestIdInChannel, latestFromMessages);

        if (freshMessages.length) {
          window.notificationManager?.notifyChatMessages?.(freshMessages);
          // Play receive sound for new messages from others
          this.receiveAudio.play().catch(err => console.log('Audio play failed:', err));
        }
        this.renderMessages();
      }
      this.updateNavBadge();
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      this.isLoadingMessages = false;
    }
  }

  hasMessageChanges(oldMessages, newMessages) {
    // Check if messages actually changed (length, deletion status, etc.)
    if (oldMessages.length !== newMessages.length) return true;

    // Check for deletions or updates in existing messages
    for (let i = 0; i < oldMessages.length; i++) {
      const oldMsg = oldMessages[i];
      const newMsg = newMessages.find(m => m.id === oldMsg.id);

      if (!newMsg) return true; // Message removed
      if (oldMsg.deletedAt !== newMsg.deletedAt) return true; // Deletion status changed
      if (oldMsg.message !== newMsg.message) return true; // Content changed
      if (oldMsg.imageUrl !== newMsg.imageUrl) return true; // Image changed
      if (oldMsg.readCount !== newMsg.readCount) return true; // Read count changed
      if (oldMsg.replyToId !== newMsg.replyToId) return true; // Reply target changed
      if (this.reactionsChanged(oldMsg.reactions, newMsg.reactions)) return true; // Reactions changed
    }

    return false;
  }

  reactionsChanged(oldList, newList) {
    const a = Array.isArray(oldList) ? oldList : [];
    const b = Array.isArray(newList) ? newList : [];
    if (a.length !== b.length) return true;

    const normalize = (list) => {
      const map = {};
      list.forEach((item) => {
        const emoji = item?.emoji;
        if (!emoji) return;
        const students = Array.isArray(item.students)
          ? [...item.students]
              .map((s) => {
                const num = Number(s);
                return Number.isFinite(num) ? num : String(s);
              })
              .sort((a, b) => (a > b ? 1 : a < b ? -1 : 0))
          : [];
        map[emoji] = {
          count: Number(item.count) || students.length,
          students
        };
      });
      return map;
    };

    const mapA = normalize(a);
    const mapB = normalize(b);
    const emojis = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);

    for (const emoji of emojis) {
      const left = mapA[emoji] || { count: 0, students: [] };
      const right = mapB[emoji] || { count: 0, students: [] };
      if (left.count !== right.count) return true;
      if (left.students.length !== right.students.length) return true;
      for (let i = 0; i < left.students.length; i++) {
        if (left.students[i] !== right.students[i]) return true;
      }
    }

    return false;
  }

  renderMessages() {
    if (!this.messagesList) return;

    // Save scroll position
    const wasAtBottom = this.isScrolledToBottom();

    this.messagesList.innerHTML = '';

    const timeline = this.messages.map(msg => {
      const timestamp = this.parseTimestamp(msg.timestamp || msg.postedAt || msg.createdAt);
      return {
        type: 'chat',
        timestamp: timestamp ? timestamp.getTime() : 0,
        payload: msg
      };
    });

    if (this.voteTimelineEvent) {
      timeline.push(this.voteTimelineEvent);
    }

    if (timeline.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-message';
      empty.innerHTML = `
        <div class="message-content">
          <div class="message-body" style="text-align: center; color: rgba(255,255,255,0.5);">
            채팅 메시지가 없습니다. 첫 메시지를 보내보세요!
          </div>
        </div>
      `;
      this.messagesList.appendChild(empty);
      if (this.voteBubble) {
        this.voteBubble.hidden = true;
      }
      return;
    }

    timeline.sort((a, b) => a.timestamp - b.timestamp);

    timeline.forEach(event => {
      if (event.type === 'chat') {
        const msgEl = this.createMessageElement(event.payload);
        this.messagesList.appendChild(msgEl);
        return;
      }

      if (event.type === 'vote' && this.voteBubble) {
        this.voteBubble.hidden = false;
        this.voteBubble.dataset.timelineState = event.state || this.voteBubble.dataset.timelineState || 'result';
        this.messagesList.appendChild(this.voteBubble);
      }
    });

    // Auto-scroll if was at bottom
    if (wasAtBottom) {
      this.scrollToBottom();
    }

    // Mark as read with latest message ID
    const channelKey = (this.currentChannel || 'home').toLowerCase();
    const latestFromMessages = this.messages.length ? Math.max(...this.messages.map((m) => m.id || 0)) : 0;
    const latestKnown = Math.max(
      latestFromMessages,
      this.channelLatestMap[channelKey] || 0,
      this.lastMessageId || 0
    );
    this.markChannelAsRead(this.currentChannel, latestKnown);
    this.sendReadReceipt(latestKnown);
  }

  createMessageElement(msg) {
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message';
    msgEl.dataset.messageId = msg.id;

    if (msg.deletedAt) {
      msgEl.classList.add('message-deleted');
    }

    if (msg.studentNumber === this.studentNumber) {
      msgEl.classList.add('own');
    }

    // Avatar (커스터마이징 지원)
    const avatar = window.renderAvatar
      ? window.renderAvatar(msg.studentNumber, msg.avatar)
      : this.createDefaultAvatar(msg.studentNumber);

    // 아바타 클릭 시 프로필 표시
    avatar.addEventListener('click', () => {
      if (window.profileModalManager) {
        window.profileModalManager.open(msg.studentNumber);
      }
    });

    // Content container
    const content = document.createElement('div');
    content.className = 'message-content';

    // Header (author + time)
    const header = document.createElement('div');
    header.className = 'message-header';

    const author = document.createElement('span');
    author.className = 'message-author';
    const displayName = msg.nickname
      ? `${msg.nickname}(${msg.studentNumber}번)`
      : `${msg.studentNumber}번`;
    author.textContent = displayName;

    const time = document.createElement('span');
    time.className = 'message-time';
    const timestamp = msg.timestamp || msg.postedAt || msg.createdAt;
    time.textContent = this.formatTime(timestamp);

    if (msg.readCount != null) {
      const readSpan = document.createElement('span');
      readSpan.className = 'message-read-count';
      readSpan.textContent = `${msg.readCount} 읽음`;
      header.appendChild(readSpan);
    }

    header.appendChild(author);
    header.appendChild(time);

    // Reply indicator (if replying to another message)
    if (msg.replyToId) {
      const replyTo = this.messages.find(m => m.id === msg.replyToId);
      if (replyTo) {
        const replyDiv = document.createElement('div');
        replyDiv.className = 'message-reply-to';
        const replyText = replyTo.message || (replyTo.imageUrl ? '[이미지]' : '');
        const safeText = this.escapeHtml(replyText);
        replyDiv.innerHTML = `
          <span class="reply-author">${replyTo.studentNumber}번</span>: ${safeText.substring(0, 50)}${replyText && replyText.length > 50 ? '...' : ''}
        `;
        replyDiv.addEventListener('click', () => this.scrollToMessage(msg.replyToId));
        content.appendChild(replyDiv);
      } else {
        const replyDiv = document.createElement('div');
        replyDiv.className = 'message-reply-to';
        replyDiv.textContent = '원본 메시지를 불러올 수 없습니다.';
        content.appendChild(replyDiv);
      }
    }

    // Body
    const body = document.createElement('div');
    body.className = 'message-body';

    const text = document.createElement('p');
    text.className = 'message-text';
    if (msg.deletedAt) {
      text.textContent = '(삭제된 메시지)';
    } else {
      const messageText = msg.message || (msg.imageUrl ? '이미지를 공유했습니다.' : '');
      // 마크다운 및 이펙트 처리
      text.innerHTML = this.parseMessageMarkdown(messageText);
      this.attachMentionHandlers(text);
    }

    body.appendChild(text);

    // Image (if exists and not deleted)
    if (msg.imageUrl && !msg.deletedAt) {
      const img = document.createElement('img');
      img.className = 'message-image';
      img.src = msg.imageUrl;
      img.alt = 'Shared image';
      img.loading = 'lazy';
      img.addEventListener('click', () => this.openImageView(msg.imageUrl));
      body.appendChild(img);
    }

    content.appendChild(header);
    content.appendChild(body);

    // Reactions (메시지 반응 표시)
    if (!msg.deletedAt && window.renderMessageReactions) {
      const reactionsEl = window.renderMessageReactions(msg, this.studentNumber, (messageId, emoji, isOwn) => {
        if (isOwn && window.messageReactionManager) {
          // 이미 반응한 경우 제거
          window.messageReactionManager.removeReaction(messageId, emoji);
        } else if (window.messageReactionManager) {
          // 반응 추가 (같은 이모지 클릭 시)
          window.messageReactionManager.addReaction(messageId, emoji);
        }
      });

      if (reactionsEl) {
        content.appendChild(reactionsEl);
      }
    }

    // Actions (delete button for own messages)
    if (msg.studentNumber === this.studentNumber && !msg.deletedAt) {
      const actions = document.createElement('div');
      actions.className = 'message-actions';

      const replyBtn = document.createElement('button');
      replyBtn.className = 'btn-message-action';
      replyBtn.textContent = '답장';
      replyBtn.addEventListener('click', () => this.setReplyTo(msg));

      const addReactionBtn = document.createElement('button');
      addReactionBtn.className = 'btn-message-action btn-add-reaction';
      addReactionBtn.textContent = '👍+';
      addReactionBtn.addEventListener('click', () => {
        if (window.messageReactionManager) {
          window.messageReactionManager.open(msg.id);
        }
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-message-action btn-delete';
      deleteBtn.textContent = '삭제';
      deleteBtn.addEventListener('click', () => this.deleteMessage(msg.id));

      actions.appendChild(replyBtn);
      actions.appendChild(addReactionBtn);
      actions.appendChild(deleteBtn);
      content.appendChild(actions);
    } else if (!msg.deletedAt) {
      // Reply button for others' messages
      const actions = document.createElement('div');
      actions.className = 'message-actions';

      const replyBtn = document.createElement('button');
      replyBtn.className = 'btn-message-action';
      replyBtn.textContent = '답장';
      replyBtn.addEventListener('click', () => this.setReplyTo(msg));

      const addReactionBtn = document.createElement('button');
      addReactionBtn.className = 'btn-message-action btn-add-reaction';
      addReactionBtn.textContent = '👍+';
      addReactionBtn.addEventListener('click', () => {
        if (window.messageReactionManager) {
          window.messageReactionManager.open(msg.id);
        }
      });

      actions.appendChild(replyBtn);
      actions.appendChild(addReactionBtn);
      content.appendChild(actions);
    }

    msgEl.appendChild(avatar);
    msgEl.appendChild(content);

    return msgEl;
  }

  startSendLongPress() {
    if (this.sendLongPressTimer) {
      clearTimeout(this.sendLongPressTimer);
    }
    this.longPressTriggered = false;
    this.sendLongPressTimer = window.setTimeout(() => {
      this.longPressTriggered = true;
      this.skipNextSendClick = true;
      this.openSendMenu();
    }, 500);
  }

  cancelSendLongPress(markSkip) {
    if (this.sendLongPressTimer) {
      clearTimeout(this.sendLongPressTimer);
      this.sendLongPressTimer = null;
    }
    if (!this.longPressTriggered) {
      this.skipNextSendClick = false;
      return;
    }
    if (markSkip) {
      this.skipNextSendClick = true;
    }
  }

  openSendMenu() {
    if (!this.sendMenu) return;
    this.sendMenu.hidden = false;
  }

  closeSendMenu() {
    if (!this.sendMenu) return;
    this.sendMenu.hidden = true;
    this.longPressTriggered = false;
    this.skipNextSendClick = false;
  }

  async handleSendMessage(options = {}) {
    const { boardPreview = true, toastMessage } = options || {};
    if (!this.consentGranted) {
      this.showToast('채팅 이용 동의 후 사용할 수 있습니다');
      this.openConsentModal();
      return;
    }
    const text = this.chatInput?.value?.trim();

    // Check for pending image from mediaManager as well
    let imageUrl = this.pendingImageUrl;
    if (!imageUrl && window.mediaManager?.hasPendingImage()) {
      imageUrl = window.mediaManager.getPendingImageUrl();
    }

    if (!text && !imageUrl) {
      this.showToast('메시지를 입력해주세요');
      return;
    }

    if (!this.grade || !this.section) {
      this.showToast('로그인 정보가 없습니다');
      return;
    }

    const payload = {
      message: text || '',
      imageUrl: imageUrl || undefined,
      replyToId: this.replyToMessage?.id || undefined,
      channel: this.currentChannel
    };
    if (boardPreview === false) {
      payload.boardPreview = false;
    }

    try {
      const res = await fetch(
        `/api/classes/chat/send?grade=${this.grade}&section=${this.section}&channel=${encodeURIComponent(this.currentChannel || 'home')}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload)
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Failed to send' }));
        throw new Error(errData.error || 'Failed to send message');
      }

      // Play send sound
      this.sendAudio.play().catch(err => console.log('Audio play failed:', err));

      // Clear input and pending states
      if (this.chatInput) this.chatInput.value = '';
      this.pendingImageUrl = null;
      this.cancelReply();

      // Reload messages immediately
      await this.loadMessages();
      this.scrollToBottom();
      if (toastMessage) {
        this.showToast(toastMessage);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      this.showToast(err.message || '메시지 전송 실패');
    }
  }

  async handleSendBoardOnly() {
    if (!this.consentGranted) {
      this.showToast('채팅 이용 동의 후 사용할 수 있습니다');
      this.openConsentModal();
      return;
    }
    const text = this.chatInput?.value?.trim();
    if (!text) {
      this.showToast('메시지를 입력해주세요');
      return;
    }
    if (this.pendingImageUrl || window.mediaManager?.hasPendingImage()) {
      this.showToast('칠판에는 텍스트만 보낼 수 있어요');
      return;
    }
    if (text.length > 140) {
      this.showToast('칠판 메시지는 140자까지 보낼 수 있어요');
      return;
    }
    if (!this.grade || !this.section) {
      this.showToast('로그인 정보가 없습니다');
      return;
    }

    try {
      const res = await fetch(
        `/api/classes/thought?grade=${this.grade}&section=${this.section}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            thought: text,
            duration: 5,
            skipChat: true,
            target: 'board-only'
          })
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || '칠판으로 전송 실패');
      }

      if (this.chatInput) this.chatInput.value = '';
      this.pendingImageUrl = null;
      this.cancelReply();
      this.showToast('칠판에만 전송했어요');
    } catch (err) {
      console.error('Failed to send to board only:', err);
      this.showToast(err.message || '칠판 전송 실패');
    }
  }

  setReplyTo(msg) {
    this.replyToMessage = msg;

    if (this.replyIndicator) {
      const replyText = document.getElementById('replyText');
      if (replyText) {
        const displayName = msg.nickname
          ? `${msg.nickname}(${msg.studentNumber}번)`
          : `${msg.studentNumber}번`;
        const replySource = msg.message || (msg.imageUrl ? '이미지 메시지' : '');
        const trimmed = replySource.length > 50 ? `${replySource.substring(0, 50)}...` : replySource;
        replyText.textContent = `${displayName}에게 답장: ${trimmed}`;
      }
      this.replyIndicator.style.display = 'flex';
    }

    this.chatInput?.focus();
  }

  cancelReply() {
    this.replyToMessage = null;
    if (this.replyIndicator) {
      this.replyIndicator.style.display = 'none';
    }
  }

  async deleteMessage(messageId) {
    if (!confirm('이 메시지를 삭제하시겠습니까?')) return;

    try {
      const res = await fetch(
        `/api/classes/chat/delete/${messageId}?grade=${this.grade}&section=${this.section}`,
        {
          method: 'DELETE',
          credentials: 'include'
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Failed to delete' }));
        throw new Error(errData.error || 'Failed to delete message');
      }

      this.showToast('메시지가 삭제되었습니다');
      await this.loadMessages();
    } catch (err) {
      console.error('Failed to delete message:', err);
      this.showToast(err.message || '메시지 삭제 실패');
    }
  }

  openImageUrlModal() {
    if (this.imageUrlModal) {
      this.imageUrlModal.hidden = false;
      this.imageUrlInput.value = '';
      if (this.imagePreviewContainer) {
        this.imagePreviewContainer.style.display = 'none';
      }
      this.imageConfirmBtn.disabled = true;
      this.imageUrlInput.focus();
    }
  }

  closeImageUrlModal() {
    if (this.imageUrlModal) {
      this.imageUrlModal.hidden = true;
      this.imageUrlInput.value = '';
      if (this.imagePreviewContainer) {
        this.imagePreviewContainer.style.display = 'none';
      }
    }
  }

  handleImageUrlInput() {
    const url = this.imageUrlInput?.value?.trim();

    // Validate HTTPS URL with image extension
    const urlPattern = /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i;

    if (url && urlPattern.test(url)) {
      // Show preview
      if (this.imagePreview) {
        this.imagePreview.src = url;
      }
      if (this.imagePreviewContainer) {
        this.imagePreviewContainer.style.display = 'block';
      }
      // Confirm button enabled after image loads successfully
    } else {
      if (this.imagePreviewContainer) {
        this.imagePreviewContainer.style.display = 'none';
      }
      this.imageConfirmBtn.disabled = true;
    }
  }

  async confirmImageUrl() {
    const url = this.imageUrlInput?.value?.trim();
    if (url) {
      this.pendingImageUrl = url;
      this.closeImageUrlModal();
      await this.handleSendMessage();
    }
  }

  openImageView(imageUrl) {
    const fullImg = document.getElementById('imageViewFull');
    if (fullImg && this.imageViewModal) {
      fullImg.src = imageUrl;
      this.imageViewModal.hidden = false;
    }
  }

  closeImageView() {
    if (this.imageViewModal) {
      this.imageViewModal.hidden = true;
    }
  }

  scrollToMessage(messageId) {
    const msgEl = this.messagesList?.querySelector(`[data-message-id="${messageId}"]`);
    if (msgEl) {
      msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      msgEl.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
      setTimeout(() => {
        msgEl.style.backgroundColor = '';
      }, 1000);
    }
  }

  scrollToBottom() {
    if (this.messagesContainer) {
      // Double RAF to ensure images and all content are loaded
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
          // Extra safety: scroll again after a short delay to catch late-loading images
          setTimeout(() => {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
          }, 100);
        });
      });
    }
  }

  isScrolledToBottom() {
    if (!this.messagesContainer) return true;
    const threshold = 100;
    return this.messagesContainer.scrollHeight - this.messagesContainer.clientHeight <=
           this.messagesContainer.scrollTop + threshold;
  }

  showToast(message) {
    if (!this.toast) return;

    this.toast.textContent = message;
    this.toast.classList.add('show');

    setTimeout(() => {
      this.toast.classList.remove('show');
    }, 3000);
  }

  parseTimestamp(value) {
    if (!value && value !== 0) return null;

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const raw = String(value).trim();
    if (!raw) return null;

    // Treat timestamps without timezone info as UTC.
    const hasTimezone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
    const normalized = hasTimezone ? raw : `${raw}Z`;

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  setVoteTimelineEvent(eventData) {
    if (!eventData) {
      this.voteTimelineEvent = null;
      if (this.voteBubble) {
        this.voteBubble.hidden = true;
      }
      this.renderMessages();
      return;
    }

    const targetChannel = (eventData.channel || eventData.payload?.channel || 'home').toLowerCase();
    if ((this.currentChannel || 'home').toLowerCase() !== targetChannel) {
      this.voteTimelineEvent = null;
      if (this.voteBubble) {
        this.voteBubble.hidden = true;
      }
      return;
    }

    const timestampSource = eventData.timestamp || eventData.expiresAt || eventData.createdAt;
    const parsedTs = this.parseTimestamp(timestampSource);

    this.voteTimelineEvent = {
      type: 'vote',
      timestamp: parsedTs ? parsedTs.getTime() : Date.now(),
      state: eventData.state || 'result',
      payload: eventData
    };

    if (this.voteBubble) {
      this.voteBubble.hidden = false;
      this.voteBubble.dataset.timelineState = eventData.state || 'result';
    }

    this.renderMessages();
  }

  formatTime(isoString) {
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // UTC+9

    try {
      const utcDate = this.parseTimestamp(isoString);
      if (!utcDate) return '';

      const kstDate = new Date(utcDate.getTime() + KST_OFFSET_MS);
      const nowKst = new Date(Date.now() + KST_OFFSET_MS);

      const messageDay = Date.UTC(
        kstDate.getUTCFullYear(),
        kstDate.getUTCMonth(),
        kstDate.getUTCDate()
      );
      const todayDay = Date.UTC(
        nowKst.getUTCFullYear(),
        nowKst.getUTCMonth(),
        nowKst.getUTCDate()
      );
      const daysDiff = Math.floor((todayDay - messageDay) / (1000 * 60 * 60 * 24));

      const hours = String(kstDate.getUTCHours()).padStart(2, '0');
      const minutes = String(kstDate.getUTCMinutes()).padStart(2, '0');
      const timeStr = `${hours}:${minutes}`;

      if (daysDiff === 0) return timeStr;
      if (daysDiff === 1) return `1일 전 ${timeStr}`;
      if (daysDiff > 1) return `${daysDiff}일 전 ${timeStr}`;
      return timeStr;
    } catch (error) {
      console.warn('[ChatPage] Failed to format time', error);
      return '';
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  }

  parseMessageMarkdown(text) {
    if (!text) return '';

    // Escape HTML first
    let escaped = this.escapeHtml(text);

    // 링크 자동 인식 (URL을 클릭 가능한 링크로 변환)
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    escaped = escaped.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

    // 마크다운 문법 처리
    // **굵게** -> <strong>굵게</strong>
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // *기울임* -> <em>기울임</em>
    escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // __밑줄__ -> <u>밑줄</u>
    escaped = escaped.replace(/__(.+?)__/g, '<u>$1</u>');

    // ~~취소선~~ -> <s>취소선</s>
    escaped = escaped.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // `코드` -> <code>코드</code>
    escaped = escaped.replace(/`(.+?)`/g, '<code>$1</code>');

    // 글자 이펙트 처리
    // [rainbow:텍스트] -> 무지개 효과
    escaped = escaped.replace(/\[rainbow:(.+?)\]/g, '<span class="effect-rainbow">$1</span>');

    // [glow:텍스트] -> 글로우 효과
    escaped = escaped.replace(/\[glow:(.+?)\]/g, '<span class="effect-glow">$1</span>');

    // [shake:텍스트] -> 흔들림 효과
    escaped = escaped.replace(/\[shake:(.+?)\]/g, '<span class="effect-shake">$1</span>');

    // [bounce:텍스트] -> 바운스 효과
    escaped = escaped.replace(/\[bounce:(.+?)\]/g, '<span class="effect-bounce">$1</span>');

    // [fade:텍스트] -> 페이드 효과
    escaped = escaped.replace(/\[fade:(.+?)\]/g, '<span class="effect-fade">$1</span>');

    // [spin:텍스트] -> 회전 효과
    escaped = escaped.replace(/\[spin:(.+?)\]/g, '<span class="effect-spin">$1</span>');

    // [wave:텍스트] -> 물결 효과
    escaped = escaped.replace(/\[wave:(.+?)\]/g, (match, content) => {
      const letters = content.split('').map((char, i) =>
        `<span class="wave-letter" style="animation-delay: ${i * 0.1}s">${char}</span>`
      ).join('');
      return `<span class="effect-wave">${letters}</span>`;
    });

    escaped = this.highlightMentions(escaped);

    return escaped;
  }

  highlightMentions(htmlText) {
    if (!htmlText) return htmlText;
    const mentionPattern = /(^|[\s.,!?()[\]{}"'])@([가-힣a-zA-Z0-9_]{1,20})/g;

    return htmlText.replace(mentionPattern, (match, prefix, handle) => {
      const type = /^\d+$/.test(handle) ? 'number' : 'text';
      return `${prefix}<span class="message-mention" data-mention="${handle}" data-mention-type="${type}">@${handle}</span>`;
    });
  }

  attachMentionHandlers(container) {
    if (!container) return;
    const mentions = container.querySelectorAll('.message-mention');
    mentions.forEach((mentionEl) => {
      mentionEl.addEventListener('click', () => {
        const target = mentionEl.dataset.mention;
        const type = mentionEl.dataset.mentionType || 'text';
        this.handleMentionClick(target, type);
      });
    });
  }

  handleMentionClick(target, type) {
    if (!target) return;

    let studentNumber = null;
    if (type === 'number') {
      const num = Number(target);
      if (!Number.isNaN(num)) {
        studentNumber = num;
      }
    } else {
      const normalizedTarget = target.toLowerCase();
      const match = this.messages.find(
        (msg) => msg.nickname && msg.nickname.toLowerCase() === normalizedTarget
      );
      if (match) {
        studentNumber = match.studentNumber;
      }
    }

    if (studentNumber && window.profileModalManager) {
      window.profileModalManager.open(studentNumber);
      return;
    }

    this.showToast('멘션 대상을 찾을 수 없어요');
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  const chatPage = new ChatPageManager();
  window.chatPage = chatPage;
  chatPage.init();

  // Initialize voting and reactions managers

  // Voting event listeners
  const voteCreateBtn = document.getElementById('voteCreateBtn');
  const voteSubmitBtn = document.getElementById('voteSubmitBtn');
  const voteCreateSubmitBtn = document.getElementById('voteCreateSubmitBtn');
  const voteCreateCancelBtn = document.getElementById('voteCreateCancelBtn');
  const voteAddOptionBtn = document.getElementById('voteAddOptionBtn');

  if (voteCreateBtn) {
    voteCreateBtn.addEventListener('click', () => {
      const overlay = document.getElementById('voteCreateOverlay');
      if (overlay) {
        overlay.hidden = false;
        initVoteCreateModal();
      }
    });
  }

  if (voteSubmitBtn) {
    voteSubmitBtn.addEventListener('click', async () => {
      if (!window.votingManager) return;
      await window.votingManager.submitVote();
      // submitVote 함수 내부에서 토스트 메시지를 표시하므로 여기서는 별도 처리 불필요
    });
  }

  if (voteCreateSubmitBtn) {
    voteCreateSubmitBtn.addEventListener('click', async () => {
      const question = document.getElementById('voteQuestionInput')?.value;
      const optionsList = document.getElementById('voteOptionsList');
      const options = Array.from(optionsList?.querySelectorAll('input') || [])
        .map(input => input.value.trim())
        .filter(v => v);
      const maxChoices = parseInt(document.getElementById('voteMaxChoices')?.value || '1');

      const feedback = document.getElementById('voteCreateFeedback');
      if (!window.votingManager) return;

      const result = await window.votingManager.createVote(question, options, maxChoices);

      if (result.success) {
        if (feedback) {
          feedback.textContent = '투표가 생성되었습니다!';
          feedback.style.color = '#38d67a';
        }
        setTimeout(() => {
          document.getElementById('voteCreateOverlay').hidden = true;
        }, 1000);
      } else {
        if (feedback) {
          feedback.textContent = result.error || '투표를 생성하지 못했어요.';
          feedback.style.color = '#ff5c5c';
        }
      }
    });
  }

  if (voteCreateCancelBtn) {
    voteCreateCancelBtn.addEventListener('click', () => {
      document.getElementById('voteCreateOverlay').hidden = true;
    });
  }

  if (voteAddOptionBtn) {
    voteAddOptionBtn.addEventListener('click', addVoteOption);
  }

  // Reaction event listeners
  const reactionBtn = document.getElementById('reactionBtn');
  const reactionCloseBtn = document.getElementById('reactionCloseBtn');

  if (reactionBtn) {
    reactionBtn.addEventListener('click', () => {
      if (window.reactionsManager) {
        window.reactionsManager.openPicker();
      }
    });
  }

  if (reactionCloseBtn) {
    reactionCloseBtn.addEventListener('click', () => {
      if (window.reactionsManager) {
        window.reactionsManager.closePicker();
      }
    });
  }

  // Avatar customization event listener
  const avatarBtn = document.getElementById('avatarBtn');
  if (avatarBtn) {
    avatarBtn.addEventListener('click', () => {
      if (window.avatarModalManager) {
        window.avatarModalManager.open();
      }
    });
  }

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    chatPage.stopPolling();
  });
});

// Vote create modal helpers
function initVoteCreateModal() {
  const optionsList = document.getElementById('voteOptionsList');
  if (!optionsList) return;

  optionsList.innerHTML = '';
  // Default 2 options
  addVoteOption();
  addVoteOption();
}

function addVoteOption() {
  const optionsList = document.getElementById('voteOptionsList');
  if (!optionsList) return;

  const count = optionsList.children.length;
  if (count >= 10) {
    alert('옵션은 최대 10개까지 추가할 수 있습니다.');
    return;
  }

  const optionDiv = document.createElement('div');
  optionDiv.style.cssText = 'display:flex;gap:8px';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = `옵션 ${count + 1}`;
  input.maxLength = 100;
  input.style.cssText = 'flex:1;background:var(--card);border:none;padding:10px 14px;border-radius:8px;color:var(--text);font-size:14px;font-family:inherit;outline:none';

  const delBtn = document.createElement('button');
  delBtn.textContent = '×';
  delBtn.type = 'button';
  delBtn.style.cssText = 'height:auto;min-width:40px;padding:8px;border-radius:8px;background:var(--card);border:1px solid color-mix(in oklab, var(--text) 15%, transparent);color:var(--text);cursor:pointer;font-size:18px';
  delBtn.addEventListener('click', () => {
    optionDiv.remove();
  });

  optionDiv.appendChild(input);
  optionDiv.appendChild(delBtn);
  optionsList.appendChild(optionDiv);
}
