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
  var turtleSkins = ['turtle-01.png', 'turtle-02.png', 'turtle-03.png'];
  var selectedSkin = turtleSkins[Math.floor(Math.random() * turtleSkins.length)];
  var selectedRole = 'player';
  var selectedSabotageTarget = '';
  var selectedSabotageItem = '';
  var activeVoteId = 0;
  var votedVoteId = 0;

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
    errorBox: document.getElementById('errorBox'),
    skinOptions: Array.prototype.slice.call(document.querySelectorAll('[data-turtle-skin]')),
    roleOptions: Array.prototype.slice.call(document.querySelectorAll('[data-turtle-role]')),
    gameSkinPicker: document.getElementById('gameSkinPicker'),
    entrySkinPicker: document.getElementById('entrySkinPicker'),
    sabotagePanel: document.getElementById('sabotagePanel'),
    sabotageStatus: document.getElementById('sabotageStatus'),
    sabotageTargets: document.getElementById('sabotageTargets'),
    sabotageItems: document.getElementById('sabotageItems'),
    fakeResetButton: document.getElementById('fakeResetButton')
  };

  restoreNickname();
  bindRolePicker();
  bindSkinPicker();
  updateRoleSelection();
  updateSkinSelection();

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
        avatar: avatarId(),
        skin: selectedSkin,
        role: selectedRole
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
    if (fresh) {
      player = fresh;
      if (player.skin && player.skin !== selectedSkin) {
        selectedSkin = sanitizeSkin(player.skin) || selectedSkin;
        updateSkinSelection();
      }
    }
    els.statusText.textContent = statusLabel(state.status);
    renderPlayer();
    renderSabotagePanel();
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
    var isSaboteur = player && player.role === 'saboteur';
    els.myProgress.textContent = progress + '%';
    els.progressBar.style.setProperty('--progress', progress + '%');
    els.tapCount.textContent = (player ? player.taps : 0) + ' taps';
    if (els.gameSkinPicker) {
      var canChoose = !isSaboteur && sessionState && (sessionState.status === 'lobby' || sessionState.status === 'countdown');
      els.gameSkinPicker.hidden = !canChoose;
      els.gameSkinPicker.classList.toggle('is-locked', !canChoose);
    }
    if (isSaboteur) {
      els.myProgress.textContent = '훼방';
      els.progressBar.style.setProperty('--progress', '100%');
      els.tapCount.textContent = '아이템 투표';
      els.tapButton.hidden = true;
      if (els.fakeResetButton) els.fakeResetButton.classList.remove('is-active');
    } else {
      els.tapButton.hidden = false;
    }
    var effects = (player && player.effects) || {};
    var shrinkActive = effects.shrink && effects.shrink > currentServerNow();
    var fakeResetActive = effects.fakeReset && effects.fakeReset > currentServerNow();
    els.tapButton.classList.toggle('is-shrunk', !!shrinkActive);
    if (els.fakeResetButton) {
      els.fakeResetButton.classList.toggle('is-active', !!fakeResetActive && !isSaboteur && sessionState && sessionState.status === 'racing');
    }
    if (!isSaboteur && sessionState && sessionState.status === 'racing' && player && !player.finished) {
      els.tapButton.disabled = false;
      els.tapButton.innerHTML = '<img src="' + turtleSkinUrl(selectedSkin) + '" alt="">전진';
    } else {
      els.tapButton.disabled = true;
      els.tapButton.textContent = sessionState && sessionState.status === 'countdown' ? '준비' : '대기';
    }
    if (isSaboteur) {
      els.myRank.textContent = '5초마다 아이템을 투표해 경주를 흔드세요.';
    } else if (player && player.rank) {
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
    if (sessionState.status === 'racing') {
      renderPlayer();
      renderSabotagePanel();
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

  function bindRolePicker() {
    els.roleOptions.forEach(function (button) {
      button.addEventListener('click', function () {
        selectedRole = button.getAttribute('data-turtle-role') === 'saboteur' ? 'saboteur' : 'player';
        updateRoleSelection();
      });
    });
  }

  function updateRoleSelection() {
    els.roleOptions.forEach(function (button) {
      var selected = button.getAttribute('data-turtle-role') === selectedRole;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    if (els.entrySkinPicker) {
      els.entrySkinPicker.hidden = selectedRole === 'saboteur';
    }
  }

  function bindSkinPicker() {
    els.skinOptions.forEach(function (button) {
      button.addEventListener('click', function () {
        var nextSkin = sanitizeSkin(button.getAttribute('data-turtle-skin'));
        if (!nextSkin) return;
        selectedSkin = nextSkin;
        updateSkinSelection();
        if (socket && socket.connected && sessionState && (sessionState.status === 'lobby' || sessionState.status === 'countdown')) {
          socket.emit('turtle_select_skin', {
            code: code,
            playerId: playerId,
            skin: selectedSkin
          });
        }
      });
    });
  }

  function updateSkinSelection() {
    els.skinOptions.forEach(function (button) {
      button.classList.toggle('is-selected', button.getAttribute('data-turtle-skin') === selectedSkin);
      button.setAttribute('aria-pressed', button.getAttribute('data-turtle-skin') === selectedSkin ? 'true' : 'false');
    });
  }

  function sanitizeSkin(skin) {
    var file = String(skin || '').split('/').pop();
    return turtleSkins.indexOf(file) === -1 ? '' : file;
  }

  function turtleSkinUrl(skin) {
    return '/' + (sanitizeSkin(skin) || 'turtle-01.png');
  }

  function renderSabotagePanel() {
    if (!els.sabotagePanel) return;
    var isSaboteur = player && player.role === 'saboteur';
    var active = isSaboteur && sessionState && sessionState.status === 'racing';
    els.sabotagePanel.classList.toggle('active', !!active);
    if (!active) return;
    var vote = sessionState.sabotageVote || {};
    var voteId = Number(vote.id || 0);
    if (voteId !== activeVoteId) {
      activeVoteId = voteId;
      selectedSabotageTarget = '';
      selectedSabotageItem = '';
    }
    var remaining = vote.endsAt ? formatSeconds(vote.endsAt - currentServerNow()) : '--';
    var targetName = selectedSabotageTarget ? selectedTargetName() : '';
    var itemName = selectedSabotageItem ? selectedItemName() : '';
    els.sabotageStatus.textContent = votedVoteId && voteId === votedVoteId
      ? '투표 완료 · 다음 투표까지 ' + remaining + '초'
      : (targetName || itemName ? '선택: ' + (targetName || '대상 미선택') + ' / ' + (itemName || '아이템 미선택') + ' · ' + remaining + '초' : '대상과 아이템을 고르세요 · ' + remaining + '초');
    renderSabotageTargets(voteId);
    renderSabotageItems(voteId);
  }

  function renderSabotageTargets(voteId) {
    els.sabotageTargets.innerHTML = '';
    (sessionState.players || []).filter(function (item) {
      return item.role === 'player' && !item.finished;
    }).forEach(function (target) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = target.nickname + ' · ' + Math.round(target.progressPercent || 0) + '%';
      button.classList.toggle('is-selected', selectedSabotageTarget === target.id);
      button.disabled = !!votedVoteId && voteId === votedVoteId;
      button.addEventListener('click', function () {
        selectedSabotageTarget = target.id;
        maybeSubmitSabotageVote(voteId);
      });
      els.sabotageTargets.appendChild(button);
    });
  }

  function renderSabotageItems(voteId) {
    els.sabotageItems.innerHTML = '';
    (sessionState.sabotageItems || []).forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      button.title = item.description || '';
      button.classList.toggle('is-selected', selectedSabotageItem === item.id);
      button.disabled = !!votedVoteId && voteId === votedVoteId;
      button.addEventListener('click', function () {
        selectedSabotageItem = item.id;
        maybeSubmitSabotageVote(voteId);
      });
      els.sabotageItems.appendChild(button);
    });
  }

  function maybeSubmitSabotageVote(voteId) {
    renderSabotagePanel();
    if (!selectedSabotageTarget || !selectedSabotageItem || !socket || !socket.connected) return;
    votedVoteId = voteId;
    socket.emit('turtle_sabotage_vote', {
      code: code,
      playerId: playerId,
      targetId: selectedSabotageTarget,
      itemId: selectedSabotageItem
    });
    renderSabotagePanel();
  }

  function selectedTargetName() {
    var targets = (sessionState && sessionState.players) || [];
    for (var i = 0; i < targets.length; i += 1) {
      if (targets[i].id === selectedSabotageTarget) return targets[i].nickname;
    }
    return '';
  }

  function selectedItemName() {
    var items = (sessionState && sessionState.sabotageItems) || [];
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].id === selectedSabotageItem) return items[i].label;
    }
    return '';
  }

  els.tapButton.addEventListener('click', function () {
    if (!sessionState || sessionState.status !== 'racing' || (player && player.finished)) return;
    pendingTaps += 1;
    if (player) {
      player.taps += 1;
      player.progressPercent = Math.min(100, (player.progressPercent || 0) + ((sessionState.tapProgress || 0.007) * 100));
      player.progress = player.progressPercent / 100;
      renderPlayer();
    }
    if (pendingTaps >= 6) flushTaps();
  });
  if (els.fakeResetButton) {
    els.fakeResetButton.addEventListener('click', function () {
      els.fakeResetButton.classList.remove('is-active');
      els.myRank.textContent = '함정 버튼이었어요. 계속 전진하세요.';
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
        role: player.role,
        skin: player.skin,
        progress: player.progressPercent,
        taps: player.taps,
        rank: player.rank,
        effects: player.effects
      } : null
    });
  };
})();
