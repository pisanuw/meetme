/**
 * common.js — Shared helpers for all MeetMe static pages
 *
 * Functions exported to the global scope (no module bundler — just a plain <script>):
 *   apiFetch(url, options)  — fetch wrapper that handles errors and 401 redirects
 *   checkAuth()             — call /api/auth/me and update the nav; returns user or null
 *   requireAuth()           — like checkAuth but redirects to / if not signed in
 *   showFlash(message, cat) — display a dismissible status banner
 *   escapeHtml(str)         — escape user content before inserting into the DOM
 */

/**
 * Central fetch helper for all API calls.
 * Always resolves to { ok, status, data } — never throws.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<{ ok: boolean, status: number, data: object }>}
 */
async function apiFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    return { ok: false, status: 0, data: { error: `Network error: ${networkErr.message}` } };
  }

  // Treat 401 as a session expiry — redirect to the sign-in page automatically.
  if (res.status === 401) {
    window.location.href = '/';
    return { ok: false, status: 401, data: { error: 'Session expired. Redirecting to sign in…' } };
  }

  let data;
  const text = await res.text().catch(() => '');
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Server returned something that is not JSON (e.g. an HTML error page).
    data = { error: `Server returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}` };
  }

  return { ok: res.ok, status: res.status, data };
}

/**
 * Call /api/auth/me and, if the user is signed in, update the navigation bar
 * to show their name and inject "Edit Profile" (and "Admin" if applicable) links.
 * Safe to call on every page — silently returns null when not authenticated.
 *
 * @returns {Promise<object|null>} The user object from the session, or null
 */
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;

    const user = await res.json();

    // Show the authenticated nav section and display the user's name.
    const navAuth = document.getElementById('nav-auth');
    const navUser = document.getElementById('nav-username');
    if (navAuth) navAuth.style.display = '';
    if (navUser) {
      navUser.textContent = user.is_impersonated
        ? `${user.name} (impersonated)`
        : user.name;
    }

    const logoutLink = document.getElementById('logout-link');

    // Inject the "Edit Profile" link once, immediately before the logout link.
    if (!document.getElementById('profile-link') && logoutLink?.parentNode) {
      const profileLink = document.createElement('a');
      profileLink.id = 'profile-link';
      profileLink.href = '/profile.html';
      profileLink.className = 'nav-link';
      profileLink.textContent = 'Edit Profile';
      logoutLink.parentNode.insertBefore(profileLink, logoutLink);
    }

    // Inject the "Admin" link once for admin users. This check is separate from
    // the profile link check so both links are always injected regardless of order.
    if (user.is_admin && !document.getElementById('admin-nav-link') && logoutLink?.parentNode) {
      const adminLink = document.createElement('a');
      adminLink.id = 'admin-nav-link';
      adminLink.href = '/admin.html';
      adminLink.className = 'nav-link';
      adminLink.textContent = 'Admin';
      adminLink.style.color = '#c084fc';
      logoutLink.parentNode.insertBefore(adminLink, logoutLink);
    }

    // When an admin is impersonating another user, provide an easy way to
    // restore the original admin session from any page.
    if (user.is_impersonated && !document.getElementById('stop-impersonation-link') && logoutLink?.parentNode) {
      const stopLink = document.createElement('a');
      stopLink.id = 'stop-impersonation-link';
      stopLink.href = '#';
      stopLink.className = 'nav-link';
      stopLink.textContent = 'Return to Admin';
      stopLink.style.color = '#f59e0b';
      stopLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const { ok, data } = await apiFetch('/api/auth/impersonation/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!ok) {
          showFlash(data.error || 'Could not restore admin session.', 'error');
          return;
        }
        window.location.href = '/admin.html';
      });
      logoutLink.parentNode.insertBefore(stopLink, logoutLink);
    }

    return user;
  } catch {
    return null;
  }
}

/**
 * Require the user to be signed in. If not, redirects to the root sign-in page.
 *
 * @returns {Promise<object|null>} The user object, or null (after redirect)
 */
async function requireAuth() {
  const user = await checkAuth();
  if (!user) {
    window.location.href = '/';
    return null;
  }
  return user;
}

/**
 * Display a dismissible flash message in the `#flash-container` element.
 * The banner automatically disappears after 5 seconds.
 *
 * @param {string} message
 * @param {'info'|'success'|'warn'|'error'} [category='info']
 */
function showFlash(message, category = 'info') {
  const container = document.getElementById('flash-container');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `flash flash-${category}`;
  div.innerHTML = `${escapeHtml(message)} <button class="flash-close" onclick="this.parentElement.remove()">&#x2715;</button>`;
  container.appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

/**
 * Escape a string for safe insertion into the DOM as HTML text.
 * Always use this function (or `textContent`) instead of `innerHTML` when
 * displaying user-supplied content to prevent Cross-Site Scripting (XSS).
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Logout handler
document.addEventListener('DOMContentLoaded', () => {
  const logoutLink = document.getElementById('logout-link');
  if (logoutLink) {
    logoutLink.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      window.location.href = '/';
    });
  }
});
