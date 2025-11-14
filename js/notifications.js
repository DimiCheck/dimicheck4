(function (window) {
  const ICON = '/src/favicon/android-chrome-192x192.png';
  const BADGE = '/src/favicon/android-chrome-192x192.png';
  const TIMETABLE_TAG = 'dimicheck-timetable';
  const TIMETABLE_STORAGE_KEY = 'dimicheck:lastTimetableNotification';
  const CLASS_CONTEXT_KEY = 'dimicheck:class-context';

  class NotificationManager {
    constructor() {
      this.registration = null;
      this.periodicSupported = false;
      this.fallbackTimer = null;
      this.settings = window.preferences?.getSettings?.() || {};
      this.classContext = this.loadClassContext();
      this.isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
      this.isDesktopBrowser = this.detectDesktop();
      this.ready = this.init();
    }

    async init() {
      if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        return;
      }

      try {
        this.registration = await navigator.serviceWorker.ready;
        this.periodicSupported = Boolean(this.registration.periodicSync);
      } catch (error) {
        console.warn('[Notifications] Service worker not ready.', error);
      }

      window.addEventListener('dimicheck:settings-changed', (event) => {
        this.settings = event.detail || {};
        this.syncState();
      });

      this.syncState();
      this.pushClassContextToServiceWorker();
    }

    async syncState() {
      if (!this.registration) {
        return;
      }

      if (this.settings.chatNotifications) {
        const granted = await this.ensurePermission();
        if (!granted) {
          window.preferences?.setPreference?.('chatNotifications', false);
        }
      }

      if (this.settings.timetableNotifications) {
        const granted = await this.ensurePermission();
        if (!granted) {
          window.preferences?.setPreference?.('timetableNotifications', false);
          return;
        }
        await this.enableTimetableChannel();
      } else {
        await this.disableTimetableChannel();
      }

      if (this.shouldUseBrowserNotifications()) {
        const granted = await this.ensurePermission();
        if (!granted) {
          window.preferences?.setPreference?.('browserNotifications', false);
        }
      }
    }

    async ensurePermission() {
      if (!('Notification' in window)) {
        return false;
      }

      if (Notification.permission === 'granted') {
        return true;
      }

      if (Notification.permission === 'denied') {
        return false;
      }

      try {
        const result = await Notification.requestPermission();
        return result === 'granted';
      } catch (error) {
        console.warn('[Notifications] Permission request failed.', error);
        return false;
      }
    }

    async notifyChatMessages(messages) {
      if (!messages?.length) return;
      if (document.visibilityState === 'visible' && document.hasFocus()) return;

      const latest = messages[messages.length - 1];

      if (this.settings.chatNotifications && this.registration) {
        const granted = await this.ensurePermission();
        if (granted) {
          const options = this.buildNotificationOptions(latest);
          try {
            await this.registration.showNotification('새 채팅 메시지', options);
          } catch (error) {
            console.warn('[Notifications] Failed to show chat notification.', error);
          }
        }
        return;
      }

      if (this.shouldUseBrowserNotifications()) {
        const granted = await this.ensurePermission();
        if (!granted) return;
        try {
          const options = this.buildNotificationOptions(latest);
          new Notification('새 채팅 메시지', options);
        } catch (error) {
          console.warn('[Notifications] Browser notification failed.', error);
        }
      }
    }

    startFallbackTimer() {
      if (this.fallbackTimer) return;
      this.fallbackTimer = setInterval(() => this.checkTimetableWindow(), 60000);
      this.checkTimetableWindow();
    }

    stopFallbackTimer() {
      if (!this.fallbackTimer) return;
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }

    async enableTimetableChannel() {
      if (this.periodicSupported) {
        try {
          const tags = await this.registration.periodicSync.getTags();
          if (!tags.includes(TIMETABLE_TAG)) {
            await this.registration.periodicSync.register(TIMETABLE_TAG, {
              minInterval: 12 * 60 * 60 * 1000
            });
          }
        } catch (error) {
          console.warn('[Notifications] Periodic Sync unavailable.', error);
          this.periodicSupported = false;
        }
      }

      if (this.periodicSupported) {
      this.stopFallbackTimer();
    } else {
      this.startFallbackTimer();
    }

      this.registration?.active?.postMessage({
        type: 'TIMETABLE_PREF_CHANGED',
        enabled: !!this.settings.timetableNotifications
      });

      this.registration?.active?.postMessage({ type: 'TIMETABLE_FORCE_CHECK' });
    }

    async disableTimetableChannel() {
      if (this.registration?.periodicSync) {
        try {
          const tags = await this.registration.periodicSync.getTags();
          if (tags.includes(TIMETABLE_TAG)) {
            await this.registration.periodicSync.unregister(TIMETABLE_TAG);
          }
        } catch (error) {
          console.warn('[Notifications] Failed to unregister Periodic Sync.', error);
        }
      }

      this.stopFallbackTimer();
      try {
        localStorage.removeItem(TIMETABLE_STORAGE_KEY);
      } catch (error) {
        console.warn('[Notifications] Failed to reset timetable state.', error);
      }

      this.registration?.active?.postMessage({
        type: 'TIMETABLE_PREF_CHANGED',
        enabled: false
      });
    }

    checkTimetableWindow() {
      if (!this.settings.timetableNotifications) return;

      const now = new Date();
      if (!this.isWeekday(now)) return;
      if (now.getHours() >= 12) return;

      const target = new Date(now);
      target.setHours(6, 30, 0, 0);
      if (now.getTime() < target.getTime()) {
        return;
      }

      const dateKey = now.toISOString().slice(0, 10);
      const last = localStorage.getItem(TIMETABLE_STORAGE_KEY);
      if (last === dateKey) {
        return;
      }
      localStorage.setItem(TIMETABLE_STORAGE_KEY, dateKey);
      this.requestTimetableNotification();
    }

    requestTimetableNotification() {
      if (!this.registration?.active) return;
      this.registration.active.postMessage({ type: 'TIMETABLE_FORCE_CHECK' });
    }

    isWeekday(date) {
      const day = date.getDay();
      return day >= 1 && day <= 5;
    }

    async requestPermission() {
      return this.ensurePermission();
    }

    isSupported() {
      return 'Notification' in window && 'serviceWorker' in navigator;
    }

    isDesktop() {
      return this.isDesktopBrowser;
    }

    loadClassContext() {
      try {
        const raw = localStorage.getItem(CLASS_CONTEXT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return {
          grade: Number(parsed.grade) || null,
          section: Number(parsed.section) || null
        };
      } catch (error) {
        console.warn('[Notifications] Failed to parse class context.', error);
        return null;
      }
    }

    setClassContext(context) {
      if (!context) return;
      const grade = Number(context.grade);
      const section = Number(context.section);
      if (!grade || !section) return;

      this.classContext = { grade, section };
      try {
        localStorage.setItem(CLASS_CONTEXT_KEY, JSON.stringify(this.classContext));
      } catch (error) {
        console.warn('[Notifications] Failed to store class context.', error);
      }
      this.pushClassContextToServiceWorker();
    }

    pushClassContextToServiceWorker() {
      if (!this.registration?.active || !this.classContext) return;
      this.registration.active.postMessage({
        type: 'CLASS_CONTEXT',
        context: this.classContext
      });
    }

    shouldUseBrowserNotifications() {
      return (
        this.settings.browserNotifications &&
        this.isDesktopBrowser &&
        !this.isStandalone
      );
    }

    detectDesktop() {
      const ua = navigator.userAgent || navigator.vendor || '';
      const mobilePattern = /android|iphone|ipad|ipod|iemobile|blackberry|opera mini/i;
      return !mobilePattern.test(ua);
    }

    buildNotificationOptions(latest) {
      const title = latest.nickname
        ? `${latest.nickname}(${String(latest.studentNumber).padStart(2, '0')}번)`
        : `${String(latest.studentNumber).padStart(2, '0')}번`;
      const body = (latest.message && latest.message.trim())
        || (latest.imageUrl ? '이미지 메시지를 보냈습니다.' : '새 메시지가 도착했습니다.');

      const options = {
        body,
        tag: `chat-${latest.id}`,
        renotify: false,
        data: { url: '/chat.html' },
        icon: ICON,
        badge: BADGE,
        timestamp: Date.now()
      };

      if (latest.imageUrl) {
        options.image = latest.imageUrl;
      }

      return options;
    }
  }

  window.notificationManager = new NotificationManager();
})(window);
