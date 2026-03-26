# MeetMe — Open and Deferred Improvements

This document lists changes that have been reviewed but **not yet implemented**, along with
the specific reason each one is deferred. Items that have already been fully implemented
have been removed. See `CodebaseReview.md` for current codebase documentation.

---

## Table of Contents

1. [auth.mjs Is Still Too Large](#1-authmjs-is-still-too-large)
2. [Broader Input Validation Cleanup](#2-broader-input-validation-cleanup)
3. [HTML String Concatenation for Rendering](#3-html-string-concatenation-for-rendering)
4. [Duplicated Navigation HTML Across All Pages](#4-duplicated-navigation-html-across-all-pages)
5. [Expand Test Coverage](#5-expand-test-coverage)
6. [Rate-Limiting Is Silently Skipped for Local Dev](#6-rate-limiting-is-silently-skipped-for-local-dev)
7. [Unauthenticated /api/auth/health Endpoint](#7-unauthenticated-apiauthhealth-endpoint)
8. [Missing JSDoc Types for the Core Data Model](#8-missing-jsdoc-types-for-the-core-data-model)
9. [Single-Blob Meeting Index — Long-Term Scalability Risk](#9-single-blob-meeting-index--long-term-scalability-risk)
10. [getDb Called Repeatedly Inside Route Handlers](#10-getdb-called-repeatedly-inside-route-handlers)
11. [Sensitive Google Token Fields Always Included in Internal User Reads](#11-sensitive-google-token-fields-always-included-in-internal-user-reads)

---

## 1. auth.mjs Is Still Too Large

**File affected:** `netlify/functions/auth.mjs`.

**What was done:** The Google OAuth and Calendar OAuth helpers were extracted into
`auth-google.mjs`.

**What remains:** `auth.mjs` still handles magic-link request/verify, user
registration, the `/me` and `/profile` endpoints, logout, the health check, and feedback
submission — seven distinct concerns in one file.

**Why not done yet:** Splitting these requires moving `getOrCreateUser` and
`linkPendingInvites` to a shared `auth-helpers.mjs`, then touching every import in every
caller — a larger coordinated change than the Google-OAuth extraction.

**Recommendation:** Group routes into three files:

| File              | Routes                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `auth.mjs`        | `/me`, `/profile`, `/logout`, `/health`                                                                              |
| `magic-link.mjs`  | `/magic-link/request`, `/magic-link/verify`                                                                          |
| `google-auth.mjs` | `/google/start`, `/google/callback`, and their calendar variants                                                     |

Shared helpers (`getOrCreateUser`, `linkPendingInvites`) move to `auth-helpers.mjs`.

---

## 2. Broader Input Validation Cleanup

**Files affected:** `meetings.mjs`, `meeting-actions.mjs`, `admin.mjs`, `auth.mjs`.

**What was done:** Bounded validation was added for meeting title, description, invite
count, meeting type, dates/day values, finalization duration, and name lengths.

**What remains:** The validation is currently scattered across individual route handlers.
There are no shared constants for the limits, and not every endpoint that accepts
user-controlled strings has been audited. A contributor adding a new endpoint has no
single reference for what is acceptable.

**Why not done yet:** A thorough audit of every route handler is a sustained cleanup
effort rather than a targeted bug fix.

**Recommendation:** Define a `LIMITS` export in `utils.mjs` that centralizes all
server-side validation constants:

```js
export const LIMITS = {
  TITLE_MAX: 200,
  DESCRIPTION_MAX: 2000,
  MAX_INVITEES: 50,
  NAME_MAX: 100,
};
```

Then apply them systematically at the entry point of every route handler.

---

## 3. HTML String Concatenation for Rendering

**Files affected:** `static/dashboard.js`, `static/meeting.js`, `static/admin.js`.

**Why not done yet:** Converting all dynamic rendering to DOM-based construction
(using `document.createElement` + `textContent`) is a significant refactor of the
largest page scripts. The current rendering is safe because `escapeHtml` is used on
user-supplied values, but this safety is enforced by convention, not by construction —
a single missed call opens an XSS hole. The refactor was agreed to in principle but
deferred because it is larger than a surgical maintenance patch.

**Recommendation:** Define small render functions that return `DocumentFragment`
objects built entirely with DOM APIs. This makes XSS impossible by construction:
`textContent` never interprets its content as markup. Alternatively, adopt a tagged
template literal helper that HTML-escapes interpolated values automatically.

---

## 4. Duplicated Navigation HTML Across All Pages

**Files affected:** All HTML pages (`index.html`, `dashboard.html`, `create-meeting.html`,
`meeting.html`, `profile.html`, `email-sent.html`, `feedback.html`, `admin.html`,
`register.html`, `404.html`).

**What was done:** The `<footer>` block was centralized via `static/layout.js` —
each page now contains only a `<footer data-shared-footer></footer>` placeholder and
the footer is injected at load time.

**What remains:** The `<nav>` block is still copy-pasted verbatim in every HTML file.
Adding or renaming a nav link requires editing ten files.

**Why not done yet:** The nav contains conditional elements (logout link, admin link)
that depend on the authenticated user, which are already being set by `common.js`. A
full nav injection requires restructuring `checkAuth()` / `requireAuth()` to hand off
the populated user to a `renderNav()` call, and then replacing the existing nav markup
in every HTML file — a coordinated multi-file change.

**Recommendation:** Extend `static/layout.js` with a `renderSharedNav()` that injects
the nav skeleton into a `<nav data-shared-nav></nav>` placeholder (mirroring the footer
pattern). The dynamic parts (username display, logout, admin link) can then be populated
by `common.js` using its existing `getElementById` calls.

---

## 5. Expand Test Coverage

**What was done:** A `node:test` harness was introduced with utility unit tests
(`test/utils.test.mjs`) and route-behaviour integration tests
(`test/api-routes.test.mjs`) covering auth/meetings/admin core flows.

**What remains:** The following areas have no automated tests:

- `encryptSecret` / `decryptSecret` round-trip and error cases
- `validateEmail` — valid and invalid addresses, edge cases
- `checkRateLimit` — allow / deny / window reset (requires a fake Blobs stub)
- `isAdmin` — case-insensitivity, multiple emails, missing env var
- `generateId` — output format and uniqueness
- Meeting creation end-to-end (including invite generation and pending-invite linking)
- Google Calendar busy-slot conversion (`localToUTC`, slot overlap logic)

**Why not done yet:** Several of these require an in-memory Blobs mock to exercise
without a live Netlify Dev instance. That stub infrastructure has not been built yet.

**Recommendation:** Implement a lightweight Blobs stub (`test/stubs/blobs.mjs`) backed
by a plain `Map`. Inject it via dependency injection or module mocking so that
`utils.mjs` helpers can be tested without a real Blobs connection.

---

## 6. Rate-Limiting Is Silently Skipped for Local Dev

**File affected:** `netlify/functions/auth.mjs` (multiple `isLocalDevRequest` guards).

**Why not changed:** Bypassing rate-limits for localhost requests is an intentional
developer-experience tradeoff and is already documented in comments.

**Remaining concern:** The bypass is triggered by checking the `Host` request header.
Any proxy or tunneling setup that forwards requests with `Host: localhost` would bypass
rate limits in production — an unlikely but real attack surface.

**Recommendation:** Replace the opaque hostname heuristic with an explicit environment
variable flag:

```js
// utils.mjs
export function isRateLimitEnabled() {
  return getEnv("DISABLE_RATE_LIMIT", "") !== "true";
}
```

Add `DISABLE_RATE_LIMIT=true` to `.env.example` with a comment that it is for local
development only. This removes the host-header bypass risk.

---

## 7. Unauthenticated /api/auth/health Endpoint

**File affected:** `netlify/functions/auth.mjs` (health route).

**Why not changed:** The health endpoint is kept intentionally unauthenticated because
it is useful for Netlify platform monitoring and for local development diagnostics
without needing to sign in first.

**Remaining concern:** The response reveals which environment variables are configured
(`jwt_secret`, `resend_api_key`, `google_client_id`, etc.). This information helps an
attacker understand the app's integrations without authentication.

**Recommendation:** Return only a binary `ok: true/false` to unauthenticated callers
and require admin authentication to see the per-variable `checks` breakdown:

```js
if (!isAdmin(getUserFromRequest(req))) {
  return jsonResponse(200, { ok: allPresent });
}
// full breakdown only for admins
return jsonResponse(200, { ok: allPresent, checks, missing });
```

---

## 8. Missing JSDoc Types for the Core Data Model

**Files affected:** `netlify/functions/utils.mjs`, `meetings.mjs`, `auth.mjs`.

**Why deferred:** This is documentation debt rather than a production bug. The codebase
is consistent enough that contributors can read the code to understand the data shapes,
but autocomplete and type-checked IDE experience are absent.

**Recommendation:** Add `@typedef` blocks in `utils.mjs` for each core entity (User,
Meeting, Invite, AvailabilitySlot, EventRecord). For example:

```js
/**
 * @typedef {object} Meeting
 * @property {string}   id
 * @property {string}   title
 * @property {string}   description
 * @property {string}   creator_id
 * @property {string}   creator_name
 * @property {"specific_dates"|"days_of_week"} meeting_type
 * @property {string[]} dates_or_days
 * @property {string}   start_time     - "HH:MM"
 * @property {string}   end_time       - "HH:MM"
 * @property {string}   timezone       - IANA timezone
 * @property {number}   duration_minutes
 * @property {boolean}  is_finalized
 * @property {string|null} finalized_date
 * @property {string|null} finalized_slot
 * @property {string}   note
 * @property {string}   created_at     - ISO 8601
 */
```

Adding a `jsconfig.json` with `"checkJs": true` would then surface type errors in
editors without requiring a full TypeScript migration.

---

## 9. Single-Blob Meeting Index — Long-Term Scalability Risk

**File affected:** `netlify/functions/meetings.mjs` (meeting index management).

**What was done:** Primary list endpoints now derive meeting IDs via `store.list()`,
reducing reliance on the single-blob index for reads.

**What remains:** Meeting _creation_ and _deletion_ still read-modify-write the `"index"`
blob. Two simultaneous writes will race: both reads see the same old array, both writes
save different arrays, and one silently overwrites the other's change (lost update).

**Why not done yet:** Fully eliminating the index blob requires switching to
timestamp-prefixed keys for all meetings (`2026-03-26T10:00:00Z-<id>`) so that
`store.list()` returns them in chronological order without a central index. All existing
stored records would need to be migrated.

**Recommendation (long term):** Store each meeting under a key prefixed with its
`created_at` timestamp (`${meeting.created_at}-${meeting.id}`). Drop the `"index"` blob
entirely — `store.list()` with lexicographic sorting naturally provides chronological
ordering. Add a comment to the current index-mutation code noting the race condition so
contributors are aware.

---

## 10. getDb Called Repeatedly Inside Route Handlers

**Files affected:** `netlify/functions/meeting-actions.mjs`, `admin.mjs`.

**Why not changed:** `getDb` is cheap (it returns a store handle, not a connection) and
the repeated calls do not cause correctness problems. The current pattern makes it easy
to see which store each route block needs without scrolling to the top of the function.

**Remaining concern:** It is inconsistent with `meetings.mjs`, which declares all store
handles once at the top of the handler. A contributor adding a new route might create the
same store handle multiple times if following the local pattern.

**Recommendation:** Declare store handles at the top of each handler function before the
route-matching logic, following the `meetings.mjs` style:

```js
const meetings = getDb("meetings");
const invites = getDb("invites");
const availability = getDb("availability");
// then route matching
```

This is a style-consistency change with no functional effect.

---

## 11. Sensitive Google Token Fields Always Included in Internal User Reads

**Files affected:** `netlify/functions/admin.mjs`, `auth.mjs`, `calendar.mjs`.

**Why not changed:** On review, all public-facing responses already strip token fields:
the `/me` endpoint returns only `id`, `email`, `name`, and flags; `admin.mjs` explicitly
deletes token fields before serializing user responses. The risk is an oversight on a
_future_ endpoint that returns a user object without remembering to strip the fields.

**Remaining concern:** The safety is enforced by convention (deleting fields before
returning), not by construction. A new endpoint that does `return jsonResponse(200, user)`
would silently leak encrypted tokens.

**Recommendation:** Define a `sanitizeUser` helper in `utils.mjs` that strips token
fields by design:

```js
export function sanitizeUser(user) {
  const { google_access_token, google_refresh_token, ...safe } = user;
  return safe;
}
```

Use `sanitizeUser` in every endpoint that returns user data. Keep a separate
`getUserWithTokens(email)` helper for the narrow internal paths (`calendar.mjs`, OAuth
callbacks) that genuinely need the raw token fields.

---

_All items that had already been fully implemented have been removed from this document.
The highest-value remaining items are: **4** (nav deduplication — low effort, high
maintenance benefit), **7** (health endpoint — small targeted security improvement), and
**8** (JSDoc types — unblocks better tooling with no code churn)._
