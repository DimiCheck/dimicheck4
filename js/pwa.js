(function () {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  let refreshing = false;

  function registerServiceWorker() {
    navigator.serviceWorker
      .register('/service-worker.js')
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
    refreshing = true;
    window.location.reload();
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
