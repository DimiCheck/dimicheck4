const CACHE_VERSION = 'v4';
const STATIC_CACHE = `dimicheck-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `dimicheck-runtime-${CACHE_VERSION}`;
const TIMETABLE_META_CACHE = 'dimicheck-timetable-meta';
const TIMETABLE_META_URL = '/__timetable-meta__';
const CLASS_CONTEXT_URL = '/__class-context__';
const ATPT_OFCDC_SC_CODE = 'J10';
const SD_SCHUL_CODE = '7530560';
const NEIS_API_KEY = 'da82433f0f3a4351bda4ca9a0f11fc7d';
const PRECACHE_URLS = [
  '/',
  '/login.html',
  '/user.html',
  '/my.html',
  '/schoollife.html',
  '/routine.html',
  '/enter_pin.html',
  '/404.html',
  '/manifest.webmanifest',
  '/main.css',
  '/js/preferences.js',
  '/js/notifications.js',
  '/js/my-page.js',
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
    if (networkResponse && networkResponse.ok && networkResponse.status !== 206) {
      runtime.put(request, networkResponse.clone());
    }
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
      if (networkResponse && networkResponse.ok && networkResponse.status !== 206) {
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
    if (response && response.ok && response.status !== 206) {
      const runtime = await caches.open(RUNTIME_CACHE);
      await runtime.put(request, response.clone());
    }
  } catch (error) {
    // Ignore background update failures
  }
}

self.addEventListener('notificationclick', (event) => {
  const targetUrl = event.notification?.data?.url || '/';
  event.notification?.close();
  event.waitUntil(openOrFocusClient(targetUrl));
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'TIMETABLE_FORCE_CHECK') {
    event.waitUntil(triggerTimetableNotification());
  }
  if (data.type === 'TIMETABLE_PREF_CHANGED' && data.enabled === false) {
    event.waitUntil(clearTimetableMeta());
  }
  if (data.type === 'CLASS_CONTEXT') {
    event.waitUntil(storeClassContext(data.context));
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'dimicheck-timetable') {
    event.waitUntil(triggerTimetableNotification());
  }
});

async function openOrFocusClient(url) {
  const target = new URL(url, self.location.origin);
  const clientsList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientsList) {
    const clientUrl = new URL(client.url);
    if (clientUrl.pathname === target.pathname) {
      await client.focus();
      return client;
    }
  }
  return clients.openWindow(target.href);
}

async function triggerTimetableNotification() {
  const now = new Date();
  if (!isWeekday(now)) {
    return;
  }
  if (now.getHours() >= 12) {
    return;
  }
  const target = new Date(now);
  target.setHours(6, 30, 0, 0);
  if (now.getTime() < target.getTime()) {
    return;
  }

  const dateKey = now.toISOString().slice(0, 10);
  const last = await getLastTimetableDate();
  if (last === dateKey) {
    return;
  }

  const context = await getClassContext();
  if (!context || !context.grade || !context.section) {
    return;
  }

  const timetableLines = await fetchTodayTimetable(context.grade, context.section, now);

  try {
    await self.registration.showNotification('시간표 알림', {
      body: timetableLines.length ? timetableLines.join('\n') : '오늘 일정을 확인해보세요.',
      tag: 'dimicheck-timetable',
      data: { url: '/routine.html' },
      icon: '/src/favicon/android-chrome-192x192.png',
      badge: '/src/favicon/android-chrome-192x192.png',
      timestamp: Date.now()
    });
    await setLastTimetableDate(dateKey);
  } catch (error) {
    console.warn('[SW] Failed to show timetable notification', error);
  }
}

async function getLastTimetableDate() {
  const cache = await caches.open(TIMETABLE_META_CACHE);
  const match = await cache.match(TIMETABLE_META_URL);
  if (!match) {
    return null;
  }
  return match.text();
}

async function setLastTimetableDate(dateKey) {
  const cache = await caches.open(TIMETABLE_META_CACHE);
  await cache.put(TIMETABLE_META_URL, new Response(dateKey, {
    headers: { 'Content-Type': 'text/plain' }
  }));
}

async function clearTimetableMeta() {
  const cache = await caches.open(TIMETABLE_META_CACHE);
  await cache.delete(TIMETABLE_META_URL);
}

async function storeClassContext(context) {
  const cache = await caches.open(TIMETABLE_META_CACHE);
  const grade = Number(context?.grade);
  const section = Number(context?.section);
  if (!grade || !section) {
    await cache.delete(CLASS_CONTEXT_URL);
    return;
  }
  await cache.put(
    CLASS_CONTEXT_URL,
    new Response(JSON.stringify({ grade, section }), { headers: { 'Content-Type': 'application/json' } })
  );
}

async function getClassContext() {
  const cache = await caches.open(TIMETABLE_META_CACHE);
  const match = await cache.match(CLASS_CONTEXT_URL);
  if (!match) {
    return null;
  }
  try {
    const parsed = await match.json();
    const grade = Number(parsed?.grade);
    const section = Number(parsed?.section);
    if (!grade || !section) {
      return null;
    }
    return { grade, section };
  } catch (error) {
    console.warn('[SW] Failed to read class context', error);
    return null;
  }
}

function isWeekday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function formatYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function normalizeSubject(row) {
  return (
    row?.ITRT_CNTNT ||
    row?.SUBJECT ||
    row?.SUB_NM ||
    row?.CONT ||
    row?.CONTNT ||
    ''
  );
}

async function fetchTodayTimetable(grade, section, date = new Date()) {
  try {
    const params = new URLSearchParams({
      KEY: NEIS_API_KEY,
      Type: 'json',
      ATPT_OFCDC_SC_CODE,
      SD_SCHUL_CODE,
      GRADE: grade,
      CLASS_NM: section,
      ALL_TI_YMD: formatYMD(date)
    });

    const response = await fetch(`https://open.neis.go.kr/hub/hisTimetable?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`NEIS error ${response.status}`);
    }

    const data = await response.json();
    const tables = data?.hisTimetable;
    if (!Array.isArray(tables)) {
      return [];
    }
    const rows = tables.find((part) => Array.isArray(part.row))?.row || [];
    const sorted = rows
      .map((row) => ({
        period: Number(row?.PERIO || row?.PERIOD || row?.ITRT_CNTNTSEQ || row?.PERIOD_NM) || null,
        subject: normalizeSubject(row)
      }))
      .filter((item) => item.subject)
      .sort((a, b) => {
        if (a.period == null) return 1;
        if (b.period == null) return -1;
        return a.period - b.period;
      });

    return sorted.map((item, index) => {
      const label = item.period ? `${item.period}교시` : `${index + 1}교시`;
      return `${label}: ${item.subject}`;
    });
  } catch (error) {
    console.warn('[SW] Failed to fetch timetable data', error);
    return [];
  }
}
