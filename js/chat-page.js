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

    // Audio elements
    this.sendAudio = new Audio('/src/send.mp3');
    this.receiveAudio = new Audio('/src/recieve.mp3');
  }

  init() {
    this.initElements();
    this.loadAuthStatus();
    this.attachEventListeners();
    this.startPolling();
  }

  initElements() {
    // Messages
    this.messagesList = document.getElementById('chatMessagesList');
    this.messagesContainer = document.getElementById('chatMessagesContainer');
    this.chatInput = document.getElementById('chatInput');
    this.sendBtn = document.getElementById('sendBtn');
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
  }

  attachEventListeners() {
    // Send message
    this.sendBtn?.addEventListener('click', () => this.handleSendMessage());
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
        window.votingManager.init(this.grade, this.section, this.studentNumber);
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
      this.loadMessages();
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

  startPolling() {
    // Poll every 2 seconds
    this.pollingInterval = setInterval(() => {
      this.loadMessages();
    }, 2000);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  async loadMessages() {
    if (!this.grade || !this.section) return;

    try {
      const res = await fetch(
        `/api/classes/chat/today?grade=${this.grade}&section=${this.section}`,
        { credentials: 'include' }
      );

      if (!res.ok) throw new Error('Failed to load messages');

      const data = await res.json();
      const newMessages = data.messages || [];
      const previousLastId = this.lastMessageId;

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
        if (this.messages.length > 0) {
          this.lastMessageId = Math.max(...this.messages.map(m => m.id));
        } else {
          this.lastMessageId = 0;
        }

        if (freshMessages.length) {
          window.notificationManager?.notifyChatMessages?.(freshMessages);
          // Play receive sound for new messages from others
          this.receiveAudio.play().catch(err => console.log('Audio play failed:', err));
        }
        this.renderMessages();
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
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

  async handleSendMessage() {
    const text = this.chatInput?.value?.trim();

    if (!text && !this.pendingImageUrl) {
      this.showToast('메시지를 입력해주세요');
      return;
    }

    if (!this.grade || !this.section) {
      this.showToast('로그인 정보가 없습니다');
      return;
    }

    const payload = {
      message: text || '',
      imageUrl: this.pendingImageUrl || undefined,
      replyToId: this.replyToMessage?.id || undefined
    };

    try {
      const res = await fetch(
        `/api/classes/chat/send?grade=${this.grade}&section=${this.section}`,
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
    } catch (err) {
      console.error('Failed to send message:', err);
      this.showToast(err.message || '메시지 전송 실패');
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

  confirmImageUrl() {
    const url = this.imageUrlInput?.value?.trim();
    if (url) {
      this.pendingImageUrl = url;
      this.closeImageUrlModal();
      this.showToast('이미지가 추가되었습니다. 메시지를 전송하세요.');
      this.chatInput?.focus();
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
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
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
