(function () {
  const FALLBACK_WALLPAPERS = [
    {
      id: 'just-black-2024',
      name: '단색 검정',
      url: 'src/wallpaper-black.svg'
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
  const boardContext = getBoardContext();
  const STORAGE_KEY = boardContext ? `dimicheck.wallpaper.selection.${boardContext.grade}-${boardContext.section}` : 'dimicheck.wallpaper.selection';

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

  function applyWallpaperEntry(entry, options = {}) {
    if (!entry?.url) return;
    selectedId = entry.id || entry.url;
    applyWallpaper(entry.url);
    if (!options.skipPersist) {
      persistSelection(entry);
    }
    renderGrid();
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

  function getBoardContext() {
    try {
      const params = new URLSearchParams(window.location.search);
      const grade = Number(params.get('grade'));
      const section = Number(params.get('section'));
      if (Number.isFinite(grade) && Number.isFinite(section)) {
        return { grade, section };
      }
    } catch (_) {}
    return null;
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

  async function loadCurrentWallpaper() {
    if (!boardContext) return null;
    try {
      const res = await fetch(`/api/classes/wallpaper?grade=${boardContext.grade}&section=${boardContext.section}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`wallpaper state load failed: ${res.status}`);
      const data = await res.json();
      return data?.wallpaper?.url ? data.wallpaper : null;
    } catch (err) {
      console.warn('[wallpaper] 현재 배경을 불러오지 못했습니다.', err);
      return null;
    }
  }

  async function persistWallpaper(entry) {
    if (!boardContext || !entry?.url) {
      persistSelection(entry);
      return true;
    }
    try {
      const res = await fetch(`/api/classes/wallpaper?grade=${boardContext.grade}&section=${boardContext.section}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallpaper: {
            id: entry.id || '',
            name: entry.name || '',
            url: entry.url,
          }
        }),
      });
      if (!res.ok) throw new Error(`wallpaper save failed: ${res.status}`);
      persistSelection(entry);
      return true;
    } catch (err) {
      console.warn('[wallpaper] 배경 저장에 실패했습니다.', err);
      persistSelection(entry);
      return false;
    }
  }

  async function selectWallpaper(entry) {
    if (!entry || !entry.url) return;
    applyWallpaperEntry(entry, { skipPersist: true });
    await persistWallpaper(entry);
  }

  function getDefaultWallpaper(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return list.find((item) => item?.id === 'just-black-2024') || list[0];
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

      card.addEventListener('click', () => { void selectWallpaper(item); });
      applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void selectWallpaper(item);
      });

      meta.append(name, applyBtn);
      card.append(thumb, badge, meta);
      grid.append(card);
    });
  }

  async function initialize() {
    const loaded = await loadWallpapers();
    if (loaded.length) wallpapers = loaded;

    const saved = await loadCurrentWallpaper() || loadSavedSelection();
    const hasSaved = saved && wallpapers.some(w => (w.id || w.url) === (saved.id || saved.url));
    let renderedViaSelect = false;
    if (hasSaved) {
      selectedId = saved.id || saved.url;
      applyWallpaper(saved.url);
    } else if (wallpapers[0]) {
      await selectWallpaper(getDefaultWallpaper(wallpapers));
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

  window.applyBoardWallpaperEntry = function applyBoardWallpaperEntry(entry) {
    if (!entry?.url) return;
    applyWallpaperEntry(entry);
  };
})();
