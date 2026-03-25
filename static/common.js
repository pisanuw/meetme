// common.js — shared helpers for MeetSync static pages

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
