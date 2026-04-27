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
  var lastSentDirection = '';
  var lastSentAt = 0;
  var lastEventKey = '';

  var els = {
    entryPanel: document.getElementById('entryPanel'),
    joinForm: document.getElementById('joinForm'),
    nicknameInput: document.getElementById('nicknameInput'),
    joinButton: document.getElementById('joinButton'),
    gamePanel: document.getElementById('gamePanel'),
    teamCard: document.getElementById('teamCard'),
    statusText: document.getElementById('statusText'),
    teamName: document.getElementById('teamName'),
    playerName: document.getElementById('playerName'),
    myScore: document.getElementById('myScore'),
    remainingTime: document.getElementById('remainingTime'),
    eventText: document.getElementById('eventText'),
    errorBox: document.getElementById('errorBox')
  };

  restoreNickname();

  function showError(message) {
    els.errorBox.textContent = message || '';
    els.errorBox.hidden = !message;
  }

  function getOrCreatePlayerId() {
    var key = 'dimicheck:arcade-player-id:' + code;
    try {
      var existing = sessionStorage.getItem(key);
      if (existing) return existing;
      var generated = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(key, generated);
      return generated;
    } catch (error) {
      console.warn('[Arcade] failed to persist player id', error);
      return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
  }

  function restoreNickname() {
    try {
      var saved = localStorage.getItem('dimicheck:arcade-nickname');
      if (saved) els.nicknameInput.value = saved;
    } catch (error) {
      console.warn('[Arcade] failed to restore nickname', error);
      return;
    }
  }

  function saveNickname(value) {
    try {
      localStorage.setItem('dimicheck:arcade-nickname', value);
    } catch (error) {
      console.warn('[Arcade] failed to save nickname', error);
      return;
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
      showError('현재 Arcade가 비활성화되어 있습니다.');
      return;
    }
    if (!window.io) {
      showError('Socket.IO를 불러오지 못했습니다. 네트워크를 확인해 주세요.');
      return;
    }
    els.joinButton.disabled = true;
    showError('');
    socket = window.io('/ws/arcade', {
      transports: ['websocket', 'polling'],
      query: { code: code, playerId: playerId }
    });
    socket.on('connect', function () {
      socket.emit('join_player', {
        code: code,
        playerId: playerId,
        nickname: nickname,
        avatar: avatarId()
      });
    });
    socket.on('arcade:joined', function (payload) {
      player = payload.player;
      sessionState = payload.session;
      saveNickname(nickname);
      els.entryPanel.classList.add('hidden');
      els.gamePanel.classList.add('active');
      renderState(sessionState);
    });
    socket.on('arcade:state', renderState);
    socket.on('arcade:ended', renderState);
    socket.on('arcade:error', function (payload) {
      els.joinButton.disabled = false;
      showError(payload && payload.message ? payload.message : '입장할 수 없습니다.');
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

  function renderState(state) {
    if (!state) return;
    sessionState = state;
    serverOffsetMs = state.now - Date.now();

    var freshPlayer = null;
    for (var i = 0; i < (state.players || []).length; i += 1) {
      if (state.players[i].id === playerId) {
        freshPlayer = state.players[i];
        break;
      }
    }
    if (freshPlayer) player = freshPlayer;

    if (player) {
      els.teamCard.className = 'team-card ' + player.team + (player.boosted ? ' boosted' : '');
      els.teamName.textContent = player.teamLabel || (player.team === 'red' ? '딸기팀' : '소다팀');
      els.playerName.textContent = player.nickname + (player.boosted ? ' · 스피드 업' : '');
      els.myScore.textContent = player.contribution || 0;
    }

    if (state.status === 'waiting') {
      els.statusText.textContent = '입장 완료. 시작을 기다리는 중';
    } else if (state.status === 'countdown') {
      els.statusText.textContent = '곧 시작합니다';
    } else if (state.status === 'running') {
      els.statusText.textContent = '진행 중';
    } else if (state.status === 'ended') {
      els.statusText.textContent = state.winner === 'draw' ? '무승부' : state.winnerLabel + ' 승리';
    }
    renderEventText(state.events || []);
    updateClock();
  }

  function renderEventText(events) {
    if (!events.length || !els.eventText) return;
    var latest = events[events.length - 1];
    var key = latest.at + ':' + latest.message;
    if (key === lastEventKey) return;
    lastEventKey = key;
    els.eventText.textContent = latest.message;
  }

  function updateClock() {
    if (!sessionState) return;
    if (sessionState.status === 'waiting') {
      els.remainingTime.textContent = formatSeconds((sessionState.scheduledStartAt - currentServerNow()) / 1000);
    } else if (sessionState.status === 'countdown') {
      els.remainingTime.textContent = formatSeconds((sessionState.startsAt - currentServerNow()) / 1000);
    } else if (sessionState.status === 'running') {
      els.remainingTime.textContent = formatSeconds((sessionState.endsAt - currentServerNow()) / 1000);
    } else {
      els.remainingTime.textContent = '끝';
    }
  }

  function sendDirection(direction) {
    if (!socket || !socket.connected || !player || !sessionState) return;
    if (sessionState.status !== 'countdown' && sessionState.status !== 'running') return;
    var now = Date.now();
    if (lastSentDirection === direction && now - lastSentAt < 90) return;
    lastSentDirection = direction;
    lastSentAt = now;
    socket.emit('player_input', {
      code: code,
      playerId: playerId,
      direction: direction
    });
  }

  els.joinForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var nickname = String(els.nicknameInput.value || '').replace(/\s+/g, ' ').trim();
    if (nickname.length < 2) {
      showError('닉네임은 2자 이상으로 입력해 주세요.');
      return;
    }
    connectAndJoin(nickname.slice(0, 8));
  });

  var directionButtons = document.querySelectorAll('[data-dir]');
  for (var i = 0; i < directionButtons.length; i += 1) {
    var button = directionButtons[i];
    button.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      sendDirection(this.getAttribute('data-dir'));
    });
    button.addEventListener('click', function () {
      sendDirection(this.getAttribute('data-dir'));
    });
  }

  document.addEventListener('keydown', function (event) {
    var map = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      w: 'up',
      W: 'up',
      s: 'down',
      S: 'down',
      a: 'left',
      A: 'left',
      d: 'right',
      D: 'right'
    };
    var direction = map[event.key];
    if (!direction) return;
    event.preventDefault();
    sendDirection(direction);
  });

  window.setInterval(updateClock, 250);
})();
