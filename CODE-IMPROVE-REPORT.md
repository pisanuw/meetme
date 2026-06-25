# Code Improve Report — meetme-new (whole repository)

_Generated 2026-06-25 as a report-only review. **Update (same day): all six items in "Suggested order of work" were subsequently implemented at the user's request — see that section for per-item status and the two deliberate scope decisions. The findings below are preserved as written at review time.**_

## Summary

- **Scope:** 113 tracked files. Deep bug/quality review focused on the ~57 logic files (`netlify/functions/**/*.mjs`, `static/*.js`, `scripts/`). HTML pages (no inline scripts under the strict CSP) and test files were not deep-reviewed for defects.
- **Review findings:** 6 confirmed (1 medium, 5 low) + 1 design consideration. **3 reviewer claims were verified false and dropped** (see _Verified and dismissed_).
- **Simplification proposals:** ~15 behavior-preserving (mostly de-duplication). The single biggest opportunity is ~350 lines of duplicated frontend code (calendar picker + drag-select grid).
- **Audits run (detect-only):** secret-hygiene (light), repo-artifacts, ci-gates, fail-closed-security, history-and-presentation.
- **⚠ Action required:** **none.** No leaked secrets, no tracked build artifacts, no CI gaps, fail-closed security posture holds.

This is a clean, well-built codebase. The findings below are refinements, not firefighting. Each `file:line` was opened and verified against the actual code before inclusion.

---

## Review findings

### Medium

**`netlify/functions/meeting-actions.mjs:108-135` and `netlify/functions/meetings.mjs:479-497` — Lost-update race on non-atomic Blobs read-modify-write (confidence 75)**
Both paths do `read → modify-in-memory → setJSON` against a single meeting key with no etag/CAS:

- `meeting-actions.mjs` reads `availability` for the meeting, filters out the caller's old rows, appends new rows, writes the whole array back.
- `meetings.mjs` reads `invites`, appends a "added via shared link" participant, writes back.

Two concurrent writers on the same meeting can clobber each other (one user's availability submission, or one participant add, silently lost — last write wins). This is the exact hazard `lib/rate-limit.mjs` deliberately defends against with etag compare-and-swap, and that the booking path mitigates with post-write reconciliation; the meeting availability/invite paths do neither. Likelihood is real for group scheduling (multiple invitees responding at once). _Fix direction: an etag-retry CAS wrapper around these writes, or reuse the rate-limiter's CAS helper._

### Low

**`netlify/functions/lib/bookings-helpers.mjs:55` — `getWeekdayForDate` returns the wrong weekday for UTC+13/+14 host timezones (confidence 70)**
`new Date(`${dateStr}T12:00:00Z`)` (noon UTC) shifts into the _next_ calendar day for offsets beyond +12 (e.g. Pacific/Kiritimati +14 → 02:00 next day), so the weekday returned is off by one. A host configured in such a zone with weekly availability would have their windows fail to match and slots wouldn't appear. Negative offsets and all normal zones are unaffected. Low population, but a genuine logic defect. _Fix direction: anchor the weekday computation to the date's local midday in `timezone`, not UTC noon._

**`static/create-meeting.js:174` — No double-submit guard on meeting creation (confidence 60)**
The submit handler never disables the submit button while the POST is in flight. A double-click (or slow network) can fire `POST /api/meetings` twice, creating duplicate meetings and duplicate invite emails. (Note: a Stage-1 reviewer framed this as "user trapped when the server errors" — that's inverted; because the button is never disabled, the user is _not_ trapped. The real, smaller issue is the missing in-flight guard.) The same pattern recurs on other submit handlers. _Fix direction: disable on submit, re-enable in a `finally`._

**`static/book.js:251`, `static/booking-availability.js:605`, `static/booking-setup.js:108`, `static/booking-confirmation.js:87`, `static/feedback.js:1` — Page-init async entrypoints without `.catch()` (confidence 70)**
Each page kicks off an `async` init (IIFE or `init()` / `checkAuth().then(...)`) with no rejection handler. If initialization throws (e.g. a failed `apiFetch` during bootstrap), the user sees a blank or half-rendered page and the only signal is an uncaught-rejection in the console. _Fix direction: wrap init in a `.catch()` that surfaces a flash/error state._

**`static/meeting.js:177` — Empty-name modal "Save" silently does nothing (confidence 55)**
In the anonymous-name modal, `onSave` returns early when the trimmed name is empty without resolving or giving feedback, so clicking Save with a blank field appears to do nothing. Not a hang (the modal stays open and the user can type a name or cancel — the awaiting caller is _meant_ to wait), but there's no validation hint explaining why. _Fix direction: show an inline "Please enter a name" hint or disable Save while empty._

**`netlify/functions/admin.mjs:14` — Header doc advertises an unimplemented route (confidence 75)**
The file header comment lists `POST /api/admin/meetings/:id/delete — force-delete any meeting`, but no such route handler exists (admin routes implemented: stats, users CRUD, users/admin, users/delete, impersonate, GET meetings, events). Stale documentation. _Fix direction: implement the route or remove the line._

### Design consideration (below the reporting bar; surfaced for a product decision)

**`netlify/functions/meetings.mjs:485` + `netlify/functions/lib/utils-core.mjs:90` — Account meeting IDs double as the share capability and are low-entropy**
Any authenticated user who presents a meeting ID to `GET /api/meetings/:id` is auto-added as a participant ("added via shared link"). That is the intended Doodle-style sharing model — the meeting URL _is_ the invite. The caveat: account meeting IDs come from `generateId()` = `Date.now().toString(36)` + 6 base-36 random chars (~31 bits of randomness), so the capability is more guessable/enumerable than a signed token. Anonymous meetings already use signed PARTICIPATION/ADMIN JWTs and stronger IDs. This is **not** an unauthenticated bypass (a Stage-1 reviewer mislabeled it as such — a valid session is required). Worth a deliberate decision: confirm "anyone with the link can join" is intended for account meetings, and if so consider raising the ID entropy (e.g. `crypto.randomUUID()` / 128-bit random).

---

## Simplification proposals

All behavior-preserving; report-only. Listed highest-value first. (Note: this codebase has no bundler, so frontend extractions must attach helpers to `window`, the existing pattern for `apiFetch`/`showFlash`/etc.)

### Frontend (largest win — ~350 lines of duplication)

- **`static/index.js:78-188` ≈ `static/create-meeting.js:59-172`** — The entire mini-calendar / specific-dates picker (`initCalendar`, `renderCalendar`, `shiftMonth`, `toggleDate`, `updateChips`, months array, wiring) is duplicated ~verbatim (~110 lines). Extract to one shared module.
- **`static/index.js:31-67` ≈ `static/create-meeting.js:17-57`** — Start/end time `<option>` builders + day-of-week checkbox builder are byte-for-byte identical (~40 lines). Extract to `common.js`.
- **`static/meeting.js:874-989` ≈ `static/booking-availability.js:443-535`** — Click-and-drag + touch grid interaction (mousedown/move/up + touch state machine) is ~115 near-identical lines; only the start/apply/end callbacks differ. Extract `bindDragSelect(grid, {startDrag, applyDrag, endDrag})`.
- **`static/meeting.js:699-733` ≈ `static/booking-availability.js:181-219`** — Shared `ag-grid` DOM builder (corner, column headers, time-label rows, per-column cells with date/time/key datasets). Extract one builder.
- **`static/{meeting,booking-availability,book,index,create-meeting}.js`** — `fmtDate` (`toLocaleDateString("en-US", {weekday,month,day})`) reimplemented in 5 files. Consolidate into one helper.
- **`static/{index,profile,create-meeting}.js`** — The "populate timezone select, prepend value if missing, set value" routine is duplicated in 3 files. Extract `applyTimezoneToSelect(sel, tz)`.
- **`static/dashboard.js` / `static/admin.js` (pagination handlers ~211-216, 450-455)** — `onUsersPaginationClick` / `onMeetingsPaginationClick` differ only by a `data-kind` selector and target var. Collapse into one parameterized handler.
- **`static/login.js:1-6`** — `sanitizeNextPath` duplicates the leading-slash / `//` guard already in `common.js`. Reuse the shared sanitizer.

### Backend libraries

- **`netlify/functions/lib/user-store.mjs:6` and `lib/email.mjs:13`** — `normalizeEmail` (trim + lowercase) is defined verbatim in both. **Confirmed duplicate.** Extract to `utils-core.mjs`.
- **`netlify/functions/lib/http.mjs:71-89, 124-142`** — `shouldUseSecureCookies` and `getAppUrl` each independently parse a URL to detect localhost/127.0.0.1/::1. Extract one `isLocalHostname(host)` predicate.
- **`netlify/functions/lib/meeting-store.mjs:62-66, 109-112`** — The "list blobs, keep canonical keys ending in `-${id}`" filter is duplicated in `getMeetingRecord` and `deleteMeetingRecord`. Extract a small helper.

### Backend routes

- **`netlify/functions/meeting-actions.mjs:116-131` ≈ `public-meetings.mjs:371-391`** — Identical slot-key parse/validate loop (`indexOf("_")` + `validDates`/`validTimes` + push/skip). Extract `parseAvailabilitySlots(...)`.
- **`netlify/functions/meetings.mjs:519`, `meeting-actions.mjs:144` & `:406`, `public-meetings.mjs:272` & `:406`** — The `slotCounts` aggregation loop is copy-pasted in 5 places. Extract `countSlots(availList)`.
- **`netlify/functions/meetings.mjs:365`** — Inlines the same preference-token + opt-out/block URL construction that `meeting-actions.mjs` already provides as `buildEmailPreferenceLinks`. Promote that helper to `lib` and reuse.
- **`netlify/functions/auth-google.mjs` (sign-in ~144 vs calendar ~319; state-verify ~124 vs ~306)** — The Google `authorization_code` token exchange and the `oauth_state` cookie + state-match + purpose-check are duplicated across the two OAuth callbacks. Extract `exchangeCodeForTokens(...)` and `verifyOAuthState(req, cookieName, purpose)`.
- **`netlify/functions/admin.mjs:118` & `:410`** — The GET users-list and GET meetings-list routes share an identical "load blobs → filter by query over fields → sort by `created_at` desc → paginate → slice" pipeline. Extract one helper taking a field-extractor.
- **`netlify/functions/bookings.mjs:477` & `:494`** — Host-list and attendee-list routes differ only by the `host:`/`attendee:` index key. Extract `loadBookingsByIndex(bookingsDb, indexKey)`.
- **Across `auth.mjs`, `meetings.mjs`, `meeting-actions.mjs`, `calendar.mjs`, `bookings.mjs`** — The `const u = getUserFromRequest(req); if (!u) return errorResponse(401, ...)` boilerplate repeats ~20× with identical wording. A `requireUser(req)` helper returning `{user}` or `{error}` would collapse it.

_Not proposed (deliberately): the per-handler top-level `try/catch` wrapper and the per-route rate-limit guards look duplicated but each carries distinct `FN`/bucket/response semantics; extracting them risks behavior drift. Also: the Stage-2 simplifier suggested removing `verifyTokenVerbose` as dead code — **rejected**, it's exercised by `test/jwt.test.mjs:57`._

---

## Audit findings (detect-only)

### Secret hygiene (light read-only scan) — clean

Only `.env.example` is tracked (expected, safe). No `.key`/`.pem`/`.gpg`/keyring/`AI-log.md` files, and no private-key blocks, AWS/Stripe/Slack/GitHub token patterns in tracked content. `.sops.yaml` carries a placeholder key per the documented SOPS workflow. **No action.** (`audit-secret-hygiene` was correctly _not_ run — it rewrites history and is out of scope for a read-only sweep.)

### Repo artifacts — clean

No tracked `dist/`/`build/`/`node_modules/`/coverage, no compiled binaries, no data dumps, no root scratch files. Largest tracked file is `package-lock.json` (476 KB, expected). `.git` is 1.5 MB. **No action.**

### CI gates — comprehensive, no gaps

`.github/workflows/ci.yml` runs: prod-dependency `npm audit`, `format:check`, `typecheck` (`tsc --checkJs`), `lint` (`eslint --max-warnings 0`) + per-file `node -c` syntax check of `static/*.js`, unit tests in **two** modes, e2e Playwright smoke, and staging smoke. Verified the two test jobs are genuinely distinct: the "rate limit enabled" job sets `TEST_RATE_LIMIT_MODE: on`, which `test/test-helpers.mjs:83` translates into actually enabling the limiter. **No action.**

### Fail-closed security — posture holds

A dedicated detection pass over crypto, JWT, SSRF, secret comparison, and rate limiting found nothing ≥70 confidence, and spot-verification confirms: `JWT_SECRET` and `TOKEN_ENCRYPTION_KEY` **throw** when missing (no weak fallback); all server-side fetches target hard-coded Google/Resend hosts; webhook/magic-link/signed-link secrets compare via `secretsEqual` → `crypto.timingSafeEqual`; rate limiting is durable (Netlify Blobs CAS) and **denies on store error** unless `failOpen` is explicitly passed. The only `process.env` shortcut in `rate-limit.mjs:90` affects log level only, not the deny decision. **No action.**

### History & presentation — strong, one cosmetic nit

Commit history is exemplary (Conventional Commits, descriptive, one feature per commit). `LICENSE` (MIT) and a 22 KB `README.md` are present. Only nit: `package.json` has no `description` field (the package is `"private": true`, so impact is cosmetic). **Optional:** add a `description`.

---

## ⚠ Verified and dismissed (for transparency)

These were raised by Stage-1 reviewers, then checked against the code and found not to hold — recorded so they aren't re-flagged later:

- **"`bookings.mjs:420` leaves orphaned host/attendee index entries on booking rollback"** — **false.** The rollback `return` (line 427) executes _before_ the host/attendee index writes (lines 436-437); on rollback those indices were never touched. The path is clean.
- **"`rate-limit.mjs:90` bypasses the env abstraction"** — **not a defect.** `process.env` is read only to choose a log level on store failure; the fail-closed decision is unaffected, and `process.env` is valid in the Functions runtime.
- **"`verifyTokenVerbose` is dead code"** — **false.** It's covered by `test/jwt.test.mjs`.

---

## Suggested order of work

_All six items implemented on 2026-06-25. Full gate green afterward: 140 unit tests (both default and rate-limit-enabled modes), `tsc --checkJs` (0 new findings), eslint `--max-warnings 0`, prettier, and all 16 Playwright smoke tests._

1. ✅ **Add CAS/etag retry to the meeting availability + invite writes** (`meeting-actions.mjs`, `meetings.mjs`) — added `updateJsonWithCas()` to `lib/db.mjs` (etag compare-and-swap with retry) and applied it to the availability submit and the shared-link participant-add. The participant-add only logs/emits its event when this request is the one that actually added.
2. ✅ **Decide the meeting-ID trust model** — kept the "anyone with the link joins" model and removed the enumeration concern: added `generateSecureId()` (128-bit CSPRNG hex, chosen over `crypto.randomUUID()` because the meeting-store key pattern requires `[a-z0-9]+` and a UUID's hyphens would break it) and switched both account and anonymous meeting-ID creation to it.
3. ✅ **Frontend de-duplication** — extracted the mini-calendar/specific-dates picker + time/day builders into a new `static/scheduling.js` (`window.MeetingForm`), and the drag-select mouse/touch state machine into `bindDragSelect()` in `common.js`. ~265 lines of verbatim duplication removed across `index.js`, `create-meeting.js`, `meeting.js`, `booking-availability.js`. _The shared `ag-grid` DOM builder was deliberately left:_ the two builders diverge (date-columns vs column-objects, different `dataset` keys, different time-slot sources, meeting-specific finalize wiring), so a unified builder would be a leaky, parameter-heavy abstraction rather than a simplification.
4. ✅ **Small correctness/UX fixes** — `getWeekdayForDate` now resolves the weekday in UTC (the weekday of a bare date is timezone-independent), fixing the UTC+13/+14 off-by-one and dropping the misleading `timezone` param; added `.catch()` to all five page-init entrypoints; added a double-submit guard to create-meeting (disable on submit, re-enable only on failure since success navigates away); added an accessible "Please enter a name" hint to the modal; rewrote the admin header doc to match the actually-implemented routes.
5. ✅ **Backend route de-duplication** — added `requireUser(req)` (in `lib/jwt.mjs`) and applied it to the 12 identical auth-guard sites (the 3 non-standard sites — admin-check, OAuth redirect, bookings' single-lookup-with-reused-guards — were left); added pure `countSlots()` and `parseAvailabilitySlots()` helpers and applied them to the 4 slot-count and 2 slot-parse loops; extracted the verbatim Google token-exchange fetch into `requestGoogleToken()`. _The OAuth state-verification was deliberately left:_ the sign-in and calendar callbacks differ in CSRF-check granularity, cookie name, error-redirect targets, and logging, so unifying them would change security-relevant behavior on code with no automated coverage.
6. ✅ **Cosmetic** — added a `description` to `package.json`.
