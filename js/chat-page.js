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
    this.lastMessageId = 0;
    this.pollingInterval = null;

    // Reply state
    this.replyToMessage = null;

    // Image URL state
    this.pendingImageUrl = null;

    // DOM elements
    this.messagesList = null;
    this.messagesContainer = null;
    this.chatInput = null;
    this.sendBtn = null;
    this.imageUrlBtn = null;

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
      this.loadMessages();
    } catch (err) {
      console.error('Failed to load auth status:', err);
      this.showToast('로그인 정보를 불러오지 못했습니다');
    }
  }

  resolveClassContext(data) {
    // Parse grade, section, studentNumber from auth data
    if (data.grade) this.grade = data.grade;
    if (data.section || data.class || data.class_no) {
      this.section = data.section || data.class || data.class_no;
    }
    if (data.number) {
      this.studentNumber = data.number;
    } else if (data.student_number) {
      const num = Number(data.student_number);
      if (num >= 1000) {
        this.grade = Math.floor(num / 1000);
        this.section = Math.floor((num % 1000) / 100);
        this.studentNumber = num % 100;
      } else {
        this.studentNumber = num;
      }
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

      // Check for new messages
      const hasNew = newMessages.some(msg => msg.id > this.lastMessageId);
      if (hasNew || this.messages.length !== newMessages.length) {
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
        }
        this.renderMessages();
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }

  renderMessages() {
    if (!this.messagesList) return;

    // Save scroll position
    const wasAtBottom = this.isScrolledToBottom();

    this.messagesList.innerHTML = '';

    if (this.messages.length === 0) {
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
      return;
    }

    this.messages.forEach(msg => {
      const msgEl = this.createMessageElement(msg);
      this.messagesList.appendChild(msgEl);
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

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = `message-avatar avatar-color-${msg.studentNumber % 10}`;
    avatar.textContent = String(msg.studentNumber).padStart(2, '0');

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
      text.textContent = msg.message || (msg.imageUrl ? '이미지를 공유했습니다.' : '');
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

    // Actions (delete button for own messages)
    if (msg.studentNumber === this.studentNumber && !msg.deletedAt) {
      const actions = document.createElement('div');
      actions.className = 'message-actions';

      const replyBtn = document.createElement('button');
      replyBtn.className = 'btn-message-action';
      replyBtn.textContent = '답장';
      replyBtn.addEventListener('click', () => this.setReplyTo(msg));

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-message-action btn-delete';
      deleteBtn.textContent = '삭제';
      deleteBtn.addEventListener('click', () => this.deleteMessage(msg.id));

      actions.appendChild(replyBtn);
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

      actions.appendChild(replyBtn);
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

  formatTime(isoString) {
    try {
      if (!isoString) return '';
      const date = new Date(isoString);
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    } catch {
      return '';
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  const chatPage = new ChatPageManager();
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
      const result = await window.votingManager.submitVote();
      if (!result.success) {
        alert(result.error || '투표를 제출하지 못했어요.');
      }
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
