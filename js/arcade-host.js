(function () {
  var root = document.querySelector('.page');
  if (!root) return;

  var grade = Number(root.getAttribute('data-grade') || 0);
  var section = Number(root.getAttribute('data-section') || 0);
  var enabled = root.getAttribute('data-enabled') === '1';
  var boardUrl = grade && section ? '/board?grade=' + encodeURIComponent(grade) + '&section=' + encodeURIComponent(section) : '/';

  var els = {
    error: document.getElementById('hostError'),
    joinCard: document.getElementById('joinCard'),
    sessionCode: document.getElementById('sessionCode'),
    qrImage: document.getElementById('qrImage'),
    joinLink: document.getElementById('joinLink'),
    redScore: document.getElementById('redScore'),
    blueScore: document.getElementById('blueScore'),
    playerCount: document.getElementById('playerCount'),
    remainingTime: document.getElementById('remainingTime'),
    startButton: document.getElementById('startButton'),
    endButton: document.getElementById('endButton'),
    boardLink: document.getElementById('boardLink'),
    roster: document.getElementById('roster'),
    statusText: document.getElementById('statusText'),
    phaseText: document.getElementById('phaseText'),
    cellLayer: document.getElementById('cellLayer'),
    playerLayer: document.getElementById('playerLayer'),
    overlay: document.getElementById('stageOverlay'),
    overlayTitle: document.getElementById('overlayTitle'),
    overlayText: document.getElementById('overlayText')
  };

  var sessionState = null;
  var socket = null;
  var cells = [];
  var serverOffsetMs = 0;
  var returnedToBoard = false;
  var debugBots = [];
  var debugBotTimers = [];
  var debugAllowAnyTime = false;

  els.boardLink.href = boardUrl;

  function setError(message) {
    if (!els.error) return;
    els.error.textContent = message || '';
    els.error.hidden = !message;
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        if (!response.ok) {
          throw new Error(data.error || '요청을 처리하지 못했습니다.');
        }
        return data;
      });
    });
  }

  function ensureGrid(width, height) {
    if (cells.length === width * height) return;
    cells = [];
    els.cellLayer.innerHTML = '';
    for (var i = 0; i < width * height; i += 1) {
      var cell = document.createElement('div');
      cell.className = 'cell';
      els.cellLayer.appendChild(cell);
      cells.push(cell);
    }
  }

  function applyFullGrid(grid) {
    if (!grid || !grid.length) return;
    ensureGrid(grid[0].length, grid.length);
    for (var y = 0; y < grid.length; y += 1) {
      for (var x = 0; x < grid[y].length; x += 1) {
        applyCell(x, y, grid[y][x], grid[0].length);
      }
    }
  }

  function applyCell(x, y, team, width) {
    var index = y * width + x;
    var cell = cells[index];
    if (!cell) return;
    cell.className = 'cell' + (team === 'red' || team === 'blue' ? ' ' + team : '');
  }

  function applyChangedCells(changedCells, width) {
    if (!changedCells) return;
    for (var i = 0; i < changedCells.length; i += 1) {
      applyCell(changedCells[i][0], changedCells[i][1], changedCells[i][2], width);
    }
  }

  function formatSeconds(seconds) {
    if (!isFinite(seconds)) return '--';
    var safe = Math.max(0, Math.ceil(seconds));
    var min = Math.floor(safe / 60);
    var sec = safe % 60;
    return min + ':' + (sec < 10 ? '0' + sec : String(sec));
  }

  function currentServerNow() {
    return Date.now() + serverOffsetMs;
  }

  function setOverlay(title, text, hidden) {
    els.overlayTitle.textContent = title;
    els.overlayText.textContent = text || '';
    els.overlay.hidden = Boolean(hidden);
  }

  function statusLabel(state) {
    if (!state) return 'Arcade 준비 중';
    if (state.status === 'waiting') return '입장 대기';
    if (state.status === 'countdown') return '곧 시작';
    if (state.status === 'running') return '진행 중';
    if (state.status === 'ended') return '결과';
    return 'Arcade';
  }

  function renderPlayers(players, width, height) {
    els.playerLayer.innerHTML = '';
    for (var i = 0; i < players.length; i += 1) {
      var player = players[i];
      var marker = document.createElement('div');
      marker.className = 'player ' + player.team;
      marker.style.left = ((player.x + 0.5) / width * 100) + '%';
      marker.style.top = ((player.y + 0.5) / height * 100) + '%';
      marker.textContent = avatarGlyph(player.avatar);
      var label = document.createElement('span');
      label.textContent = player.nickname;
      marker.appendChild(label);
      els.playerLayer.appendChild(marker);
    }
  }

  function avatarGlyph(index) {
    var glyphs = ['●', '◆', '▲', '■', '★', '✦', '✿', '✚', '⬟', '⬢', '◈', '☘'];
    return glyphs[Math.abs(Number(index) || 0) % glyphs.length];
  }

  function renderRoster(players) {
    els.roster.innerHTML = '';
    for (var i = 0; i < players.length; i += 1) {
      var player = players[i];
      var chip = document.createElement('div');
      chip.className = 'roster-chip ' + player.team;
      chip.textContent = player.nickname + ' ' + player.contribution;
      els.roster.appendChild(chip);
    }
  }

  function renderState(state) {
    sessionState = state;
    serverOffsetMs = state.now - Date.now();
    ensureGrid(state.gridWidth, state.gridHeight);
    if (state.grid) applyFullGrid(state.grid);
    applyChangedCells(state.changedCells, state.gridWidth);

    els.statusText.textContent = statusLabel(state);
    els.phaseText.textContent = state.phaseLabel ? state.phaseLabel + ' Arcade' : 'DimiCheck Arcade';
    els.redScore.textContent = state.scores.red || 0;
    els.blueScore.textContent = state.scores.blue || 0;
    els.playerCount.textContent = (state.players || []).length + '명';
    els.startButton.disabled = state.status !== 'waiting' && state.status !== 'countdown';
    els.endButton.disabled = state.status === 'ended';
    renderRoster(state.players || []);
    renderPlayers(state.players || [], state.gridWidth, state.gridHeight);

    if (state.status === 'waiting') {
      setOverlay('입장 대기', 'QR을 스캔하면 바로 참여할 수 있습니다.', false);
    } else if (state.status === 'countdown') {
      setOverlay(Math.max(1, Math.ceil((state.startsAt - currentServerNow()) / 1000)), '곧 시작합니다.', false);
    } else if (state.status === 'running') {
      setOverlay('', '', true);
    } else if (state.status === 'ended') {
      var winner = state.winner === 'draw' ? '무승부' : state.winnerLabel + ' 승리';
      setOverlay(winner, '잠시 후 Board로 돌아갑니다.', false);
      stopDebugBotInputs();
      scheduleBoardReturn(state.resultSeconds || 10);
    }
  }

  function updateClock() {
    if (!sessionState) return;
    if (sessionState.status === 'waiting') {
      els.remainingTime.textContent = formatSeconds((sessionState.scheduledStartAt - currentServerNow()) / 1000);
    } else if (sessionState.status === 'countdown') {
      els.remainingTime.textContent = formatSeconds((sessionState.startsAt - currentServerNow()) / 1000);
      setOverlay(String(Math.max(1, Math.ceil((sessionState.startsAt - currentServerNow()) / 1000))), '곧 시작합니다.', false);
    } else if (sessionState.status === 'running') {
      els.remainingTime.textContent = formatSeconds((sessionState.endsAt - currentServerNow()) / 1000);
    } else if (sessionState.status === 'ended') {
      els.remainingTime.textContent = '끝';
    }
  }

  function scheduleBoardReturn(delaySeconds) {
    if (returnedToBoard) return;
    returnedToBoard = true;
    window.setTimeout(function () {
      window.location.href = boardUrl;
    }, Math.max(2, delaySeconds) * 1000);
  }

  function setupJoinCard(state) {
    var origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
    var joinUrl = origin + '/arcade/join/' + encodeURIComponent(state.code);
    els.joinCard.hidden = false;
    els.sessionCode.textContent = state.code;
    els.joinLink.textContent = joinUrl;
    els.qrImage.src = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=12&data=' + encodeURIComponent(joinUrl);
    els.qrImage.onerror = function () {
      els.qrImage.style.display = 'none';
    };
  }

  function connectSocket(code) {
    if (!window.io) {
      setError('Socket.IO를 불러오지 못했습니다. 네트워크를 확인해 주세요.');
      return;
    }
    socket = window.io('/ws/arcade', {
      transports: ['websocket', 'polling'],
      query: { code: code }
    });
    socket.on('connect', function () {
      socket.emit('join_host', { code: code });
    });
    socket.on('arcade:state', renderState);
    socket.on('arcade:ended', renderState);
    socket.on('arcade:error', function (payload) {
      setError(payload && payload.message ? payload.message : 'Arcade 오류가 발생했습니다.');
    });
  }

  function debugSessionCode() {
    if (!sessionState || !sessionState.code) {
      throw new Error('Arcade 세션이 아직 준비되지 않았습니다.');
    }
    return sessionState.code;
  }

  function randomDirection() {
    var directions = ['up', 'down', 'left', 'right'];
    return directions[Math.floor(Math.random() * directions.length)];
  }

  function createDebugBot(index) {
    var code = debugSessionCode();
    if (!window.io) {
      throw new Error('Socket.IO를 불러오지 못했습니다.');
    }
    var playerId = 'debug-' + Date.now().toString(36) + '-' + index + '-' + Math.random().toString(36).slice(2, 7);
    var nickname = '봇' + String(index + 1);
    var botSocket = window.io('/ws/arcade', {
      transports: ['websocket', 'polling'],
      query: { code: code, playerId: playerId }
    });
    botSocket.on('connect', function () {
      botSocket.emit('join_player', {
        code: code,
        playerId: playerId,
        nickname: nickname,
        avatar: index
      });
    });
    var timer = window.setInterval(function () {
      if (!botSocket.connected || !sessionState) return;
      if (sessionState.status !== 'countdown' && sessionState.status !== 'running') return;
      botSocket.emit('player_input', {
        code: code,
        playerId: playerId,
        direction: randomDirection()
      });
    }, 180 + Math.floor(Math.random() * 180));
    debugBotTimers.push(timer);
    debugBots.push({ id: playerId, nickname: nickname, socket: botSocket });
    return nickname;
  }

  function addDebugBots(count) {
    var safeCount = Math.max(1, Math.min(Number(count) || 8, 50));
    var created = [];
    for (var i = 0; i < safeCount; i += 1) {
      created.push(createDebugBot(debugBots.length));
    }
    return {
      created: created.length,
      nicknames: created,
      totalBots: debugBots.length
    };
  }

  function stopDebugBotInputs() {
    while (debugBotTimers.length) {
      window.clearInterval(debugBotTimers.pop());
    }
  }

  function clearDebugBots() {
    stopDebugBotInputs();
    while (debugBots.length) {
      var bot = debugBots.pop();
      if (bot && bot.socket) {
        bot.socket.disconnect();
      }
    }
    return { totalBots: 0 };
  }

  function installDebugConsole() {
    var api = {
      help: function () {
        return {
          'ArcadeDebug.allowAnyTime()': '시간 제한 우회 테스트 세션을 새로 만듭니다. 서버에서 ARCADE_DEBUG_ALLOW_ANY_TIME=1일 때만 동작합니다.',
          'ArcadeDebug.bots(12)': '테스트 봇 12명을 입장시킵니다.',
          'ArcadeDebug.start()': '현재 세션을 바로 시작합니다.',
          'ArcadeDebug.end()': '현재 세션을 종료합니다.',
          'ArcadeDebug.demo(12)': '봇을 입장시키고 1.2초 뒤 바로 시작합니다.',
          'ArcadeDebug.clear()': '테스트 봇 연결을 끊습니다.',
          'ArcadeDebug.state()': '현재 호스트가 받은 최신 상태를 봅니다.'
        };
      },
      state: function () {
        return sessionState;
      },
      allowAnyTime: function () {
        debugAllowAnyTime = true;
        clearDebugBots();
        sessionState = null;
        returnedToBoard = false;
        createSession();
        return '시간 제한 우회 세션을 요청했습니다. 서버 설정이 꺼져 있으면 거부됩니다.';
      },
      bots: function (count) {
        return addDebugBots(count);
      },
      clear: clearDebugBots,
      start: function () {
        return postJson('/api/arcade/sessions/' + encodeURIComponent(debugSessionCode()) + '/start').then(renderState);
      },
      end: function () {
        return postJson('/api/arcade/sessions/' + encodeURIComponent(debugSessionCode()) + '/end').then(renderState);
      },
      demo: function (count) {
        var result = addDebugBots(count || 12);
        window.setTimeout(function () {
          api.start();
        }, 1200);
        return result;
      }
    };
    window.DimiArcadeDebug = api;
    window.ArcadeDebug = api;
  }

  function createSession() {
    if (!enabled || !grade || !section) {
      setOverlay('시작할 수 없음', 'Board 인증이 필요하거나 Arcade가 비활성화되어 있습니다.', false);
      setError('Board에서 인증된 상태로 Arcade를 열어 주세요.');
      return;
    }
    setOverlay('준비 중', 'Arcade 세션을 만들고 있습니다.', false);
    postJson('/api/arcade/sessions', {
      grade: grade,
      section: section,
      debugAllowAnyTime: debugAllowAnyTime
    }).then(function (state) {
      setupJoinCard(state);
      renderState(state);
      connectSocket(state.code);
    }).catch(function (error) {
      setOverlay('시작할 수 없음', error.message, false);
      setError(error.message);
    });
  }

  els.startButton.addEventListener('click', function () {
    if (!sessionState) return;
    els.startButton.disabled = true;
    postJson('/api/arcade/sessions/' + encodeURIComponent(sessionState.code) + '/start').then(renderState).catch(function (error) {
      setError(error.message);
    });
  });

  els.endButton.addEventListener('click', function () {
    if (!sessionState) return;
    els.endButton.disabled = true;
    postJson('/api/arcade/sessions/' + encodeURIComponent(sessionState.code) + '/end').then(renderState).catch(function (error) {
      setError(error.message);
    });
  });

  window.setInterval(updateClock, 250);
  installDebugConsole();
  createSession();
})();
