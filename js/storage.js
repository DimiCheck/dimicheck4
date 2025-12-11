const connectionMonitor = (() => {
  const banner = document.getElementById('connectionStatusBanner');
  const OFFLINE_HTML = '현재 디미체크가 정상적으로 작동하지 않아 오프라인 모드로 전환합니다. 디미체크 상태는 <a href="https://checstat.netlify.app" target="_blank" rel="noopener noreferrer">checstat.netlify.app</a>에서 확인하실 수 있습니다. 상태를 계속 확인하는 중...';
  const ONLINE_HTML = '디미체크에 다시 연결되었습니다. 최신 상태를 동기화했습니다.';
  let state = 'online';
  let healthTimer = null;
  let hideTimer = null;
  let resyncInFlight = false;

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
      handleRecovery();
    } catch {
      // keep waiting
    }
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
    state = 'online';
    showBanner('online', ONLINE_HTML, 4000);
    stopHealthMonitoring();
    triggerResync();
  }

  function markFailure() {
    if (state === 'offline') return;
    state = 'offline';
    showBanner('offline', OFFLINE_HTML);
    startHealthMonitoring();
  }

  function markSuccess() {
    if (state === 'offline') {
      handleRecovery();
    }
  }

  function isOffline() {
    return state === 'offline';
  }

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
  return {
    text: text.slice(0, 20),
    color,
    updatedAt: payload.updatedAt || payload.updated_at || payload.postedAt || null,
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
  const monitor = window.connectionMonitor;
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
      data.top  = parseFloat(m.style.top)  || 0;
    }
    magnets[num] = data;
  });

  try {
    const res = await fetch(`/api/classes/state/save?grade=${grade}&section=${section}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magnets })
    });
    if (!res.ok) {
      throw new Error(`save failed: ${res.status}`);
    }
    if (monitor && typeof monitor.markSuccess === 'function') {
      monitor.markSuccess();
    }
    return true;
  } catch (e) {
    console.warn("saveState failed:", e);
    if (monitor && typeof monitor.markFailure === 'function') {
      monitor.markFailure();
    }
    return false;
  }
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

async function loadState(grade, section, options = {}) {
  const monitor = window.connectionMonitor;
  const ignoreOffline = Boolean(options && options.ignoreOffline);
  if (!ignoreOffline && monitor && typeof monitor.isOffline === 'function' && monitor.isOffline()) {
    return;
  }

  try {
    const res = await fetch(`/api/classes/state/load?grade=${grade}&section=${section}`, { cache: 'no-store' });
    if (!res.ok) throw new Error("로드 실패");
    const parsed = await res.json();
    const magnets = parsed.magnets || {};
    let didNormalizeSection = false;
    const thoughtProcessed = new Set();

    // 자석 반영
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

      if (magnetData.attachedTo === "section") {
        restoreToFreePosition(el, magnetData);
        didNormalizeSection = true;
      } else if (magnetData.attachedTo) {
        const sec = document.querySelector(`.board-section[data-category="${magnetData.attachedTo}"] .section-content`);
        if (sec) {
          el.classList.add("attached");
          if (magnetData.reason) {
            el.dataset.reason = magnetData.reason.trim();   // ✅ reason 저장
            el.classList.add("has-reason");
          } else {
            delete el.dataset.reason;                       // ✅ reason 없을 때는 삭제
            el.classList.remove("has-reason");
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

      // Update reaction badge
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

    // Clear reactions for magnets not in the loaded state
    if (typeof window.updateMagnetReaction === 'function') {
      document.querySelectorAll('.magnet:not(.placeholder)').forEach(magnet => {
        const num = magnet.dataset.number || '';
        if (!thoughtProcessed.has(num)) {
          window.updateMagnetReaction(magnet, null);
        }
      });
    }

    // ✅ 끝나고 기타 패널 갱신
    updateEtcReasonPanel();
    sortAllSections();
    updateAttendance();
    updateMagnetOutline();
    if (typeof window.repositionThoughtBubbles === 'function') {
      window.repositionThoughtBubbles();
    }

    handleMarqueePayload(parsed.marquee);

    if (didNormalizeSection) {
      await saveState(grade, section);
    }

    if (monitor && typeof monitor.markSuccess === 'function') {
      monitor.markSuccess();
    }
  } catch (e) {
    console.error("loadState error:", e);
    if (monitor && typeof monitor.markFailure === 'function') {
      monitor.markFailure();
    }
  }
}

// Expose for other scripts
window.loadState = loadState;
window.saveState = saveState;
window.fetchMagnetConfig = fetchMagnetConfig;
