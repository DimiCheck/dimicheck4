(function () {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  let refreshing = false;
  const SW_RELOAD_GUARD_KEY = 'dimicheck_sw_last_reload_at';
  const SW_RELOAD_GUARD_MS = 15000;

  async function resolveServiceWorkerUrl() {
    try {
      const res = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) {
        return '/service-worker.js';
      }
      const data = await res.json();
      const version = data && data.version ? String(data.version) : '';
      if (!version) {
        return '/service-worker.js';
      }
      return `/service-worker.js?v=${encodeURIComponent(version)}`;
    } catch (error) {
      return '/service-worker.js';
    }
  }

  async function registerServiceWorker() {
    const swUrl = await resolveServiceWorkerUrl();
    navigator.serviceWorker
      .register(swUrl, { updateViaCache: 'none' })
      .then((registration) => {
        onRegistration(registration);
      })
      .catch((error) => {
        console.error('[PWA] Service worker registration failed:', error);
      });
  }

  function onRegistration(registration) {
    if (registration.waiting) {
      dispatchUpdateEvent(registration.waiting);
    }

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) {
        return;
      }

      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          dispatchUpdateEvent(worker);
        }
      });
    });
  }

  function dispatchUpdateEvent(worker) {
    const updateEvent = new CustomEvent('dimicheck:pwa-update', { detail: worker });
    window.dispatchEvent(updateEvent);
  }

  window.addEventListener('load', registerServiceWorker);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const changeEvent = new Event('dimicheck:pwa-controllerchange');
    window.dispatchEvent(changeEvent);
    if (refreshing) {
      return;
    }
    const now = Date.now();
    let lastReloadAt = 0;
    try {
      lastReloadAt = Number(sessionStorage.getItem(SW_RELOAD_GUARD_KEY) || 0);
    } catch (error) {
      lastReloadAt = 0;
    }
    if (now - lastReloadAt < SW_RELOAD_GUARD_MS) {
      console.warn('[PWA] Skip reload to prevent service worker reload loop');
      return;
    }
    try {
      sessionStorage.setItem(SW_RELOAD_GUARD_KEY, String(now));
    } catch (error) {
      // Ignore storage failures
    }
    refreshing = true;
    window.location.reload();
  });
})();

(function chatNavGate() {
  const CHAT_NAV_SELECTOR = 'a.nav-item[href="/chat.html"]';
  const CHAT_GATE_CACHE_KEY = 'dimicheck.chatNavGate';
  const CHAT_GATE_CACHE_TTL_MS = 5 * 60 * 1000;

  function readCachedChatGateState() {
    try {
      const raw = sessionStorage.getItem(CHAT_GATE_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const ts = Number(parsed.ts || 0);
      if (!Number.isFinite(ts) || (Date.now() - ts) > CHAT_GATE_CACHE_TTL_MS) {
        return null;
      }
      return { chatEnabled: Boolean(parsed.chatEnabled) };
    } catch {
      return null;
    }
  }

  function writeCachedChatGateState(state) {
    try {
      sessionStorage.setItem(
        CHAT_GATE_CACHE_KEY,
        JSON.stringify({ chatEnabled: Boolean(state?.chatEnabled), ts: Date.now() }),
      );
    } catch {
      // ignore cache failures
    }
  }

  async function loadChatGateState() {
    const cached = readCachedChatGateState();
    if (cached) return cached;

    try {
      const authRes = await fetch('/auth/status', { credentials: 'include', cache: 'no-store' });
      if (!authRes.ok) return null;
      const auth = await authRes.json().catch(() => null);
      if (!auth?.logged_in || String(auth.role || auth.type || '').toLowerCase() !== 'student') {
        return null;
      }
      const grade = Number(auth.grade);
      const section = Number(auth.section || auth.class);
      if (!Number.isFinite(grade) || !Number.isFinite(section)) {
        return null;
      }
      const configRes = await fetch(`/api/classes/config?grade=${grade}&section=${section}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!configRes.ok) return null;
      const config = await configRes.json().catch(() => null);
      const state = { chatEnabled: Boolean(config?.chatEnabled) };
      writeCachedChatGateState(state);
      return state;
    } catch (error) {
      console.warn('[ChatNav] failed to resolve chat gate state', error);
      return null;
    }
  }

  function applyChatNavLabel(state) {
    if (!state || state.chatEnabled) return;
    document.querySelectorAll(CHAT_NAV_SELECTOR).forEach((link) => {
      const label = link.querySelector('span');
      if (label) {
        label.textContent = '공지';
      }
    });
  }

  window.addEventListener('DOMContentLoaded', async () => {
    if (!document.querySelector(CHAT_NAV_SELECTOR)) return;
    const state = await loadChatGateState();
    applyChatNavLabel(state);
  });
})();

// ---------------------------------------------------------------------------
// CSRF helper: automatically attach X-CSRF-Token for same-origin mutating requests
// ---------------------------------------------------------------------------
(function csrfFetchPatch() {
  const originalFetch = window.fetch;
  if (!originalFetch) return;

  async function fetchCsrfToken() {
    if (window.__csrfToken) return window.__csrfToken;
    try {
      const res = await originalFetch('/me', { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const token = data && (data.csrf_token || data.csrfToken);
      if (token) {
        window.__csrfToken = token;
      }
      return token || null;
    } catch (e) {
      console.warn('[CSRF] Failed to fetch token', e);
      return null;
    }
  }

  function shouldAttachCsrf(input, init) {
    const method = ((init && init.method) || (input && input.method) || 'GET').toString().toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return false;
    }
    let urlStr = '';
    if (typeof input === 'string') {
      urlStr = input;
    } else if (input && input.url) {
      urlStr = input.url;
    }
    try {
      const urlObj = new URL(urlStr, window.location.href);
      if (urlObj.origin !== window.location.origin) return false;
    } catch {
      return false;
    }
    return true;
  }

  window.fetch = async function patchedFetch(input, init = {}) {
    const attach = shouldAttachCsrf(input, init);
    if (!attach) {
      return originalFetch(input, init);
    }

    const token = await fetchCsrfToken();
    if (!token) {
      return originalFetch(input, init);
    }

    // Merge headers safely for Request/Init usage
    let headers = new Headers(init.headers || (input && input.headers));
    headers.set('X-CSRF-Token', token);

    const patchedInit = { ...init, headers };
    return originalFetch(input, patchedInit);
  };

  // Expose token getter for debugging or manual use
  window.getCsrfToken = fetchCsrfToken;
})();
