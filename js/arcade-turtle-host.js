(function () {
  var root = document.querySelector('.page');
  if (!root) return;

  var grade = Number(root.getAttribute('data-grade') || 0);
  var section = Number(root.getAttribute('data-section') || 0);
  var enabled = root.getAttribute('data-enabled') === '1';
  var debugAllowAnyTime = root.getAttribute('data-debug-allow-any-time') === '1';
  var boardUrl = grade && section ? '/board?grade=' + encodeURIComponent(grade) + '&section=' + encodeURIComponent(section) : '/';
  var sessionState = null;
  var socket = null;
  var serverOffsetMs = 0;

  var els = {
    error: document.getElementById('hostError'),
    joinCard: document.getElementById('joinCard'),
    sessionCode: document.getElementById('sessionCode'),
    qrImage: document.getElementById('qrImage'),
    joinLink: document.getElementById('joinLink'),
    playerCount: document.getElementById('playerCount'),
    raceStatus: document.getElementById('raceStatus'),
    startButton: document.getElementById('startButton'),
    endButton: document.getElementById('endButton'),
    boardLink: document.getElementById('boardLink'),
    statusText: document.getElementById('statusText'),
    phaseText: document.getElementById('phaseText'),
    timerText: document.getElementById('timerText'),
    track: document.getElementById('track'),
    rankings: document.getElementById('rankings')
  };

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
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
        return data;
      });
    });
  }

  function currentServerNow() {
    return Date.now() + serverOffsetMs;
  }

  function formatSeconds(ms) {
    if (!isFinite(ms)) return '--';
    return String(Math.max(0, Math.ceil(ms / 1000)));
  }

  function statusLabel(status) {
    if (status === 'lobby') return '입장 대기';
    if (status === 'countdown') return '출발 준비';
    if (status === 'racing') return '경주 중';
    if (status === 'ended') return '결과';
    return '준비';
  }

  function setupJoinCard(state) {
    var origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
    var joinUrl = origin + '/arcade/turtle/join/' + encodeURIComponent(state.code);
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
      setError('Socket.IO를 불러오지 못했습니다.');
      return;
    }
    socket = window.io('/ws/arcade', {
      transports: ['websocket', 'polling'],
      query: { code: code }
    });
    socket.on('connect', function () {
      socket.emit('turtle_join_host', { code: code });
    });
    socket.on('turtle:state', renderState);
    socket.on('turtle:ended', renderState);
    socket.on('turtle:error', function (payload) {
      setError(payload && payload.message ? payload.message : '거북이 경주 오류가 발생했습니다.');
    });
  }

  function createSession() {
    if (!enabled || !grade || !section) {
      setError('Board에서 인증된 상태로 열어 주세요.');
      return Promise.reject(new Error('Board 인증이 필요합니다.'));
    }
    return postJson('/api/arcade/turtle/sessions', {
      grade: grade,
      section: section,
      debugAllowAnyTime: debugAllowAnyTime
    }).then(function (state) {
      setupJoinCard(state);
      renderState(state);
      connectSocket(state.code);
      return state;
    }).catch(function (error) {
      setError(error.message);
      throw error;
    });
  }

  function renderState(state) {
    sessionState = state;
    serverOffsetMs = state.now - Date.now();
    els.statusText.textContent = statusLabel(state.status);
    els.raceStatus.textContent = statusLabel(state.status);
    els.phaseText.textContent = state.phaseLabel ? state.phaseLabel + ' · 거북이 경주' : '거북이 경주';
    var racers = (state.players || []).filter(function (player) { return player.role === 'player' && player.connected; }).length;
    var saboteurs = (state.players || []).filter(function (player) { return player.role === 'saboteur' && player.connected; }).length;
    els.playerCount.textContent = '플레이어 ' + racers + '명 · 훼방 ' + saboteurs + '명';
    els.startButton.disabled = state.status !== 'lobby' || racers < Number(state.minRacers || 2);
    els.endButton.disabled = state.status === 'ended';
    renderTrack(state.players || []);
    renderRankings(state);
    updateClock();
  }

  function renderTrack(players) {
    els.track.querySelectorAll('.lane').forEach(function (node) { node.remove(); });
    var racers = players.filter(function (player) { return player.role === 'player'; });
    if (!racers.length) {
      var empty = document.createElement('div');
      empty.className = 'lane';
      empty.innerHTML = '<span class="lane-name">플레이어 2명을 기다리는 중</span><span class="turtle"><img src="/turtle-01.png" alt=""></span>';
      els.track.appendChild(empty);
      return;
    }
    racers.forEach(function (player) {
      var lane = document.createElement('div');
      lane.className = 'lane';
      var name = document.createElement('span');
      name.className = 'lane-name';
      name.textContent = (player.rank ? player.rank + '위 · ' : '') + player.nickname + ' · ' + Math.round(player.progressPercent) + '%';
      var turtle = document.createElement('span');
      turtle.className = 'turtle';
      turtle.style.setProperty('--progress', String(Math.min(0.9, player.progress || 0)));
      var turtleImage = document.createElement('img');
      turtleImage.src = turtleSkinUrl(player.skin);
      turtleImage.alt = player.nickname + ' 거북이';
      turtle.appendChild(turtleImage);
      if (player.finished) {
        var flag = document.createElement('span');
        flag.className = 'finish-flag';
        flag.textContent = '🏁';
        turtle.appendChild(flag);
      }
      lane.appendChild(name);
      lane.appendChild(turtle);
      els.track.appendChild(lane);
    });
  }

  function renderRankings(state) {
    els.rankings.innerHTML = '';
    if (state.status === 'racing' && state.sabotageVote && state.sabotageVote.endsAt) {
      var voteChip = document.createElement('div');
      voteChip.className = 'chip';
      voteChip.textContent = '훼방 투표 ' + formatSeconds(state.sabotageVote.endsAt - currentServerNow()) + '초 · ' + (state.sabotageVote.votesCount || 0) + '표';
      els.rankings.appendChild(voteChip);
    }
    (state.recentEvents || []).slice(-3).reverse().forEach(function (event) {
      var eventChip = document.createElement('div');
      eventChip.className = 'chip';
      eventChip.textContent = event.message || (event.itemLabel + ' → ' + event.targetNickname);
      els.rankings.appendChild(eventChip);
    });
    (state.rankings || []).slice(0, 12).forEach(function (player, index) {
      var chip = document.createElement('div');
      chip.className = 'chip';
      chip.textContent = (index + 1) + '위 ' + player.nickname + ' · ' + Math.round(player.progressPercent) + '% · ' + player.taps + '탭';
      els.rankings.appendChild(chip);
    });
  }

  function turtleSkinUrl(skin) {
    var file = String(skin || 'turtle-01.png').split('/').pop();
    if (!/^turtle-0[1-3]\.png$/.test(file)) file = 'turtle-01.png';
    return '/' + file;
  }

  function updateClock() {
    if (!sessionState) return;
    var now = currentServerNow();
    if (sessionState.status === 'countdown') {
      els.timerText.textContent = formatSeconds(sessionState.startsAt - now);
    } else if (sessionState.status === 'racing') {
      els.timerText.textContent = formatSeconds(sessionState.endsAt - now);
    } else if (sessionState.status === 'ended') {
      els.timerText.textContent = '끝';
    } else {
      els.timerText.textContent = '--';
    }
    if (sessionState.status === 'racing') {
      renderRankings(sessionState);
    }
  }

  function sessionCode() {
    if (!sessionState || !sessionState.code) throw new Error('세션이 아직 준비되지 않았습니다.');
    return sessionState.code;
  }

  function installDebugConsole() {
    var api = {
      allowAnyTime: function () {
        debugAllowAnyTime = true;
        return createSession().then(function (state) {
          return { ok: true, code: state.code };
        }).catch(function (error) {
          return { ok: false, message: error.message };
        });
      },
      start: function () {
        return postJson('/api/arcade/turtle/sessions/' + encodeURIComponent(sessionCode()) + '/start').then(renderState);
      },
      end: function () {
        return postJson('/api/arcade/turtle/sessions/' + encodeURIComponent(sessionCode()) + '/end').then(renderState);
      },
      state: function () {
        return sessionState;
      }
    };
    window.TurtleDebug = api;
    window.ArcadeDebug = window.ArcadeDebug || api;
  }

  els.startButton.addEventListener('click', function () {
    if (!sessionState) return;
    els.startButton.disabled = true;
    postJson('/api/arcade/turtle/sessions/' + encodeURIComponent(sessionState.code) + '/start').then(renderState).catch(function (error) {
      setError(error.message);
    });
  });
  els.endButton.addEventListener('click', function () {
    if (!sessionState) return;
    postJson('/api/arcade/turtle/sessions/' + encodeURIComponent(sessionState.code) + '/end').then(renderState).catch(function (error) {
      setError(error.message);
    });
  });

  window.setInterval(updateClock, 200);
  installDebugConsole();
  createSession();

  window.render_game_to_text = function renderGameToText() {
    return JSON.stringify({
      mode: 'turtle-host',
      status: sessionState ? sessionState.status : 'loading',
      code: sessionState ? sessionState.code : null,
      players: sessionState ? sessionState.players.map(function (player) {
        return { nickname: player.nickname, skin: player.skin, progress: player.progressPercent, taps: player.taps, rank: player.rank };
      }) : []
    });
  };
})();
