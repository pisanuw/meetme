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
    res = await fetch(url, { ...options, credentials: "include" });
  } catch (networkErr) {
    return { ok: false, status: 0, data: { error: `Network error: ${networkErr.message}` } };
  }

  // Don't auto-redirect on 401 — let each page handle it (login page needs 401 to show login form).
  // Pages that require auth (like dashboard.js) use requireAuth() to handle 401 explicitly.

  let data;
  const text = await res.text().catch(() => "");
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Server returned something that is not JSON (e.g. an HTML error page).
    data = {
      error: `Server returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
    };
  }

  return { ok: res.ok, status: res.status, data };
}

function getCurrentPathWithQuery() {
  const path = `${window.location.pathname || "/"}${window.location.search || ""}${window.location.hash || ""}`;
  if (!path.startsWith("/")) return "/";
  if (path.startsWith("//")) return "/";
  return path;
}

function ensureNavDropdown(container, { menuId, listId, label, beforeNode }) {
  let menu = document.getElementById(menuId);
  let menuList = document.getElementById(listId);

  // Guard against conflicting element types from page HTML
  if (menu && menu.tagName !== "DETAILS") { menu.removeAttribute("id"); menu = null; }
  if (menuList && menuList.tagName !== "DIV") { menuList.removeAttribute("id"); menuList = null; }

  if (!menu || !menuList) {
    if (menu) menu.remove();
    if (menuList) menuList.remove();

    menu = document.createElement("details");
    menu.id = menuId;
    menu.className = "nav-dropdown";

    const summary = document.createElement("summary");
    summary.className = "nav-dropdown-trigger";
    summary.textContent = label;

    menuList = document.createElement("div");
    menuList.id = listId;
    menuList.className = "nav-dropdown-list";

    menu.append(summary, menuList);

    menu.addEventListener("toggle", () => {
      if (menu.open) {
        document.querySelectorAll("details.nav-dropdown").forEach((other) => {
          if (other !== menu) other.removeAttribute("open");
        });
      }
    });
  }

  if (beforeNode && beforeNode.parentNode === container) {
    container.insertBefore(menu, beforeNode);
  } else {
    container.appendChild(menu);
  }

  return { menu, menuList };
}

function setNavDropdownLabel(menu, label) {
  if (!menu) return;
  const trigger = menu.querySelector("summary.nav-dropdown-trigger");
  if (trigger) trigger.textContent = label;
}

function getAccountShortName(user) {
  const firstName = (user.first_name || "").trim();
  if (firstName) return firstName;

  const fullName = (user.name || "").trim();
  if (!fullName) return "Account";
  return fullName.split(/\s+/)[0] || fullName;
}

function applyResponsiveAccountLabel(accountMenu) {
  if (!accountMenu) return;
  const desktopLabel = accountMenu.dataset.desktopLabel || "Account";
  const mobileLabel = accountMenu.dataset.mobileLabel || desktopLabel;
  const isMobile = window.matchMedia("(max-width: 720px)").matches;
  setNavDropdownLabel(accountMenu, isMobile ? mobileLabel : desktopLabel);
}

function bindResponsiveAccountLabelUpdates() {
  if (window.__accountLabelResizeBound) return;
  let resizeDebounce;

  window.addEventListener("resize", () => {
    window.clearTimeout(resizeDebounce);
    resizeDebounce = window.setTimeout(() => {
      const accountMenu = document.getElementById("nav-account-menu");
      applyResponsiveAccountLabel(accountMenu);
    }, 120);
  });

  window.__accountLabelResizeBound = true;
}

function ensureNavMenus(logoutLink) {
  const navAuth = document.getElementById("nav-auth");
  if (!navAuth) return null;

  const account = ensureNavDropdown(navAuth, {
    menuId: "nav-account-menu",
    listId: "nav-account-menu-list",
    label: "Account",
    beforeNode: logoutLink && logoutLink.parentNode === navAuth ? logoutLink : null
  });

  const bookings = ensureNavDropdown(navAuth, {
    menuId: "nav-bookings-menu",
    listId: "nav-bookings-menu-list",
    label: "Bookings",
    beforeNode: account.menu
  });

  if (logoutLink) {
    logoutLink.className = "nav-dropdown-item nav-dropdown-item-danger";
    if (logoutLink.parentNode !== account.menuList) {
      account.menuList.appendChild(logoutLink);
    }
  }

  return {
    bookingsMenu: bookings.menu,
    bookingsMenuList: bookings.menuList,
    accountMenu: account.menu,
    accountMenuList: account.menuList,
  };
}

function ensureMenuLink(navMenuList, { id, href, text, className = "", beforeNode = null }) {
  let link = document.getElementById(id);
  if (link && link.tagName !== "A") {
    link.removeAttribute("id");
    link = null;
  }

  if (!link) {
    link = document.createElement("a");
    link.id = id;
  }

  link.href = href;
  link.textContent = text;
  link.className = `nav-dropdown-item ${className}`.trim();

  if (beforeNode && beforeNode.parentNode === navMenuList) {
    navMenuList.insertBefore(link, beforeNode);
  } else {
    navMenuList.appendChild(link);
  }

  return link;
}

function ensureMenuDivider(navMenuList, logoutLink) {
  let divider = document.getElementById("nav-menu-divider");
  if (divider && divider.tagName !== "DIV") {
    divider.removeAttribute("id");
    divider = null;
  }

  if (!divider) {
    divider = document.createElement("div");
    divider.id = "nav-menu-divider";
  }

  divider.className = "nav-dropdown-divider";
  if (logoutLink && logoutLink.parentNode === navMenuList) {
    navMenuList.insertBefore(divider, logoutLink);
  } else {
    navMenuList.appendChild(divider);
  }
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
    const { ok, data: user } = await apiFetch("/api/auth/me");
    if (!ok || !user) return null;

    const fullName = (user.name || "").trim() || "Account";
    const shortName = getAccountShortName(user);
    const displayName = user.is_impersonated ? `${fullName} (impersonated)` : fullName;
    const shortDisplayName = user.is_impersonated ? `${shortName} (impersonated)` : shortName;

    // Show the authenticated nav section and display the user's name.
    const navAuth = document.getElementById("nav-auth");
    const navUser = document.getElementById("nav-username");
    if (navAuth) navAuth.hidden = false;
    if (navUser) {
      navUser.textContent = "";
    }

    const logoutLink = document.getElementById("logout-link");
    const menuState = ensureNavMenus(logoutLink);
    if (!menuState) return user;

    const { bookingsMenu, bookingsMenuList, accountMenu, accountMenuList } = menuState;
    accountMenu.dataset.desktopLabel = displayName;
    accountMenu.dataset.mobileLabel = shortDisplayName;
    bindResponsiveAccountLabelUpdates();
    applyResponsiveAccountLabel(accountMenu);

    ensureMenuLink(accountMenuList, {
      id: "profile-link",
      href: "/profile.html",
      text: "Edit Profile",
      beforeNode: logoutLink,
    });
    ensureMenuLink(bookingsMenuList, {
      id: "booking-setup-link",
      href: "/booking-setup.html",
      text: "Event Types",
    });
    // Availability is always tied to a specific event type, so remove the general link
    ensureMenuLink(bookingsMenuList, {
      id: "booking-links-link",
      href: "/booking-links.html",
      text: "Booking Links",
    });
    ensureMenuLink(bookingsMenuList, {
      id: "bookings-link",
      href: "/bookings.html",
      text: "My Bookings",
    });

    const existingAdmin = document.getElementById("admin-nav-link");
    if (user.is_admin) {
      ensureMenuLink(accountMenuList, {
        id: "admin-nav-link",
        href: "/admin.html",
        text: "Admin",
        className: "nav-dropdown-item-admin",
        beforeNode: logoutLink,
      });
    } else if (existingAdmin) {
      existingAdmin.remove();
    }

    const existingStop = document.getElementById("stop-impersonation-link");
    if (user.is_impersonated) {
      const stopLink = ensureMenuLink(accountMenuList, {
        id: "stop-impersonation-link",
        href: "#",
        text: "Return to Admin",
        className: "nav-dropdown-item-warning",
        beforeNode: logoutLink,
      });

      if (!stopLink.dataset.handlerBound) {
        stopLink.addEventListener("click", async (e) => {
          e.preventDefault();
            accountMenu.open = false;
          const { ok, data } = await apiFetch("/api/auth/impersonation/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (!ok) {
            showFlash(data.error || "Could not restore admin session.", "error");
            return;
          }
          window.location.href = "/admin.html";
        });
        stopLink.dataset.handlerBound = "1";
      }
    } else if (existingStop) {
      existingStop.remove();
    }

    ensureMenuDivider(accountMenuList, logoutLink);

    [bookingsMenuList, accountMenuList].forEach((list) => {
      list.querySelectorAll("a").forEach((link) => {
        if (!link.dataset.closeMenuBound) {
          link.addEventListener("click", () => {
            bookingsMenu.open = false;
            accountMenu.open = false;
          });
          link.dataset.closeMenuBound = "1";
        }
      });
    });

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
    const next = getCurrentPathWithQuery();
    const loginUrl = next && next !== "/" ? `/?next=${encodeURIComponent(next)}` : "/";
    window.location.href = loginUrl;
    return null;
  }
  return user;
}

/**
 * Display a dismissible flash message in the `#flash-container` element.
 * The banner automatically disappears after 5 seconds.
 *
 * @param {string} message
 * @param {'info'|'success'|'warning'|'danger'|'warn'|'error'} [category='info']
 */
function showFlash(message, category = "info") {
  const container = document.getElementById("flash-container");
  if (!container) return;
  const normalizedCategory = { warn: "warning", error: "danger" }[category] || category || "info";
  const div = document.createElement("div");
  div.className = `flash flash-${normalizedCategory}`;

  const textNode = document.createTextNode(`${message} `);
  const closeBtn = document.createElement("button");
  closeBtn.className = "flash-close";
  closeBtn.type = "button";
  closeBtn.innerHTML = "&#x2715;";
  closeBtn.addEventListener("click", () => div.remove());

  div.append(textNode, closeBtn);
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
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

window.apiFetch = apiFetch;
window.checkAuth = checkAuth;
window.requireAuth = requireAuth;
window.showFlash = showFlash;
window.escapeHtml = escapeHtml;

// Logout handler
document.addEventListener("DOMContentLoaded", () => {
  const logoutLink = document.getElementById("logout-link");
  if (logoutLink) {
    logoutLink.addEventListener("click", async (e) => {
      e.preventDefault();
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      window.location.href = "/";
    });
  }
});
