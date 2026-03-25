// common.js — shared helpers for MeetMe static pages

/**
 * Central fetch helper.
 * Always returns { ok, status, data } — never throws.
 * - data is the parsed JSON object (or { error: '...' } on failure)
 * - Automatically redirects to / on 401 (session expired)
 */
async function apiFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    return { ok: false, status: 0, data: { error: `Network error: ${networkErr.message}` } };
  }

  if (res.status === 401) {
    window.location.href = '/';
    return { ok: false, status: 401, data: { error: 'Session expired. Redirecting to sign in…' } };
  }

  let data;
  const text = await res.text().catch(() => '');
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: `Server returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}` };
  }

  return { ok: res.ok, status: res.status, data };
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const user = await res.json();
      // Update nav
      const navAuth = document.getElementById('nav-auth');
      const navUser = document.getElementById('nav-username');
      if (navAuth) navAuth.style.display = '';
      if (navUser) navUser.textContent = user.name;

      // Inject "Edit Profile" link before logout if not already in DOM
      if (!document.getElementById('profile-link')) {
        const profileLink = document.createElement('a');
        profileLink.id = 'profile-link';
        profileLink.href = '/profile.html';
        profileLink.className = 'nav-link';
        profileLink.textContent = 'Edit Profile';
        const logoutLink = document.getElementById('logout-link');
        if (logoutLink && logoutLink.parentNode) {
          logoutLink.parentNode.insertBefore(profileLink, logoutLink);

              // Inject "Admin" link for admin users
              if (user.is_admin && !document.getElementById('admin-nav-link')) {
                const adminLink = document.createElement('a');
                adminLink.id = 'admin-nav-link';
                adminLink.href = '/admin.html';
                adminLink.className = 'nav-link';
                adminLink.textContent = 'Admin';
                adminLink.style.color = '#c084fc';
                const logoutLink = document.getElementById('logout-link');
                if (logoutLink && logoutLink.parentNode) {
                  logoutLink.parentNode.insertBefore(adminLink, logoutLink);
                }
              }
        }
      }

      return user;
    }
  } catch {}
  return null;
}

async function requireAuth() {
  const user = await checkAuth();
  if (!user) {
    window.location.href = '/';
    return null;
  }
  return user;
}

function showFlash(message, category = 'info') {
  const container = document.getElementById('flash-container');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `flash flash-${category}`;
  div.innerHTML = `${escapeHtml(message)} <button class="flash-close" onclick="this.parentElement.remove()">&#x2715;</button>`;
  container.appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

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
