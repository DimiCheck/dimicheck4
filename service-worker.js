const CACHE_VERSION = 'v1';
const STATIC_CACHE = `dimicheck-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `dimicheck-runtime-${CACHE_VERSION}`;
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/login.html',
  '/user.html',
  '/schoollife.html',
  '/routine.html',
  '/enter_pin.html',
  '/404.html',
  '/manifest.webmanifest',
  '/main.css',
  '/js/etc.js',
  '/js/info.js',
  '/js/magnet.js',
  '/js/reset.js',
  '/js/storage.js',
  '/js/time.js',
  '/js/pwa.js',
  '/src/infoicn.png',
  '/src/dimicheck_templogo.png',
  '/src/dipulllogo.svg',
  '/src/favicon/android-chrome-192x192.png',
  '/src/favicon/android-chrome-512x512.png',
  '/src/favicon/apple-touch-icon.png',
  '/src/favicon/favicon-32x32.png',
  '/src/favicon/favicon-16x16.png',
  '/src/favicon/favicon.ico'
];
const PRECACHE_SET = new Set(PRECACHE_URLS);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const currentCaches = [STATIC_CACHE, RUNTIME_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !currentCaches.includes(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/api/') ||
     url.pathname.startsWith('/auth/') ||
     url.pathname === '/me')
  ) {
    event.respondWith(
      fetch(request).catch(async () => {
        const fallback = await caches.match(request);
        if (fallback) {
          return fallback;
        }
        throw new Error('Network request failed and no cache entry found.');
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  event.respondWith(handleAssetRequest(event, request, url));
});

async function handleNavigationRequest(request) {
  try {
    const networkResponse = await fetch(request);
    const runtime = await caches.open(RUNTIME_CACHE);
    runtime.put(request, networkResponse.clone());
    return networkResponse;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    const fallback = await caches.match('/index.html');
    if (fallback) {
      return fallback;
    }
    throw error;
  }
}

function handleAssetRequest(event, request, url) {
  return (async () => {
    const cached = await caches.match(request);
    if (cached) {
      event.waitUntil(updateRuntimeCache(request));
      return cached;
    }

    try {
      const networkResponse = await fetch(request);
      if (networkResponse && networkResponse.ok) {
        const runtime = await caches.open(RUNTIME_CACHE);
        await runtime.put(request, networkResponse.clone());
      }
      return networkResponse;
    } catch (error) {
      if (PRECACHE_SET.has(url.pathname)) {
        const fallback = await caches.match(url.pathname);
        if (fallback) {
          return fallback;
        }
      }
      throw error;
    }
  })();
}

async function updateRuntimeCache(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const runtime = await caches.open(RUNTIME_CACHE);
      await runtime.put(request, response.clone());
    }
  } catch (error) {
    // Ignore background update failures
  }
}
