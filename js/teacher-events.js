class TeacherEventsController {
  constructor() {
    this.events = [];
    this.busy = false;
    this.toastTimer = null;
  }

  init() {
    this.form = document.getElementById('eventForm');
    this.titleInput = document.getElementById('eventTitle');
    this.rewardInput = document.getElementById('eventReward');
    this.questionInput = document.getElementById('eventQuestion');
    this.hintInput = document.getElementById('eventHint');
    this.descriptionInput = document.getElementById('eventDescription');
    this.answerInput = document.getElementById('eventAnswer');
    this.aliasesInput = document.getElementById('eventAliases');
    this.startsAtInput = document.getElementById('eventStartsAt');
    this.endsAtInput = document.getElementById('eventEndsAt');
    this.targetAllInput = document.getElementById('targetAll');
    this.targetGradeInput = document.getElementById('targetGrade');
    this.targetSectionInput = document.getElementById('targetSection');
    this.submitBtn = document.getElementById('eventSubmitBtn');
    this.helper = document.getElementById('eventHelper');
    this.eventList = document.getElementById('eventList');
    this.refreshBtn = document.getElementById('refreshBtn');
    this.toast = document.getElementById('teacherEventToast');

    this.form?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.createEvent();
    });
    this.targetAllInput?.addEventListener('change', () => this.syncTargetControls());
    this.refreshBtn?.addEventListener('click', () => this.load());
    this.eventList?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action][data-event-id]');
      if (!button || this.busy) return;
      if (button.dataset.action === 'toggle') {
        this.toggleEvent(Number(button.dataset.eventId), button.dataset.active !== 'true');
      }
    });

    this.syncTargetControls();
    this.load();
  }

  syncTargetControls() {
    const disabled = Boolean(this.targetAllInput?.checked);
    if (this.targetGradeInput) this.targetGradeInput.disabled = disabled;
    if (this.targetSectionInput) this.targetSectionInput.disabled = disabled;
  }

  buildPayload() {
    const targetAll = Boolean(this.targetAllInput?.checked);
    return {
      title: this.titleInput?.value.trim(),
      description: this.descriptionInput?.value.trim(),
      question: this.questionInput?.value.trim(),
      hint: this.hintInput?.value.trim(),
      answer: this.answerInput?.value.trim(),
      answerAliases: String(this.aliasesInput?.value || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      rewardCoins: Number(this.rewardInput?.value || 0),
      targetAll,
      targetGrade: targetAll ? null : Number(this.targetGradeInput?.value || 0),
      targetSection: targetAll ? null : Number(this.targetSectionInput?.value || 0),
      startsAt: this.startsAtInput?.value || null,
      endsAt: this.endsAtInput?.value || null,
      active: true
    };
  }

  async createEvent() {
    if (this.busy) return;
    const payload = this.buildPayload();
    if (!payload.title || !payload.question || !payload.answer) {
      this.setHelper('제목, 문제, 정답을 입력해주세요.');
      return;
    }
    if (payload.rewardCoins < 10 || payload.rewardCoins > 50) {
      this.setHelper('보상은 10~50코인만 가능합니다.');
      return;
    }

    this.setBusy(true);
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(this.humanizeError(error.error, res.status));
      }
      this.form?.reset();
      if (this.rewardInput) this.rewardInput.value = '20';
      if (this.targetAllInput) this.targetAllInput.checked = true;
      this.syncTargetControls();
      this.showToast('이벤트를 만들었습니다.');
      await this.load();
    } catch (error) {
      this.showToast(error.message || '이벤트를 만들지 못했습니다.');
    } finally {
      this.setBusy(false);
    }
  }

  async load() {
    try {
      const res = await fetch('/api/events/teacher', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(this.humanizeError(error.error, res.status));
      }
      const payload = await res.json();
      this.events = payload.events || [];
      this.render();
    } catch (error) {
      this.showToast(error.message || '이벤트를 불러오지 못했습니다.');
      this.renderEmpty('이벤트를 불러오지 못했습니다.');
    }
  }

  async toggleEvent(eventId, nextActive) {
    this.setBusy(true);
    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: nextActive })
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(this.humanizeError(error.error, res.status));
      }
      const payload = await res.json();
      this.events = this.events.map((item) => (Number(item.id) === eventId ? payload.event : item));
      this.showToast(nextActive ? '이벤트를 다시 열었습니다.' : '이벤트를 비활성화했습니다.');
      this.render();
    } catch (error) {
      this.showToast(error.message || '이벤트 상태를 바꾸지 못했습니다.');
    } finally {
      this.setBusy(false);
    }
  }

  render() {
    if (!this.eventList) return;
    if (!this.events.length) {
      this.renderEmpty('아직 만든 이벤트가 없습니다.');
      return;
    }
    this.eventList.innerHTML = this.events.map((item) => this.renderEvent(item)).join('');
  }

  renderEvent(item) {
    const active = Boolean(item.active);
    const target = item.targetAll ? '전체 반' : `${item.targetGrade}학년 ${item.targetSection}반`;
    const period = this.formatPeriod(item);
    return `
      <article class="event-card ${active ? '' : 'inactive'}">
        <div class="event-title-row">
          <div>
            <h3>${this.escapeHtml(item.title)}</h3>
            <p class="muted">${this.escapeHtml(item.question)}</p>
          </div>
          <span class="badge">+${Number(item.rewardCoins || 0).toLocaleString('ko-KR')} 코인</span>
        </div>
        <div class="event-meta">
          <span class="helper">${this.escapeHtml(target)}</span>
          <span class="helper">수령 ${Number(item.claimCount || 0).toLocaleString('ko-KR')}명</span>
          <span class="helper">${active ? '활성' : '비활성'}</span>
          ${period ? `<span class="helper">${this.escapeHtml(period)}</span>` : ''}
        </div>
        ${item.hint ? `<p class="helper">힌트: ${this.escapeHtml(item.hint)}</p>` : ''}
        <div class="actions">
          <button class="ghost-btn" type="button" data-action="toggle" data-event-id="${Number(item.id)}" data-active="${active}" ${this.busy ? 'disabled' : ''}>
            ${active ? '비활성화' : '다시 열기'}
          </button>
        </div>
      </article>
    `;
  }

  formatPeriod(item) {
    const start = item.startsAt ? new Date(item.startsAt) : null;
    const end = item.endsAt ? new Date(item.endsAt) : null;
    const format = (value) => value.toLocaleString('ko-KR', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    if (start && !Number.isNaN(start.getTime()) && end && !Number.isNaN(end.getTime())) {
      return `${format(start)}부터 ${format(end)}까지`;
    }
    if (end && !Number.isNaN(end.getTime())) return `${format(end)}까지`;
    if (start && !Number.isNaN(start.getTime())) return `${format(start)}부터`;
    return '';
  }

  renderEmpty(message) {
    if (!this.eventList) return;
    this.eventList.innerHTML = `<div class="empty">${this.escapeHtml(message)}</div>`;
  }

  setBusy(nextBusy) {
    this.busy = nextBusy;
    if (this.submitBtn) this.submitBtn.disabled = nextBusy;
    this.render();
  }

  setHelper(message) {
    if (this.helper) this.helper.textContent = message;
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

  humanizeError(error, status) {
    if (error === 'reward must be between 10 and 50') return '보상은 10~50코인만 가능합니다.';
    if (error === 'answer required') return '정답을 입력해주세요.';
    if (error === 'target class required') return '대상 반을 선택해주세요.';
    if (status === 403) return '선생님 권한이 필요합니다.';
    return error || '요청을 처리하지 못했습니다.';
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
  new TeacherEventsController().init();
});
