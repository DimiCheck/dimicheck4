(function () {
  const WHATS_NEW_VERSION = 'board-whats-new-2026-04-multi-select-drop';
  const WHATS_NEW_SEEN_KEY = 'dimicheck:board-whats-new-seen';
  const WHATS_NEW_MENU_OPENED_KEY = 'dimicheck:board-whats-new-menu-opened';
  const WHATS_NEW_FIRST_EXPOSED_KEY = 'dimicheck:board-whats-new-first-exposed';
  const FAB_BADGE_TTL_MS = 24 * 60 * 60 * 1000;

  const infoFab = document.getElementById('infoFab');
  const infoMenu = document.getElementById('infoMenu');
  const whatsNewItem = document.getElementById('whatsNewItem');
  const whatsNewModal = document.getElementById('whatsNewModal');
  const whatsNewClose = document.getElementById('whatsNewClose');
  const whatsNewConfirm = document.getElementById('whatsNewConfirm');
  const arcadeItem = document.getElementById('arcadeItem');

  if (!infoFab || !infoMenu) {
    return;
  }

  function closeInfoMenu() {
    infoMenu.classList.remove('open');
    infoFab.setAttribute('aria-expanded', 'false');
  }

  function getSeenVersion() {
    try {
      return localStorage.getItem(WHATS_NEW_SEEN_KEY);
    } catch (error) {
      console.warn('[Board info] failed to read whats-new version', error);
      return null;
    }
  }

  function getStoredVersion(keyName) {
    try {
      return localStorage.getItem(keyName);
    } catch (error) {
      console.warn('[Board info] failed to read whats-new marker', error);
      return null;
    }
  }

  function setStoredVersion(keyName, version) {
    try {
      localStorage.setItem(keyName, version);
    } catch (error) {
      console.warn('[Board info] failed to persist whats-new marker', error);
    }
  }

  function getFirstExposedStorageKey() {
    return `${WHATS_NEW_FIRST_EXPOSED_KEY}:${WHATS_NEW_VERSION}`;
  }

  function getFirstExposedAt() {
    try {
      const raw = localStorage.getItem(getFirstExposedStorageKey());
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    } catch (error) {
      console.warn('[Board info] failed to read first-exposed timestamp', error);
      return null;
    }
  }

  function setFirstExposedAt(timestamp) {
    try {
      localStorage.setItem(getFirstExposedStorageKey(), String(timestamp));
    } catch (error) {
      console.warn('[Board info] failed to persist first-exposed timestamp', error);
    }
  }

  function ensureExposureWindow() {
    const seenVersion = getSeenVersion();
    if (seenVersion === WHATS_NEW_VERSION) {
      return;
    }
    const menuOpenedVersion = getStoredVersion(WHATS_NEW_MENU_OPENED_KEY);
    if (menuOpenedVersion === WHATS_NEW_VERSION) {
      return;
    }
    const firstExposedAt = getFirstExposedAt();
    if (firstExposedAt == null) {
      setFirstExposedAt(Date.now());
    }
  }

  function markWhatsNewSeen() {
    setStoredVersion(WHATS_NEW_SEEN_KEY, WHATS_NEW_VERSION);
    setStoredVersion(WHATS_NEW_MENU_OPENED_KEY, WHATS_NEW_VERSION);
  }

  function markWhatsNewMenuOpened() {
    setStoredVersion(WHATS_NEW_MENU_OPENED_KEY, WHATS_NEW_VERSION);
  }

  function hasUnreadWhatsNew() {
    return getSeenVersion() !== WHATS_NEW_VERSION;
  }

  function shouldShowFabBadge() {
    if (!hasUnreadWhatsNew()) {
      return false;
    }
    const menuOpenedVersion = getStoredVersion(WHATS_NEW_MENU_OPENED_KEY);
    if (menuOpenedVersion === WHATS_NEW_VERSION) {
      return false;
    }
    const firstExposedAt = getFirstExposedAt();
    if (firstExposedAt == null) {
      return true;
    }
    return Date.now() - firstExposedAt < FAB_BADGE_TTL_MS;
  }

  function updateWhatsNewIndicators() {
    const unread = hasUnreadWhatsNew();
    infoFab.classList.toggle('has-unread', shouldShowFabBadge());
    if (whatsNewItem) {
      whatsNewItem.classList.toggle('fab-item--seen', !unread);
    }
  }

  function closeWhatsNewModal() {
    if (!whatsNewModal) return;
    whatsNewModal.hidden = true;
  }

  function openWhatsNewModal() {
    if (!whatsNewModal) return;
    closeInfoMenu();
    whatsNewModal.hidden = false;
  }

  function acknowledgeWhatsNew() {
    markWhatsNewSeen();
    updateWhatsNewIndicators();
    closeWhatsNewModal();
  }

  infoFab.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = infoMenu.classList.toggle('open');
    infoFab.setAttribute('aria-expanded', String(isOpen));
    if (isOpen && hasUnreadWhatsNew()) {
      markWhatsNewMenuOpened();
      updateWhatsNewIndicators();
    }
  });

  document.addEventListener('click', (event) => {
    if (!infoMenu.classList.contains('open')) return;
    const target = event.target;
    if (target === infoFab || infoFab.contains(target) || infoMenu.contains(target)) return;
    closeInfoMenu();
  });

  whatsNewItem?.addEventListener('click', () => {
    openWhatsNewModal();
  });

  arcadeItem?.addEventListener('click', () => {
    const grade = window.boardGrade || new URLSearchParams(window.location.search).get('grade');
    const section = window.boardSection || new URLSearchParams(window.location.search).get('section');
    if (!grade || !section) {
      return;
    }
    window.location.href = `/arcade/host?grade=${encodeURIComponent(grade)}&section=${encodeURIComponent(section)}`;
  });

  whatsNewClose?.addEventListener('click', closeWhatsNewModal);
  whatsNewConfirm?.addEventListener('click', acknowledgeWhatsNew);

  whatsNewModal?.addEventListener('click', (event) => {
    if (event.target === whatsNewModal) {
      closeWhatsNewModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (whatsNewModal && !whatsNewModal.hidden) {
      closeWhatsNewModal();
      return;
    }
    closeInfoMenu();
  });

  ensureExposureWindow();
  updateWhatsNewIndicators();
})();
