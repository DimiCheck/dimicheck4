(function () {
  const STORAGE_KEY = 'dimicheck.wallpaper.selection';
  const FALLBACK_WALLPAPERS = [
    {
      id: 'city-night-2024',
      name: '야경 네온 시티',
      url: 'https://cdn.pixabay.com/photo/2024/09/30/16/36/background-9086186_1280.jpg'
    },
    {
      id: 'ai-grid-2024',
      name: 'AI 패턴 스카이라인',
      url: 'https://cdn.pixabay.com/photo/2024/11/27/05/42/ai-generated-9227230_1280.jpg'
    }
  ];

  const wallpaperBtn = document.getElementById('wallpaperItem');
  const modal = document.getElementById('wallpaperModal');
  const grid = document.getElementById('wallpaperGrid');
  const modalClose = document.getElementById('wallpaperModalClose');
  const infoMenu = document.getElementById('infoMenu');
  const infoFab = document.getElementById('infoFab');

  let wallpapers = [...FALLBACK_WALLPAPERS];
  let selectedId = null;

  const savedSelection = loadSavedSelection();
  if (savedSelection?.url) {
    applyWallpaper(savedSelection.url);
    selectedId = savedSelection.id || savedSelection.url;
  }

  initialize();

  function closeInfoMenu() {
    if (infoMenu) infoMenu.classList.remove('open');
    if (infoFab) infoFab.setAttribute('aria-expanded', 'false');
  }

  function applyWallpaper(url) {
    if (!url) return;
    document.documentElement.style.setProperty('--wallpaper-url', `url('${url}')`);
  }

  function persistSelection(entry) {
    if (!entry || !entry.url) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: entry.id || null, url: entry.url }));
    } catch (_) {}
  }

  function loadSavedSelection() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.url) return parsed;
      if (typeof raw === 'string' && raw.startsWith('http')) return { id: null, url: raw };
    } catch (_) {}
    return null;
  }

  function openModal() {
    if (!modal) return;
    modal.hidden = false;
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
  }

  async function loadWallpapers() {
    try {
      const res = await fetch('wallpaper.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`wallpaper load failed: ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : (Array.isArray(data?.wallpapers) ? data.wallpapers : []);
      if (list.length) {
        return list.filter(item => item && item.url);
      }
    } catch (err) {
      console.warn('[wallpaper] 목록을 불러오지 못했습니다.', err);
    }
    return [...FALLBACK_WALLPAPERS];
  }

  function selectWallpaper(entry) {
    if (!entry || !entry.url) return;
    selectedId = entry.id || entry.url;
    applyWallpaper(entry.url);
    persistSelection(entry);
    renderGrid();
  }

  function renderGrid() {
    if (!grid) return;
    grid.innerHTML = '';

    if (!wallpapers.length) {
      const empty = document.createElement('div');
      empty.className = 'wallpaper-empty';
      empty.textContent = '등록된 배경화면이 없습니다.';
      grid.appendChild(empty);
      return;
    }

    wallpapers.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'wallpaper-card';
      const identity = item.id || item.url;
      if (identity === selectedId) card.classList.add('selected');

      const thumb = document.createElement('div');
      thumb.className = 'wallpaper-thumb';
      thumb.style.backgroundImage = `url('${item.url}')`;

      const badge = document.createElement('div');
      badge.className = 'wallpaper-badge';
      badge.textContent = identity === selectedId ? '현재 배경' : '미리보기';

      const meta = document.createElement('div');
      meta.className = 'wallpaper-meta';

      const name = document.createElement('div');
      name.className = 'wallpaper-name';
      name.textContent = item.name || '이름 없음';

      const applyBtn = document.createElement('button');
      applyBtn.className = 'wallpaper-apply';
      applyBtn.type = 'button';
      applyBtn.textContent = identity === selectedId ? '적용됨' : '적용';
      applyBtn.disabled = identity === selectedId;

      card.addEventListener('click', () => selectWallpaper(item));
      applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectWallpaper(item);
      });

      meta.append(name, applyBtn);
      card.append(thumb, badge, meta);
      grid.append(card);
    });
  }

  async function initialize() {
    const loaded = await loadWallpapers();
    if (loaded.length) wallpapers = loaded;

    const saved = loadSavedSelection();
    const hasSaved = saved && wallpapers.some(w => (w.id || w.url) === (saved.id || saved.url));
    let renderedViaSelect = false;
    if (hasSaved) {
      selectedId = saved.id || saved.url;
      applyWallpaper(saved.url);
    } else if (wallpapers[0]) {
      selectWallpaper(wallpapers[0]);
      renderedViaSelect = true;
    } else if (saved?.url) {
      applyWallpaper(saved.url);
    }

    if (!renderedViaSelect) renderGrid();

    if (wallpaperBtn) {
      wallpaperBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeInfoMenu();
        openModal();
      });
    }

    if (modalClose) modalClose.addEventListener('click', closeModal);
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.hidden) {
        closeModal();
        e.stopImmediatePropagation();
      }
    });
  }
})();
