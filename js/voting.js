/**
 * voting.js - 투표 기능 관리
 * 투표 생성, 참여, 실시간 업데이트
 */

class VotingManager {
  constructor() {
    this.grade = null;
    this.section = null;
    this.myNumber = null;
    this.activeVote = null;
    this.pollingInterval = null;
    this.countdownInterval = null;
    this.bubble = null;
    this.questionEl = null;
    this.countdownEl = null;
    this.optionsEl = null;
    this.submitBtn = null;
    this.formSection = null;
    this.resultSection = null;
    this.resultList = null;
    this.resultSummary = null;
    this.messagesList = null;
    this.stateLabel = null;
    this.pendingSelection = new Set();
    this.currentVoteId = null;
  }

  init(grade, section, myNumber) {
    this.grade = grade;
    this.section = section;
    this.myNumber = myNumber;
    this.cacheElements();
    this.startPolling();
  }

  cacheElements() {
    if (!this.bubble) {
      this.bubble = document.getElementById('voteBubble');
      this.questionEl = document.getElementById('voteQuestion');
      this.countdownEl = document.getElementById('voteCountdown');
      this.optionsEl = document.getElementById('voteOptions');
      this.submitBtn = document.getElementById('voteSubmitBtn');
      this.formSection = document.getElementById('voteFormSection');
      this.resultSection = document.getElementById('voteResultSection');
      this.resultList = document.getElementById('voteResultList');
      this.resultSummary = document.getElementById('voteResultSummary');
      this.stateLabel = document.getElementById('voteStateLabel');
    }
    const list = document.getElementById('chatMessagesList');
    if (list) {
      this.messagesList = list;
    }
  }

  attachBubble(container) {
    this.cacheElements();
    if (!this.bubble || !container) return;
    if (this.bubble.parentElement !== container) {
      container.appendChild(this.bubble);
    }
  }

  startPolling() {
    if (this.pollingInterval) return;
    // 2초마다 활성 투표 확인
    this.checkActiveVote();
    this.pollingInterval = setInterval(() => {
      this.checkActiveVote();
    }, 2000);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  async checkActiveVote() {
    if (!this.grade || !this.section) return;

    try {
      const res = await fetch(`/api/classes/vote/active?grade=${this.grade}&section=${this.section}`);
      if (!res.ok) return;

      const data = await res.json();

      if (!data.active) {
        this.activeVote = null;
        if (data.lastResult) {
          this.showVoteResult(data.lastResult);
        } else {
          this.hideVote();
        }
        return;
      }

      this.activeVote = data;
      this.showVote(data);
    } catch (err) {
      console.error('checkActiveVote error:', err);
    }
  }

  showVote(voteData) {
    this.cacheElements();
    if (!this.bubble) return;
    if (!this.pendingSelection) {
      this.pendingSelection = new Set();
    }

    this.bubble.hidden = false;
    this.bubble.style.display = '';
    this.bubble.dataset.state = 'active';
    if (this.messagesList) {
      this.attachBubble(this.messagesList);
    }
    if (this.formSection) this.formSection.hidden = false;
    if (this.resultSection) this.resultSection.hidden = true;
    if (this.stateLabel) this.stateLabel.textContent = '투표 진행 중';
    if (this.questionEl) this.questionEl.textContent = voteData.question;
    if (this.countdownEl) this.countdownEl.textContent = '--:--';

    this.startCountdown(voteData.expiresAt);

    if (this.optionsEl) {
      const isSameVote = this.currentVoteId === voteData.voteId;
      if (!isSameVote) {
        this.pendingSelection = new Set(voteData.myVote || []);
        this.currentVoteId = voteData.voteId;
      }

      const preserved = new Set();
      if (this.optionsEl.children.length) {
        this.optionsEl.querySelectorAll('input:checked').forEach(input => preserved.add(input.value));
      }
      if (preserved.size) {
        this.pendingSelection = preserved;
      }

      this.optionsEl.innerHTML = '';
      voteData.options.forEach(option => {
        const optionEl = document.createElement('label');
        optionEl.className = 'vote-option';

        const input = document.createElement('input');
        input.type = voteData.maxChoices > 1 ? 'checkbox' : 'radio';
        input.name = 'vote-option';
        input.value = option;

        if (this.pendingSelection.has(option)) {
          input.checked = true;
        } else if (voteData.myVote && voteData.myVote.includes(option)) {
          input.checked = true;
        }

        input.addEventListener('change', () => {
          if (voteData.maxChoices > 1) {
            if (input.checked) {
              this.pendingSelection.add(option);
            } else {
              this.pendingSelection.delete(option);
            }
          } else {
    this.pendingSelection?.clear();
            if (input.checked) {
              this.pendingSelection.add(option);
            }
            // For radio, ensure others cleared visually
            this.optionsEl.querySelectorAll('input[type="radio"]').forEach(r => {
              if (r !== input) r.checked = false;
            });
          }
        });

        const span = document.createElement('span');
        span.textContent = option;

        optionEl.appendChild(input);
        optionEl.appendChild(span);
        this.optionsEl.appendChild(optionEl);
      });
    }

    this.showIndexVote(voteData);
  }

  showVoteResult(resultData) {
    this.cacheElements();
    if (!this.bubble || !resultData) {
      this.hideVote();
      return;
    }

    this.bubble.hidden = false;
    this.bubble.style.display = '';
    this.bubble.dataset.state = 'result';
    if (this.messagesList) {
      this.attachBubble(this.messagesList);
    }
    if (this.formSection) this.formSection.hidden = true;
    if (this.resultSection) this.resultSection.hidden = false;
    if (this.stateLabel) this.stateLabel.textContent = '투표 종료';
    if (this.questionEl) this.questionEl.textContent = resultData.question;
    if (this.countdownEl) this.countdownEl.textContent = '종료';
    this.currentVoteId = resultData.voteId ?? null;
    this.renderResultList(resultData);

    const overlay = document.getElementById('indexVoteOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  renderResultList(resultData) {
    if (!this.resultList) return;
    const counts = resultData.counts || {};
    const options = resultData.options || Object.keys(counts);
    const total = resultData.totalVotes ?? Object.values(counts).reduce((a, b) => a + b, 0);
    this.resultList.innerHTML = '';

    options.forEach(option => {
      const count = counts[option] || 0;
      const percent = total > 0 ? Math.round((count / total) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'vote-result-row';
      row.innerHTML = `
        <div class="vote-result-meta">
          <span>${option}</span>
          <span>${count}표 ・ ${percent}%</span>
        </div>
        <div class="vote-result-bar-wrap">
          <div class="vote-result-bar" style="width:${percent}%"></div>
        </div>
      `;
      this.resultList.appendChild(row);
    });

    if (this.resultSummary) {
      if (resultData.expiresAt) {
        const ended = new Date(resultData.expiresAt);
        const timeStr = Number.isNaN(ended.getTime())
          ? ''
          : ended.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
        this.resultSummary.textContent = timeStr
          ? `총 ${total}표 · ${timeStr} 마감`
          : `총 ${total}표 · 종료된 투표`;
      } else {
        this.resultSummary.textContent = `총 ${total}표 · 종료된 투표`;
      }
    }
  }

  showIndexVote(voteData) {
    // index.html의 투표 오버레이에 표시
    const overlay = document.getElementById('indexVoteOverlay');
    if (!overlay) return;

    overlay.style.display = 'flex';

    const question = document.getElementById('indexVoteQuestion');
    const results = document.getElementById('indexVoteResults');

    if (question) question.textContent = voteData.question;

    if (results) {
      results.innerHTML = '';

      voteData.options.forEach(option => {
        const count = voteData.counts[option] || 0;
        const total = Object.values(voteData.counts).reduce((a, b) => a + b, 0);
        const percentage = total > 0 ? Math.round((count / total) * 100) : 0;

        const resultEl = document.createElement('div');
        resultEl.className = 'index-vote-result';

        const labelEl = document.createElement('div');
        labelEl.className = 'index-vote-label';
        labelEl.textContent = option;

        const barContainer = document.createElement('div');
        barContainer.className = 'index-vote-bar-container';

        const bar = document.createElement('div');
        bar.className = 'index-vote-bar';
        bar.style.width = `${percentage}%`;

        const countEl = document.createElement('span');
        countEl.className = 'index-vote-count';
        countEl.textContent = `${count}표 (${percentage}%)`;

        barContainer.appendChild(bar);
        resultEl.appendChild(labelEl);
        resultEl.appendChild(barContainer);
        resultEl.appendChild(countEl);

        results.appendChild(resultEl);
      });
    }
  }

  hideVote() {
    this.cacheElements();
    if (this.bubble) {
      this.bubble.hidden = true;
      this.bubble.style.display = 'none';
      this.bubble.dataset.state = 'hidden';
    }
    this.pendingSelection?.clear();
    this.currentVoteId = null;

    const overlay = document.getElementById('indexVoteOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  startCountdown(expiresAt) {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }

    const updateCountdown = () => {
      const now = new Date().getTime();
      // 서버에서 naive UTC datetime을 보내므로, 'Z'를 추가하여 UTC로 파싱
      const expiryString = expiresAt.endsWith('Z') ? expiresAt : expiresAt + 'Z';
      const expiry = new Date(expiryString).getTime();
      const remaining = Math.max(0, expiry - now);

      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);

      const countdown = document.getElementById('voteCountdown');
      if (countdown) {
        countdown.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      }

      if (remaining <= 0) {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
        this.checkActiveVote();
      }
    };

    updateCountdown();
    this.countdownInterval = setInterval(updateCountdown, 1000);
  }

  async submitVote() {
    if (!this.activeVote) return { success: false, error: '활성 투표가 없습니다.' };

    const options = document.getElementById('voteOptions');
    if (!options) return { success: false, error: '투표 UI를 찾을 수 없습니다.' };

    const checked = Array.from(options.querySelectorAll('input:checked')).map(input => input.value);

    if (checked.length === 0) {
      return { success: false, error: '투표할 항목을 선택해주세요.' };
    }

    if (checked.length > this.activeVote.maxChoices) {
      return { success: false, error: `최대 ${this.activeVote.maxChoices}개까지 선택 가능합니다.` };
    }

    try {
      const res = await fetch(`/api/classes/vote/respond?grade=${this.grade}&section=${this.section}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voteId: this.activeVote.voteId,
          selected: checked
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'Failed to submit vote');
      }

      // 즉시 투표 현황 새로고침
      await this.checkActiveVote();
      this.pendingSelection?.clear();
      return { success: true };
    } catch (err) {
      console.error('submitVote error:', err);
      return { success: false, error: '투표를 제출하지 못했어요.' };
    }
  }

  async createVote(question, options, maxChoices) {
    if (!question || !question.trim()) {
      return { success: false, error: '질문을 입력해주세요.' };
    }

    if (!options || options.length < 2 || options.length > 10) {
      return { success: false, error: '옵션은 2~10개여야 합니다.' };
    }

    if (maxChoices < 1 || maxChoices > options.length) {
      return { success: false, error: '최대 선택 개수가 올바르지 않습니다.' };
    }

    try {
      const res = await fetch(`/api/classes/vote/create?grade=${this.grade}&section=${this.section}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          options: options,
          maxChoices: maxChoices
        })
      });

      if (!res.ok) {
        const data = await res.json();
        if (data.error === 'active vote already exists') {
          throw new Error('이미 진행 중인 투표가 있습니다.');
        }
        throw new Error(data.error || 'Failed to create vote');
      }

      // 즉시 투표 확인
      await this.checkActiveVote();
      return { success: true };
    } catch (err) {
      console.error('createVote error:', err);
      return { success: false, error: err.message || '투표를 생성하지 못했어요.' };
    }
  }
}

// 전역 인스턴스
window.votingManager = new VotingManager();
