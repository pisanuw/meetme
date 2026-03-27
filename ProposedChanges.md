# MeetMe — Code Review and Proposed Changes

This document is a full independent review of the MeetMe codebase conducted March 2026.
It covers all Netlify Functions, static client scripts, HTML templates, and supporting
configuration. Each item includes a priority rating, the affected file(s), the specific
concern, and a concrete recommendation.

See `CodebaseReview.md` for architectural documentation.

---

## Implementation Summary (March 2026)

The following items were reviewed and acted on. Each entry records whether the change
was **implemented** or **deferred** and the reason.

| # | Item | Decision |
|---|------|----------|
| 1 | Rate-limiting bypass via Host header | ✅ Implemented |
| 2 | Health endpoint information disclosure | ✅ Implemented |
| 3 | Webhook secret as URL query parameter | ✅ Implemented |
| 4 | auth.mjs too large | ⏭ Deferred — see note below |
| 5 | listMeetingIds duplicated | ✅ Implemented |
| 6 | Sensitive Google token fields | ✅ Implemented |
| 7 | Admin flash message bug | ✅ Implemented |
| 8 | Expand test coverage | ⏭ Deferred — see note below |
| 9 | Duplicated navigation HTML | ⏭ Deferred — see note below |
| 10 | Race condition on meeting index | ⏭ Deferred — see note below |
| 11 | calendar.mjs "24:00" end-time edge case | ✅ Implemented |
| 12 | Input validation constants consolidation | ⏭ Deferred — see note below |
| 13 | HTML string concatenation XSS risk | ⏭ Deferred — see note below |
| 14 | innerHTML += in loops | ✅ Implemented |
| 15 | getDb called repeatedly in meeting-actions | ✅ Implemented |
| 16 | getAppUrl() inconsistency | ✅ Implemented |
| 17 | Feedback route non-standard email validation | ✅ Implemented |
| 18 | auth-google.mjs missing JSDoc header | ✅ Implemented |
| 19 | Secure flag missing from cookies | ✅ Implemented |
| 20 | Missing JSDoc types for User and EventRecord | ✅ Implemented |

### Deferred — reasons

**Item 4 (auth.mjs splitting):** Splitting auth.mjs into three files would require moving
`getOrCreateUser` and `linkPendingInvites` into a shared helper module and updating all
import sites. This is a valuable architectural improvement but carries a meaningful risk of
introducing regressions in the auth flows without a broader test suite in place. Deferred
until item 8 (test coverage) is addressed.

**Item 8 (Expand test coverage):** Building a proper Blobs in-memory stub and writing
coverage for every exported utility, rate-limit behaviour, and per-route integration test
is a significant undertaking. It is the right next investment but is tracked separately
as its own work item.

**Item 9 (Duplicated navigation HTML):** The nav block contains dynamic elements (admin
link, impersonation banner, logout handler) that are wired up by `common.js` using
`getElementById` calls that depend on the existing static DOM. Centralising the nav
without a test suite risks silently breaking user-visible UI flows across all ten pages.
Deferred until item 8 is in place.

**Item 10 (Race condition on meeting index):** The long-term fix (timestamp-prefixed keys
and removal of the index blob) requires a one-time data migration and would make the
codebase incompatible with any existing stored records without a migration script. The
short-term comment approach was not implemented as it adds noise without reducing risk.
This is tracked as a future architectural improvement.

**Item 12 (LIMITS consolidation):** The validation limits are subtly different between
files (e.g. `MAX_DURATION_MINUTES` only exists in `meeting-actions.mjs`), and some
constants serve as in-file documentation as well as constraints. A mechanical consolidation
without understanding each file's semantics could silently change a limit. Deferred to a
dedicated refactoring pass.

**Item 13 (HTML string concatenation XSS):** Refactoring all render functions in
`dashboard.js`, `meeting.js`, and `admin.js` to use DOM APIs or a tagged template literal
helper is a large change that touches the most user-visible code paths. The current code
is safe because `escapeHtml()` is applied consistently. Deferred until item 8 provides
regression coverage.

---

## Deployment Readiness Verdict

**The codebase is conditionally ready for a first deployment**, but three issues carry
enough risk that they should be resolved beforehand:

| # | Issue | Risk if shipped as-is |
|---|-------|-----------------------|
| 6 | Rate-limit bypass via `Host` header | Auth brute-force protection can be disabled by any proxy forwarding `Host: localhost` |
| 7 | Health endpoint information disclosure | Any anonymous caller learns which third-party services are wired up |
| 12 | Webhook secret documented as a URL query parameter | The secret can leak into proxy/CDN/server access logs |

All other items are maintenance debt or minor improvements that do not block a launch.
The highest-value post-launch improvements are items **4** (nav deduplication), **11**
(sanitizeUser helper), and **5** (test coverage).

---

## Table of Contents

**Pre-launch (address before going live)**
1. [Rate-Limiting Is Bypassed via Host Header](#1-rate-limiting-is-bypassed-via-host-header)
2. [Unauthenticated /api/auth/health Endpoint Discloses Integration Map](#2-unauthenticated-apiauthhealth-endpoint-discloses-integration-map)
3. [Webhook Secret Documented as a URL Query Parameter](#3-webhook-secret-documented-as-a-url-query-parameter)

**High-value maintenance (plan for first month post-launch)**
4. [auth.mjs Is Too Large — Seven Concerns in One File](#4-authmjs-is-too-large--seven-concerns-in-one-file)
5. [listMeetingIds Is Duplicated Across Two Files](#5-listmeetingids-is-duplicated-across-two-files)
6. [Sensitive Google Token Fields Exposed by Convention, Not Construction](#6-sensitive-google-token-fields-exposed-by-convention-not-construction)
7. [Admin Flash Message Bug — "User updated." Always Shown on Create](#7-admin-flash-message-bug--user-updated-always-shown-on-create)

**Important improvements (plan within first quarter)**
8. [Expand Test Coverage](#8-expand-test-coverage)
9. [Duplicated Navigation HTML Across All Pages](#9-duplicated-navigation-html-across-all-pages)
10. [Single-Blob Meeting Index — Race Condition on Concurrent Writes](#10-single-blob-meeting-index--race-condition-on-concurrent-writes)
11. [calendar.mjs "24:00" End-Time Edge Case Uses Wrong Fallback](#11-calendarmjs-2400-end-time-edge-case-uses-wrong-fallback)

**Code quality and style**
12. [Broader Input Validation Cleanup and Centralisation](#12-broader-input-validation-cleanup-and-centralisation)
13. [HTML String Concatenation for Rendering (XSS Risk by Convention)](#13-html-string-concatenation-for-rendering-xss-risk-by-convention)
14. [innerHTML += in Loops (create-meeting.js / meeting.js)](#14-innerhtml--in-loops-create-meetingjs--meetingjs)
15. [getDb Called Repeatedly Inside Route Handlers](#15-getdb-called-repeatedly-inside-route-handlers)
16. [getAppUrl() Defined Inconsistently Across Files](#16-getappurl-defined-inconsistently-across-files)
17. [Feedback Route Uses Non-Standard Email Validation](#17-feedback-route-uses-non-standard-email-validation)
18. [auth-google.mjs Has No Module-Level JSDoc Header](#18-auth-googlemjs-has-no-module-level-jsdoc-header)
19. [Secure Flag Missing from Session Cookies](#19-secure-flag-missing-from-session-cookies)
20. [Missing JSDoc Types for Remaining Core Data Shapes](#20-missing-jsdoc-types-for-remaining-core-data-shapes)

---

## 1. Rate-Limiting Is Bypassed via Host Header

**Priority:** ⛔ Pre-launch
**File affected:** `netlify/functions/auth.mjs`, `netlify/functions/auth-google.mjs`

**Concern:** Every auth endpoint that performs rate limiting first calls
`isLocalDevRequest(req)` and skips the check entirely when the request's `Host` header
contains `"localhost"` or `"127.0.0.1"`. This is an intentional developer-experience
shortcut, but the detection mechanism is exploitable: any reverse proxy or tunnelling
tool that forwards requests with `Host: localhost` would bypass all auth rate limits in
production.

**Recommendation:** Replace the hostname heuristic with an explicit opt-in environment
variable:

```js
// utils.mjs
export function isRateLimitEnabled() {
  return getEnv("DISABLE_RATE_LIMIT", "") !== "true";
}
```

Add `DISABLE_RATE_LIMIT=true` to `.env.example` with a clear comment that this is for
local development only and must never be set in production. Remove the `isLocalDevRequest`
function and all its call sites; replace them with `if (isRateLimitEnabled())` guards.

---

## 2. Unauthenticated /api/auth/health Endpoint Discloses Integration Map

**Priority:** ⛔ Pre-launch
**File affected:** `netlify/functions/auth.mjs` (health route, line 222)

**Concern:** The health endpoint is intentionally unauthenticated so it can be polled by
monitoring tools. However, the response body includes a per-variable `checks` object that
reveals exactly which third-party integrations are configured (`jwt_secret`,
`resend_api_key`, `google_client_id`, etc.). An attacker who queries this endpoint before
attempting an attack immediately knows which sign-in paths are available and which
external services to target.

**Recommendation:** Return only a binary status to anonymous callers. Expose the full
`checks` and `missing` breakdowns only to authenticated admins:

```js
const allPresent = missing.length === 0;
const currentUser = getUserFromRequest(req);
if (!isAdmin(currentUser)) {
  return jsonResponse(200, {
    ok: allPresent,
    note: "Sign in as an admin to see per-variable details.",
  });
}
return jsonResponse(200, { ok: allPresent, checks, missing });
```

---

## 3. Webhook Secret Documented as a URL Query Parameter

**Priority:** ⛔ Pre-launch
**Files affected:** `.env.example` (line 15), `netlify/functions/webhooks.mjs` (line 62)

**Concern:** The `.env.example` comment instructs operators to configure the Resend
webhook with a `?secret=<value>` URL query parameter. URL query strings appear in web
server access logs, Netlify function logs, CDN logs, proxy logs, browser history, and
HTTP `Referer` headers on subsequent navigations. Any of these systems receiving the
webhook URL would silently capture the secret.

`webhooks.mjs` already supports header-based delivery (`x-webhook-secret`) and only
falls back to the query string when no header is present.

**Recommendation:** Update `.env.example` to document only the header-based approach:

```
# In Resend dashboard → Webhooks, configure:
#   URL: https://your-site.netlify.app/api/webhooks/resend
#   Header: x-webhook-secret: <RESEND_WEBHOOK_SECRET>
#   (Do NOT pass the secret as a ?secret= query parameter — it will appear in logs.)
```

Consider removing the `url.searchParams.get("secret")` fallback in `webhooks.mjs`
to prevent insecure usage by future operators.

---

## 4. auth.mjs Is Too Large — Seven Concerns in One File

**Priority:** 🔶 High-value maintenance
**File affected:** `netlify/functions/auth.mjs` (612 lines)

**Concern:** `auth.mjs` currently handles magic-link request and verify, user registration
via `getOrCreateUser`, the `/me` and `/profile` endpoints, logout, the health check, and
feedback submission — seven conceptually distinct concerns. Google OAuth was already
extracted into `auth-google.mjs`, but the remaining surface area is still large enough to
make it hard to audit individual flows and to onboard new contributors.

**Recommendation:** Split into three files, with shared helpers moved to a new
`auth-helpers.mjs`:

| File              | Routes                                          |
| ----------------- | ----------------------------------------------- |
| `auth.mjs`        | `/me`, `/profile`, `/logout`, `/health`         |
| `magic-link.mjs`  | `/magic-link/request`, `/magic-link/verify`     |
| `google-auth.mjs` | `/google/*`, `/google/calendar-*`               |

`getOrCreateUser` and `linkPendingInvites` move to `auth-helpers.mjs` so they can be
imported by both `magic-link.mjs` and `auth-google.mjs` without circular dependencies.

---

## 5. listMeetingIds Is Duplicated Across Two Files

**Priority:** 🔶 High-value maintenance
**Files affected:** `netlify/functions/meetings.mjs` (lines 52–58),
`netlify/functions/admin.mjs` (lines 35–41)

**Concern:** The `listMeetingIds(meetingsDb)` function is defined identically in both
files — same logic, same filter, same comment. If the filtering rules change (e.g. a new
key prefix is introduced), both copies must be updated in lockstep or they will diverge.

**Recommendation:** Export `listMeetingIds` from `utils.mjs` and import it in both
callers:

```js
// utils.mjs
export async function listMeetingIds(meetingsDb) {
  const listing = await meetingsDb.list().catch(() => ({ blobs: [] }));
  return asArray(listing?.blobs)
    .map((b) => b?.key)
    .filter(Boolean)
    .filter((key) => key !== "index" && !key.includes(":"));
}
```

---

## 6. Sensitive Google Token Fields Exposed by Convention, Not Construction

**Priority:** 🔶 High-value maintenance
**Files affected:** `netlify/functions/admin.mjs`, `auth.mjs`, `calendar.mjs`

**Concern:** Every endpoint that returns a user object manually deletes token fields
before serialising:

```js
// admin.mjs line 151–153
const safeUser = { ...u };
delete safeUser.google_access_token;
delete safeUser.google_refresh_token;
```

This convention is currently followed correctly, but a new endpoint that returns
`jsonResponse(200, user)` directly would silently expose encrypted (but still sensitive)
OAuth tokens. There is no structural guarantee against this mistake.

**Recommendation:** Add a `sanitizeUser` helper to `utils.mjs`:

```js
export function sanitizeUser(user) {
  const {
    google_access_token,
    google_refresh_token,
    google_token_expiry,
    ...safe
  } = user;
  return safe;
}
```

Use `sanitizeUser(user)` at every public-facing response site. For `calendar.mjs` and
the OAuth callbacks, which need the raw tokens, keep reading the full object internally
but document that those paths are the only approved consumers of raw token data.

---

## 7. Admin Flash Message Bug — "User updated." Always Shown on Create

**Priority:** 🔶 High-value maintenance
**Files affected:** `static/admin.js` (line 174), `netlify/functions/admin.mjs`

**Concern:** In `admin.js`, the flash message after saving a user is:

```js
showFlash(data.created ? "User created." : "User updated.", "success");
```

The API never includes a `created` field in its response body — it returns
`{ success: true, user: u }` for both create (HTTP 201) and update (HTTP 200). As a
result, `data.created` is always `undefined` (falsy), so the UI always shows
"User updated." even when a brand-new account was just created.

**Recommendation:** Either add a `created: true` field to the 201 response body in
`admin.mjs`, or key the flash message on the HTTP status code returned by `apiFetch`:

```js
// Option A — API-side change (admin.mjs)
return jsonResponse(201, { success: true, created: true, user: u });

// Option B — Client-side change (admin.js)
const { ok, status, data } = await apiFetch("/api/admin/users", { ... });
showFlash(status === 201 ? "User created." : "User updated.", "success");
```

---

## 8. Expand Test Coverage

**Priority:** 🔸 Important improvement
**Files affected:** `test/utils.test.mjs` (4 tests), `test/api-routes.test.mjs` (5 tests)

**Concern:** The test suite currently has nine tests total. The following important paths
have no automated coverage:

- `encryptSecret` / `decryptSecret` round-trip and tampered-input cases
- `validateEmail` — valid and invalid addresses, edge cases (e.g. no TLD dot, Unicode)
- `checkRateLimit` — allow / deny / window-reset behaviour (requires a Blobs stub)
- `isAdmin` — case-insensitivity, multiple emails, missing env var
- `generateId` — output format and collision resistance
- Meeting creation end-to-end, including invite generation and pending-invite linking
- Google Calendar busy-slot conversion (`localToUTC`, slot overlap logic, edge cases)
- The `calendar.mjs` "24:00" end-time fallback path

**Recommendation:** Build a lightweight in-memory Blobs stub (`test/stubs/blobs.mjs`)
backed by a `Map`. Inject it via an environment-controlled import or module mocking so
`utils.mjs` helpers can be exercised without a running Netlify Dev instance. Aim for
coverage of every exported function in `utils.mjs` and at least one integration test per
route file.

---

## 9. Duplicated Navigation HTML Across All Pages

**Priority:** 🔸 Important improvement
**Files affected:** All ten HTML pages

**Concern:** The `<nav>` block is copy-pasted verbatim in every HTML file. Adding,
renaming, or reordering a nav link requires editing ten files simultaneously. The `<footer>`
was already centralised via `static/layout.js`; the nav has not been.

**Recommendation:** Extend `static/layout.js` with a `renderSharedNav()` function that
injects the nav skeleton into a `<nav data-shared-nav></nav>` placeholder on each page
(mirroring the footer pattern):

```js
function renderSharedNav() {
  document.querySelectorAll("nav[data-shared-nav]").forEach((nav) => {
    nav.innerHTML = `
      <a class="nav-logo" href="/dashboard.html">MeetMe</a>
      <div id="nav-auth" style="display:none">
        <span id="nav-username"></span>
        <a id="logout-link" href="#" class="nav-link">Sign out</a>
      </div>`;
  });
}
```

The dynamic parts (username display, logout handler, admin link, impersonation link) are
already populated by the `getElementById` calls in `common.js` and will continue to work
unchanged.

---

## 10. Single-Blob Meeting Index — Race Condition on Concurrent Writes

**Priority:** 🔸 Important improvement
**File affected:** `netlify/functions/meetings.mjs` (lines 213–215, 481–483)

**Concern:** Meeting creation and deletion both perform a read-modify-write on the
`"index"` blob. If two requests execute concurrently, both reads see the same stale array,
both compute a different updated version, and one write silently discards the other's
change (classic lost-update problem).

Primary list reads already use `store.list()` instead of the index blob, which reduced
the surface area. However, the index write paths remain.

**Recommendation (short term):** Add a code comment on both index-mutation sites that
explicitly names the race condition and the circumstances under which it manifests:

```js
// WARNING: read-modify-write on a shared blob — concurrent creates or deletes
// can cause a lost update. Track https://github.com/... for the fix.
const indexData = asArray(await meetings.get("index", { type: "json" }).catch(() => []));
```

**Recommendation (long term):** Store meetings under timestamp-prefixed keys
(`${meeting.created_at}-${meeting.id}`) so that `store.list()` returns them in
chronological order without a central index, and remove the `"index"` blob entirely.
All existing stored records would need a one-time migration.

---

## 11. calendar.mjs "24:00" End-Time Edge Case Uses Wrong Fallback

**Priority:** 🔸 Important improvement
**File affected:** `netlify/functions/calendar.mjs` (lines 197–203)

**Concern:** The create-meeting UI allows `end_time = "24:00"` (midnight). When
`localToUTC(lastDate, "24:00", meetingTz)` is called, `new Date("YYYY-MM-DDT24:00:00Z")`
returns `Invalid Date`. The current fallback handles this by substituting `"20:00"` and
adding one day:

```js
if (isNaN(endUTC.getTime())) {
  endUTC = localToUTC(lastDate, "20:00", meetingTz);
  endUTC.setDate(endUTC.getDate() + 1);
}
```

The substituted time ("20:00" + 1 day) does not correspond to midnight of the last
meeting date, so the Google Calendar free/busy query uses an incorrect time window.
Slots between 20:01 and 24:00 on the last day will not be queried even though they are
within the meeting's configured time range.

**Recommendation:** Replace the `isNaN` fallback with an explicit normalisation step
that converts `"24:00"` to `"00:00"` on the following day before calling `localToUTC`:

```js
function normalisedEndTime(dateStr, timeStr, timezone) {
  if (timeStr === "24:00") {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return localToUTC(d.toISOString().slice(0, 10), "00:00", timezone);
  }
  return localToUTC(dateStr, timeStr, timezone);
}
```

---

## 12. Broader Input Validation Cleanup and Centralisation

**Priority:** 🔵 Code quality
**Files affected:** `meetings.mjs`, `meeting-actions.mjs`, `admin.mjs`, `auth.mjs`

**Concern:** Validation constants (`MAX_TITLE_LENGTH`, `MAX_DESCRIPTION_LENGTH`,
`MAX_INVITEES`, `MAX_NAME_LENGTH`, etc.) are defined locally in each file that needs
them. There is no single reference for what limits apply across the API. A new endpoint
author has no canonical source to consult, and changing a limit requires finding every
affected file.

**Recommendation:** Define a single `LIMITS` export in `utils.mjs`:

```js
export const LIMITS = {
  TITLE_MAX: 200,
  DESCRIPTION_MAX: 2000,
  MAX_INVITEES: 50,
  NAME_MAX: 100,
  DURATION_MIN: 15,
  DURATION_MAX: 24 * 60,
};
```

Import and use `LIMITS.*` in all route files, removing the per-file constant
declarations.

---

## 13. HTML String Concatenation for Rendering (XSS Risk by Convention)

**Priority:** 🔵 Code quality
**Files affected:** `static/dashboard.js`, `static/meeting.js`, `static/admin.js`

**Concern:** Dynamic HTML rendering uses `innerHTML` assignment with hand-crafted string
concatenation. This is currently safe because `escapeHtml()` is applied to every
user-supplied value. However, the safety is enforced only by convention: a single missed
`escapeHtml()` call anywhere in these functions would introduce a stored XSS
vulnerability. There is no structural guarantee.

**Recommendation:** Refactor render functions to build `DocumentFragment` objects using
DOM APIs (`createElement`, `textContent`, `appendChild`). `textContent` never interprets
its input as markup, making XSS impossible by construction regardless of the content.
Alternatively, introduce a tagged template literal helper that HTML-escapes all
interpolations automatically:

```js
function html(strings, ...values) {
  return strings.reduce((acc, s, i) => acc + s + (values[i] !== undefined ? escapeHtml(String(values[i])) : ""), "");
}
// Usage: element.innerHTML = html`<td>${user.name}</td>`;
```

---

## 14. innerHTML += in Loops (create-meeting.js / meeting.js)

**Priority:** 🔵 Code quality
**Files affected:** `static/create-meeting.js` (lines 22, 29, 38),
`static/meeting.js` (lines 136, 149–163)

**Concern:** Several loops build lists of DOM elements by repeatedly appending to
`element.innerHTML`:

```js
for (let h = 6; h < 24; h++) {
  startSel.innerHTML += `<option ...>`;   // Re-parses the full DOM on every iteration
}
```

Each `+=` forces the browser to serialise the entire subtree to a string, concatenate,
and re-parse it from scratch. For small lists (like 72 time-slot options or a handful of
participants) this is imperceptible, but it is an antipattern that causes noticeable jank
at larger scales.

**Recommendation:** Build the complete HTML string first, then assign it once:

```js
const parts = [];
for (let h = 6; h < 24; h++) {
  for (const m of [0, 15, 30, 45]) {
    parts.push(`<option ...>`);
  }
}
startSel.innerHTML = parts.join("");
```

Or use `document.createDocumentFragment()` with `appendChild`.

---

## 15. getDb Called Repeatedly Inside Route Handlers

**Priority:** 🔵 Code quality
**Files affected:** `netlify/functions/meeting-actions.mjs`, `admin.mjs`

**Concern:** In `meeting-actions.mjs`, store handles (`getDb("meetings")`,
`getDb("invites")`) are re-declared inside each route block rather than once at the top
of the handler. `getDb` is cheap (it returns a store handle, not a network connection),
so there is no performance problem, but the pattern is inconsistent with `meetings.mjs`,
which declares all handles at the start of its handler. A contributor following the local
pattern in `meeting-actions.mjs` may also create new `getDb` calls for existing stores
when adding a new route.

**Recommendation:** Declare all store handles at the top of each handler function before
the route-matching logic, following the `meetings.mjs` style:

```js
async function handleMeetingActions(req, _context) {
  const meetings   = getDb("meetings");
  const invites    = getDb("invites");
  const availability = getDb("availability");
  // ... route matching below
}
```

---

## 16. getAppUrl() Defined Inconsistently Across Files

**Priority:** 🔵 Code quality
**Files affected:** `netlify/functions/auth.mjs` (line 57),
`netlify/functions/meeting-actions.mjs` (lines 57–60)

**Concern:** `getAppUrl` is defined differently in two files:

- In `auth.mjs`: a module-level function that takes `req` as a parameter —
  `function getAppUrl(req) { ... }`
- In `meeting-actions.mjs`: a nested closure inside `handleMeetingActions` that
  captures `req` from the outer scope — `function getAppUrl() { ... }`

The inconsistency makes it harder to trace where the app URL is resolved and why the
signatures differ.

**Recommendation:** Export a single `getAppUrl(req)` from `utils.mjs` (or from a new
`app-helpers.mjs`) and import it in both files. This removes the inconsistency and
makes the dependency explicit.

---

## 17. Feedback Route Uses Non-Standard Email Validation

**Priority:** 🔵 Code quality
**File affected:** `netlify/functions/auth.mjs` (line 547)

**Concern:** The feedback endpoint validates the sender email address with an ad-hoc
check:

```js
if (!senderEmail || !senderEmail.includes("@")) {
  return errorResponse(400, "A valid email address is required.");
}
```

All other endpoints that accept an email use the shared `validateEmail()` helper from
`utils.mjs`, which also lower-cases and trims the input and checks for a `.` as well
as `@`. This inconsistency means the feedback route silently accepts inputs like
`"user@nodot"` that other routes would reject, and the email is not normalised before
being used in the reply-to header.

**Recommendation:** Replace the inline check with `validateEmail()`:

```js
const senderEmail = validateEmail(body.email || "");
if (!senderEmail) {
  return errorResponse(400, "A valid email address is required.");
}
```

---

## 18. auth-google.mjs Has No Module-Level JSDoc Header

**Priority:** 🔵 Code quality
**File affected:** `netlify/functions/auth-google.mjs`

**Concern:** Every other function file (`auth.mjs`, `meetings.mjs`, `meeting-actions.mjs`,
`calendar.mjs`, `admin.mjs`, `webhooks.mjs`, `utils.mjs`) begins with a JSDoc block that
lists the routes it handles, its security model, and any relevant design notes.
`auth-google.mjs` has no such header — it begins directly with import statements. A
developer navigating to this file has no quick overview of what it exports or which
routes it owns.

**Recommendation:** Add a standard module JSDoc header matching the style of the other
files:

```js
/**
 * auth-google.mjs — Google OAuth sign-in and Google Calendar OAuth helpers
 *
 * Exported entry point: handleGoogleAuthRoute({ req, path, ... })
 *
 * Routes handled (via auth.mjs delegation):
 *   GET  google/start              — begin Google sign-in OAuth flow
 *   GET  google/callback           — handle Google sign-in callback
 *   GET  google/calendar-start     — begin Google Calendar OAuth flow
 *   GET  google/calendar-callback  — handle Calendar OAuth callback
 *
 * Security model:
 *   - OAuth CSRF protection via signed JWT state parameter + cookie comparison
 *   - Access and refresh tokens are AES-256-GCM encrypted before storage
 *   - Rate limiting for google/start is enforced at the IP level
 */
```

---

## 19. Secure Flag Missing from Session Cookies

**Priority:** 🔵 Code quality
**File affected:** `netlify/functions/utils.mjs` (line 312, `setCookie`)

**Concern:** The `setCookie` helper does not include the `Secure` attribute:

```js
return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
```

Without `Secure`, a browser will send the cookie over plain HTTP if such a request is
ever made. Netlify's HTTPS-only hosting and the `Strict-Transport-Security` header in
`netlify.toml` make this highly unlikely in practice, but the cookie itself provides no
defence in depth against accidental HTTP exposure (e.g., during a misconfigured local
dev scenario where traffic is proxied over HTTP).

**Recommendation:** Add `; Secure` to all `Set-Cookie` values emitted in production.
For local dev compatibility, conditionally omit it based on the `DISABLE_RATE_LIMIT` /
environment flag introduced in item 1:

```js
export function setCookie(name, value, maxAge = 7 * 24 * 3600) {
  const secure = getEnv("DISABLE_RATE_LIMIT") === "true" ? "" : "; Secure";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}
```

---

## 20. Missing JSDoc Types for Remaining Core Data Shapes

**Priority:** 🔵 Code quality
**Files affected:** `netlify/functions/utils.mjs`, `meetings.mjs`, `auth.mjs`

**Concern:** `@typedef` blocks for `Meeting`, `Invite`, and `AvailabilitySlot` have been
added to `utils.mjs`. The `User` and `EventRecord` shapes still have no typedef, so
editors and JSDoc-aware tools cannot provide autocomplete or type checking for those
objects.

**Recommendation:** Add the missing typedefs to `utils.mjs`:

```js
/**
 * @typedef {object} User
 * @property {string}  id
 * @property {string}  email
 * @property {string}  name
 * @property {string}  first_name
 * @property {string}  last_name
 * @property {boolean} profile_complete
 * @property {string}  created_at
 * @property {string}  [timezone]
 * @property {boolean} [calendar_connected]
 */

/**
 * @typedef {object} EventRecord
 * @property {string} ts
 * @property {"info"|"warn"|"error"} level
 * @property {string} fn
 * @property {string} message
 */
```

Adding a `jsconfig.json` with `"checkJs": true` and `"strict": true` at the project root
would then surface type mismatches in editors without requiring a TypeScript migration.

---

_This review was conducted against the codebase as of March 2026. Items 1–3 should be
resolved before production launch. Items 4–11 are planned for the first month post-launch.
Items 12–20 are maintenance improvements to be addressed on an ongoing basis._
