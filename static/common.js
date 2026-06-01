// common.js — shared browser helpers used by every page.
// Stub for now; auth-aware helpers (apiFetch, checkAuth, requireAuth, flashes)
// are filled in once the auth API exists.

/** Escape user-supplied text before inserting it into HTML. */
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch],
  );
}

/** Read a query-string parameter from the current URL. */
function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

window.MeetMe = window.MeetMe || {};
window.MeetMe.escapeHtml = escapeHtml;
window.MeetMe.getQueryParam = getQueryParam;
