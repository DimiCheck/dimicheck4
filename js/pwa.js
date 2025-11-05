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
