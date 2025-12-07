/**
 * voting.js - 투표 기능 관리
 * 투표 생성, 참여, 실시간 업데이트
 */

class VotingManager {
  constructor() {
    this.grade = null;
    this.section = null;
    this.myNumber = null;
    this.channel = 'home';
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
    this.stateLabel = null;
    this.pendingSelection = new Set();
    this.currentVoteId = null;
    this.lastResultCounts = null;
  }

  init(grade, section, myNumber, channel = 'home') {
    this.grade = grade;
    this.section = section;
    this.myNumber = myNumber;
    this.channel = channel || 'home';
    this.cacheElements();
    this.startPolling();
  }

  setChannel(channel) {
    const normalized = (channel || 'home').trim();
    if (this.channel === normalized) return;
    this.channel = normalized;
    this.activeVote = null;
    this.currentVoteId = null;
    this.lastResultCounts = null;
    this.notifyTimelineEvent(null);
    this.checkActiveVote();
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
      const res = await fetch(`/api/classes/vote/active?grade=${this.grade}&section=${this.section}&channel=${encodeURIComponent(this.channel || 'home')}`);
      if (!res.ok) return;

      const data = await res.json();

      if (data.channel && data.channel.toLowerCase() !== (this.channel || 'home').toLowerCase()) {
        this.hideVote();
        return;
      }

      if (!data.active) {
        this.activeVote = null;
        if (data.lastResult) {
          // 결과가 변경되었을 때만 렌더링
          if (this.hasResultChanged(data.lastResult)) {
            this.showVoteResult(data.lastResult);
          }
        } else {
          this.hideVote();
        }
        return;
      }

      // 활성 투표가 변경되었을 때만 렌더링
      if (this.hasVoteChanged(data)) {
        this.activeVote = data;
        this.showVote(data);
      } else {
        // 투표는 동일하지만 실시간 카운트만 업데이트
        this.activeVote = data;
        this.updateVoteCounts(data);
      }
    } catch (err) {
      console.error('checkActiveVote error:', err);
    }
  }

  hasVoteChanged(newVote) {
    if (!this.activeVote) return true;

    if ((this.activeVote.channel || '').toLowerCase() !== (newVote.channel || '').toLowerCase()) return true;

    // 투표 ID가 다르면 새로운 투표
    if (this.activeVote.voteId !== newVote.voteId) return true;

    // 질문이 변경되었는지 확인
    if (this.activeVote.question !== newVote.question) return true;

    // 옵션이 변경되었는지 확인
    if (JSON.stringify(this.activeVote.options) !== JSON.stringify(newVote.options)) return true;

    // 내 투표가 변경되었는지 확인
    if (JSON.stringify(this.activeVote.myVote) !== JSON.stringify(newVote.myVote)) return true;

    return false;
  }

  hasResultChanged(newResult) {
    if (!this.bubble || this.bubble.dataset.state !== 'result') return true;
    if (this.currentVoteId !== newResult.voteId) return true;

    // 카운트가 변경되었는지 확인
    const oldCounts = this.lastResultCounts || {};
    const newCounts = newResult.counts || {};

    if (JSON.stringify(oldCounts) !== JSON.stringify(newCounts)) {
      this.lastResultCounts = newCounts;
      return true;
    }

    return false;
  }

  updateVoteCounts(voteData) {
    // 투표 현황(counts)만 업데이트 - index.html 오버레이용
    if (voteData.counts) {
      this.showIndexVote(voteData);
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
    this.notifyTimelineEvent(this.buildTimelineEventPayload('active', voteData));
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
    if (this.formSection) this.formSection.hidden = true;
    if (this.resultSection) {
      this.resultSection.hidden = false;
      // 기본으로 접혀있게 설정
      if (!this.resultSection.dataset.initialized) {
        this.resultSection.dataset.initialized = 'true';
        this.resultSection.dataset.collapsed = 'true';
        this.resultList.style.display = 'none';
      }
    }
    if (this.stateLabel) this.stateLabel.textContent = '투표 종료';
    if (this.questionEl) {
      this.questionEl.textContent = resultData.question;
      // 클릭하면 접기/펼치기
      this.questionEl.style.cursor = 'pointer';
      this.questionEl.onclick = () => this.toggleResultCollapse();
    }

    // 종료 시간을 KST로 표시
    if (this.countdownEl && resultData.expiresAt) {
      const kstTime = this.formatKSTTime(resultData.expiresAt);
      this.countdownEl.textContent = kstTime;
    } else if (this.countdownEl) {
      this.countdownEl.textContent = '종료';
    }

    this.currentVoteId = resultData.voteId ?? null;
    this.renderResultList(resultData);

    const overlay = document.getElementById('indexVoteOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
    this.notifyTimelineEvent(this.buildTimelineEventPayload('result', resultData));
  }

  toggleResultCollapse() {
    if (!this.resultSection || !this.resultList) return;

    const isCollapsed = this.resultSection.dataset.collapsed === 'true';
    if (isCollapsed) {
      this.resultSection.dataset.collapsed = 'false';
      this.resultList.style.display = 'block';
    } else {
      this.resultSection.dataset.collapsed = 'true';
      this.resultList.style.display = 'none';
    }
  }

  formatKSTTime(isoString) {
    try {
      const date = new Date(isoString);
      const kstOptions = { timeZone: 'Asia/Seoul', hour12: false };
      const kstDateStr = date.toLocaleString('en-US', kstOptions);
      const kstDate = new Date(kstDateStr);

      const month = (kstDate.getMonth() + 1).toString().padStart(2, '0');
      const day = kstDate.getDate().toString().padStart(2, '0');
      const hours = kstDate.getHours().toString().padStart(2, '0');
      const minutes = kstDate.getMinutes().toString().padStart(2, '0');
      return `${month}/${day} ${hours}:${minutes} 종료`;
    } catch {
      return '종료';
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

  buildTimelineEventPayload(state, data) {
    if (!data) return null;
    return {
      state,
      expiresAt: data.expiresAt,
      timestamp: data.expiresAt || data.createdAt,
      channel: data.channel || this.channel,
      payload: data
    };
  }

  notifyTimelineEvent(eventData) {
    if (window.chatPage?.setVoteTimelineEvent) {
      window.chatPage.setVoteTimelineEvent(eventData);
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
    this.notifyTimelineEvent(null);
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

    // 버튼 비활성화 및 로딩 상태 표시
    const submitBtn = document.getElementById('voteSubmitBtn');
    const originalText = submitBtn?.textContent || '투표하기';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '투표 중...';
    }

    try {
      const res = await fetch(`/api/classes/vote/respond?grade=${this.grade}&section=${this.section}&channel=${encodeURIComponent(this.channel || 'home')}`, {
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

      // 성공 피드백 표시
      if (submitBtn) {
        submitBtn.textContent = '✓ 투표 완료!';
        submitBtn.style.background = '#38d67a';
      }
      this.showToast('투표가 완료되었습니다!');

      // 즉시 투표 현황 새로고침
      await this.checkActiveVote();
      this.pendingSelection?.clear();

      // 1초 후 버튼 원래대로 복구
      setTimeout(() => {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
          submitBtn.style.background = '';
        }
      }, 1000);

      return { success: true };
    } catch (err) {
      console.error('submitVote error:', err);

      // 에러 피드백 표시
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
      this.showToast('투표를 제출하지 못했습니다.');

      return { success: false, error: '투표를 제출하지 못했어요.' };
    }
  }

  showToast(message) {
    // chat-page의 토스트 사용
    if (window.chatPage?.showToast) {
      window.chatPage.showToast(message);
      return;
    }

    // 대체 토스트 표시
    const toast = document.getElementById('chatToast');
    if (toast) {
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 3000);
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
      const res = await fetch(`/api/classes/vote/create?grade=${this.grade}&section=${this.section}&channel=${encodeURIComponent(this.channel || 'home')}`, {
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
