(function (window) {
  const STORAGE_KEY = 'dimicheck:settings';
  const DEFAULT_SETTINGS = {
    theme: 'system',
    chatNotifications: false,
    timetableNotifications: false,
    browserNotifications: false
  };

  let settings = loadSettings();
  const subscribers = new Set();

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return { ...DEFAULT_SETTINGS };
      }
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed
      };
    } catch (error) {
      console.warn('[Preferences] Failed to parse settings, resetting.', error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn('[Preferences] Failed to save settings.', error);
    }
    notify();
  }

  function notify() {
    const snapshot = { ...settings };
    subscribers.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (error) {
        console.warn('[Preferences] subscriber error', error);
      }
    });
    window.dispatchEvent(
      new CustomEvent('dimicheck:settings-changed', { detail: snapshot })
    );
  }

  function applyThemePreference() {
    const theme = settings.theme;
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }

  function setThemePreference(theme) {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') {
      return;
    }
    settings = { ...settings, theme };
    applyThemePreference();
    persist();
  }

  function update(partial) {
    settings = { ...settings, ...partial };
    persist();
  }

  applyThemePreference();
  notify();

  window.preferences = {
    getSettings() {
      return { ...settings };
    },
    setThemePreference,
    setPreference(key, value) {
      update({ [key]: value });
    },
    update,
    subscribe(callback) {
      if (typeof callback !== 'function') {
        return () => {};
      }
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    applyTheme: applyThemePreference
  };
})(window);
