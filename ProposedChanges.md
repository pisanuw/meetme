# MeetMe — Proposed Changes for Clarity and Future Maintenance

This document is a structured code review of the MeetMe repository. Each section identifies
a specific area for improvement and explains *why* the change matters for future maintainers,
followed by a concrete recommendation.

---

## Table of Contents

1. [Duplicated Time-Slot Generation Logic](#1-duplicated-time-slot-generation-logic)
2. [auth.mjs Is Too Large — Split Into Focused Modules](#2-authmjs-is-too-large--split-into-focused-modules)
3. [Inconsistent API Route Naming (Singular vs Plural)](#3-inconsistent-api-route-naming-singular-vs-plural)
4. [Timing-Attack Vulnerability in Webhook Secret Comparison](#4-timing-attack-vulnerability-in-webhook-secret-comparison)
5. [Dead Code in calendar.mjs — Unused Fallback Variable](#5-dead-code-in-calendarmjs--unused-fallback-variable)
6. [Incomplete String Replace for meeting_type Label](#6-incomplete-string-replace-for-meeting_type-label)
7. [Input Validation Gaps](#7-input-validation-gaps)
8. [N+1 Blob Reads in List Endpoints](#8-n1-blob-reads-in-list-endpoints)
9. [Hardcoded Default Admin Email in getEnv Fallback](#9-hardcoded-default-admin-email-in-getenv-fallback)
10. [Flash Message Category Inconsistency](#10-flash-message-category-inconsistency)
11. [Inline HTML Event Handlers in Dynamic Content](#11-inline-html-event-handlers-in-dynamic-content)
12. [HTML String Concatenation for Rendering](#12-html-string-concatenation-for-rendering)
13. [Duplicated Navigation and Footer HTML Across All Pages](#13-duplicated-navigation-and-footer-html-across-all-pages)
14. [No Tests](#14-no-tests)
15. [No Linter or Formatter Configuration](#15-no-linter-or-formatter-configuration)
16. [Rate-Limiting Is Silently Skipped for Local Dev](#16-rate-limiting-is-silently-skipped-for-local-dev)
17. [Unauthenticated /api/auth/health Endpoint](#17-unauthenticated-apiauthhealth-endpoint)
18. [Webhook Secret in URL Query String](#18-webhook-secret-in-url-query-string)
19. [Missing JSDoc Types for the Core Data Model](#19-missing-jsdoc-types-for-the-core-data-model)
20. [Single-Blob Meeting Index Is a Scalability and Consistency Risk](#20-single-blob-meeting-index-is-a-scalability-and-consistency-risk)
21. [Hard-Deleted Meetings Leave Orphaned Pending Invites](#21-hard-deleted-meetings-leave-orphaned-pending-invites)
22. [meeting_type Values Are Not Validated Against an Allowed List](#22-meeting_type-values-are-not-validated-against-an-allowed-list)
23. [getDb Is Called Repeatedly Inside Route Handlers](#23-getdb-is-called-repeatedly-inside-route-handlers)
24. [checkAuth() Bypasses the apiFetch Wrapper](#24-checkauth-bypasses-the-apifetch-wrapper)
25. [invite_emails Parsing Does Not Deduplicate Addresses](#25-invite_emails-parsing-does-not-deduplicate-addresses)
26. [content-security-policy Uses unsafe-inline for Scripts](#26-content-security-policy-uses-unsafe-inline-for-scripts)
27. [Sensitive Google Token Fields Always Included in User Reads](#27-sensitive-google-token-fields-always-included-in-user-reads)

---

## 1. Duplicated Time-Slot Generation Logic

**Files affected:** `meetings.mjs` (lines 313–321), `meeting-actions.mjs` (lines 82–89),
`calendar.mjs` (lines 228–229).

**Problem:** The logic that converts a start/end time string into a list of 15-minute slot
keys (`"HH:MM"` strings) is copy-pasted in three separate functions. If the slot granularity
ever changes (say, to 30 minutes), all three copies must be updated in sync, and a maintainer
who misses one copy will introduce a subtle inconsistency in the grid.

**Recommendation:** Extract the logic into a shared utility function in `utils.mjs` and
import it everywhere it is needed.

```js
// utils.mjs — new export
/**
 * Build an ordered list of "HH:MM" time-slot strings between startTime and endTime
 * at 15-minute intervals. The end time itself is excluded.
 *
 * @param {string} startTime - "HH:MM"
 * @param {string} endTime   - "HH:MM"
 * @param {number} [stepMin=15]
 * @returns {string[]}
 */
export function buildTimeSlots(startTime, endTime, stepMin = 15) {
  const [sh, sm] = (startTime || "08:00").split(":").map(Number);
  const [eh, em] = (endTime   || "20:00").split(":").map(Number);
  const slots = [];
  let cur = sh * 60 + sm;
  const end = eh * 60 + em;
  while (cur < end) {
    slots.push(
      `${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`
    );
    cur += stepMin;
  }
  return slots;
}
```

---

## 2. auth.mjs Is Too Large — Split Into Focused Modules

**File affected:** `netlify/functions/auth.mjs` (801 lines).

**Problem:** `auth.mjs` handles at least six separate concerns in one file:
- Magic-link request and verification
- Google sign-in OAuth flow
- Google Calendar OAuth flow
- User profile read/write
- Logout
- Feedback form submission

A new contributor reading `auth.mjs` has to mentally parse nearly 800 lines before
understanding any one of these features. The file is also harder to review for security
because the auth flow and the profile/feedback logic are interleaved.

**Recommendation:** Split `auth.mjs` along natural feature boundaries. A practical first
step is to move the Google-specific helpers into a `google-oauth.mjs` helper module and
keep `auth.mjs` focused on session management (magic-link + login/logout + /me).
Alternatively, group routes into:

| File | Routes |
|---|---|
| `auth.mjs` | `me`, `profile`, `logout`, `health` |
| `magic-link.mjs` | `magic-link/request`, `magic-link/verify` |
| `google-auth.mjs` | `google/start`, `google/callback`, `google/calendar-start`, `google/calendar-callback`, `google/calendar-disconnect` |

Each file would share the utility helpers from `utils.mjs` and the common helpers
(`getOrCreateUser`, `linkPendingInvites`) could live in a small new `auth-helpers.mjs`.

---

## 3. Inconsistent API Route Naming (Singular vs Plural)

**Files affected:** `meetings.mjs`, `meeting-actions.mjs`, `admin.mjs`.

**Problem:** The API uses `/api/meetings` (plural) for list/create/delete, but
`/api/meeting` (singular) for per-meeting actions such as submitting availability,
finalizing, and reminders. The `admin.mjs` file also mixes `/api/admin/user` (singular)
and `/api/admin/users` (plural) for related resources.

This inconsistency forces API callers to remember arbitrary exceptions to the rule and is
a common source of bugs when adding a new endpoint.

**Recommendation:** Standardize on plural resource names throughout. Migrate the
singular `/api/meeting/:id/*` prefix in `meeting-actions.mjs` to `/api/meetings/:id/*`
and align `admin.mjs` similarly. Update the matching `config.path` exports and all
`apiFetch` calls in the HTML pages. This is a breaking change requiring coordinated
update to both frontend and backend, so it should be done in a single PR.

---

## 4. Timing-Attack Vulnerability in Webhook Secret Comparison

**File affected:** `netlify/functions/webhooks.mjs` (line 51).

**Problem:** The webhook secret is compared with `===`:

```js
if (!providedSecret || providedSecret !== expectedSecret) {
```

String equality in JavaScript is not constant-time: if the strings share a common prefix
the comparison takes slightly longer, which leaks information to an attacker probing for
the correct secret (a timing attack). This is a minor but real vulnerability for secrets
that protect sensitive webhook endpoints.

**Recommendation:** Use `crypto.timingSafeEqual` from Node's built-in `crypto` module,
which is already imported in `utils.mjs`:

```js
import crypto from "node:crypto";

function secretsEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// In webhooks.mjs:
if (!secretsEqual(providedSecret, expectedSecret)) {
  return errorResponse(403, "Invalid webhook secret.");
}
```

Export `secretsEqual` from `utils.mjs` so other callers can reuse it.

---

## 5. Dead Code in calendar.mjs — Unused Fallback Variable

**File affected:** `netlify/functions/calendar.mjs` (lines 175–179).

**Problem:** The code attempts to handle the edge case where `endUTC` is `NaN` (from
passing `"24:00"` to `localToUTC`), but the computed `fallback` variable is never used —
it is computed and then the `if` block ends:

```js
if (isNaN(endUTC.getTime())) {
  // end_time "20:00" on last date + 1 day
  const fallback = localToUTC(lastDate, "20:00", meetingTz);
  fallback.setDate(fallback.getDate() + 1);
  // ← fallback is never returned or assigned; endUTC is still NaN
}
```

The subsequent `freeBusy` API call will then receive a `NaN` value for `timeMax`, producing
an invalid request that silently fails or returns an error from Google's API.

**Recommendation:** Assign the fallback back to `endUTC`:

```js
let endUTC = localToUTC(lastDate, meeting.end_time || "20:00", meetingTz);
if (isNaN(endUTC.getTime())) {
  endUTC = localToUTC(lastDate, "20:00", meetingTz);
  endUTC.setDate(endUTC.getDate() + 1);
}
```

Alternatively, clamp `end_time` to `"23:59"` before passing it to `localToUTC` and remove
the edge-case branch entirely.

---

## 6. Incomplete String Replace for meeting_type Label

**File affected:** `netlify/functions/meetings.mjs` (line 178).

**Problem:** The human-readable label for `meeting_type` is built with:

```js
const typeLabel = (meeting.meeting_type || "").replace("_", " ").replace(/\b\w/g, c => c.toUpperCase());
```

`String.prototype.replace` with a string (not a regex) replaces only the **first**
occurrence. The value `"days_of_week"` becomes `"days of_week"` rather than `"days of week"`.

**Recommendation:** Use a regex with the global flag:

```js
const typeLabel = (meeting.meeting_type || "")
  .replace(/_/g, " ")
  .replace(/\b\w/g, c => c.toUpperCase());
```

---

## 7. Input Validation Gaps

**Files affected:** `meetings.mjs`, `meeting-actions.mjs`, `admin.mjs`, `auth.mjs`.

**Problem:** Several fields accept unconstrained or minimally constrained values:

- **`title`**: checked for presence but has no maximum-length limit. A title of several
  megabytes would be stored in Netlify Blobs and then returned in every list endpoint.
- **`description`**: no length limit at all.
- **`duration_minutes`** (finalization): parsed with `parseInt` but not validated; negative
  numbers or extremely large values (e.g., `2147483647`) are accepted silently.
- **`dates_or_days`**: no format validation on individual entries (arbitrary strings could
  be stored and returned in email subjects, heatmap labels, etc.).
- **`invite_emails`**: split on newline/comma, but the total number of addresses is not
  bounded — a malicious or buggy client could trigger hundreds of invitation emails.
- **`body.name`** in profile update: no length limit.

**Recommendation:** Add server-side validation constants at the top of the relevant files
(e.g., `MAX_TITLE_LENGTH = 200`, `MAX_DESCRIPTION_LENGTH = 2000`, `MAX_INVITEES = 50`) and
return `400` with a clear message when a value exceeds them. For date strings, validate
against `YYYY-MM-DD` format when `meeting_type === "specific_dates"` and against a known
set of day names when `meeting_type === "days_of_week"`.

---

## 8. N+1 Blob Reads in List Endpoints

**Files affected:** `meetings.mjs` (`GET /api/meetings`), `admin.mjs`
(`GET /api/admin/users`, `GET /api/admin/meetings`).

**Problem:** All list endpoints follow the pattern:
1. Fetch an index of IDs (one read).
2. Loop over every ID and fetch the full record individually (N reads).
3. For meetings, also fetch the invites record for each meeting (another N reads).

For 100 meetings this means 200+ sequential async Blobs reads per request. Netlify Blobs
adds network round-trip latency for each read, so large accounts will experience slow
dashboard loads that worsen as usage grows.

**Recommendation (short term):** Use `Promise.all` to parallelise the reads within each
loop instead of awaiting them one-by-one:

```js
const meetingEntries = await Promise.all(
  indexData.map(id => meetings.get(id, { type: "json" }).catch(() => null))
);
```

**Recommendation (long term):** Maintain denormalized summary blobs (e.g.,
`meetings:summary:<id>`) that store only the fields needed for the list view
(`title`, `creator_id`, `invite_count`, `respond_count`, `is_finalized`). The full record
is only fetched when viewing the meeting detail page.

---

## 9. Hardcoded Default Admin Email in getEnv Fallback

**File affected:** `netlify/functions/utils.mjs` (line 336).

**Problem:** The `isAdmin` function falls back to a hardcoded email when `ADMIN_EMAILS`
is not set:

```js
const adminEmails = getEnv("ADMIN_EMAILS", "yusuf.pisan@gmail.com")
```

If a developer clones the repo, forgets to set `ADMIN_EMAILS`, and deploys their own
instance, `yusuf.pisan@gmail.com` becomes an admin on their deployment. Even if the
developer never registers that email, having a hardcoded address in source code looks
like a backdoor to security reviewers.

**Recommendation:** Change the fallback to an empty string:

```js
const adminEmails = getEnv("ADMIN_EMAILS", "")
  .split(",")
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);
```

If `ADMIN_EMAILS` is empty, `isAdmin` correctly returns `false` for everyone. Document in
`README.md` and `.env.example` that at least one admin email should be configured before
deployment.

---

## 10. Flash Message Category Inconsistency

**Files affected:** `index.html`, `dashboard.html`, `create-meeting.html`, `meeting.html`,
`profile.html`, `admin.html`, `static/common.js`.

**Problem:** `showFlash` in `common.js` documents four valid categories:
`'info' | 'success' | 'warn' | 'error'`. However, the HTML pages call `showFlash` with
`'danger'` and `'warning'` — categories that have no corresponding CSS rule, so the flash
banner appears with no visual distinction from the default style:

```js
showFlash('Meeting created!', 'warning');   // no CSS rule for "flash-warning"
showFlash(data.error, 'danger');            // no CSS rule for "flash-danger"
```

**Recommendation:** Choose one set of category names and apply them consistently. The CSS
file should define all expected variants (`flash-info`, `flash-success`, `flash-warn`,
`flash-error`). Update both the `showFlash` JSDoc and every call site to use only the
documented set.

---

## 11. Inline HTML Event Handlers in Dynamic Content

**Files affected:** `dashboard.html`, `meeting.html`, `create-meeting.html`.

**Problem:** Dynamically-built HTML strings include inline `onclick` attributes that call
global functions by name:

```js
html += `<button onclick="deleteMeeting('${m.id}')">Delete</button>`;
html += `<div onclick="${isPast ? '' : `toggleDate('${key}')`}">...</div>`;
```

This pattern has several drawbacks:
- It requires functions (`deleteMeeting`, `toggleDate`) to be global, polluting
  `window` and making future module migration difficult.
- Injecting a value like `m.id` into an `onclick` string is an XSS risk if the ID is
  ever derived from user input rather than being a server-generated opaque ID.
- Linters and IDEs cannot validate the code inside the attribute string.

**Recommendation:** Build elements with `document.createElement` and attach listeners with
`addEventListener`, passing data via `element.dataset` attributes:

```js
const btn = document.createElement('button');
btn.className = 'btn btn-sm btn-danger';
btn.textContent = 'Delete';
btn.dataset.meetingId = m.id;
btn.addEventListener('click', handleDeleteMeeting);
container.appendChild(btn);

function handleDeleteMeeting(e) {
  const id = e.currentTarget.dataset.meetingId;
  // ...
}
```

---

## 12. HTML String Concatenation for Rendering

**Files affected:** `dashboard.html`, `meeting.html`, `admin.html`.

**Problem:** Large chunks of HTML are built by appending to a string and then assigned to
`container.innerHTML`. While `escapeHtml` is used on user-supplied values in most places,
string-concatenation-based rendering is fragile: a single missed call to `escapeHtml` opens
an XSS hole, and there is no systematic way to enforce the rule. It is also difficult to
maintain when the markup grows.

**Recommendation:** Adopt a template-function pattern using a tagged template literal
helper, or move to `document.createElement` + `textContent` for all user-supplied text.
As a lower-effort alternative, define small functions that return `DocumentFragment`
objects (built with the DOM API) rather than HTML strings. This makes XSS impossible by
construction because `textContent` never interprets its content as markup.

---

## 13. Duplicated Navigation and Footer HTML Across All Pages

**Files affected:** All HTML pages (`index.html`, `dashboard.html`, `create-meeting.html`,
`meeting.html`, `profile.html`, `email-sent.html`, `feedback.html`, `admin.html`,
`register.html`).

**Problem:** Every HTML file contains an identical copy of the `<nav>` element and
`<footer>` element. Changing the brand name, adding a nav link, or updating the footer
requires editing nine files and it is easy to miss one.

**Recommendation:** Extract the nav and footer into small JavaScript functions in
`common.js` that inject the HTML at load time, or use server-side HTML includes. For
example:

```js
// common.js
function renderNav() {
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  nav.innerHTML = /* standard nav markup */;
}
document.addEventListener('DOMContentLoaded', renderNav);
```

Each HTML page then only contains a placeholder `<nav id="app-nav"></nav>`. Because
`common.js` is already loaded on every page, this adds no new dependency.

---

## 14. No Tests

**Files affected:** Entire project (no `*.test.*` or `*.spec.*` files exist).

**Problem:** There are zero automated tests. Core business logic—time-slot generation,
rate-limit counters, encryption/decryption, meeting index management, invite linking—is
only verified manually. This makes refactoring risky and regressions hard to catch before
deployment.

**Recommendation:** Introduce a lightweight test runner (e.g., Node's built-in
`node:test` module, which requires no additional dependencies) and start with unit tests
for the pure utility functions in `utils.mjs` and the time-slot logic. A reasonable
starter set would cover:

- `generateId` — output format and uniqueness
- `encryptSecret` / `decryptSecret` — round-trip, empty input, legacy values
- `validateEmail` — valid and invalid addresses
- `buildTimeSlots` (once extracted) — edge cases: start == end, midnight, 24:00
- `checkRateLimit` — allow / deny / window reset (using a fake Blobs stub)
- `isAdmin` — case-insensitivity, multiple emails, missing env var

---

## 15. No Linter or Formatter Configuration

**Files affected:** `package.json`, project root.

**Problem:** There is no ESLint or Prettier configuration. Without automated style
enforcement, different contributors will introduce inconsistent indentation, quote styles,
and code patterns. The existing code is generally consistent, but relying on manual
discipline does not scale.

**Recommendation:** Add ESLint with a minimal flat-config (e.g.,
`eslint.config.mjs` using `@eslint/js`) and Prettier. Add lint and format scripts
to `package.json`:

```json
"scripts": {
  "lint":   "eslint netlify/functions/ static/",
  "format": "prettier --write ."
}
```

A pre-commit hook (via `simple-git-hooks` + `lint-staged`) can enforce these on every
commit without requiring CI.

---

## 16. Rate-Limiting Is Silently Skipped for Local Dev

**File affected:** `netlify/functions/auth.mjs` (multiple `isLocalDevRequest` guards).

**Problem:** Rate limiting is bypassed entirely for requests from `localhost`. While
this is convenient for local development, the bypass is implicit — a developer may not
realize that their local testing gives them a false sense of how the app behaves under
repeated requests. It also means that any attack that reaches the function with a
`Host: localhost` header (unlikely but possible on certain proxy setups) would bypass
rate limits entirely.

**Recommendation:** Keep the bypass for development ergonomics, but make it explicit and
configurable:

```js
// In utils.mjs or a config module
export function isRateLimitEnabled() {
  return getEnv("DISABLE_RATE_LIMIT", "") !== "true";
}
```

Add `DISABLE_RATE_LIMIT=true` to `.env.example` with a comment explaining it is for local
development only. Remove the `isLocalDevRequest(req)` hostname heuristic to avoid
host-header-based bypass.

---

## 17. Unauthenticated /api/auth/health Endpoint

**File affected:** `netlify/functions/auth.mjs` (health route, ~line 202).

**Problem:** The `/api/auth/health` endpoint returns which environment variables are
configured:

```json
{
  "checks": {
    "jwt_secret": true,
    "resend_api_key": false,
    "google_client_id": true,
    ...
  }
}
```

While it never returns secret values, this information is useful to an attacker who wants
to understand which third-party integrations are active or misconfigured. The endpoint
is reachable by anyone without authentication.

**Recommendation:** Require admin authentication for the health endpoint (same guard used
in `admin.mjs`), or restrict it to localhost-only requests. Alternatively, move the
health check logic into the admin panel UI so it is only visible to authenticated admins.

---

## 18. Webhook Secret in URL Query String

**File affected:** `netlify/functions/webhooks.mjs`, `.env.example`.

**Problem:** The Resend webhook is authenticated by appending a secret to the URL:
`/api/webhooks/resend?secret=<value>`. URL query strings appear in:
- Web server access logs
- Browser history (if anyone navigates to the URL)
- `Referer` headers sent from the webhook URL in some proxy configurations
- Netlify function logs (the full URL is logged via `logRequest`)

This risks leaking the secret.

**Recommendation:** Authenticate the webhook using an HTTP header instead. Resend supports
custom headers on webhook deliveries. Configure Resend to send the secret as
`X-Webhook-Secret: <value>` and read it from the request headers on the server:

```js
const providedSecret = req.headers.get("x-webhook-secret") || "";
```

Update `.env.example` and the webhook setup instructions accordingly.

---

## 19. Missing JSDoc Types for the Core Data Model

**File affected:** `netlify/functions/utils.mjs`, `meetings.mjs`, `auth.mjs`.

**Problem:** The application has well-defined data structures (User, Meeting, Invite,
AvailabilitySlot, EventRecord) that are read and written throughout the codebase, but
none of them are documented with `@typedef`. This means:
- Editors cannot offer autocomplete on object properties.
- A developer adding a new field to Meeting must search all files to understand the
  current shape.
- Type errors (e.g., accessing `meeting.creator` instead of `meeting.creator_id`) are
  only caught at runtime.

**Recommendation:** Add `@typedef` blocks in `utils.mjs` for each core entity:

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

If the project later adopts TypeScript or enables `"checkJs": true` in a
`jsconfig.json`, these annotations become enforced.

---

## 20. Single-Blob Meeting Index Is a Scalability and Consistency Risk

**File affected:** `netlify/functions/meetings.mjs` (meeting index management).

**Problem:** All meeting IDs are stored in a single blob under the key `"index"`. Every
time a meeting is created or deleted, the full array is read, modified, and written back.
Two simultaneous writes would create a race condition: both reads see the same old array
and both writes save different arrays, with one write silently overwriting the other's
change (a lost update).

**Recommendation (short term):** Document the race condition explicitly in code comments
and in the README so future contributors are aware of it.

**Recommendation (long term):** Use Netlify Blobs metadata or a list-by-prefix approach
instead of a manually maintained index array. Netlify Blobs supports `store.list()` to
enumerate all keys in a store; maintaining a separate index is only necessary for efficient
ordering. If ordering is important, switch to a per-meeting timestamp-prefixed key (e.g.,
`2024-03-15T12:00:00Z-<id>`) so the natural lexicographic order of keys gives chronological
order without a central index blob.

---

## 21. Hard-Deleted Meetings Leave Orphaned Pending Invites

**File affected:** `netlify/functions/meetings.mjs` (delete route, ~line 369).

**Problem:** When a meeting is deleted, the code correctly removes the meeting blob, the
invites blob, and the availability blob. However, if any invitee had a
`invites:"pending:<email>"` entry referencing the deleted meeting (i.e., they were invited
but never registered), those pending references are not cleaned up. When the user later
registers, `linkPendingInvites` will try to load the deleted meeting's invite list and
silently do nothing (the `.catch(() => [])` swallows the error), but the pending reference
remains in the blob store indefinitely.

**Recommendation:** During meeting deletion, also clean up pending invite references for
any invitee whose `user_id` is null (i.e., not yet registered):

```js
for (const inv of meetingInvites) {
  if (!inv.user_id) {
    const pendingKey = `pending:${inv.email}`;
    const pending = asArray(await invites.get(pendingKey, { type: "json" }).catch(() => []));
    const updated = pending.filter(id => id !== meetingId);
    if (updated.length < pending.length) {
      await invites.setJSON(pendingKey, updated);
    }
  }
}
```

---

## 22. meeting_type Values Are Not Validated Against an Allowed List

**File affected:** `netlify/functions/meetings.mjs` (create route).

**Problem:** The `meeting_type` field is stored without validation. The calendar busy
endpoint (`calendar.mjs`, line 131) already contains a subtle inconsistency, checking for
both `"day_of_week"` (singular) and `"days_of_week"` (plural), suggesting an earlier typo
that was patched defensively rather than fixed at the source. Any unrecognised value would
be stored silently and could cause unexpected behaviour in the grid rendering, email
templates, and calendar integration.

**Recommendation:** Add explicit validation at meeting creation:

```js
const VALID_MEETING_TYPES = new Set(["specific_dates", "days_of_week"]);
if (!VALID_MEETING_TYPES.has(meeting_type)) {
  return errorResponse(400, `meeting_type must be one of: ${[...VALID_MEETING_TYPES].join(", ")}`);
}
```

Remove the defensive dual-check in `calendar.mjs` once all stored records have valid values.

---

## 23. getDb Is Called Repeatedly Inside Route Handlers

**File affected:** `netlify/functions/meeting-actions.mjs` and `admin.mjs`.

**Problem:** `getDb("meetings")` is called inside each individual `if` route block in
`meeting-actions.mjs`, meaning the same store handle is obtained multiple times per
request and different route blocks independently call `getDb("invites")` and
`getDb("availability")`. This is harmless (the function is cheap), but it creates visual
noise and makes it less obvious which stores a function uses.

**Recommendation:** Declare all store handles at the top of the `handleMeetingActions`
function, once, before the route matching:

```js
const meetings     = getDb("meetings");
const invites      = getDb("invites");
const availability = getDb("availability");
```

This is already done correctly in `meetings.mjs` (lines 49–51) and should be applied
consistently in the other function files.

---

## 24. checkAuth() Bypasses the apiFetch Wrapper

**File affected:** `static/common.js` (line 55).

**Problem:** `checkAuth` calls `fetch('/api/auth/me')` directly instead of using the
shared `apiFetch` helper. This means that if `/api/auth/me` returns a non-JSON response
(e.g., during a platform error), or the network fails, `checkAuth` will throw or behave
inconsistently compared to every other API call.

The intentional reason for not using `apiFetch` is likely that `checkAuth` should not
redirect on 401 (a 401 from `me` means "not logged in", not "session expired"). However,
this reason is not documented.

**Recommendation:** Add a comment explaining why `apiFetch` is deliberately not used here,
and add a try/catch around the JSON parse call to match the resilience of `apiFetch`:

```js
async function checkAuth() {
  try {
    // We call fetch directly (not apiFetch) so that a 401 response does NOT
    // trigger an automatic redirect. A 401 from /me simply means "not signed in".
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    const user = await res.json();
    // ...
  } catch {
    return null;
  }
}
```

---

## 25. invite_emails Parsing Does Not Deduplicate Addresses

**File affected:** `netlify/functions/meetings.mjs` (create route, ~line 145).

**Problem:** If a creator enters the same email address twice in the invite field, two
separate invite records are created for that address and two separate invitation emails
are sent. The meeting-actions `availability` endpoint uses `user_id` to identify a user's
slots, so the duplicate invite entries could cause incorrect `respond_count` values (one
responded entry but two invite entries).

**Recommendation:** Deduplicate the email list after parsing:

```js
const emails = [...new Set(
  rawEmails.map(e => validateEmail(e)).filter(e => e && e !== user.email)
)];
```

---

## 26. content-security-policy Uses unsafe-inline for Scripts

**File affected:** `netlify.toml`.

**Problem:** The `Content-Security-Policy` header includes `script-src 'self' 'unsafe-inline'`.
This allows any inline `<script>` tag on the page to execute, which significantly weakens
XSS protection. If an attacker can inject HTML into a page (e.g., through a missing
`escapeHtml` call in the dashboard grid), they can also inject a `<script>` block.

The reason `'unsafe-inline'` is currently needed is that the page-specific JavaScript is
written directly in `<script>` tags in each HTML file.

**Recommendation (short term):** Add a `nonce`-based CSP approach. At build time (or via
a Netlify edge function), generate a random nonce per response and inject it into both the
`Content-Security-Policy` header and each `<script>` tag:

```
Content-Security-Policy: script-src 'self' 'nonce-<random>'
```

**Recommendation (long term):** Move all page-specific JavaScript into external `.js`
files in the `static/` directory and remove the inline `<script>` blocks entirely. This
allows replacing `'unsafe-inline'` with `'self'` in the CSP.

---

## 27. Sensitive Google Token Fields Always Included in User Reads

**File affected:** Multiple (`admin.mjs`, `auth.mjs`, `calendar.mjs`).

**Problem:** Every `usersDb.get(email, { type: "json" })` call returns the full user
record including `google_access_token` and `google_refresh_token` (even though they are
encrypted). Most call sites do not need these fields — for example, the auth `/me` endpoint
only returns `id`, `email`, and `name`. `admin.mjs` explicitly deletes the fields before
sending the response (`delete safeUser.google_access_token`), but this defensive step is
easy to forget if someone adds a new endpoint.

**Recommendation:** Define a `sanitizeUser` helper in `utils.mjs` that strips sensitive
fields from a user object before it leaves the server:

```js
export function sanitizeUser(user) {
  const { google_access_token, google_refresh_token, ...safe } = user;
  return safe;
}
```

Use this function in every endpoint that returns user data, and use a separate dedicated
function (`getUserWithTokens`) in the narrow places that genuinely need the token fields
(calendar.mjs, auth callback handlers).

---

*End of proposed changes. Each item above is independent; they can be addressed in any
order or prioritized by impact. Items 4, 5, 6, 9, and 25 are the smallest fixes with
the highest impact per line of code changed and are good starting points.*
