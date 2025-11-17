/**
 * Simple client-side auth guard that ensures the current user is logged in.
 * Redirects to the auth login page when no valid session is found.
 */
(function authGuard() {
  const redirectToLogin = () => {
    // Avoid redirect loops if the user is already on an auth/login page.
    if (window.location.pathname.startsWith('/auth')) return;
    if (window.location.pathname === '/login.html') return;
    window.location.href = '/auth/login';
  };

  async function ensureAuthenticated() {
    try {
      const res = await fetch('/auth/status', { credentials: 'include' });
      if (!res.ok) {
        redirectToLogin();
        return null;
      }

      const data = await res.json().catch(() => null);
      if (!data || !data.logged_in) {
        redirectToLogin();
        return null;
      }

      return data;
    } catch (error) {
      console.warn('[AuthGuard] Failed to verify auth status.', error);
      redirectToLogin();
      return null;
    }
  }

  // Reuse the same promise so other scripts can await it if needed.
  if (!window.authGuardPromise) {
    window.authGuardPromise = ensureAuthenticated();
  }
})();

