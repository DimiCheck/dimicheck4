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
    playerCount: document.getElementById('playerCount'),
    roundCount: document.getElementById('roundCount'),
    submitCount: document.getElementById('submitCount'),
    remainingTime: document.getElementById('remainingTime'),
    startButton: document.getElementById('startButton'),
    endButton: document.getElementById('endButton'),
    boardLink: document.getElementById('boardLink'),
    roster: document.getElementById('roster'),
    statusText: document.getElementById('statusText'),
    phaseText: document.getElementById('phaseText'),
    roundTitle: document.getElementById('roundTitle'),
    instruction: document.getElementById('instruction'),
    promptText: document.getElementById('promptText'),
    sequence: document.getElementById('sequence'),
    progressBar: document.getElementById('progressBar'),
    results: document.getElementById('results'),
    rankings: document.getElementById('rankings')
  };

  var sessionState = null;
  var socket = null;
  var serverOffsetMs = 0;
  var debugAllowAnyTime = root.getAttribute('data-debug-allow-any-time') === '1';
  var returnedToBoard = false;
  var debugBots = [];
  var latestCueText = '';

  els.boardLink.href = boardUrl;

  function setError(message) {
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
    if (!state) return 'Party 준비 중';
    if (state.status === 'lobby') return '입장 대기';
    if (state.status === 'countdown') return '곧 시작';
    if (state.status === 'round_intro') return '라운드 소개';
    if (state.status === 'playing') return '입력 중';
    if (state.status === 'round_result') return '라운드 결과';
    if (state.status === 'ended') return '최종 결과';
    return 'Party';
  }

  function setupJoinCard(state) {
    var origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
    var joinUrl = origin + '/arcade/party/join/' + encodeURIComponent(state.code);
    els.joinCard.hidden = false;
    els.sessionCode.textContent = state.code;
    els.joinLink.textContent = joinUrl;
    els.qrImage.src = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=12&data=' + encodeURIComponent(joinUrl);
    els.qrImage.onerror = function () {
      els.qrImage.style.display = 'none';
    };
  }

  function renderRoster(players) {
    els.roster.innerHTML = '';
    players.forEach(function (player) {
      var chip = document.createElement('div');
      chip.className = 'chip';
      chip.textContent = player.nickname + ' · ' + player.score + '점' + (player.connected ? '' : ' · 오프라인');
      els.roster.appendChild(chip);
    });
  }

  function renderSequence(sequence) {
    els.sequence.innerHTML = '';
    (sequence || []).forEach(function (item) {
      var chip = document.createElement('div');
      chip.className = 'seq-chip';
      chip.textContent = item;
      els.sequence.appendChild(chip);
    });
  }

  function renderResults(results) {
    els.results.innerHTML = '';
    (results || []).slice(0, 6).forEach(function (result, index) {
      var card = document.createElement('div');
      card.className = 'result-card';
      card.textContent = (index + 1) + '. ' + result.nickname + ' · +' + result.score + ' · ' + result.note;
      els.results.appendChild(card);
    });
  }

  function renderRankings(state) {
    els.rankings.innerHTML = '';
    appendRankingGroup('총점', ((state.rankings || {}).total || []).slice(0, 10));
    appendRankingGroup('평균', ((state.rankings || {}).average || []).filter(function (player) {
      return player.roundsPlayed > 0;
    }).slice(0, 10));
  }

  function appendRankingGroup(title, ranking) {
    if (!ranking.length) return;
    var group = document.createElement('div');
    group.className = 'ranking-group';
    var titleChip = document.createElement('div');
    titleChip.className = 'rank-title';
    titleChip.textContent = title;
    group.appendChild(titleChip);
    ranking.forEach(function (player, index) {
      var chip = document.createElement('div');
      chip.className = 'chip';
      chip.textContent = title === '평균'
        ? (index + 1) + '위 ' + player.nickname + ' ' + player.averageScore + '점'
        : (index + 1) + '위 ' + player.nickname + ' ' + player.score + '점';
      group.appendChild(chip);
    });
    els.rankings.appendChild(group);
  }

  function setPromptText(text, cueState) {
    if (latestCueText === text && els.promptText.dataset.cueState === String(cueState || '')) return;
    latestCueText = text;
    els.promptText.textContent = text || '';
    els.promptText.dataset.cueState = String(cueState || '');
    els.promptText.className = 'prompt' + (cueState ? ' cue ' + cueState : '');
  }

  function renderRound(state) {
    var round = state.currentRound;
    els.sequence.innerHTML = '';
    els.results.innerHTML = '';
    latestCueText = '';
    setPromptText('', '');
    if (!round) {
      els.roundTitle.textContent = state.status === 'ended' ? 'Party 종료' : '입장 대기';
      els.instruction.textContent = state.status === 'ended' ? '최종 순위를 확인하세요.' : '학생들이 QR로 입장하면 시작할 수 있습니다.';
      return;
    }
    els.roundTitle.textContent = round.title;
    els.instruction.textContent = round.instruction;
    if (round.status === 'round_intro') {
      setPromptText('곧 시작합니다', 'waiting');
    } else if (round.engine === 'reaction') {
      updateLiveCue();
    } else if (round.engine === 'timing') {
      setPromptText('목표 ' + Math.round((round.prompt.targetMs || 0) / 1000 * 10) / 10 + '초', '');
    } else if (round.engine === 'memory') {
      setPromptText('순서를 기억하세요', '');
      renderSequence(round.prompt.sequence || []);
    } else if (round.engine === 'choice') {
      setPromptText(round.prompt.cue ? '표시: ' + round.prompt.cue : '정답을 고르세요', '');
      renderSequence(round.prompt.options || []);
    } else if (round.engine === 'majority') {
      setPromptText(round.prompt.unique ? '겹치지 않는 선택' : '적게 고른 쪽 승리', '');
      renderSequence(round.prompt.options || []);
    } else if (round.engine === 'luck') {
      setPromptText('운을 골라 보세요', '');
      renderSequence(round.prompt.options || []);
    }
    if (round.status === 'round_result') {
      renderResults(round.results || []);
    }
  }

  function renderState(state) {
    sessionState = state;
    serverOffsetMs = state.now - Date.now();
    els.statusText.textContent = statusLabel(state);
    els.phaseText.textContent = state.phaseLabel ? state.phaseLabel + ' Party' : 'DimiCheck Party';
    els.playerCount.textContent = (state.players || []).filter(function (player) { return player.connected; }).length + '명';
    els.roundCount.textContent = state.roundIndex + '/' + state.roundCount;
    var round = state.currentRound;
    var submitted = round ? round.submittedCount : 0;
    var participants = round ? round.participants.length : 0;
    els.submitCount.textContent = submitted + '/' + participants;
    els.startButton.disabled = state.status !== 'lobby' && state.status !== 'round_result';
    els.endButton.disabled = state.status === 'ended';
    renderRoster(state.players || []);
    renderRound(state);
    renderRankings(state);
    updateClock();
    updateLiveCue();
    if (state.status === 'ended') {
      scheduleBoardReturn(10);
    }
  }

  function updateLiveCue() {
    if (!sessionState || !sessionState.currentRound || sessionState.currentRound.engine !== 'reaction') return;
    var round = sessionState.currentRound;
    if (sessionState.status === 'round_intro') {
      setPromptText('곧 시작합니다', 'waiting');
      return;
    }
    if (sessionState.status !== 'playing') return;
    var now = currentServerNow();
    if (round.prompt && round.prompt.late) {
      setPromptText('끝나기 직전이 기회', 'ready');
      return;
    }
    var signalAt = Number(round.prompt && round.prompt.signalAt);
    var fakeAt = Number(round.prompt && round.prompt.fakeAt);
    if (fakeAt && now >= fakeAt && now < fakeAt + 650 && now < signalAt) {
      setPromptText('가짜!', 'waiting');
      return;
    }
    if (signalAt && now < signalAt) {
      setPromptText('기다리세요', 'waiting');
    } else {
      setPromptText('지금!', 'ready');
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
    els.remainingTime.textContent = sessionState.status === 'ended' ? '끝' : formatSeconds((target - now) / 1000);
    var round = sessionState.currentRound;
    if (!round || sessionState.status === 'ended') {
      els.progressBar.style.setProperty('--progress', sessionState.status === 'ended' ? '100%' : '0%');
      return;
    }
    var start = round.startsAt;
    var end = round.endsAt;
    if (sessionState.status === 'round_intro') {
      start = round.introAt;
      end = round.startsAt;
    } else if (sessionState.status === 'round_result') {
      start = round.endsAt;
      end = sessionState.nextTransitionAt;
    }
    var percent = Math.max(0, Math.min(100, ((now - start) / Math.max(1, end - start)) * 100));
    els.progressBar.style.setProperty('--progress', percent + '%');
    updateLiveCue();
  }

  function scheduleBoardReturn(delaySeconds) {
    if (returnedToBoard) return;
    returnedToBoard = true;
    window.setTimeout(function () {
      window.location.href = boardUrl;
    }, Math.max(2, delaySeconds) * 1000);
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
      socket.emit('party_join_host', { code: code });
    });
    socket.on('party:state', renderState);
    socket.on('party:ended', renderState);
    socket.on('party:error', function (payload) {
      setError(payload && payload.message ? payload.message : 'Party 오류가 발생했습니다.');
    });
  }

  function createSession() {
    if (!enabled || !grade || !section) {
      setError('Board에서 인증된 상태로 Party를 열어 주세요.');
      return;
    }
    postJson('/api/arcade/party/sessions', {
      grade: grade,
      section: section,
      debugAllowAnyTime: debugAllowAnyTime
    }).then(function (state) {
      setupJoinCard(state);
      renderState(state);
      connectSocket(state.code);
    }).catch(function (error) {
      setError(error.message);
      els.roundTitle.textContent = '시작할 수 없음';
      els.instruction.textContent = error.message;
    });
  }

  function sessionCode() {
    if (!sessionState || !sessionState.code) {
      throw new Error('Party 세션이 아직 준비되지 않았습니다.');
    }
    return sessionState.code;
  }

  function randomValueForRound(round) {
    if (!round) return 'tap';
    if (round.engine === 'timing') {
      return Math.floor((round.prompt.targetMs || 4000) + (Math.random() * 1000 - 500));
    }
    if (round.engine === 'memory') {
      return (round.prompt.sequence || []).slice();
    }
    var options = round.prompt.options || ['A', 'B'];
    return options[Math.floor(Math.random() * options.length)];
  }

  function addDebugBot(index) {
    var code = sessionCode();
    var playerId = 'party-bot-' + Date.now().toString(36) + '-' + index + '-' + Math.random().toString(36).slice(2, 7);
    var botSocket = window.io('/ws/arcade', {
      transports: ['websocket', 'polling'],
      query: { code: code, playerId: playerId }
    });
    botSocket.on('connect', function () {
      botSocket.emit('party_join_player', {
        code: code,
        playerId: playerId,
        nickname: '봇' + (index + 1),
        avatar: index
      });
    });
    botSocket.on('party:state', function (state) {
      var round = state.currentRound;
      if (!round || state.status !== 'playing') return;
      var already = (round.results || []).some(function (item) { return item.playerId === playerId; });
      if (already) return;
      window.setTimeout(function () {
        botSocket.emit('party_submit', {
          code: code,
          playerId: playerId,
          value: randomValueForRound(round)
        });
      }, 300 + Math.floor(Math.random() * 1800));
    });
    debugBots.push(botSocket);
  }

  function installDebugConsole() {
    var api = {
      help: function () {
        return {
          'ArcadeDebug.allowAnyTime()': 'Party에서도 같은 이름으로 시간 제한 우회 테스트 세션을 새로 만듭니다.',
          'PartyDebug.allowAnyTime()': '시간 제한 우회 테스트 세션을 새로 만듭니다. 서버에서 ARCADE_DEBUG_ALLOW_ANY_TIME=1일 때만 동작합니다.',
          'PartyDebug.bots(12)': '테스트 봇 12명을 입장시킵니다.',
          'PartyDebug.start()': '현재 Party를 시작합니다.',
          'PartyDebug.end()': '현재 Party를 종료합니다.',
          'PartyDebug.state()': '현재 상태를 봅니다.'
        };
      },
      state: function () {
        return sessionState;
      },
      allowAnyTime: function () {
        debugAllowAnyTime = true;
        createSession();
        return '시간 제한 우회 Party를 요청했습니다.';
      },
      bots: function (count) {
        var total = Math.max(1, Math.min(Number(count) || 8, 50));
        for (var i = 0; i < total; i += 1) addDebugBot(debugBots.length);
        return { totalBots: debugBots.length };
      },
      start: function () {
        return postJson('/api/arcade/party/sessions/' + encodeURIComponent(sessionCode()) + '/start').then(renderState);
      },
      end: function () {
        return postJson('/api/arcade/party/sessions/' + encodeURIComponent(sessionCode()) + '/end').then(renderState);
      }
    };
    window.DimiPartyDebug = api;
    window.PartyDebug = api;
    window.ArcadeDebug = api;
  }

  els.startButton.addEventListener('click', function () {
    if (!sessionState) return;
    els.startButton.disabled = true;
    postJson('/api/arcade/party/sessions/' + encodeURIComponent(sessionState.code) + '/start').then(renderState).catch(function (error) {
      setError(error.message);
    });
  });

  els.endButton.addEventListener('click', function () {
    if (!sessionState) return;
    els.endButton.disabled = true;
    postJson('/api/arcade/party/sessions/' + encodeURIComponent(sessionState.code) + '/end').then(renderState).catch(function (error) {
      setError(error.message);
    });
  });

  window.setInterval(updateClock, 250);
  installDebugConsole();
  createSession();

  window.render_game_to_text = function renderGameToText() {
    var round = sessionState && sessionState.currentRound;
    return JSON.stringify({
      mode: 'party-host',
      status: sessionState ? sessionState.status : 'loading',
      code: sessionState ? sessionState.code : null,
      players: sessionState ? (sessionState.players || []).length : 0,
      round: round ? {
        index: round.index,
        title: round.title,
        engine: round.engine,
        submitted: round.submittedCount,
        participants: round.participants.length
      } : null
    });
  };
})();
