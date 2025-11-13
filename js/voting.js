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
  }

  init(grade, section, myNumber) {
    this.grade = grade;
    this.section = section;
    this.myNumber = myNumber;
    this.startPolling();
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
        this.hideVote();
        return;
      }

      this.activeVote = data;
      this.showVote(data);
    } catch (err) {
      console.error('checkActiveVote error:', err);
    }
  }

  showVote(voteData) {
    // user.html에 투표 UI 표시
    const container = document.getElementById('voteContainer');
    if (!container) return;

    container.style.display = 'block';

    const question = document.getElementById('voteQuestion');
    const options = document.getElementById('voteOptions');
    const countdown = document.getElementById('voteCountdown');

    if (question) question.textContent = voteData.question;

    // 카운트다운
    this.startCountdown(voteData.expiresAt);

    // 옵션 렌더링
    if (options) {
      options.innerHTML = '';

      voteData.options.forEach(option => {
        const count = voteData.counts[option] || 0;

        const optionEl = document.createElement('div');
        optionEl.className = 'vote-option';

        const checkbox = document.createElement('input');
        checkbox.type = voteData.maxChoices > 1 ? 'checkbox' : 'radio';
        checkbox.name = 'vote-option';
        checkbox.value = option;
        checkbox.id = `vote-${option}`;

        // 이미 투표한 경우 체크
        if (voteData.myVote && voteData.myVote.includes(option)) {
          checkbox.checked = true;
        }

        const label = document.createElement('label');
        label.htmlFor = `vote-${option}`;
        label.textContent = option;

        const countSpan = document.createElement('span');
        countSpan.className = 'vote-count';
        countSpan.textContent = `${count}표`;

        optionEl.appendChild(checkbox);
        optionEl.appendChild(label);
        optionEl.appendChild(countSpan);

        options.appendChild(optionEl);
      });
    }

    // index.html에도 표시
    this.showIndexVote(voteData);
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
    const container = document.getElementById('voteContainer');
    if (container) {
      container.style.display = 'none';
    }

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
