/**
 * Media Manager - 이미지 업로드 및 반 이모티콘 관리
 */

class MediaManager {
  constructor() {
    this.pendingImageUrl = null;
    this.currentStudentNumber = null;
    this.classEmojis = [];

    // Media menu
    this.mediaBtn = document.getElementById('mediaBtn');
    this.mediaMenu = document.getElementById('mediaMenu');

    // Image upload modal
    this.imageUploadModal = document.getElementById('imageUploadModal');
    this.imageFileInput = document.getElementById('imageFileInput');
    this.imageFileSelectBtn = document.getElementById('imageFileSelectBtn');
    this.uploadPreviewContainer = document.getElementById('uploadPreviewContainer');
    this.uploadPreview = document.getElementById('uploadPreview');
    this.uploadFileName = document.getElementById('uploadFileName');
    this.uploadCancelBtn = document.getElementById('uploadCancelBtn');
    this.uploadConfirmBtn = document.getElementById('uploadConfirmBtn');
    this.uploadProgress = document.getElementById('uploadProgress');

    // Class emoji modal
    this.classEmojiModal = document.getElementById('classEmojiModal');
    this.classEmojiGrid = document.getElementById('classEmojiGrid');
    this.classEmojiCloseBtn = document.getElementById('classEmojiCloseBtn');
    this.classEmojiCloseBtnTop = document.getElementById('classEmojiCloseBtnTop');
    this.emojiUploadBtn = document.getElementById('emojiUploadBtn');

    // Emoji upload modal
    this.emojiUploadModal = document.getElementById('emojiUploadModal');
    this.emojiNameInput = document.getElementById('emojiNameInput');
    this.emojiFileInput = document.getElementById('emojiFileInput');
    this.emojiFileSelectBtn = document.getElementById('emojiFileSelectBtn');
    this.emojiUploadPreviewContainer = document.getElementById('emojiUploadPreviewContainer');
    this.emojiUploadPreview = document.getElementById('emojiUploadPreview');
    this.emojiUploadFileName = document.getElementById('emojiUploadFileName');
    this.emojiUploadCancelBtn = document.getElementById('emojiUploadCancelBtn');
    this.emojiUploadConfirmBtn = document.getElementById('emojiUploadConfirmBtn');
    this.emojiUploadProgress = document.getElementById('emojiUploadProgress');

    this.init();
  }

  init() {
    // Media menu toggle
    this.mediaBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMediaMenu();
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!this.mediaMenu?.contains(e.target) && !this.mediaBtn?.contains(e.target)) {
        this.closeMediaMenu();
      }
    });

    // Media menu items
    document.querySelectorAll('.media-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const action = e.currentTarget.dataset.action;
        this.handleMediaMenuAction(action);
        this.closeMediaMenu();
      });
    });

    // Image upload modal
    this.imageFileSelectBtn?.addEventListener('click', () => {
      this.imageFileInput?.click();
    });

    this.imageFileInput?.addEventListener('change', (e) => {
      this.handleImageFileSelect(e.target.files[0]);
    });

    this.uploadCancelBtn?.addEventListener('click', () => {
      this.closeImageUploadModal();
    });

    this.uploadConfirmBtn?.addEventListener('click', () => {
      this.uploadImage();
    });

    // Class emoji modal
    this.classEmojiCloseBtn?.addEventListener('click', () => {
      this.closeClassEmojiModal();
    });

    this.classEmojiCloseBtnTop?.addEventListener('click', () => {
      this.closeClassEmojiModal();
    });

    this.emojiUploadBtn?.addEventListener('click', () => {
      this.openEmojiUploadModal();
    });

    // Emoji upload modal
    this.emojiFileSelectBtn?.addEventListener('click', () => {
      this.emojiFileInput?.click();
    });

    this.emojiFileInput?.addEventListener('change', (e) => {
      this.handleEmojiFileSelect(e.target.files[0]);
    });

    this.emojiUploadCancelBtn?.addEventListener('click', () => {
      this.closeEmojiUploadModal();
    });

    this.emojiUploadConfirmBtn?.addEventListener('click', () => {
      this.uploadEmoji();
    });

    // Get current student number from session
    this.loadStudentNumber();
  }

  async loadStudentNumber() {
    try {
      const res = await fetch('/api/session');
      const data = await res.json();
      if (data.user?.number) {
        this.currentStudentNumber = data.user.number;
      }
    } catch (err) {
      console.error('Failed to load student number:', err);
    }
  }

  toggleMediaMenu() {
    const isHidden = this.mediaMenu?.hasAttribute('hidden');
    if (isHidden) {
      this.mediaMenu?.removeAttribute('hidden');
    } else {
      this.closeMediaMenu();
    }
  }

  closeMediaMenu() {
    this.mediaMenu?.setAttribute('hidden', '');
  }

  handleMediaMenuAction(action) {
    switch (action) {
      case 'image-url':
        // Trigger existing image URL modal (from chat-page.js)
        if (window.chatPage) {
          window.chatPage.openImageUrlModal();
        }
        break;
      case 'gif':
        // Trigger existing GIF picker (from gif-picker.js)
        if (window.gifPickerManager) {
          window.gifPickerManager.open();
        }
        break;
      case 'image-upload':
        this.openImageUploadModal();
        break;
      case 'class-emoji':
        this.openClassEmojiModal();
        break;
    }
  }

  // ============================================================================
  // Image Upload
  // ============================================================================

  openImageUploadModal() {
    this.imageUploadModal?.removeAttribute('hidden');
    this.resetImageUploadForm();
  }

  closeImageUploadModal() {
    this.imageUploadModal?.setAttribute('hidden', '');
    this.resetImageUploadForm();
  }

  resetImageUploadForm() {
    if (this.imageFileInput) this.imageFileInput.value = '';
    this.uploadPreviewContainer?.setAttribute('style', 'display:none');
    if (this.uploadPreview) this.uploadPreview.src = '';
    if (this.uploadFileName) this.uploadFileName.textContent = '';
    if (this.uploadConfirmBtn) this.uploadConfirmBtn.disabled = true;
    if (this.uploadProgress) this.uploadProgress.textContent = '';
  }

  handleImageFileSelect(file) {
    if (!file) return;

    // Validate file type
    if (!file.type.match(/^image\/(png|jpeg|gif)$/)) {
      alert('PNG, JPEG, GIF 형식만 가능합니다');
      return;
    }

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
      if (this.uploadPreview) this.uploadPreview.src = e.target.result;
      this.uploadPreviewContainer?.setAttribute('style', 'display:block');
      if (this.uploadFileName) this.uploadFileName.textContent = file.name;
      if (this.uploadConfirmBtn) this.uploadConfirmBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  }

  async uploadImage() {
    const file = this.imageFileInput?.files[0];
    if (!file) return;

    if (this.uploadConfirmBtn) this.uploadConfirmBtn.disabled = true;
    if (this.uploadProgress) this.uploadProgress.textContent = '업로드 중...';

    try {
      // Upload directly to image server
      const formData = new FormData();
      formData.append('image', file);

      const res = await fetch('https://img.codz.me/upload', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        throw new Error('업로드 실패');
      }

      const data = await res.json();
      this.pendingImageUrl = data.url;

      if (this.uploadProgress) this.uploadProgress.textContent = '업로드 완료!';

      // Close modal after short delay
      setTimeout(() => {
        this.closeImageUploadModal();
        // Focus on chat input
        document.getElementById('chatInput')?.focus();
      }, 500);

    } catch (err) {
      console.error('Image upload error:', err);
      if (this.uploadProgress) this.uploadProgress.textContent = `오류: ${err.message}`;
      if (this.uploadConfirmBtn) this.uploadConfirmBtn.disabled = false;
    }
  }

  getPendingImageUrl() {
    const url = this.pendingImageUrl;
    this.pendingImageUrl = null;
    return url;
  }

  hasPendingImage() {
    return this.pendingImageUrl !== null;
  }

  // ============================================================================
  // Class Emoji Picker
  // ============================================================================

  async openClassEmojiModal() {
    this.classEmojiModal?.removeAttribute('hidden');
    await this.loadClassEmojis();
  }

  closeClassEmojiModal() {
    this.classEmojiModal?.setAttribute('hidden', '');
  }

  async loadClassEmojis() {
    try {
      const res = await fetch('/api/classes/chat/emojis');
      if (!res.ok) throw new Error('Failed to load emojis');

      const data = await res.json();
      this.classEmojis = data.emojis || [];
      this.renderClassEmojis();
    } catch (err) {
      console.error('Failed to load class emojis:', err);
      this.renderEmptyState();
    }
  }

  renderClassEmojis() {
    if (!this.classEmojiGrid) return;

    if (this.classEmojis.length === 0) {
      this.renderEmptyState();
      return;
    }

    this.classEmojiGrid.innerHTML = this.classEmojis.map(emoji => {
      const canDelete = this.currentStudentNumber === emoji.uploadedBy;
      return `
        <div class="emoji-item" data-emoji-id="${emoji.id}" data-emoji-url="${emoji.imageUrl}">
          <img src="${emoji.imageUrl}" alt="${emoji.name}" loading="lazy" />
          <div class="emoji-item-name">${emoji.name}</div>
          ${canDelete ? '<button class="emoji-item-delete" data-emoji-id="' + emoji.id + '">×</button>' : ''}
        </div>
      `;
    }).join('');

    // Add click handlers
    this.classEmojiGrid.querySelectorAll('.emoji-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // Don't trigger if clicking delete button
        if (e.target.classList.contains('emoji-item-delete')) return;

        const emojiUrl = item.dataset.emojiUrl;
        this.selectClassEmoji(emojiUrl);
      });
    });

    // Add delete handlers
    this.classEmojiGrid.querySelectorAll('.emoji-item-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const emojiId = btn.dataset.emojiId;
        if (confirm('이 이모티콘을 삭제하시겠습니까?')) {
          await this.deleteEmoji(emojiId);
        }
      });
    });
  }

  renderEmptyState() {
    if (!this.classEmojiGrid) return;
    this.classEmojiGrid.innerHTML = `
      <div class="emoji-empty-state">
        <div class="empty-icon">😔</div>
        <p>아직 반 이모티콘이 없습니다</p>
        <p style="font-size:14px;margin-top:8px">+ 업로드 버튼을 눌러 이모티콘을 추가해보세요!</p>
      </div>
    `;
  }

  selectClassEmoji(emojiUrl) {
    this.pendingImageUrl = emojiUrl;
    this.closeClassEmojiModal();
    // Focus on chat input
    document.getElementById('chatInput')?.focus();
  }

  async deleteEmoji(emojiId) {
    try {
      const res = await fetch(`/api/classes/chat/emojis/${emojiId}`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || '삭제 실패');
      }

      // Reload emojis
      await this.loadClassEmojis();
    } catch (err) {
      console.error('Failed to delete emoji:', err);
      alert(`삭제 실패: ${err.message}`);
    }
  }

  // ============================================================================
  // Emoji Upload
  // ============================================================================

  openEmojiUploadModal() {
    this.emojiUploadModal?.removeAttribute('hidden');
    this.resetEmojiUploadForm();
  }

  closeEmojiUploadModal() {
    this.emojiUploadModal?.setAttribute('hidden', '');
    this.resetEmojiUploadForm();
  }

  resetEmojiUploadForm() {
    if (this.emojiNameInput) this.emojiNameInput.value = '';
    if (this.emojiFileInput) this.emojiFileInput.value = '';
    this.emojiUploadPreviewContainer?.setAttribute('style', 'display:none');
    if (this.emojiUploadPreview) this.emojiUploadPreview.src = '';
    if (this.emojiUploadFileName) this.emojiUploadFileName.textContent = '';
    if (this.emojiUploadConfirmBtn) this.emojiUploadConfirmBtn.disabled = true;
    if (this.emojiUploadProgress) this.emojiUploadProgress.textContent = '';
  }

  handleEmojiFileSelect(file) {
    if (!file) return;

    // Validate file type
    if (!file.type.match(/^image\/(png|jpeg|gif)$/)) {
      alert('PNG, JPEG, GIF 형식만 가능합니다');
      return;
    }

    // Auto-fill name from filename if empty
    if (this.emojiNameInput && !this.emojiNameInput.value) {
      const name = file.name.replace(/\.[^/.]+$/, ''); // Remove extension
      this.emojiNameInput.value = name;
    }

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
      if (this.emojiUploadPreview) this.emojiUploadPreview.src = e.target.result;
      this.emojiUploadPreviewContainer?.setAttribute('style', 'display:block');
      if (this.emojiUploadFileName) this.emojiUploadFileName.textContent = file.name;
      if (this.emojiUploadConfirmBtn) this.emojiUploadConfirmBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  }

  async uploadEmoji() {
    const file = this.emojiFileInput?.files[0];
    const name = this.emojiNameInput?.value?.trim();

    if (!file) {
      alert('파일을 선택해주세요');
      return;
    }

    if (!name) {
      alert('이모티콘 이름을 입력해주세요');
      return;
    }

    if (this.emojiUploadConfirmBtn) this.emojiUploadConfirmBtn.disabled = true;
    if (this.emojiUploadProgress) this.emojiUploadProgress.textContent = '이미지 업로드 중...';

    try {
      // Step 1: Upload image to image server
      const imageFormData = new FormData();
      imageFormData.append('image', file);

      const uploadRes = await fetch('https://img.codz.me/upload', {
        method: 'POST',
        body: imageFormData
      });

      if (!uploadRes.ok) {
        throw new Error('이미지 업로드 실패');
      }

      const uploadData = await uploadRes.json();
      const imageUrl = uploadData.url;

      if (this.emojiUploadProgress) this.emojiUploadProgress.textContent = '이모티콘 등록 중...';

      // Step 2: Register emoji with backend
      const res = await fetch('/api/classes/chat/emojis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          imageUrl: imageUrl
        })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || '이모티콘 등록 실패');
      }

      if (this.emojiUploadProgress) this.emojiUploadProgress.textContent = '업로드 완료!';

      // Close modal and refresh emoji list
      setTimeout(async () => {
        this.closeEmojiUploadModal();
        await this.loadClassEmojis();
      }, 500);

    } catch (err) {
      console.error('Emoji upload error:', err);
      if (this.emojiUploadProgress) this.emojiUploadProgress.textContent = `오류: ${err.message}`;
      if (this.emojiUploadConfirmBtn) this.emojiUploadConfirmBtn.disabled = false;
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.mediaManager = new MediaManager();
  });
} else {
  window.mediaManager = new MediaManager();
}
