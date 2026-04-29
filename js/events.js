class EventPageController {
  constructor() {
    this.state = null;
    this.busyEventId = null;
    this.couponBusy = false;
    this.toastTimer = null;
  }

  init() {
    this.walletCoins = document.getElementById('walletCoins');
    this.dailyClaimed = document.getElementById('dailyClaimed');
    this.dailyRemaining = document.getElementById('dailyRemaining');
    this.couponForm = document.getElementById('couponForm');
    this.couponCodeInput = document.getElementById('couponCodeInput');
    this.couponClaimBtn = document.getElementById('couponClaimBtn');
    this.eventList = document.getElementById('eventList');
    this.toast = document.getElementById('eventToast');
    this.couponForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.claimCoupon();
    });
    this.eventList?.addEventListener('submit', (event) => {
      const form = event.target.closest('form[data-event-id]');
      if (!form) return;
      event.preventDefault();
      this.claim(Number(form.dataset.eventId), form);
    });
    this.load();
  }

  async load() {
    try {
      const res = await fetch('/api/events/me', { credentials: 'include', cache: 'no-store' });
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      if (!res.ok) {
        throw new Error(`이벤트를 불러오지 못했습니다. (${res.status})`);
      }
      this.state = await res.json();
      this.render();
    } catch (error) {
      console.error('[Events] load failed', error);
      this.showToast(error.message || '이벤트를 불러오지 못했습니다.');
      this.renderEmpty('이벤트를 불러오지 못했습니다.');
    }
  }

  async claim(eventId, form) {
    if (this.busyEventId) return;
    const input = form.querySelector('[name="answer"]');
    const answer = String(input?.value || '').trim();
    if (!answer) {
      this.showToast('정답을 입력해주세요.');
      input?.focus();
      return;
    }
    this.busyEventId = eventId;
    this.render();
    try {
      const res = await fetch(`/api/events/${eventId}/claim`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer })
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(this.humanizeError(error.error, res.status));
      }
      const payload = await res.json();
      this.state.wallet = payload.wallet || this.state.wallet;
      this.state.dailyClaimed = payload.dailyClaimed ?? this.state.dailyClaimed;
      this.state.dailyRemaining = payload.dailyRemaining ?? this.state.dailyRemaining;
      this.state.events = (this.state.events || []).map((item) => (
        Number(item.id) === eventId ? { ...item, claimed: true } : item
      ));
      this.showToast(`${Number(payload.rewardCoins || 0).toLocaleString('ko-KR')}코인을 받았습니다.`);
    } catch (error) {
      this.showToast(error.message || '정답을 제출하지 못했습니다.');
    } finally {
      this.busyEventId = null;
      this.render();
    }
  }

  async claimCoupon() {
    if (this.couponBusy) return;
    const code = String(this.couponCodeInput?.value || '').trim();
    if (!code) {
      this.showToast('코드를 입력해주세요.');
      this.couponCodeInput?.focus();
      return;
    }
    this.couponBusy = true;
    this.renderCouponBusy();
    try {
      const res = await fetch('/api/events/coupon/claim', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(this.humanizeError(error.error, res.status));
      }
      const payload = await res.json();
      this.state.wallet = payload.wallet || this.state.wallet;
      if (this.couponCodeInput) this.couponCodeInput.value = '';
      this.showToast(`${payload.title || '코드 보상'} · ${Number(payload.rewardCoins || 0).toLocaleString('ko-KR')}코인을 받았습니다.`);
    } catch (error) {
      this.showToast(error.message || '코드를 등록하지 못했습니다.');
    } finally {
      this.couponBusy = false;
      this.render();
    }
  }

  humanizeError(error, status) {
    if (error === 'incorrect answer') return '아직 정답이 아닙니다.';
    if (error === 'already claimed') return '이미 보상을 받은 퀴즈입니다.';
    if (error === 'daily limit reached') return '오늘 받을 수 있는 퀴즈 보상을 모두 받았습니다.';
    if (error === 'event unavailable') return '참여할 수 없는 이벤트입니다.';
    if (error === 'coupon code required') return '코드를 입력해주세요.';
    if (error === 'invalid coupon') return '사용할 수 없는 코드입니다.';
    if (status === 403) return '권한이 없습니다.';
    return error || '요청을 처리하지 못했습니다.';
  }

  render() {
    if (!this.state) {
      this.renderEmpty('이벤트를 불러오는 중입니다.');
      return;
    }
    const wallet = this.state.wallet || {};
    const coins = Number(wallet.coins || 0);
    const limit = Number(this.state.dailyLimit || 3);
    const claimed = Number(this.state.dailyClaimed || 0);
    const remaining = Number(this.state.dailyRemaining || Math.max(0, limit - claimed));
    if (this.walletCoins) this.walletCoins.textContent = `${coins.toLocaleString('ko-KR')} 코인`;
    if (this.dailyClaimed) this.dailyClaimed.textContent = `${claimed}/${limit}`;
    if (this.dailyRemaining) this.dailyRemaining.textContent = `${remaining}`;
    this.renderCouponBusy();

    const events = this.state.events || [];
    if (!events.length) {
      this.renderEmpty('지금 참여할 수 있는 이벤트가 없습니다.');
      return;
    }
    this.eventList.innerHTML = events.map((item) => this.renderEvent(item, remaining)).join('');
  }

  renderCouponBusy() {
    if (this.couponCodeInput) this.couponCodeInput.disabled = this.couponBusy;
    if (this.couponClaimBtn) {
      this.couponClaimBtn.disabled = this.couponBusy;
      this.couponClaimBtn.textContent = this.couponBusy ? '등록 중...' : '코인 받기';
    }
  }

  renderEvent(item, remaining) {
    const id = Number(item.id);
    const claimed = Boolean(item.claimed);
    const busy = this.busyEventId === id;
    const disabled = claimed || busy || remaining <= 0;
    const buttonText = claimed ? '수령 완료' : remaining <= 0 ? '오늘 한도 도달' : busy ? '확인 중...' : '정답 제출';
    const hint = item.hint ? `<p class="hint">힌트: ${this.escapeHtml(item.hint)}</p>` : '';
    const desc = item.description ? `<p class="desc">${this.escapeHtml(item.description)}</p>` : '';
    const period = this.formatPeriod(item);
    return `
      <article class="event-card">
        <div class="event-top">
          <div>
            <h2 class="event-title">${this.escapeHtml(item.title)}</h2>
            ${period ? `<p class="meta">${this.escapeHtml(period)}</p>` : ''}
          </div>
          <span class="reward">+${Number(item.rewardCoins || 0).toLocaleString('ko-KR')} 코인</span>
        </div>
        ${desc}
        <p class="question">${this.escapeHtml(item.question)}</p>
        ${hint}
        <form class="answer-row" data-event-id="${id}">
          <input class="answer-input" name="answer" type="text" autocomplete="off" placeholder="${claimed ? '이미 수령했습니다' : '정답 입력'}" ${disabled ? 'disabled' : ''} />
          <button class="claim-btn" type="submit" ${disabled ? 'disabled' : ''}>${buttonText}</button>
        </form>
      </article>
    `;
  }

  formatPeriod(item) {
    const end = item.endsAt ? new Date(item.endsAt) : null;
    if (!end || Number.isNaN(end.getTime())) return '';
    return `${end.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}까지`;
  }

  renderEmpty(message) {
    if (!this.eventList) return;
    this.eventList.innerHTML = `<div class="empty-state">${this.escapeHtml(message)}</div>`;
  }

  showToast(message) {
    if (!this.toast) return;
    this.toast.textContent = message;
    this.toast.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.classList.remove('show');
    }, 2400);
  }

  escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new EventPageController().init();
});
