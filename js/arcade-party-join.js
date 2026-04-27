(function () {
  var root = document.querySelector('.shell');
  if (!root) return;

  var code = String(root.getAttribute('data-code') || '').toUpperCase();
  var enabled = root.getAttribute('data-enabled') === '1';
  var playerId = getOrCreatePlayerId();
  var socket = null;
  var player = null;
  var sessionState = null;
  var serverOffsetMs = 0;
  var renderedRoundKey = '';
  var submittedRoundId = '';
  var answerBuffer = [];
  var liveActionButton = null;
  var liveActionRound = null;
  var autoSubmitTimer = 0;
  var targetGrid = null;
  var targetStats = null;

  var els = {
    entryPanel: document.getElementById('entryPanel'),
    joinForm: document.getElementById('joinForm'),
    nicknameInput: document.getElementById('nicknameInput'),
    joinButton: document.getElementById('joinButton'),
    gamePanel: document.getElementById('gamePanel'),
    statusText: document.getElementById('statusText'),
    roundName: document.getElementById('roundName'),
    instruction: document.getElementById('instruction'),
    myScore: document.getElementById('myScore'),
    remainingTime: document.getElementById('remainingTime'),
    controls: document.getElementById('controls'),
    errorBox: document.getElementById('errorBox'),
    entryErrorBox: document.getElementById('entryErrorBox')
  };

  restoreNickname();

  var colorStyles = {
    '빨강': { background: '#ff5a6f', color: '#fff' },
    '파랑': { background: '#2f8cff', color: '#fff' },
    '노랑': { background: '#ffd84d', color: '#2a2400' },
    '초록': { background: '#45c96f', color: '#072414' },
    '보라': { background: '#9b72ff', color: '#fff' }
  };

  function showError(message, entry) {
    var box = entry ? els.entryErrorBox : els.errorBox;
    box.textContent = message || '';
    box.hidden = !message;
  }

  function getOrCreatePlayerId() {
    var key = 'dimicheck:party-player-id:' + code;
    try {
      var existing = sessionStorage.getItem(key);
      if (existing) return existing;
      var generated = 'pp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(key, generated);
      return generated;
    } catch (error) {
      console.warn('[Party] failed to persist player id', error);
      return 'pp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
  }

  function restoreNickname() {
    try {
      var saved = localStorage.getItem('dimicheck:arcade-nickname');
      if (saved) els.nicknameInput.value = saved;
    } catch (error) {
      console.warn('[Party] failed to restore nickname', error);
    }
  }

  function saveNickname(value) {
    try {
      localStorage.setItem('dimicheck:arcade-nickname', value);
    } catch (error) {
      console.warn('[Party] failed to save nickname', error);
    }
  }

  function avatarId() {
    var total = 12;
    var hash = 0;
    for (var i = 0; i < playerId.length; i += 1) {
      hash = ((hash << 5) - hash + playerId.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % total;
  }

  function connectAndJoin(nickname) {
    if (!enabled) {
      showError('현재 Arcade가 비활성화되어 있습니다.', true);
      return;
    }
    if (!window.io) {
      showError('Socket.IO를 불러오지 못했습니다. 네트워크를 확인해 주세요.', true);
      return;
    }
    els.joinButton.disabled = true;
    showError('', true);
    socket = window.io('/ws/arcade', {
      transports: ['websocket', 'polling'],
      query: { code: code, playerId: playerId }
    });
    socket.on('connect', function () {
      socket.emit('party_join_player', {
        code: code,
        playerId: playerId,
        nickname: nickname,
        avatar: avatarId()
      });
    });
    socket.on('party:joined', function (payload) {
      player = payload.player;
      sessionState = payload.session;
      saveNickname(nickname);
      els.entryPanel.classList.add('hidden');
      els.gamePanel.classList.add('active');
      renderState(sessionState);
    });
    socket.on('party:state', renderState);
    socket.on('party:ended', renderState);
    socket.on('party:submitted', function (payload) {
      if (payload && payload.session) {
        renderState(payload.session);
      }
      lockControls('제출 완료');
    });
    socket.on('party:error', function (payload) {
      els.joinButton.disabled = false;
      showError(payload && payload.message ? payload.message : '입장할 수 없습니다.', !player);
    });
    socket.on('disconnect', function () {
      if (sessionState && sessionState.status !== 'ended') {
        els.statusText.textContent = '다시 연결하는 중';
      }
    });
  }

  function currentServerNow() {
    return Date.now() + serverOffsetMs;
  }

  function formatSeconds(seconds) {
    if (!isFinite(seconds)) return '--';
    var safe = Math.max(0, Math.ceil(seconds));
    var min = Math.floor(safe / 60);
    var sec = safe % 60;
    return min + ':' + (sec < 10 ? '0' + sec : String(sec));
  }

  function statusLabel(state) {
    if (!state) return '연결 중';
    if (state.status === 'lobby') return '다음 라운드 대기';
    if (state.status === 'countdown') return '곧 시작';
    if (state.status === 'round_intro') return '설명을 확인하세요';
    if (state.status === 'playing') return '지금 입력하세요';
    if (state.status === 'round_result') return '결과 확인';
    if (state.status === 'ended') return 'Party 종료';
    return 'Party';
  }

  function findMe(state) {
    for (var i = 0; i < (state.players || []).length; i += 1) {
      if (state.players[i].id === playerId) {
        return state.players[i];
      }
    }
    return null;
  }

  function renderState(state) {
    if (!state) return;
    sessionState = state;
    serverOffsetMs = state.now - Date.now();
    var freshPlayer = findMe(state);
    if (freshPlayer) player = freshPlayer;
    if (player) {
      els.myScore.textContent = player.score || 0;
    }
    els.statusText.textContent = statusLabel(state);
    renderRound(state);
    updateClock();
  }

  function renderRound(state) {
    var round = state.currentRound;
    if (!round) {
      renderedRoundKey = '';
      submittedRoundId = '';
      answerBuffer = [];
      liveActionButton = null;
      liveActionRound = null;
      els.roundName.textContent = state.status === 'ended' ? '최종 결과' : '대기 중';
      els.instruction.textContent = state.status === 'ended' ? '전자칠판에서 순위를 확인하세요.' : '시작하면 자동으로 문제가 표시됩니다.';
      renderWaitingControls(state);
      return;
    }
    var key = round.id + ':' + state.status;
    els.roundName.textContent = round.title;
    els.instruction.textContent = round.instruction;
    if (key !== renderedRoundKey) {
      renderedRoundKey = key;
      answerBuffer = [];
      clearAutoSubmitTimer();
      if (state.status === 'playing' && round.participants.indexOf(playerId) !== -1 && submittedRoundId !== round.id) {
        renderInputControls(round);
      } else if (state.status === 'round_result') {
        renderResultControls(round);
      } else {
        renderWaitingControls(state);
      }
    }
  }

  function renderWaitingControls(state) {
    liveActionButton = null;
    liveActionRound = null;
    targetGrid = null;
    targetStats = null;
    clearAutoSubmitTimer();
    var text = '다음 라운드를 기다려 주세요.';
    if (state.status === 'countdown') text = '곧 라운드가 시작됩니다.';
    if (state.status === 'round_intro') text = '설명을 보고 준비하세요.';
    if (state.status === 'ended') text = '게임이 종료되었습니다.';
    els.controls.innerHTML = '<p class="muted">' + escapeHtml(text) + '</p>';
  }

  function renderResultControls(round) {
    liveActionButton = null;
    liveActionRound = null;
    targetGrid = null;
    targetStats = null;
    clearAutoSubmitTimer();
    var myResult = null;
    for (var i = 0; i < (round.results || []).length; i += 1) {
      if (round.results[i].playerId === playerId) {
        myResult = round.results[i];
        break;
      }
    }
    if (!myResult) {
      els.controls.innerHTML = '<p class="muted">이번 라운드는 관전했습니다. 다음 라운드부터 참여합니다.</p>';
      return;
    }
    els.controls.innerHTML = '<div class="status-card"><p class="muted">이번 라운드</p><div class="round-name">+' + myResult.score + '점</div><p class="muted">' + escapeHtml(myResult.note || '') + '</p></div>';
  }

  function renderInputControls(round) {
    liveActionButton = null;
    liveActionRound = null;
    targetGrid = null;
    targetStats = null;
    if (round.engine === 'reaction') {
      renderBigSubmit(round, round.prompt && round.prompt.late ? '마지막에 누르기' : '신호 보고 누르기', 'tap');
      return;
    }
    if (round.engine === 'timing') {
      renderTimingSubmit(round);
      return;
    }
    if (round.engine === 'mash') {
      renderMashControls(round);
      return;
    }
    if (round.engine === 'target') {
      renderTargetControls(round);
      return;
    }
    if (round.engine === 'memory') {
      renderMemoryControls(round);
      return;
    }
    if (round.engine === 'choice' || round.engine === 'majority' || round.engine === 'luck' || round.engine === 'risk') {
      renderChoiceControls(round);
      return;
    }
    renderBigSubmit(round, '제출', 'tap');
  }

  function renderBigSubmit(round, label, value) {
    els.controls.innerHTML = '';
    var button = document.createElement('button');
    button.className = 'big-button';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', function () {
      submitRound(round, value);
    });
    els.controls.appendChild(button);
    liveActionButton = button;
    liveActionRound = round;
    updateLiveControls();
  }

  function renderTimingSubmit(round) {
    els.controls.innerHTML = '';
    var button = document.createElement('button');
    button.className = 'big-button';
    button.type = 'button';
    button.textContent = round.prompt && round.prompt.hold ? '누르고 있다가 떼기' : '멈추기';
    var holdStartedAt = 0;
    button.addEventListener('pointerdown', function () {
      holdStartedAt = currentServerNow();
      if (round.prompt && round.prompt.hold) {
        button.textContent = '지금 떼기';
      }
    });
    button.addEventListener('pointerup', function () {
      var elapsed = Math.max(0, Math.round(currentServerNow() - round.startsAt));
      if (round.prompt && round.prompt.hold && holdStartedAt) {
        elapsed = Math.max(0, Math.round(currentServerNow() - holdStartedAt));
      }
      submitRound(round, elapsed);
    });
    button.addEventListener('click', function () {
      if (round.prompt && round.prompt.hold) return;
      submitRound(round, Math.max(0, Math.round(currentServerNow() - round.startsAt)));
    });
    els.controls.appendChild(button);
    liveActionButton = button;
    liveActionRound = round;
    updateLiveControls();
  }

  function renderMashControls(round) {
    els.controls.innerHTML = '';
    var count = 0;
    var counter = document.createElement('div');
    counter.className = 'sequence-answer';
    counter.textContent = '0회';
    var button = document.createElement('button');
    button.className = 'big-button ready';
    button.type = 'button';
    button.textContent = (round.prompt && round.prompt.label ? round.prompt.label : '연타') + '!';
    button.addEventListener('click', function () {
      count += 1;
      counter.textContent = count + '회';
      button.style.transform = 'translateY(5px) scale(0.98)';
      window.setTimeout(function () {
        button.style.transform = '';
      }, 60);
    });
    els.controls.appendChild(counter);
    els.controls.appendChild(button);
    autoSubmitAtRoundEnd(round, function () {
      submitRound(round, count);
    });
  }

  function renderTargetControls(round) {
    els.controls.innerHTML = '';
    targetStats = { hits: 0, misses: 0 };
    var score = document.createElement('div');
    score.className = 'sequence-answer';
    score.textContent = '성공 0 · 실수 0';
    var grid = document.createElement('div');
    grid.className = 'choice-grid target-grid';
    var cells = Math.max(4, Math.min(Number(round.prompt && round.prompt.cells) || 9, 16));
    for (var i = 0; i < cells; i += 1) {
      var button = document.createElement('button');
      button.type = 'button';
      button.dataset.cell = String(i);
      button.textContent = '';
      button.addEventListener('click', function (event) {
        var activeCell = currentTargetCell(round);
        var cell = Number(event.currentTarget.dataset.cell || -1);
        if (cell === activeCell) {
          targetStats.hits += 1;
        } else {
          targetStats.misses += 1;
        }
        score.textContent = '성공 ' + targetStats.hits + ' · 실수 ' + targetStats.misses;
      });
      grid.appendChild(button);
    }
    targetGrid = grid;
    els.controls.appendChild(score);
    els.controls.appendChild(grid);
    liveActionRound = round;
    updateLiveControls();
    autoSubmitAtRoundEnd(round, function () {
      submitRound(round, { hits: targetStats.hits, misses: targetStats.misses });
    });
  }

  function renderMemoryControls(round) {
    els.controls.innerHTML = '';
    var answer = document.createElement('div');
    answer.className = 'sequence-answer';
    answer.textContent = '입력: ';
    var grid = document.createElement('div');
    grid.className = 'choice-grid';
    var options = unique(round.prompt.sequence || []);
    options.forEach(function (option) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = option;
      applyTokenStyle(button, option);
      button.addEventListener('click', function () {
        answerBuffer.push(option);
        answer.textContent = '입력: ' + answerBuffer.join(' ');
        if (answerBuffer.length >= (round.prompt.sequence || []).length) {
          submitRound(round, answerBuffer.slice());
        }
      });
      grid.appendChild(button);
    });
    els.controls.appendChild(answer);
    els.controls.appendChild(grid);
  }

  function renderChoiceControls(round) {
    els.controls.innerHTML = '';
    var grid = document.createElement('div');
    grid.className = 'choice-grid';
    (round.prompt.options || []).forEach(function (option) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = option;
      applyTokenStyle(button, option);
      button.addEventListener('click', function () {
        submitRound(round, option);
      });
      grid.appendChild(button);
    });
    els.controls.appendChild(grid);
  }

  function submitRound(round, value) {
    if (!socket || !socket.connected || submittedRoundId === round.id) return;
    submittedRoundId = round.id;
    socket.emit('party_submit', {
      code: code,
      playerId: playerId,
      value: value
    });
    lockControls('제출 완료');
  }

  function lockControls(message) {
    liveActionButton = null;
    liveActionRound = null;
    targetGrid = null;
    targetStats = null;
    clearAutoSubmitTimer();
    var buttons = els.controls.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].disabled = true;
    }
    if (message) {
      var note = document.createElement('p');
      note.className = 'muted';
      note.textContent = message;
      els.controls.appendChild(note);
    }
  }

  function updateClock() {
    if (!sessionState) return;
    var now = currentServerNow();
    var target = sessionState.endsAt;
    if (sessionState.currentRound) {
      if (sessionState.status === 'countdown') target = sessionState.nextTransitionAt;
      if (sessionState.status === 'round_intro') target = sessionState.currentRound.startsAt;
      if (sessionState.status === 'playing') target = sessionState.currentRound.endsAt;
      if (sessionState.status === 'round_result') target = sessionState.nextTransitionAt;
    }
    if (sessionState.status === 'playing' && sessionState.currentRound && sessionState.currentRound.engine === 'timing') {
      els.remainingTime.textContent = '감으로';
    } else {
      els.remainingTime.textContent = sessionState.status === 'ended' ? '끝' : formatSeconds((target - now) / 1000);
    }
    updateLiveControls();
  }

  function updateLiveControls() {
    if (!sessionState || !liveActionRound || submittedRoundId === liveActionRound.id) {
      return;
    }
    var now = currentServerNow();
    if (liveActionRound.engine === 'reaction' && liveActionButton) {
      if (liveActionRound.prompt && liveActionRound.prompt.late) {
        liveActionButton.className = 'big-button danger';
        liveActionButton.textContent = '마지막까지 버티기 · ' + formatSeconds((liveActionRound.endsAt - now) / 1000);
        return;
      }
      var signalAt = Number(liveActionRound.prompt && liveActionRound.prompt.signalAt);
      var fakeAt = Number(liveActionRound.prompt && liveActionRound.prompt.fakeAt);
      if (fakeAt && now >= fakeAt && now < fakeAt + 650 && now < signalAt) {
        liveActionButton.className = 'big-button danger';
        liveActionButton.textContent = '가짜 신호!';
        return;
      }
      if (signalAt && now < signalAt) {
        liveActionButton.className = 'big-button waiting';
        liveActionButton.textContent = fakeAt ? '가짜 신호 조심' : '아직 누르지 마세요';
      } else {
        liveActionButton.className = 'big-button ready';
        liveActionButton.textContent = '지금!';
      }
      return;
    }
    if (liveActionRound.engine === 'timing' && liveActionButton) {
      liveActionButton.textContent = liveActionRound.prompt && liveActionRound.prompt.hold ? liveActionButton.textContent : '멈추기';
    }
    if (liveActionRound.engine === 'target' && targetGrid) {
      renderActiveTarget(liveActionRound);
    }
  }

  function currentTargetCell(round) {
    var targets = (round.prompt && round.prompt.targets) || [];
    if (!targets.length) return -1;
    var elapsed = Math.max(0, currentServerNow() - round.startsAt);
    var active = targets[0];
    for (var i = 0; i < targets.length; i += 1) {
      if (elapsed >= Number(targets[i].atMs || 0)) {
        active = targets[i];
      } else {
        break;
      }
    }
    return Number(active.cell);
  }

  function renderActiveTarget(round) {
    var activeCell = currentTargetCell(round);
    var buttons = targetGrid.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i += 1) {
      var isActive = Number(buttons[i].dataset.cell || -1) === activeCell;
      buttons[i].className = isActive ? 'target-active' : '';
      buttons[i].textContent = isActive ? (round.prompt && round.prompt.label === '안전' ? '안전' : '★') : '';
    }
  }

  function autoSubmitAtRoundEnd(round, callback) {
    clearAutoSubmitTimer();
    autoSubmitTimer = window.setTimeout(function () {
      if (submittedRoundId === round.id) return;
      callback();
    }, Math.max(300, round.endsAt - currentServerNow() - 120));
  }

  function clearAutoSubmitTimer() {
    if (!autoSubmitTimer) return;
    window.clearTimeout(autoSubmitTimer);
    autoSubmitTimer = 0;
  }

  function applyTokenStyle(element, token) {
    var key = String(token || '').replace(/\s*(상자|문)$/g, '');
    var style = colorStyles[key];
    element.style.background = '';
    element.style.color = '';
    if (!style) return;
    element.style.background = style.background;
    element.style.color = style.color;
  }

  function unique(items) {
    var seen = {};
    var out = [];
    items.forEach(function (item) {
      if (seen[item]) return;
      seen[item] = true;
      out.push(item);
    });
    return out;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char];
    });
  }

  els.joinForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var nickname = String(els.nicknameInput.value || '').replace(/\s+/g, ' ').trim();
    if (nickname.length < 2) {
      showError('닉네임은 2자 이상으로 입력해 주세요.', true);
      return;
    }
    connectAndJoin(nickname.slice(0, 8));
  });

  window.setInterval(updateClock, 250);

  window.render_game_to_text = function renderGameToText() {
    var round = sessionState && sessionState.currentRound;
    return JSON.stringify({
      mode: 'party-join',
      status: sessionState ? sessionState.status : 'entry',
      player: player ? {
        nickname: player.nickname,
        score: player.score,
        roundsPlayed: player.roundsPlayed
      } : null,
      round: round ? {
        id: round.id,
        title: round.title,
        engine: round.engine,
        participant: round.participants.indexOf(playerId) !== -1,
        submitted: submittedRoundId === round.id
      } : null
    });
  };
})();
