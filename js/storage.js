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
