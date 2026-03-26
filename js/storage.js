const connectionMonitor = (() => {
  const banner = document.getElementById('connectionStatusBanner');
  const OFFLINE_HTML = '현재 디미체크가 정상적으로 작동하지 않아 오프라인 모드로 전환합니다. 디미체크 상태는 <a href="https://checstat.netlify.app" target="_blank" rel="noopener noreferrer">checstat.netlify.app</a>에서 확인하실 수 있습니다. 상태를 계속 확인하는 중...';
  const ONLINE_HTML = '디미체크에 다시 연결되었습니다. 최신 상태를 동기화했습니다.';
  const FAILURE_THRESHOLD = 3;
  const RECOVERY_SUCCESS_THRESHOLD = 2;
  const OFFLINE_BANNER_DELAY_MS = 8000;
  let state = 'online';
  let healthTimer = null;
  let hideTimer = null;
  let offlineBannerTimer = null;
  let resyncInFlight = false;
  let failureStreak = 0;
  let successStreak = 0;

  function showBanner(variant, html, autoHideMs) {
    if (!banner) return;
    banner.innerHTML = html;
    banner.classList.remove('offline', 'online', 'visible');
    banner.classList.add(variant);
    banner.hidden = false;
    requestAnimationFrame(() => banner.classList.add('visible'));
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (autoHideMs) {
      hideTimer = window.setTimeout(() => {
        hideBanner();
      }, autoHideMs);
    }
  }

  function hideBanner() {
    if (!banner) return;
    banner.classList.remove('visible');
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    setTimeout(() => {
      if (!banner.classList.contains('visible')) {
        banner.hidden = true;
      }
    }, 250);
  }

  async function runHealthCheck() {
    try {
      const res = await fetch(`/healthz?ts=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`health ${res.status}`);
      markSuccess();
    } catch {
      failureStreak += 1;
      successStreak = 0;
      if (state !== 'offline' && failureStreak >= FAILURE_THRESHOLD) {
        failureStreak = 0;
        queueOfflineBanner();
        startHealthMonitoring();
      }
    }
  }

  function clearOfflineBannerTimer() {
    if (!offlineBannerTimer) return;
    clearTimeout(offlineBannerTimer);
    offlineBannerTimer = null;
  }

  function queueOfflineBanner() {
    if (state === 'offline' || offlineBannerTimer) return;
    offlineBannerTimer = window.setTimeout(() => {
      offlineBannerTimer = null;
      if (state === 'offline') return;
      if (navigator.onLine === false || failureStreak > 0) {
        state = 'offline';
        showBanner('offline', OFFLINE_HTML);
        startHealthMonitoring();
      }
    }, OFFLINE_BANNER_DELAY_MS);
  }

  function startHealthMonitoring() {
    if (healthTimer) return;
    runHealthCheck();
    healthTimer = window.setInterval(runHealthCheck, 5000);
  }

  function stopHealthMonitoring() {
    if (!healthTimer) return;
    clearInterval(healthTimer);
    healthTimer = null;
  }

  function triggerResync() {
    if (resyncInFlight) return;
    const fn = window.forceResyncState;
    if (typeof fn !== 'function') {
      return;
    }
    resyncInFlight = true;
    Promise.resolve()
      .then(() => fn())
      .catch(err => console.warn('[connection] resync failed', err))
      .finally(() => {
        resyncInFlight = false;
      });
  }

  function handleRecovery() {
    if (state !== 'offline') return;
    clearOfflineBannerTimer();
    failureStreak = 0;
    successStreak = 0;
    state = 'online';
    showBanner('online', ONLINE_HTML, 4000);
    stopHealthMonitoring();
    triggerResync();
  }

  function markFailure() {
    if (state === 'offline') {
      startHealthMonitoring();
      return;
    }
    queueOfflineBanner();
  }

  function markSuccess() {
    clearOfflineBannerTimer();
    failureStreak = 0;
    if (state === 'offline') {
      successStreak += 1;
      if (successStreak < RECOVERY_SUCCESS_THRESHOLD) return;
      successStreak = 0;
      handleRecovery();
      return;
    }
    if (healthTimer) {
      stopHealthMonitoring();
    }
  }

  function isOffline() {
    return state === 'offline';
  }

  window.addEventListener('offline', () => {
    failureStreak = 0;
    successStreak = 0;
    queueOfflineBanner();
    startHealthMonitoring();
  });

  window.addEventListener('online', () => {
    clearOfflineBannerTimer();
    startHealthMonitoring();
    runHealthCheck();
  });

  return {
    markFailure,
    markSuccess,
    isOffline,
  };
})();

window.connectionMonitor = connectionMonitor;

const marqueeState = {
  text: null,
  updatedAt: null,
  hideTimer: null,
  color: '#fdfcff',
  lastShownAt: null,
};

// Prevent stale poll responses from snapping magnets back right after local save.
let stateSyncPauseUntil = 0;
let loadStateInFlight = false;
const LOCAL_BOARD_STATE_VERSION = 1;
const BOARD_STATE_SAVE_RETRY_MS = 5000;
const BOARD_STATE_LOCAL_FIRST_PAUSE_MS = 4000;
const BOARD_STATE_LOCAL_PLACEMENT_GUARD_MS = 8000;
const MARQUEE_MAX_AGE_MS = 30 * 60 * 1000;

let lastAppliedStateSignature = '';
let boardStateSaveInFlight = false;
let boardStateSavePromise = null;
let boardStateSaveRetryTimer = null;
let pendingBoardStateSave = null;
let hydratedLocalBoardStateKey = null;
const recentLocalPlacementGuards = new Map();

let localBoardState = {
  key: null,
  storageKey: null,
  revision: 0,
  dirty: false,
  updatedAt: 0,
  magnets: {},
  marquee: null,
};

function deepCloneJson(value, fallback = null) {
  try {
    if (value == null) return fallback;
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function stableStringify(value) {
  if (value === undefined) {
    return '"__undefined__"';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function buildBoardStateSignature(magnets, marquee) {
  const safeMagnets = (magnets && typeof magnets === 'object') ? magnets : {};
  const normalizedMarquee = normalizeMarqueePayload(marquee);
  return stableStringify({ magnets: safeMagnets, marquee: normalizedMarquee });
}

function normalizeMagnetAttachedTarget(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized === 'section' || normalized === 'classroom') {
    return null;
  }
  return normalized;
}

function normalizeMagnetPlacementData(value) {
  const data = (value && typeof value === 'object') ? value : {};
  const attachedTo = normalizeMagnetAttachedTarget(data.attachedTo);
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  const left = Number(data.left);
  const top = Number(data.top);
  const roundedLeft = Number.isFinite(left) ? Math.round(left * 100) / 100 : null;
  const roundedTop = Number.isFinite(top) ? Math.round(top * 100) / 100 : null;

  if (attachedTo) {
    return {
      attachedTo,
      reason: reason || null,
    };
  }

  return {
    attachedTo: null,
    left: roundedLeft,
    top: roundedTop,
    reason: reason || null,
  };
}

function buildMagnetPlacementSignature(value) {
  return stableStringify(normalizeMagnetPlacementData(value));
}

function pruneRecentLocalPlacementGuards(now = Date.now()) {
  recentLocalPlacementGuards.forEach((until, magnetNumber) => {
    if (!Number.isFinite(until) || until <= now) {
      recentLocalPlacementGuards.delete(magnetNumber);
    }
  });
}

function markRecentLocalPlacementChanges(previousMagnets, nextMagnets) {
  const previous = (previousMagnets && typeof previousMagnets === 'object') ? previousMagnets : {};
  const next = (nextMagnets && typeof nextMagnets === 'object') ? nextMagnets : {};
  const guardUntil = Date.now() + BOARD_STATE_LOCAL_PLACEMENT_GUARD_MS;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);

  pruneRecentLocalPlacementGuards();

  keys.forEach((magnetNumber) => {
    if (buildMagnetPlacementSignature(previous[magnetNumber]) === buildMagnetPlacementSignature(next[magnetNumber])) {
      return;
    }
    recentLocalPlacementGuards.set(String(magnetNumber), guardUntil);
  });
}

function mergeLocalPlacementIntoRemoteMagnet(localMagnet, remoteMagnet) {
  const local = (localMagnet && typeof localMagnet === 'object') ? localMagnet : {};
  const remote = (remoteMagnet && typeof remoteMagnet === 'object') ? remoteMagnet : {};
  const merged = { ...remote };
  const attachedTo = normalizeMagnetAttachedTarget(local.attachedTo);
  const reason = typeof local.reason === 'string' ? local.reason.trim() : '';

  if (attachedTo) {
    merged.attachedTo = attachedTo;
    delete merged.left;
    delete merged.top;
  } else {
    merged.attachedTo = null;

    const left = Number(local.left);
    const top = Number(local.top);

    if (Number.isFinite(left)) {
      merged.left = left;
    } else {
      delete merged.left;
    }

    if (Number.isFinite(top)) {
      merged.top = top;
    } else {
      delete merged.top;
    }
  }

  if (reason) {
    merged.reason = reason;
  } else {
    delete merged.reason;
  }

  return merged;
}

function reconcileIncomingBoardStatePayload(payload, options = {}) {
  if (options.skipLocalPlacementGuard) {
    return payload;
  }

  const { grade, section } = options;
  if (grade == null || section == null) {
    return payload;
  }

  pruneRecentLocalPlacementGuards();
  if (!recentLocalPlacementGuards.size) {
    return payload;
  }

  const incomingPayload = (payload && typeof payload === 'object') ? payload : {};
  const incomingMagnets = (incomingPayload.magnets && typeof incomingPayload.magnets === 'object')
    ? incomingPayload.magnets
    : {};
  const localState = ensureLocalBoardState(grade, section);
  const localMagnets = (localState.magnets && typeof localState.magnets === 'object')
    ? localState.magnets
    : {};

  let nextMagnets = null;

  recentLocalPlacementGuards.forEach((_, magnetNumber) => {
    const localMagnet = localMagnets[magnetNumber];
    if (!localMagnet) {
      recentLocalPlacementGuards.delete(magnetNumber);
      return;
    }

    const localSignature = buildMagnetPlacementSignature(localMagnet);
    const incomingSignature = buildMagnetPlacementSignature(incomingMagnets[magnetNumber]);
    if (localSignature === incomingSignature) {
      recentLocalPlacementGuards.delete(magnetNumber);
      return;
    }

    if (!nextMagnets) {
      nextMagnets = deepCloneJson(incomingMagnets, {}) || {};
    }
    nextMagnets[magnetNumber] = mergeLocalPlacementIntoRemoteMagnet(localMagnet, nextMagnets[magnetNumber]);
  });

  if (!nextMagnets) {
    return payload;
  }

  return {
    ...incomingPayload,
    magnets: nextMagnets,
  };
}

function getBoardStateStorageKey(grade, section) {
  return `dimicheck:boardState:${grade}-${section}`;
}

function readLocalBoardStateSnapshot(storageKey) {
  if (!storageKey) return null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const magnets = (parsed.magnets && typeof parsed.magnets === 'object') ? parsed.magnets : {};
    const revisionRaw = Number(parsed.revision);
    const updatedAtRaw = Number(parsed.updatedAt);
    return {
      version: LOCAL_BOARD_STATE_VERSION,
      magnets,
      marquee: parsed.marquee ?? null,
      revision: Number.isFinite(revisionRaw) ? Math.max(0, revisionRaw) : 0,
      dirty: Boolean(parsed.dirty),
      updatedAt: Number.isFinite(updatedAtRaw) ? updatedAtRaw : 0,
    };
  } catch (_) {
    return null;
  }
}

function persistLocalBoardStateSnapshot(state) {
  if (!state || !state.storageKey) return;
  const payload = {
    version: LOCAL_BOARD_STATE_VERSION,
    magnets: deepCloneJson(state.magnets, {}),
    marquee: deepCloneJson(state.marquee, null),
    revision: Number.isFinite(Number(state.revision)) ? Number(state.revision) : 0,
    dirty: Boolean(state.dirty),
    updatedAt: Number.isFinite(Number(state.updatedAt)) ? Number(state.updatedAt) : Date.now(),
  };
  try {
    localStorage.setItem(state.storageKey, JSON.stringify(payload));
  } catch (_) {
    // ignore storage quota/security errors
  }
}

function ensureLocalBoardState(grade, section) {
  const key = `${grade}-${section}`;
  if (localBoardState.key === key) {
    return localBoardState;
  }

  const storageKey = getBoardStateStorageKey(grade, section);
  const snapshot = readLocalBoardStateSnapshot(storageKey);
  localBoardState = {
    key,
    storageKey,
    revision: snapshot?.revision || 0,
    dirty: Boolean(snapshot?.dirty),
    updatedAt: snapshot?.updatedAt || 0,
    magnets: deepCloneJson(snapshot?.magnets, {}) || {},
    marquee: Object.prototype.hasOwnProperty.call(snapshot || {}, 'marquee')
      ? deepCloneJson(snapshot.marquee, null)
      : null,
  };
  return localBoardState;
}

function updateLocalBoardState(grade, section, options = {}) {
  const state = ensureLocalBoardState(grade, section);
  const {
    magnets,
    marquee,
    incrementRevision = false,
    markDirty,
  } = options;

  if (incrementRevision) {
    state.revision = Math.max(0, Number(state.revision) || 0) + 1;
  }
  if (magnets !== undefined) {
    state.magnets = deepCloneJson(magnets, {}) || {};
  }
  if (marquee !== undefined) {
    state.marquee = deepCloneJson(marquee, null);
  }
  if (typeof markDirty === 'boolean') {
    state.dirty = markDirty;
  }
  state.updatedAt = Date.now();
  persistLocalBoardStateSnapshot(state);
  return state;
}

function collectCurrentMagnets() {
  const magnets = {};
  document.querySelectorAll('.magnet:not(.placeholder)').forEach(m => {
    const num = m.dataset.number;
    const data = {};
    if (m.dataset.reason) data.reason = m.dataset.reason;
    if (m.classList.contains('attached')) {
      const sec = m.closest('.board-section');
      data.attachedTo = sec ? sec.dataset.category : null;
    } else {
      data.attachedTo = null;
      data.left = parseFloat(m.style.left) || 0;
      data.top = parseFloat(m.style.top) || 0;
    }
    magnets[num] = data;
  });
  return magnets;
}

function scheduleBoardStateRetry() {
  if (boardStateSaveRetryTimer) return;
  boardStateSaveRetryTimer = window.setTimeout(() => {
    boardStateSaveRetryTimer = null;
    if (!pendingBoardStateSave || boardStateSaveInFlight) {
      return;
    }
    boardStateSavePromise = flushPendingBoardStateSave();
  }, BOARD_STATE_SAVE_RETRY_MS);
}

async function flushPendingBoardStateSave() {
  if (boardStateSaveInFlight) {
    return boardStateSavePromise || Promise.resolve(false);
  }

  boardStateSaveInFlight = true;
  const monitor = window.connectionMonitor;
  let latestResult = true;

  while (pendingBoardStateSave) {
    const request = pendingBoardStateSave;
    pendingBoardStateSave = null;

    try {
      const res = await fetch(`/api/classes/state/save?grade=${request.grade}&section=${request.section}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnets: request.magnets }),
      });
      if (!res.ok) {
        throw new Error(`save failed: ${res.status}`);
      }

      if (monitor && typeof monitor.markSuccess === 'function') {
        monitor.markSuccess();
      }

      const state = ensureLocalBoardState(request.grade, request.section);
      if (state.revision <= request.revision) {
        state.dirty = false;
        state.updatedAt = Date.now();
        persistLocalBoardStateSnapshot(state);
      }

      pauseStateSync(1500);
      latestResult = true;
    } catch (e) {
      console.warn('saveState failed:', e);
      latestResult = false;
      const state = ensureLocalBoardState(request.grade, request.section);
      state.dirty = true;
      state.updatedAt = Date.now();
      persistLocalBoardStateSnapshot(state);

      pendingBoardStateSave = {
        grade: request.grade,
        section: request.section,
        magnets: deepCloneJson(state.magnets, request.magnets) || request.magnets,
        revision: state.revision,
      };
      scheduleBoardStateRetry();
      break;
    }
  }

  boardStateSaveInFlight = false;
  return latestResult;
}

function queueBoardStateSave(grade, section, magnets, revision) {
  pendingBoardStateSave = {
    grade,
    section,
    magnets: deepCloneJson(magnets, {}) || {},
    revision: Number.isFinite(Number(revision)) ? Number(revision) : 0,
  };

  if (boardStateSaveRetryTimer) {
    clearTimeout(boardStateSaveRetryTimer);
    boardStateSaveRetryTimer = null;
  }

  if (!boardStateSaveInFlight) {
    boardStateSavePromise = flushPendingBoardStateSave();
  }

  return boardStateSavePromise || Promise.resolve(true);
}

async function hydrateBoardStateFromLocal(grade, section) {
  const key = `${grade}-${section}`;
  if (hydratedLocalBoardStateKey === key) {
    return;
  }
  hydratedLocalBoardStateKey = key;

  const state = ensureLocalBoardState(grade, section);
  const hasLocalPayload = state && (
    (state.magnets && Object.keys(state.magnets).length > 0) ||
    normalizeMarqueePayload(state.marquee)
  );
  if (!hasLocalPayload) return;

  await applyBoardStatePayload(
    { magnets: state.magnets, marquee: state.marquee },
    { grade, section, skipNormalizeSave: true }
  );
}

function pauseStateSync(ms = 0) {
  const until = Date.now() + Math.max(0, Number(ms) || 0);
  if (until > stateSyncPauseUntil) {
    stateSyncPauseUntil = until;
  }
}

function getMarqueeStorageKey() {
  try {
    const params = new URLSearchParams(window.location.search);
    const g = params.get('grade');
    const s = params.get('section');
    if (g && s) return `marquee:last:${g}-${s}`;
  } catch (_) {
    // ignore
  }
  return 'marquee:last:global';
}

function ensureMarqueeElements() {
  const overlay = document.getElementById('marqueeOverlay');
  const textEl = document.getElementById('marqueeText');
  if (!overlay || !textEl) return null;
  return { overlay, textEl };
}

function hideMarqueeOverlay() {
  const refs = ensureMarqueeElements();
  if (!refs) return;
  refs.overlay.hidden = true;
  refs.overlay.classList.remove('visible');
  if (marqueeState.hideTimer) {
    clearTimeout(marqueeState.hideTimer);
    marqueeState.hideTimer = null;
  }
}

function playMarqueeOverlay(text) {
  const refs = ensureMarqueeElements();
  if (!refs) return;
  const { overlay, textEl } = refs;

  textEl.textContent = text;
  textEl.style.color = marqueeState.color || '#fdfcff';
  textEl.style.setProperty('--marquee-color', marqueeState.color || '#fdfcff');

  overlay.hidden = false;
  overlay.classList.add('visible');

  // Cancel previous animation if any
  if (textEl._marqueeAnim && typeof textEl._marqueeAnim.cancel === 'function') {
    textEl._marqueeAnim.cancel();
  }

  // Measure widths to compute duration and distance
  const viewportWidth = window.innerWidth || overlay.clientWidth || 1200;
  const textWidth = Math.max(textEl.scrollWidth, 1);
  const startX = viewportWidth * 0.75; // start offscreen right
  const endX = -(textWidth + viewportWidth * 0.25); // end fully offscreen left
  const distance = Math.max(1, startX - endX);
  const speed = 440; // px per second (faster scroll)
  const duration = Math.max(6, Math.min(90, distance / speed));

  textEl.style.transform = `translateX(${startX}px)`;
  textEl._marqueeAnim = textEl.animate(
    [
      { transform: `translateX(${startX}px)` },
      { transform: `translateX(${endX}px)` }
    ],
    {
      duration: duration * 1000,
      easing: 'linear',
      fill: 'forwards'
    }
  );

  if (marqueeState.hideTimer) {
    clearTimeout(marqueeState.hideTimer);
  }

  marqueeState.lastShownAt = Date.now();

  marqueeState.hideTimer = window.setTimeout(() => {
    overlay.classList.remove('visible');
    overlay.hidden = true;
  }, duration * 1000 + 1500);
}

function normalizeMarqueePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const text = String(payload.text || '').trim();
  if (!text) return null;
  const colorRaw = String(payload.color || '#fdfcff').trim();
  const allowedLengths = [4, 5, 7, 9];
  const color = (colorRaw.startsWith('#') && allowedLengths.includes(colorRaw.length)) ? colorRaw : '#fdfcff';
  const updatedAt = payload.updatedAt || payload.updated_at || payload.postedAt || null;
  const updatedAtMs = updatedAt ? Date.parse(String(updatedAt)) : NaN;
  if (!Number.isFinite(updatedAtMs)) return null;
  if (Date.now() - updatedAtMs > MARQUEE_MAX_AGE_MS) return null;
  return {
    text: text.slice(0, 20),
    color,
    updatedAt,
  };
}

function handleMarqueePayload(payload) {
  const normalized = normalizeMarqueePayload(payload);
  if (!normalized) {
    marqueeState.text = null;
    marqueeState.updatedAt = null;
    hideMarqueeOverlay();
    return;
  }
  if (
    marqueeState.text === normalized.text &&
    marqueeState.updatedAt === normalized.updatedAt &&
    marqueeState.color === normalized.color &&
    marqueeState.lastShownAt
  ) {
    return;
  }

  const signature = `${normalized.text}|${normalized.color}|${normalized.updatedAt || ''}`;
  const storageKey = getMarqueeStorageKey();
  let seenSignature = false;
  try {
    seenSignature = localStorage.getItem(storageKey) === signature;
  } catch (_) {
    // ignore storage errors
  }
  if (seenSignature) {
    marqueeState.text = normalized.text;
    marqueeState.color = normalized.color;
    marqueeState.updatedAt = normalized.updatedAt || String(Date.now());
    marqueeState.lastShownAt = marqueeState.lastShownAt || Date.now();
    return;
  }

  marqueeState.text = normalized.text;
  marqueeState.color = normalized.color;
  marqueeState.updatedAt = normalized.updatedAt || String(Date.now());
  playMarqueeOverlay(normalized.text);

  try {
    localStorage.setItem(storageKey, signature);
  } catch (_) {
    // ignore storage errors
  }
}

async function saveState(grade, section) {
  const previousState = ensureLocalBoardState(grade, section);
  const previousMagnets = deepCloneJson(previousState.magnets, {}) || {};
  const magnets = collectCurrentMagnets();
  const state = updateLocalBoardState(grade, section, {
    magnets,
    incrementRevision: true,
    markDirty: true,
  });
  markRecentLocalPlacementChanges(previousMagnets, state.magnets);

  // Immediately trust local state first, then sync remote in background.
  lastAppliedStateSignature = buildBoardStateSignature(state.magnets, state.marquee);
  pauseStateSync(BOARD_STATE_LOCAL_FIRST_PAUSE_MS);

  return queueBoardStateSave(grade, section, state.magnets, state.revision);
}

async function fetchMagnetConfig(grade, section) {
  try {
    const res = await fetch(`/api/classes/config?grade=${grade}&section=${section}`);
    if (!res.ok) throw new Error("config load failed");
    return await res.json();  // { end: 31, skipNumbers: [12, 20, 25] }
  } catch (e) {
    console.error("fetchMagnetConfig failed:", e);
    return { end: 30, skipNumbers: [] }; // 기본값 fallback
  }
}

function restoreToFreePosition(el, data) {
  const container = document.getElementById('magnetContainer');
  if (!container) return;

  // 섹션에서 떼어내고 컨테이너로 복귀
  el.classList.remove('attached');
  container.appendChild(el);

  // 자유 상태에서는 이유 제거
  if (el.dataset.reason) {
    delete el.dataset.reason;
    el.classList.remove('has-reason');
  }

  // 저장된 좌표가 있으면 사용, 없으면 그리드 기본 자리로
  const L = Number(data && data.left);
  const T = Number(data && data.top);
  if (!Number.isNaN(L) && !Number.isNaN(T)) {
    el.style.left = `${L}px`;
    el.style.top  = `${T}px`;
    el.style.transform = 'translate(0,0)';
  } else {
    // 기본 고정격자 좌표로 스냅
    snapToHome(el);
  }
}

async function applyBoardStatePayload(payload, options = {}) {
  const resolvedPayload = reconcileIncomingBoardStatePayload(payload, options);
  const magnets = (resolvedPayload && typeof resolvedPayload === 'object' && resolvedPayload.magnets && typeof resolvedPayload.magnets === 'object')
    ? resolvedPayload.magnets
    : {};
  const marquee = resolvedPayload && typeof resolvedPayload === 'object' ? resolvedPayload.marquee : null;
  const signature = buildBoardStateSignature(magnets, marquee);

  if (lastAppliedStateSignature && signature === lastAppliedStateSignature) {
    return { applied: false, didNormalizeSection: false, magnets, marquee };
  }

  let didNormalizeSection = false;
  const thoughtProcessed = new Set();

  Object.entries(magnets).forEach(([num, rawData]) => {
    let el = document.querySelector(`.magnet[data-number="${num}"]`);
    if (!el) {
      const normalizedNum = String(parseInt(num, 10));
      if (normalizedNum && normalizedNum !== num) {
        el = document.querySelector(`.magnet[data-number="${normalizedNum}"]`);
      }
    }
    if (!el) return;

    const magnetData = (rawData && typeof rawData === 'object') ? rawData : {};
    const magnetNumber = el.dataset.number || String(num);
    thoughtProcessed.add(magnetNumber);

    if (magnetData.attachedTo === 'section') {
      restoreToFreePosition(el, magnetData);
      didNormalizeSection = true;
    } else if (magnetData.attachedTo) {
      const sec = document.querySelector(`.board-section[data-category="${magnetData.attachedTo}"] .section-content`);
      if (sec) {
        el.classList.add('attached');
        if (magnetData.reason) {
          el.dataset.reason = magnetData.reason.trim();
          el.classList.add('has-reason');
        } else {
          delete el.dataset.reason;
          el.classList.remove('has-reason');
        }
        sec.appendChild(el);
      } else {
        restoreToFreePosition(el, magnetData);
      }
    } else {
      restoreToFreePosition(el, magnetData);
    }

    if (typeof window.updateMagnetThoughtBubble === 'function') {
      window.updateMagnetThoughtBubble(el, magnetData);
    }

    if (typeof window.updateMagnetReaction === 'function') {
      window.updateMagnetReaction(el, magnetData);
    }
  });

  if (typeof window.updateMagnetThoughtBubble === 'function') {
    document.querySelectorAll('.magnet:not(.placeholder)').forEach(magnet => {
      const num = magnet.dataset.number || '';
      if (!thoughtProcessed.has(num)) {
        window.updateMagnetThoughtBubble(magnet, null);
      }
    });
  }

  if (typeof window.updateMagnetReaction === 'function') {
    document.querySelectorAll('.magnet:not(.placeholder)').forEach(magnet => {
      const num = magnet.dataset.number || '';
      if (!thoughtProcessed.has(num)) {
        window.updateMagnetReaction(magnet, null);
      }
    });
  }

  updateEtcReasonPanel();
  sortAllSections();
  updateAttendance();
  updateMagnetOutline();
  if (typeof window.repositionThoughtBubbles === 'function') {
    window.repositionThoughtBubbles();
  }

  handleMarqueePayload(marquee);
  lastAppliedStateSignature = signature;

  if (didNormalizeSection && !options.skipNormalizeSave) {
    await saveState(options.grade, options.section);
  }

  return { applied: true, didNormalizeSection, magnets, marquee };
}

async function loadState(grade, section, options = {}) {
  const monitor = window.connectionMonitor;
  const ignoreOffline = Boolean(options && options.ignoreOffline);
  const forceSync = Boolean(options && options.forceSync);

  await hydrateBoardStateFromLocal(grade, section);
  const localState = ensureLocalBoardState(grade, section);

  if (!forceSync && localState.dirty) {
    if (pendingBoardStateSave || boardStateSaveInFlight) {
      flushPendingBoardStateSave();
      return;
    }
    // Stale dirty snapshots should not block server truth forever on display boards.
    localState.dirty = false;
    persistLocalBoardStateSnapshot(localState);
  }

  if (!ignoreOffline && monitor && typeof monitor.isOffline === 'function' && monitor.isOffline()) {
    return;
  }
  if (!forceSync && Date.now() < stateSyncPauseUntil) {
    return;
  }
  if (loadStateInFlight) {
    return;
  }

  loadStateInFlight = true;
  const revisionAtRequest = localState.revision;
  try {
    const res = await fetch(`/api/classes/state/load?grade=${grade}&section=${section}`, { cache: 'no-store' });
    if (!res.ok) throw new Error("로드 실패");
    const parsed = await res.json();
    if (parsed?.wallpaper && typeof window.applyBoardWallpaperEntry === 'function') {
      window.applyBoardWallpaperEntry(parsed.wallpaper);
    }
    const latestLocalState = ensureLocalBoardState(grade, section);
    if (!forceSync && latestLocalState.dirty && latestLocalState.revision >= revisionAtRequest) {
      return;
    }

    const applyResult = await applyBoardStatePayload(parsed, { grade, section });
    if (applyResult.applied) {
      updateLocalBoardState(grade, section, {
        magnets: applyResult.magnets || {},
        marquee: applyResult.marquee ?? null,
        markDirty: false,
      });
    }

    if (monitor && typeof monitor.markSuccess === 'function') {
      monitor.markSuccess();
    }
  } catch (e) {
    console.error("loadState error:", e);
  } finally {
    loadStateInFlight = false;
  }
}

// Expose for other scripts
window.loadState = loadState;
window.saveState = saveState;
window.fetchMagnetConfig = fetchMagnetConfig;
window.flushBoardStateSync = flushPendingBoardStateSave;
window.hasPendingBoardSync = function hasPendingBoardSync(grade, section) {
  const state = ensureLocalBoardState(grade, section);
  return Boolean(
    state.dirty ||
    boardStateSaveInFlight ||
    pendingBoardStateSave
  );
};
