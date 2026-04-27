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
  var pendingTaps = 0;
  var flushTimer = 0;

  var els = {
    entryPanel: document.getElementById('entryPanel'),
    joinForm: document.getElementById('joinForm'),
    nicknameInput: document.getElementById('nicknameInput'),
    joinButton: document.getElementById('joinButton'),
    entryErrorBox: document.getElementById('entryErrorBox'),
    gamePanel: document.getElementById('gamePanel'),
    statusText: document.getElementById('statusText'),
    remainingTime: document.getElementById('remainingTime'),
    myProgress: document.getElementById('myProgress'),
    progressBar: document.getElementById('progressBar'),
    tapButton: document.getElementById('tapButton'),
    myRank: document.getElementById('myRank'),
    tapCount: document.getElementById('tapCount'),
    errorBox: document.getElementById('errorBox')
  };

  restoreNickname();

  function getOrCreatePlayerId() {
    var key = 'dimicheck:turtle-player-id:' + code;
    try {
      var existing = sessionStorage.getItem(key);
      if (existing) return existing;
      var generated = 'tp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(key, generated);
      return generated;
    } catch (error) {
      console.warn('[Turtle] failed to persist player id', error);
      return 'tp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
  }

  function showError(message, entry) {
    var box = entry ? els.entryErrorBox : els.errorBox;
    box.textContent = message || '';
    box.hidden = !message;
  }

  function restoreNickname() {
    try {
      var saved = localStorage.getItem('dimicheck:arcade-nickname');
      if (saved) els.nicknameInput.value = saved;
    } catch (error) {
      console.warn('[Turtle] failed to restore nickname', error);
    }
  }

  function saveNickname(value) {
    try {
      localStorage.setItem('dimicheck:arcade-nickname', value);
    } catch (error) {
      console.warn('[Turtle] failed to save nickname', error);
    }
  }

  function avatarId() {
    var hash = 0;
    for (var i = 0; i < playerId.length; i += 1) {
      hash = ((hash << 5) - hash + playerId.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 12;
  }

  function connectAndJoin(nickname) {
    if (!enabled) {
      showError('현재 Arcade가 비활성화되어 있습니다.', true);
      return;
    }
    if (!window.io) {
      showError('Socket.IO를 불러오지 못했습니다.', true);
      return;
    }
    els.joinButton.disabled = true;
    socket = window.io('/ws/arcade', {
      transports: ['websocket', 'polling'],
      query: { code: code, playerId: playerId }
    });
    socket.on('connect', function () {
      socket.emit('turtle_join_player', {
        code: code,
        playerId: playerId,
        nickname: nickname,
        avatar: avatarId()
      });
    });
    socket.on('turtle:joined', function (payload) {
      player = payload.player;
      sessionState = payload.session;
      saveNickname(nickname);
      els.entryPanel.classList.add('hidden');
      els.gamePanel.classList.add('active');
      renderState(sessionState);
    });
    socket.on('turtle:state', renderState);
    socket.on('turtle:ended', renderState);
    socket.on('turtle:submitted', function (payload) {
      if (payload && payload.session) renderState(payload.session);
    });
    socket.on('turtle:error', function (payload) {
      els.joinButton.disabled = false;
      showError(payload && payload.message ? payload.message : '입장할 수 없습니다.', !player);
    });
  }

  function currentServerNow() {
    return Date.now() + serverOffsetMs;
  }

  function formatSeconds(ms) {
    return String(Math.max(0, Math.ceil(ms / 1000)));
  }

  function findMe(state) {
    for (var i = 0; i < (state.players || []).length; i += 1) {
      if (state.players[i].id === playerId) return state.players[i];
    }
    return null;
  }

  function renderState(state) {
    if (!state) return;
    sessionState = state;
    serverOffsetMs = state.now - Date.now();
    var fresh = findMe(state);
    if (fresh) player = fresh;
    els.statusText.textContent = statusLabel(state.status);
    renderPlayer();
    updateClock();
  }

  function statusLabel(status) {
    if (status === 'lobby') return '출발을 기다리는 중';
    if (status === 'countdown') return '곧 출발';
    if (status === 'racing') return '연타!';
    if (status === 'ended') return '결과 확인';
    return '연결 중';
  }

  function renderPlayer() {
    var progress = player ? Math.round(player.progressPercent || 0) : 0;
    els.myProgress.textContent = progress + '%';
    els.progressBar.style.setProperty('--progress', progress + '%');
    els.tapCount.textContent = (player ? player.taps : 0) + ' taps';
    if (sessionState && sessionState.status === 'racing' && player && !player.finished) {
      els.tapButton.disabled = false;
      els.tapButton.textContent = '🐢 밀기';
    } else {
      els.tapButton.disabled = true;
      els.tapButton.textContent = sessionState && sessionState.status === 'countdown' ? '준비' : '대기';
    }
    if (player && player.rank) {
      els.myRank.textContent = player.rank + '위 · ' + (player.finished ? '완주' : '시간 종료');
    } else if (sessionState && sessionState.status === 'ended') {
      els.myRank.textContent = '결과를 전자칠판에서 확인하세요.';
    } else {
      els.myRank.textContent = '등수는 경주 후 표시됩니다.';
    }
  }

  function updateClock() {
    if (!sessionState) return;
    var now = currentServerNow();
    if (sessionState.status === 'countdown') {
      els.remainingTime.textContent = formatSeconds(sessionState.startsAt - now);
    } else if (sessionState.status === 'racing') {
      els.remainingTime.textContent = formatSeconds(sessionState.endsAt - now);
    } else if (sessionState.status === 'ended') {
      els.remainingTime.textContent = '끝';
    } else {
      els.remainingTime.textContent = '--';
    }
  }

  function flushTaps() {
    if (!pendingTaps || !socket || !socket.connected || !sessionState || sessionState.status !== 'racing') {
      pendingTaps = 0;
      return;
    }
    var count = pendingTaps;
    pendingTaps = 0;
    socket.emit('turtle_tap', {
      code: code,
      playerId: playerId,
      count: count
    });
  }

  els.tapButton.addEventListener('click', function () {
    if (!sessionState || sessionState.status !== 'racing' || (player && player.finished)) return;
    pendingTaps += 1;
    if (player) {
      player.taps += 1;
      player.progressPercent = Math.min(100, (player.progressPercent || 0) + 0.6);
      player.progress = player.progressPercent / 100;
      renderPlayer();
    }
    if (pendingTaps >= 6) flushTaps();
  });

  els.joinForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var nickname = String(els.nicknameInput.value || '').replace(/\s+/g, ' ').trim();
    if (nickname.length < 2) {
      showError('닉네임은 2자 이상으로 입력해 주세요.', true);
      return;
    }
    connectAndJoin(nickname.slice(0, 8));
  });

  flushTimer = window.setInterval(flushTaps, 140);
  window.setInterval(updateClock, 200);
  window.addEventListener('beforeunload', function () {
    if (flushTimer) window.clearInterval(flushTimer);
    flushTaps();
  });

  window.render_game_to_text = function renderGameToText() {
    return JSON.stringify({
      mode: 'turtle-join',
      status: sessionState ? sessionState.status : 'entry',
      player: player ? {
        nickname: player.nickname,
        progress: player.progressPercent,
        taps: player.taps,
        rank: player.rank
      } : null
    });
  };
})();
