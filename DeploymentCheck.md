# MeetMe — Pre-Deployment Check Report

**Review Date:** 2026-03-28  
**Reviewer:** Automated Pre-Deployment Check Agent  
**Scope:** Full code review — functionality, security, and maintainability  
**Test Status:** ✅ All 43 unit tests pass · ✅ No npm dependency vulnerabilities · ✅ ESLint clean

---

## Summary

The codebase is well-structured with solid fundamentals: HttpOnly JWT cookies, AES-256-GCM token encryption, rate limiting on auth endpoints, CSRF protection on OAuth flows, HTML escaping in both backend emails and frontend rendering, and a comprehensive CI pipeline. No critical architectural flaws were found. The issues below are ordered by deployment risk — address items 1–3 before going live.

---

## Actions & Concerns (Priority Order)

---

### 🔴 HIGH — Must Fix Before Production

---

#### 1. `all_invites` Exposes Participant Email Addresses to All Meeting Members

**File:** `netlify/functions/meetings.mjs`, line 449  
**Severity:** High — Privacy / Data Leakage

The `GET /api/meetings/:id` endpoint returns `all_invites` in the response body to every authenticated participant. The `all_invites` array contains the `email`, `user_id`, `name`, and `responded` fields for every invitee. Although the `participants` array correctly restricts email addresses to the meeting creator (`if (isCreator) entry.email = inv.email`), the `all_invites` field bypasses this restriction entirely.

Non-creator participants can read the email addresses of all other participants by inspecting the API response.

**Recommended Fix:** Either remove `all_invites` from the response entirely, or strip email addresses from it for non-creator callers before serializing:
```js
all_invites: isCreator
  ? meetingInvites
  : meetingInvites.map(({ email, ...rest }) => rest),
```

---

#### 2. Feedback Endpoint Has No Rate Limiting

**File:** `netlify/functions/auth.mjs`, line 550 (`POST /api/auth/feedback`)  
**Severity:** High — Abuse / Email Cost Exhaustion

Every other auth endpoint (`magic-link/request`, `google/start`, `google/calendar-start`) applies per-IP and/or per-email rate limiting via `checkRateLimit()`. The `POST /api/auth/feedback` route is the only auth endpoint with no rate limiting.

An unauthenticated attacker can send unlimited feedback emails to admin inboxes, flooding them and exhausting Resend API email quota with no friction.

The feedback endpoint also lacks a message length cap — a very large `message` body passes validation and is forwarded to the Resend API verbatim.

**Recommended Fix:**
- Add per-IP rate limiting (e.g. 10 requests per 15 minutes) at the start of the feedback handler, mirroring the magic-link/request pattern.
- Add a `MAX_FEEDBACK_MESSAGE_LENGTH` constant (e.g. 5000 characters) and return 400 if exceeded.
- Add a `MAX_FEEDBACK_NAME_LENGTH` constant and validate `senderName`.

---

#### 3. Internal Error Messages Are Leaked to Clients in Production

**Files:** `netlify/functions/admin.mjs:43`, `netlify/functions/bookings.mjs:69`, `netlify/functions/calendar.mjs:36`, `netlify/functions/meeting-actions.mjs:39`, `netlify/functions/meetings.mjs:61`  
**Severity:** High — Information Disclosure

Five of the seven serverless functions expose the raw `err.message` string directly in the HTTP 500 response body:
```js
// e.g. in admin.mjs, bookings.mjs, etc.
return errorResponse(500, `Internal server error: ${err.message}`);
```

This can disclose internal implementation details (library names, file paths, variable names, Netlify Blobs key names) to any user who triggers an unhandled exception. Only `auth.mjs` correctly separates the internal message from the public-facing error text.

**Recommended Fix:** Change all five catch blocks to log the detail internally and return a generic message to the client:
```js
log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
return errorResponse(500, "Internal server error.");
```

---

### 🟠 MEDIUM — Address Before or Shortly After Launch

---

#### 4. Booking Slot Capacity Check Has a TOCTOU Race Condition

**File:** `netlify/functions/bookings.mjs`, lines 739–778  
**Severity:** Medium — Double-Booking Risk

The booking creation flow reads the confirmed count for a slot, checks it against capacity, then writes a new booking. Because Netlify Blobs has no atomic compare-and-swap, two near-simultaneous booking requests for the same slot can both read a confirmed count of 0, both pass the capacity check, and both successfully create a booking — resulting in overbooking.

This is a known limitation of key-value stores without atomic transactions. The risk is proportional to traffic volume; at low traffic it is unlikely but not impossible.

**Recommended Fix (short term):** After writing the booking, re-read the slot's confirmed count. If it now exceeds capacity, immediately mark the newly-created booking as cancelled and return a 409:
```js
// After: await bookingsDb.setJSON(slotKey, [...slotBookingIds, bookingId]);
// Re-verify capacity
const updatedSlotIds = asArray(await bookingsDb.get(slotKey, { type: "json" }).catch(() => []));
let recheck = 0;
for (const bid of updatedSlotIds) {
  const b = await bookingsDb.get(`booking:${bid}`, { type: "json" }).catch(() => null);
  if (b?.status === "confirmed") recheck++;
}
if (recheck > (eventType.group_capacity || 1)) {
  booking.status = "cancelled";
  booking.cancelled_at = new Date().toISOString();
  booking.cancelled_by = "system:overbooking";
  await bookingsDb.setJSON(`booking:${bookingId}`, booking);
  return errorResponse(409, "This slot was just booked by someone else. Please choose a different time.");
}
```

---

#### 5. `invite_emails` Input Is Not Type-Checked Before Calling `.split()`

**File:** `netlify/functions/meetings.mjs`, lines 227–228  
**Severity:** Medium — 500 Error on Malformed Input

The body is destructured directly from the JSON payload without type coercion:
```js
const { invite_emails, ... } = body;
if (invite_emails) {
  const rawEmails = invite_emails.split(/[\n,]+/);
```

If a client submits `invite_emails` as a non-string (e.g., an array `["a@b.com"]` or a number), calling `.split()` throws a `TypeError`. The top-level try/catch will return a 500 with the internal error message (see issue #3 above).

**Recommended Fix:**
```js
const rawEmails = String(invite_emails || "").split(/[\n,]+/);
```
Or validate that `invite_emails` is a string before proceeding.

---

#### 6. `google/callback` Return Path Is Re-Validated After JWT Decode But Not Re-Sanitized

**File:** `netlify/functions/auth-google.mjs`, line 233  
**Severity:** Medium — Defense-in-Depth Gap

The `return_to` URL is correctly sanitized via `sanitizeNextPath()` before being embedded in the state JWT. However, after decoding the JWT at the callback, the `return_to` value is used directly without re-sanitizing:
```js
const dest = isNew || !user.profile_complete
  ? "/profile.html?setup=1"
  : statePayload.return_to || "/dashboard.html";
return redirectResponse(dest, ...);
```

Because the JWT is signed, a tampered `return_to` will fail JWT verification and never reach this line. The real risk is if the JWT secret is ever compromised. Re-applying `sanitizeNextPath()` at the callback is a low-cost defense-in-depth measure.

**Recommended Fix:**
```js
const dest = isNew || !user.profile_complete
  ? "/profile.html?setup=1"
  : sanitizeNextPath(statePayload.return_to || "") || "/dashboard.html";
```

---

#### 7. No Pagination on Admin API Endpoints (Potential Timeout/OOM at Scale)

**File:** `netlify/functions/admin.mjs`, lines 76–93 (`GET /api/admin/users`) and lines 329–367 (`GET /api/admin/meetings`)  
**Severity:** Medium — Scalability / Reliability

Both admin list endpoints load every user and meeting record into memory in a single request with no pagination. For a small deployment this is fine, but as data grows, these requests will take longer and eventually risk hitting Netlify Function execution limits (26 seconds, ~1 GB RAM) or returning responses too large for the browser.

**Recommended Fix:** Add cursor-based pagination using Netlify Blobs' `list({ cursor })` API, mirroring the pattern used elsewhere. Alternatively, add a `?limit=N&offset=M` query parameter in the short term.

---

### 🟡 LOW — Improvements to Address Post-Launch

---

#### 8. `localToUTC` Helper Is Duplicated in Two Files

**Files:** `netlify/functions/bookings.mjs:102` and `netlify/functions/calendar.mjs:54`  
**Severity:** Low — Maintainability

The `localToUTC()` function (timezone conversion) is copy-pasted identically into both `bookings.mjs` and `calendar.mjs`. If a bug is found in this function, it must be fixed in two places.

**Recommended Fix:** Move `localToUTC` to `utils.mjs` and export it. Import it in both files.

---

#### 9. `findUserByPublicSlug` Performs a Full Table Scan

**File:** `netlify/functions/bookings.mjs`, lines 149–165  
**Severity:** Low — Performance (Worsens Linearly with User Growth)

`findUserByPublicSlug` lists every user blob and reads each record individually to find the one whose `booking_public_slug` matches. This is O(N) in the number of users and runs on every public booking page view.

**Recommended Fix:** Maintain a reverse index in Netlify Blobs: write `users:slug:<slug>` → `email` whenever a slug is assigned. This would make slug lookup O(1).

---

#### 10. Meeting Index Is Not Atomic (Write-After-Read Race Condition)

**File:** `netlify/functions/meetings.mjs`, lines 212–214 and 481–483  
**Severity:** Low — Data Integrity Under Concurrent Load

Creating and deleting meetings both follow the read-modify-write pattern on the `"index"` blob:
```js
const indexData = asArray(await meetings.get("index", { type: "json" }).catch(() => []));
indexData.push(meetingId);
await meetings.setJSON("index", indexData);
```

Two concurrent meeting creations can read the same stale index, each append their own ID, and whichever write comes second overwrites the first — losing one ID from the index. The `listMeetingIds()` helper (which reads blob keys directly) partially mitigates this, but the index is still used in some read paths.

**Recommended Fix:** Transition all listing to `listMeetingIds()` using the blob key enumeration API (which Netlify maintains consistently) and stop maintaining the `"index"` blob entirely. This was already partially done — `listMeetingIds()` scans blob keys directly.

---

#### 11. Email Validation Is Too Permissive

**File:** `netlify/functions/utils.mjs`, lines 296–299  
**Severity:** Low — Weak Validation

The `validateEmail()` helper accepts any string containing `@` and `.`. This allows clearly invalid addresses such as `a@b`, `@@.c`, or `x@y.z` with no local or domain structure. All authentication flows and invite flows use this function.

While this is not directly exploitable (invalid addresses simply fail delivery), it allows garbage data into the user store and means the rate limiting key space could be polluted with trivially varied invalid addresses.

**Recommended Fix:** Apply a stricter email regex (e.g., RFC 5321 simplified pattern) or use a well-tested email validation library.

---

#### 12. `JWT_SECRET` Falls Back to a Hardcoded Dev Placeholder

**File:** `netlify/functions/utils.mjs`, lines 46–48  
**Severity:** Low — Misconfiguration Risk

```js
export function getJwtSecret() {
  return getEnv("JWT_SECRET", "meetsync-dev-secret-change-in-prod");
}
```

If `JWT_SECRET` is not set in a Netlify deployment, sessions are silently signed with the well-known placeholder string `"meetsync-dev-secret-change-in-prod"`. Anyone who reads this open-source code could forge valid session tokens.

The `/api/auth/health` endpoint already checks for `JWT_SECRET` presence, but only for admin viewers. If `JWT_SECRET` is unset, the deployment should hard-fail rather than silently degrade.

**Recommended Fix:** Remove the fallback value and instead throw a startup error:
```js
export function getJwtSecret() {
  const secret = getEnv("JWT_SECRET", "");
  if (!secret) throw new Error("JWT_SECRET environment variable is required.");
  return secret;
}
```
At minimum, ensure Netlify deploy checks validate that `JWT_SECRET` is present (the health endpoint can be used for this).

---

#### 13. Error Responses Include `err.message` as a `detail` Field (auth.mjs)

**File:** `netlify/functions/auth.mjs`, line 205  
**Severity:** Low — Information Disclosure

`auth.mjs` uses the separate `detail` field for internal error messages:
```js
return errorResponse(500, "Internal server error.", err.message);
```

The `errorResponse()` helper includes `detail` in the JSON body if provided. While not as severe as #3, clients still receive the internal error message in `data.detail`.

**Recommended Fix:** Do not pass `err.message` to `errorResponse()` for the top-level catch-all handler. Log it instead.

---

#### 14. `unsafe-inline` in Content-Security-Policy for Styles

**File:** `netlify.toml`  
**Severity:** Low — Security Header Hardening

The CSP header includes `style-src 'self' 'unsafe-inline'`, which permits inline style attributes throughout the page. This weakens XSS protection because an attacker who can inject HTML content could use inline styles for data exfiltration or UI redressing (e.g., CSS injection attacks).

**Recommended Fix (medium term):** Refactor dynamic inline styles to CSS classes and remove `'unsafe-inline'` from `style-src`. This requires a careful audit of which JS files use `element.style.*` directly vs. class toggling.

---

## Environment Variable Pre-Flight Checklist

Before deploying to production, verify the following Netlify environment variables are set correctly:

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | ✅ Required | Must be a long (≥32 char) random string. Never the placeholder. |
| `TOKEN_ENCRYPTION_KEY` | ✅ Required | Base-64 encoded 32-byte key. Distinct from JWT_SECRET. |
| `APP_URL` | ✅ Required | Must match the deployed site URL exactly (used in OAuth redirects). |
| `RESEND_API_KEY` | ✅ Required | Must be from a verified Resend account. |
| `AUTH_FROM_EMAIL` | ✅ Required | Sender domain must be verified in Resend. |
| `RESEND_WEBHOOK_SECRET` | ✅ Required | Needed for bounce/complaint webhook; configure in Resend dashboard. |
| `GOOGLE_CLIENT_ID` | ⚠️ If using Google auth | OAuth client must have the correct redirect URIs. |
| `GOOGLE_CLIENT_SECRET` | ⚠️ If using Google auth | — |
| `ADMIN_EMAILS` | ✅ Required | At least one admin email for audit log access and feedback delivery. |
| `BOOKING_REMINDERS_RUN_SECRET` | ⚠️ If manual reminder runs are used | — |
| `DISABLE_RATE_LIMIT` | ❌ Must NOT be set | Setting this to `true` in production disables all brute-force protection. |
| `ALLOW_BOOKING_REMINDER_RUN_NOW` | ❌ Must NOT be `true` | Only enable for testing/staging. |
| `COOKIE_SECURE` | Leave unset (auto) | Auto-detect is correct for production; only override for local dev. |

---

## Pre-Deployment Verification Commands

```bash
# Run all unit tests
npm test

# Run linter
npm run lint

# Check for dependency vulnerabilities
npm audit --omit=dev

# Run full pre-deploy check (tests + lint)
npm run predeploy-check

# After deploying to staging: hit the health endpoint as an admin
curl https://your-site.netlify.app/api/auth/health
```

---

## What Is Working Well

- **HttpOnly + SameSite=Lax cookies** for session management (not localStorage) — correct.
- **AES-256-GCM encryption** for Google OAuth tokens at rest — correct.
- **Single-use magic links** with JTI stored in Netlify Blobs — correctly prevents link reuse.
- **OAuth CSRF protection** using signed JWT state + cookie double-submit — correct.
- **Rate limiting on all sign-in endpoints** (IP + email) — correct (except feedback, see #2).
- **`escapeHtml()` used consistently** throughout backend emails and frontend template literals.
- **`sanitizeUser()`** strips OAuth tokens before any API response is returned.
- **`sanitizeNextPath()`** prevents open redirect via magic-link `?next=` and Google OAuth `?next=` parameters.
- **No npm vulnerabilities** in production dependencies.
- **Security headers** (CSP, HSTS, X-Frame-Options, etc.) set correctly in `netlify.toml`.
- **Comprehensive CI pipeline** with unit tests, rate-limit mode testing, and E2E smoke tests.
