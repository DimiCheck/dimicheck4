/**
 * reactions.js - 반응(이모티콘) 기능 관리
 * 반응 선택, 쿨다운, 전송
 */

class ReactionsManager {
  constructor() {
    this.grade = null;
    this.section = null;
    this.myNumber = null;
    this.cooldownEnd = 0;
    this.cooldownInterval = null;
    this.allowedEmojis = ["❤️", "😂", "😮", "😢", "🔥", "👍", "👏", "🎉", "🤩", "🥳", "😎", "💯", "❄️", "🎄", "🎅", "🧦"];
  }

  init(grade, section, myNumber) {
    this.grade = grade;
    this.section = section;
    this.myNumber = myNumber;
    this.renderEmojiPicker();
  }

  renderEmojiPicker() {
    const picker = document.getElementById('reactionPicker');
    if (!picker) return;

    picker.innerHTML = '';

    this.allowedEmojis.forEach(emoji => {
      const btn = document.createElement('button');
      btn.className = 'reaction-emoji-btn';
      btn.textContent = emoji;
      btn.type = 'button';
      btn.addEventListener('click', () => this.sendReaction(emoji));
      picker.appendChild(btn);
    });
  }

  async sendReaction(emoji) {
    if (!this.grade || !this.section) {
      return { success: false, error: '로그인 정보가 없습니다.' };
    }

    // 쿨다운 확인
    const now = Date.now();
    if (now < this.cooldownEnd) {
      const remaining = Math.ceil((this.cooldownEnd - now) / 1000);
      return { success: false, error: `${remaining}초 후에 다시 반응할 수 있어요.` };
    }

    try {
      const res = await fetch(`/api/classes/reaction?grade=${this.grade}&section=${this.section}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'Failed to send reaction');
      }

      const data = await res.json();

      // 쿨다운 시작 (5초)
      this.cooldownEnd = now + 5000;
      this.startCooldownDisplay();

      // 피드백 표시
      this.showFeedback(`${emoji} 반응을 보냈어요!`, 'success');

      // 자석 폭죽 이펙트
      if (typeof window.spawnReactionBurst === 'function' && this.myNumber) {
        window.spawnReactionBurst(this.myNumber, emoji);
      }

      // 팝업 자동 닫기
      setTimeout(() => {
        this.closePicker();
      }, 500);

      return { success: true };
    } catch (err) {
      console.error('sendReaction error:', err);
      this.showFeedback('반응을 보내지 못했어요.', 'error');
      return { success: false, error: '반응을 보내지 못했어요.' };
    }
  }

  startCooldownDisplay() {
    const cooldownEl = document.getElementById('reactionCooldown');
    if (!cooldownEl) return;

    if (this.cooldownInterval) {
      clearInterval(this.cooldownInterval);
    }

    const update = () => {
      const now = Date.now();
      const remaining = Math.max(0, this.cooldownEnd - now);

      if (remaining > 0) {
        const seconds = Math.ceil(remaining / 1000);
        cooldownEl.textContent = `${seconds}초 후 다시 사용 가능`;
        cooldownEl.style.display = 'block';
      } else {
        cooldownEl.textContent = '';
        cooldownEl.style.display = 'none';
        clearInterval(this.cooldownInterval);
        this.cooldownInterval = null;
      }
    };

    update();
    this.cooldownInterval = setInterval(update, 100);
  }

  showFeedback(message, type = 'info') {
    const feedback = document.getElementById('reactionFeedback');
    if (!feedback) return;

    feedback.textContent = message;
    feedback.className = 'reaction-feedback';
    if (type !== 'info') {
      feedback.classList.add(type);
    }

    setTimeout(() => {
      feedback.textContent = '';
      feedback.className = 'reaction-feedback';
    }, 3000);
  }

  openPicker() {
    const modal = document.getElementById('reactionModal');
    if (modal) {
      modal.hidden = false;
    }
  }

  closePicker() {
    const modal = document.getElementById('reactionModal');
    if (modal) {
      modal.hidden = true;
    }
  }
}

// 전역 인스턴스
window.reactionsManager = new ReactionsManager();
