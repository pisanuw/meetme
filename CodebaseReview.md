# MeetMe — Codebase Review for CS Students

Welcome! This document walks you through the MeetMe codebase from top to bottom.
MeetMe is a real, deployed web application that lets a group of people find a time to meet
by sharing their availability. Reading through this guide will show you how a multi-file
project fits together: how the browser talks to the server, how data is stored and retrieved,
and how authentication works.

No framework knowledge is required. If you know HTML, basic JavaScript, and have a rough
idea of what a web server does, you are ready to follow along.

---

## Table of Contents

1. [What the App Does](#1-what-the-app-does)
2. [Project Layout — Files at a Glance](#2-project-layout--files-at-a-glance)
3. [How a Browser and a Server Talk to Each Other](#3-how-a-browser-and-a-server-talk-to-each-other)
4. [The Frontend — HTML Pages](#4-the-frontend--html-pages)
5. [Shared Frontend Code — `static/common.js`](#5-shared-frontend-code--staticcommonjs)
6. [The Backend — Netlify Functions](#6-the-backend--netlify-functions)
7. [Shared Backend Utilities — `netlify/functions/utils.mjs`](#7-shared-backend-utilities--netlifyfunctionsutilsmjs)
8. [Authentication in Depth — `auth.mjs`](#8-authentication-in-depth--authmjs)
9. [Meeting Data — `meetings.mjs`](#9-meeting-data--meetingsmjs)
10. [Availability and Finalizing — `meeting-actions.mjs`](#10-availability-and-finalizing--meeting-actionsmjs)
11. [Google Calendar Integration — `calendar.mjs`](#11-google-calendar-integration--calendarmjs)
12. [Email Bounce Handling — `webhooks.mjs`](#12-email-bounce-handling--webhooksmjs)
13. [The Admin Panel — `admin.mjs`](#13-the-admin-panel--adminmjs)
14. [How Data is Stored — Netlify Blobs](#14-how-data-is-stored--netlify-blobs)
15. [Configuration and Environment Variables](#15-configuration-and-environment-variables)
16. [A Full Request Walk-Through](#16-a-full-request-walk-through)
17. [Key Patterns Worth Remembering](#17-key-patterns-worth-remembering)

---

## 1. What the App Does

MeetMe solves a common scheduling problem:

> "I need to meet with five people — when is everyone free?"

Here is the life of a typical meeting:

1. A **creator** signs in and fills out a form: meeting name, a list of possible dates or days
   of the week, and a time window (e.g., 9 AM–5 PM).
2. The creator enters email addresses of **invitees**. MeetMe emails each one a link.
3. Every invitee signs in (no password required — they get a magic link by email) and clicks
   the time slots when they are available on a visual grid.
4. As responses arrive, the creator sees a **heat-map** that darkens cells where more people
   are free.
5. The creator picks a time, **finalizes** the meeting, and everyone can download a `.ics`
   calendar invite.

This is a surprisingly complete application for its size: authentication, email delivery,
a Google Calendar integration, an admin panel, and email-bounce handling are all present.

---

## 2. Project Layout — Files at a Glance

```
meetme/
│
├── index.html              ← Login page (the "home" page)
├── register.html           ← New-user registration
├── dashboard.html          ← User's meeting list
├── create-meeting.html     ← Form to create a meeting
├── meeting.html            ← Availability grid and heat-map
├── profile.html            ← Edit your display name / connect Google Calendar
├── email-sent.html         ← Confirmation page after a magic link is requested
├── feedback.html           ← Simple feedback form
├── admin.html              ← Admin panel (restricted to admin emails)
│
├── static/
│   ├── common.js           ← Shared JavaScript that every page uses
│   └── style.css           ← All CSS styles (no external stylesheet needed)
│
├── netlify/
│   └── functions/          ← All backend code lives here (Node.js serverless functions)
│       ├── utils.mjs           ← Shared helpers (database, JWT, email, logging …)
│       ├── auth.mjs            ← Sign-in: magic links and Google OAuth
│       ├── meetings.mjs        ← Create / list / delete meetings
│       ├── meeting-actions.mjs ← Submit availability, finalize, send reminders
│       ├── calendar.mjs        ← Google Calendar busy-slot lookup
│       ├── admin.mjs           ← Admin-only routes
│       └── webhooks.mjs        ← Email bounce / spam-complaint notifications
│
├── netlify.toml            ← Netlify build & function configuration
├── package.json            ← Node.js dependencies
└── .env.example            ← Template listing every environment variable needed
```

**Important vocabulary:**
- **Frontend** — code that runs in the user's web browser (HTML, CSS, JavaScript files in the
  root and `static/` folder).
- **Backend** — code that runs on a server (JavaScript files in `netlify/functions/`).
- **API** — the set of URL endpoints the frontend calls to read/write data on the server.

---

## 3. How a Browser and a Server Talk to Each Other

Before diving into files, it helps to understand the basic communication pattern.

When you open a browser and visit `https://meetme.example.com`, the browser asks the server
for the HTML file for that page. The server sends it back. The browser renders the page.

But MeetMe also needs to *do things*: log in, save availability, load meetings. For that, the
JavaScript in the page sends **API requests** — specifically, HTTP requests — to the server's
backend functions. The server processes them and sends back JSON data. JavaScript then updates
the page with that data.

```
                  1. Browser requests page
User's Browser ─────────────────────────────► Netlify (static files)
               ◄─────────────────────────────
                  2. HTML/CSS/JS returned

                  3. JS makes API call (fetch)
User's Browser ─────────────────────────────► Netlify Functions (backend)
               ◄─────────────────────────────
                  4. JSON data returned

                  5. JS updates the DOM (the page)
```

Every backend function lives at a URL that starts with `/api/`:
- `/api/auth/...` → `auth.mjs`
- `/api/meetings/...` → `meetings.mjs`
- `/api/meeting/...` → `meeting-actions.mjs`
- `/api/calendar/...` → `calendar.mjs`
- `/api/admin/...` → `admin.mjs`
- `/api/webhooks/...` → `webhooks.mjs`

---

## 4. The Frontend — HTML Pages

Each HTML page is a standalone file. They all follow the same structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <link rel="stylesheet" href="/static/style.css"/>  <!-- shared styles -->
</head>
<body>

  <nav>...</nav>                 <!-- navigation bar -->
  <div id="flash-container">    <!-- pop-up messages (errors, success) -->
  <main>...</main>              <!-- the actual page content -->
  <footer>...</footer>

  <script src="/static/common.js"></script>  <!-- shared JS helpers, ALWAYS last -->
  <script>
    /* page-specific JS goes here */
  </script>

</body>
</html>
```

The `<script src="/static/common.js">` line is critical — it loads shared helper functions
*before* the page-specific script runs, so those helpers are available when the page script
needs them.

### Page-by-page overview

| File | Who sees it | What it does |
|------|-------------|--------------|
| `index.html` | Everyone | Enter email to get a magic sign-in link, or click "Continue with Google" |
| `register.html` | New users | Same as index but also collects a name; acts as a friendlier first-time entry point |
| `email-sent.html` | After requesting a link | Just shows "check your email" — no real logic |
| `dashboard.html` | Signed-in users | Lists meetings created by you and meetings you were invited to |
| `create-meeting.html` | Signed-in users | Form to name a meeting, pick dates/days, set time window, and invite others |
| `meeting.html` | Meeting participants | The main grid: click cells to mark availability; view heat-map; creator can finalize |
| `profile.html` | Signed-in users | Edit display name; connect Google Calendar |
| `admin.html` | Admin users only | View all users, all meetings, and an event log |
| `feedback.html` | Everyone | Simple feedback form |

### How pages know whether you are logged in

Every page that requires a logged-in user starts with a call to `requireAuth()` (defined in
`common.js`). If you are not logged in, this function redirects you to `/` (the login page).

```js
// Example from dashboard.html
(async () => {
  const user = await requireAuth();  // redirects to / if not signed in
  if (!user) return;

  // safe to load dashboard data now
  const { ok, data } = await apiFetch('/api/meetings');
  ...
})();
```

---

## 5. Shared Frontend Code — `static/common.js`

This file is included on every page. It provides three things that every page needs:

### 5.1 `apiFetch(url, options)` — the central network helper

Instead of calling `fetch()` directly, every page uses `apiFetch`. It wraps `fetch` so that:
- Network errors do not crash the page — they return `{ ok: false, ... }`.
- A 401 (Unauthorized) response automatically redirects to the login page.
- The response is always parsed as JSON, even if the server returns an error.

```js
async function apiFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    return { ok: false, status: 0, data: { error: `Network error: ${networkErr.message}` } };
  }

  if (res.status === 401) {
    window.location.href = '/';   // session expired — send to login
    return { ok: false, status: 401, data: { error: 'Session expired.' } };
  }

  let data;
  const text = await res.text().catch(() => '');
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: `Non-JSON response: ${text.slice(0, 200)}` };
  }

  return { ok: res.ok, status: res.status, data };
}
```

**Why is this a good pattern?** Without this wrapper, every page would need to copy-paste
the same error-handling code. Centralizing it in one function means a bug only needs to be
fixed in one place.

### 5.2 `checkAuth()` and `requireAuth()` — authentication checks

`checkAuth()` silently calls `/api/auth/me`. If the server responds with a user object, the
function also populates the navigation bar (username, links). It returns the user object or
`null`.

`requireAuth()` calls `checkAuth()` and, if the result is `null`, redirects to `/`. Pages
that must only be seen by signed-in users call `requireAuth()`.

### 5.3 `showFlash(message, category)` — user-visible notifications

Any page can call `showFlash('Something went wrong', 'danger')` to show a red banner at the
top of the page. Banners disappear automatically after 5 seconds.

```js
function showFlash(message, category = 'info') {
  const container = document.getElementById('flash-container');
  const div = document.createElement('div');
  div.className = `flash flash-${category}`;  // CSS class controls color
  div.innerHTML = `${escapeHtml(message)} <button ...>✕</button>`;
  container.appendChild(div);
  setTimeout(() => div.remove(), 5000);
}
```

Note the use of `escapeHtml()` before inserting user-provided text — this prevents **XSS
(Cross-Site Scripting)** attacks where a malicious string could inject JavaScript.

### 5.4 Logout handler

The logout button is wired up once in `common.js`, so every page gets it automatically:

```js
document.addEventListener('DOMContentLoaded', () => {
  const logoutLink = document.getElementById('logout-link');
  if (logoutLink) {
    logoutLink.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/auth/logout', { method: 'POST', ... });
      window.location.href = '/';
    });
  }
});
```

---

## 6. The Backend — Netlify Functions

Each file in `netlify/functions/` is an independent **serverless function**. "Serverless" does
not mean there is no server — it means you do not manage the server yourself. Netlify runs the
code in response to HTTP requests and shuts it down when there are no requests.

Every function file exports a **default async function** that receives a `Request` object and
returns a `Response` object. This is the standard Web API interface:

```js
export default async (req, context) => {
  // req  — the incoming HTTP request (method, URL, headers, body)
  // context — Netlify-specific info (e.g. URL parameters captured by wildcards)
  return new Response("hello", { status: 200 });
};

// The 'config' export tells Netlify which URL paths this function handles
export const config = {
  path: "/api/meetings/*",
};
```

The URL routing is done by pattern matching. For example, `/api/meetings/*` means this
function handles any URL that starts with `/api/meetings/`.

Inside each function, path segments are pulled apart manually to figure out what specific
action is being requested. This is a simplified version of what frameworks like Express.js
do automatically.

---

## 7. Shared Backend Utilities — `netlify/functions/utils.mjs`

This file is the backbone of the backend. Every other function file imports helpers from here.

```js
import { getDb, getUserFromRequest, jsonResponse, errorResponse, log, ... } from "./utils.mjs";
```

Here are the most important parts:

### 7.1 `getDb(name)` — database access

MeetMe uses **Netlify Blobs** as its database. Blobs is a key-value store: you give it a
name (like a folder) and a key (like a filename), and it stores any JSON you want.

```js
export function getDb(name) {
  return getStore({ name, consistency: "strong" });
}
```

Usage in other files:
```js
const meetings = getDb("meetings");
const meeting  = await meetings.get("abc123", { type: "json" });
await meetings.setJSON("abc123", { title: "Team Lunch", ... });
await meetings.delete("abc123");
```

You can think of each "store" (e.g., `"meetings"`, `"users"`) as a table in a regular
database, but without schemas — you store whatever JSON object you like.

### 7.2 JWT — "Who are you?"

After a user logs in, the server needs a way to remember them on future requests. It uses a
**JWT (JSON Web Token)**. Think of it as a tamper-proof name badge:
- The server creates a token containing the user's id, email, and name.
- It signs the token with a secret key so it cannot be forged.
- The token is sent to the browser as a **cookie** (an HTTP header the browser sends
  automatically on every subsequent request).
- On each request, the server reads the cookie, verifies the signature, and trusts the data
  inside.

```js
export function createToken(payload, expiresIn = "7d") {
  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());  // returns the payload, or null if invalid
  } catch {
    return null;
  }
}

export function getUserFromRequest(req) {
  const cookie = req.headers.get("cookie") || "";
  const match  = cookie.match(/(?:^|;\s*)token=([^;]+)/);  // find "token=..." in the cookie string
  if (!match) return null;
  return verifyToken(match[1]);
}
```

Every protected backend route starts the same way:
```js
const user = getUserFromRequest(req);
if (!user) return errorResponse(401, "Not authenticated. Please sign in.");
```

### 7.3 `jsonResponse` and `errorResponse` — response builders

Rather than writing `new Response(JSON.stringify(...), { headers: ... })` everywhere, two
helpers wrap this:

```js
export function jsonResponse(statusCode, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export function errorResponse(statusCode, message) {
  return jsonResponse(statusCode, { error: message });
}
```

### 7.4 `log` — structured logging

All log messages are written as JSON lines to the console. Netlify captures these and shows
them in its dashboard under "Functions → Logs".

```js
export function log(level, fn, message, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, fn, msg: message, ...extra };
  if (level === "error") console.error(JSON.stringify(entry));
  else                   console.log(JSON.stringify(entry));
}
```

Example output:
```json
{"ts":"2026-03-26T10:00:00.000Z","level":"info","fn":"meetings","msg":"creating meeting","title":"Team Lunch","creator":"alice@example.com"}
```

### 7.5 `checkRateLimit` — preventing abuse

Rate limiting stops a single user from making too many requests in a short time (for example,
spamming the "send magic link" button). The state is stored in the `"rate_limits"` Blobs
store.

```js
const { ok, retryAfterSec } = await checkRateLimit({
  bucket: "magic_link_email",
  key:    email,         // rate limit per email address
  limit:  5,            // at most 5 requests …
  windowMs: 60 * 60 * 1000,  // … per hour
});
if (!ok) return errorResponse(429, `Too many requests. Retry after ${retryAfterSec}s.`);
```

### 7.6 `encryptSecret` / `decryptSecret` — protecting sensitive tokens

Google OAuth gives MeetMe a `refresh_token` that can be used to access a user's calendar.
Storing it in plaintext in the database would be risky. Instead, it is encrypted with
AES-256-GCM before being saved:

```js
// Storing:
dbUser.google_refresh_token = encryptSecret(token);
await usersDb.setJSON(email, dbUser);

// Retrieving:
const token = decryptSecret(dbUser.google_refresh_token);
```

### 7.7 `sendEmail` — centralized email delivery

All outgoing emails go through the `sendEmail` helper, which calls the **Resend** API
(a third-party email service). Both the magic-link email and invitation emails use this.

---

## 8. Authentication in Depth — `auth.mjs`

This is the most complex file. It handles three things:

1. **Magic link sign-in** — email a one-time link
2. **Google OAuth sign-in** — redirect through Google's login page
3. **User creation** — creating a new user record on first sign-in

The function handles many different URL paths, selected by `if` statements:

```
GET  /api/auth/health            → are all env vars set?
POST /api/auth/magic-link/request → send a sign-in email
GET  /api/auth/magic-link/verify  → click the link in the email
POST /api/auth/register           → register with a name
GET  /api/auth/me                 → who am I?
POST /api/auth/logout             → clear the cookie
GET  /api/auth/google/start       → begin Google OAuth
GET  /api/auth/google/callback    → Google redirects back here
POST /api/auth/profile            → update display name
```

### 8.1 Magic Link Flow

**Step 1 — Request** (`POST /api/auth/magic-link/request`):

```
User enters email → browser POSTs to /api/auth/magic-link/request
                                              │
                     ┌────────────────────────▼──────────────────────────┐
                     │ 1. Rate-limit check (max 5 per hour per email)    │
                     │ 2. Generate a unique token ID (jti)               │
                     │ 3. Create a JWT containing: email, jti, purpose   │
                     │ 4. Save { email, used: false } to login_tokens    │
                     │ 5. Email the user a link containing the JWT       │
                     └───────────────────────────────────────────────────┘
```

The link looks like:
```
https://meetme.example.com/api/auth/magic-link/verify?token=eyJhbGci...
```

**Step 2 — Verify** (`GET /api/auth/magic-link/verify?token=...`):

```
User clicks link in email
        │
        ▼
Server checks:
  1. Is the JWT signature valid? (not tampered with, not expired)
  2. Does payload.purpose equal "magic_link"?
  3. Does the jti exist in login_tokens store?
  4. Has it already been used? → "link-already-used" error
  5. Does the email in the JWT match the email in the store?

All checks pass:
  6. Mark the token as used (so it can never be used again)
  7. Call getOrCreateUser(email) → look up or create user record
  8. Create a session JWT (7-day expiry) with the user's info
  9. Set the JWT as a cookie: Set-Cookie: token=...
 10. Redirect the browser to /dashboard.html
```

This "one-time token" pattern is important. Without it, anyone who saw the link URL
(in a log file, browser history, etc.) could sign in. The `used` flag prevents replay.

### 8.2 Google OAuth Flow

OAuth is an industry-standard protocol for "sign in with another service". The flow has
two round trips:

```
1. Browser visits /api/auth/google/start
   Server generates a "state" token (anti-CSRF), stores it in a cookie,
   then redirects to Google's login page with the state token embedded.

2. User logs in at Google.

3. Google redirects browser to /api/auth/google/callback?code=...&state=...
   Server checks that "state" matches the cookie (prevents cross-site request forgery).
   Server exchanges the "code" for real tokens by calling Google's API.
   Google returns an id_token containing the user's email and name.
   Server calls getOrCreateUser(email) → same as magic link.
   Server sets JWT cookie and redirects to dashboard.
```

### 8.3 `getOrCreateUser` — the single source of truth for users

Both sign-in methods funnel through the same function:

```js
async function getOrCreateUser(email, preferredName = "") {
  const users = getDb("users");
  let user = await users.get(email, { type: "json" }).catch(() => null);

  if (user) {
    return { user, isNew: false };  // existing user — just return them
  }

  // Create a new user record
  user = {
    id:   generateId(),
    email,
    name: preferredName || email.split("@")[0],
    profile_complete: false,
    created_at: new Date().toISOString(),
  };
  await users.setJSON(email, user);

  // If this email was already invited to meetings, link those invites
  await linkPendingInvites(email, user);

  return { user, isNew: true };
}
```

**`linkPendingInvites`** handles a common case: someone was invited to a meeting *before*
they had an account. The meeting creator's email might appear in the `pending:{email}` blob,
waiting to be connected once they sign up. This function does that connection.

---

## 9. Meeting Data — `meetings.mjs`

This file manages the core data of the app: creating, listing, and deleting meetings.

### 9.1 Data structure

A **meeting** object looks like this (stored in the `"meetings"` blob store, keyed by `id`):

```json
{
  "id": "abc123xyz",
  "title": "Team Lunch",
  "description": "Monthly team lunch",
  "creator_id": "def456",
  "creator_name": "Alice",
  "meeting_type": "specific_dates",
  "dates_or_days": ["2026-04-01", "2026-04-02", "2026-04-03"],
  "start_time": "11:00",
  "end_time": "14:00",
  "timezone": "America/Los_Angeles",
  "is_finalized": false,
  "finalized_date": null,   // the chosen date/day for the meeting (set when finalized)
  "finalized_slot": null,
  "note": "",
  "created_at": "2026-03-26T10:00:00.000Z"
}
```

A list of all meeting IDs is stored separately under the key `"index"` in the same store:
```json
["abc123xyz", "ghi789", "jkl012"]
```

This is a common pattern when using a key-value store: you need a separate "index" to list
all items, because you cannot query by value like in a SQL database.

An **invite** entry (in the `"invites"` store, keyed by `"meeting:{id}"`):
```json
[
  { "id": "inv1", "meeting_id": "abc123xyz", "user_id": "def456", "email": "alice@example.com", "name": "Alice",   "responded": true  },
  { "id": "inv2", "meeting_id": "abc123xyz", "user_id": "ghi789", "email": "bob@example.com",   "name": "Bob",     "responded": false }
]
```

### 9.2 Creating a meeting (`POST /api/meetings`)

```
Browser sends:
{
  "title": "Team Lunch",
  "meeting_type": "specific_dates",
  "dates_or_days": ["2026-04-01"],
  "start_time": "11:00",
  "end_time": "14:00",
  "timezone": "America/Los_Angeles",
  "invite_emails": "bob@example.com\ncarol@example.com"
}

Server:
1. Validates required fields (title, dates, time format)
2. Generates a unique meeting ID
3. Saves the meeting JSON to the "meetings" store
4. Adds the ID to the "index" list
5. Creates invite records for the creator and each invitee
6. For invitees who don't have an account yet, saves their email to "pending:{email}"
7. Sends an invitation email to each invitee (via Resend API)
8. Returns { success: true, meeting_id: "abc123xyz" }
```

### 9.3 Loading dashboard data (`GET /api/meetings`)

When the dashboard page loads, it calls this endpoint. The server:

1. Reads the full index of meeting IDs.
2. For each meeting ID, fetches the meeting object and its invite list.
3. Splits meetings into two groups: created by this user, or invited to.
4. Returns both groups sorted newest-first.

This is an `O(n)` operation — it reads every meeting. For a large application, this would
be too slow and you would use a proper database with indexed queries. For MeetMe's scale,
it works fine.

### 9.4 Loading a meeting (`GET /api/meetings/:id`)

When a user opens a meeting page, this returns everything needed to render it:

- The meeting object
- The user's own availability slots
- Aggregated slot counts (how many people are free at each slot — the heat-map data)
- The list of all time slots (generated by stepping from `start_time` to `end_time` in 15-minute increments)
- Participant info (names, response status)

**Participant auto-add via shared link:** If a logged-in user visits a meeting URL they were
not originally invited to, they are automatically added as a participant. This is the "share
the link" feature — anyone with the link can join.

---

## 10. Availability and Finalizing — `meeting-actions.mjs`

This file handles the actions that happen *inside* a meeting.

### 10.1 Slot format

Availability is stored as a flat list of slot strings. Each slot uniquely identifies a
15-minute block:

```
"2026-04-01_11:00"   →  April 1, 2026, from 11:00 to 11:15
"Monday_09:30"       →  Monday mornings from 9:30 to 9:45 (for recurring day-of-week meetings)
```

The format is `{date_or_day}_{HH:MM}`. The underscore separates the date (or day name)
from the time.

An **availability** entry (in the `"availability"` store, keyed by `"meeting:{id}"`):
```json
[
  { "meeting_id": "abc123xyz", "user_id": "def456", "date_or_day": "2026-04-01", "time_slot": "11:00" },
  { "meeting_id": "abc123xyz", "user_id": "def456", "date_or_day": "2026-04-01", "time_slot": "11:15" },
  { "meeting_id": "abc123xyz", "user_id": "ghi789", "date_or_day": "2026-04-01", "time_slot": "11:00" }
]
```

### 10.2 Submitting availability (`POST /api/meeting/:id/availability`)

The browser sends the *complete* list of selected slots every time availability is saved
(not just the changes). The server:

1. Validates that each submitted slot refers to a real date and a real time in the meeting's window.
2. Replaces all of this user's previous entries with the new list.
3. Marks the user as `responded: true` in the invite record.
4. Returns the updated `slot_counts` (how many users selected each slot) so the browser can
   immediately redraw the heat-map.

```js
// Server keeps other users' data, replaces current user's data
const otherAvail    = allAvail.filter(a => a.user_id !== user.id);
const updatedAvail  = [...otherAvail, ...newAvail];
await availability.setJSON(`meeting:${meetingId}`, updatedAvail);
```

### 10.3 Finalizing a meeting (`POST /api/meeting/:id/finalize`)

Only the meeting creator can finalize. The request body contains:

```json
{
  "date_or_day": "2026-04-01",
  "time_slot": "11:00",
  "duration_minutes": 60,
  "note": "See you in Conference Room B!"
}
```

The server updates the meeting object in place — setting `is_finalized: true` and storing the
chosen date/slot. From this point on, the meeting page shows a finalized banner and a calendar
download button instead of the availability grid.

### 10.4 Sending reminders (`POST /api/meeting/:id/remind-pending`)

The creator can press a "Send reminder" button to email everyone who has not yet responded.
The server filters the invite list to those with `responded: false` and sends each a reminder
email.

---

## 11. Google Calendar Integration — `calendar.mjs`

This optional feature lets a user see their Google Calendar busy times overlaid on the
availability grid, so they do not accidentally mark a slot as available when they already
have a meeting there.

### 11.1 Connection flow

When a user connects their Google Calendar (from the profile page), the OAuth flow in
`auth.mjs` requests extra scopes (`calendar.readonly`). Google returns a `refresh_token`
and an `access_token`. These are encrypted with AES-256-GCM and stored in the user's record:

```json
{
  "google_access_token":  "enc:v1:...",
  "google_refresh_token": "enc:v1:...",
  "google_token_expiry":  1743000000000,
  "calendar_connected":   true
}
```

### 11.2 Busy slot query (`GET /api/calendar/busy?meeting_id=X`)

When the meeting page loads, it calls this endpoint if the user has calendar connected.

1. Load the user's access token (decrypt it from storage).
2. If the token is expired (checked via `google_token_expiry`), use the refresh token to
   get a new access token from Google and update the stored value.
3. Call Google's **FreeBusy API** with the meeting's date range.
4. Google returns time ranges when the user is busy.
5. The server converts those ranges into the same slot format (`"2026-04-01_11:00"`) so the
   browser can grey out those cells.

```js
const isBusy = busyPeriods.some(p =>
  slotStartUTC.getTime() < p.end.getTime() &&
  slotEndMs   > p.start.getTime()
);
```

The `localToUTC` helper converts a date+time string from the meeting's timezone to UTC,
which is what Google's API requires. This is non-trivial because timezone rules change
(daylight saving time, etc.), so it uses the `Intl.DateTimeFormat` API rather than doing
manual arithmetic.

---

## 12. Email Bounce Handling — `webhooks.mjs`

When an invitation email cannot be delivered (the address does not exist, the inbox is full,
etc.), **Resend** (the email service) sends a notification to MeetMe's webhook URL. This
lets MeetMe notify the meeting creator that one of their invitees did not receive the email.

### 12.1 Email tracking

When `meetings.mjs` sends an invitation, it saves a record keyed by the Resend email ID:

```js
await emailTracker.setJSON(result.emailId, {
  meeting_id:    meetingId,
  meeting_title: meeting.title,
  creator_email: user.email,
  invitee_email: inv.email,
  sent_at:       new Date().toISOString(),
});
```

### 12.2 Webhook processing

When Resend calls `POST /api/webhooks/resend`:

1. Verify the shared secret in the URL query string (so random internet traffic cannot trigger
   this endpoint).
2. Parse the webhook event (`email.bounced` or `email.complained`).
3. Look up which meeting and creator this email belonged to (using the Resend email ID).
4. Send a notification email to the meeting creator.

This is a classic **event-driven** pattern: one service (Resend) notifies another (MeetMe)
asynchronously when something happens.

---

## 13. The Admin Panel — `admin.mjs`

The admin panel is restricted to email addresses listed in the `ADMIN_EMAILS` environment
variable. Every admin route starts with:

```js
const user = getUserFromRequest(req);
if (!user)        return errorResponse(401, "Not authenticated.");
if (!isAdmin(user)) return errorResponse(403, "Admin access required.");
```

`isAdmin` is defined in `utils.mjs`:

```js
export function isAdmin(user) {
  const adminEmails = getEnv("ADMIN_EMAILS", "").split(",").map(e => e.trim().toLowerCase());
  return adminEmails.includes((user.email || "").toLowerCase());
}
```

The admin routes provide:
- `GET /api/admin/stats` — total users, meetings, and logged events
- `GET /api/admin/users` — list all user records
- `GET /api/admin/user?email=X` — full details for one user
- `POST /api/admin/user` — create or update a user
- `POST /api/admin/user/delete` — delete a user (cannot delete admin accounts)
- `GET /api/admin/meetings` — list all meetings with invitee counts
- `GET /api/admin/events` — recent event log (newest first)

---

## 14. How Data is Stored — Netlify Blobs

MeetMe does not use a traditional SQL database (like PostgreSQL or MySQL). Instead, it uses
**Netlify Blobs**, which is a key-value store — similar to a giant dictionary.

Here is a map of every "store" (think: table) and what is stored in it:

| Store name | Keys | Values |
|------------|------|--------|
| `users` | `alice@example.com` (email) | User profile object |
| `meetings` | `abc123` (meeting ID) | Meeting object |
| `meetings` | `"index"` | Array of all meeting IDs |
| `invites` | `"meeting:abc123"` | Array of invite objects for that meeting |
| `invites` | `"pending:bob@example.com"` | Array of meeting IDs the user was invited to before creating an account |
| `availability` | `"meeting:abc123"` | Array of all availability entries for that meeting |
| `login_tokens` | `jti` (unique token ID) | `{ email, used, used_at }` |
| `rate_limits` | `"bucket:key"` (e.g. `"magic_link:alice@example.com"`) | `{ window_start, count }` |
| `events` | Timestamp-prefixed ID | Structured event log entry |
| `email_records` | Resend email ID | `{ meeting_id, creator_email, invitee_email, ... }` |

**Why a key-value store instead of SQL?**

For a small application deployed on a serverless platform, SQL databases add operational
complexity. Netlify Blobs requires zero configuration — you just call `getStore(name)` and
start storing data. The trade-off is that you cannot perform complex queries (joins, filters),
so the code manually loops through records when needed.

---

## 15. Configuration and Environment Variables

Sensitive values — API keys, OAuth secrets, the JWT signing secret — are never written
directly into code. Instead, they are read from **environment variables** at runtime.

`utils.mjs` provides a helper that checks both Netlify's runtime and Node's `process.env`:

```js
export function getEnv(name, fallback = "") {
  const fromNetlify = typeof Netlify !== "undefined" ? Netlify?.env?.get(name) : undefined;
  if (fromNetlify) return fromNetlify;
  return process.env?.[name] || fallback;
}
```

The file `.env.example` is a template showing every variable the app needs:

```
JWT_SECRET=replace-with-a-long-random-secret
TOKEN_ENCRYPTION_KEY=replace-with-a-different-long-random-secret
APP_URL=https://your-site.netlify.app
RESEND_API_KEY=re_xxxxx
AUTH_FROM_EMAIL=MeetMe <noreply@yourdomain.com>
RESEND_WEBHOOK_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ADMIN_EMAILS=admin@example.com
```

For local development, you copy this file to `.env` and fill in real values. `.env` is listed
in `.gitignore` so that secrets are never committed to the repository.

**Why are secrets kept out of code?**

If you committed `RESEND_API_KEY=re_live_abc123` to a public GitHub repository, anyone could
find it and send emails using your account. Environment variables solve this by keeping
secrets in a separate, access-controlled location (Netlify's dashboard, or a local `.env`
file that is never committed).

---

## 16. A Full Request Walk-Through

Let's trace exactly what happens when **Alice opens her dashboard** after signing in.

### 16.1 Browser requests the dashboard page

Alice types `https://meetme.example.com/dashboard.html` in her browser.

Netlify serves the static `dashboard.html` file. The browser parses the HTML, loads
`style.css`, and then executes the JavaScript.

### 16.2 `requireAuth()` checks the session

The dashboard script calls `requireAuth()`, which calls `checkAuth()`, which calls:

```
GET /api/auth/me
Cookie: token=eyJhbGci...
```

In `auth.mjs`, the handler for `GET /api/auth/me`:

```js
if (req.method === "GET" && path === "me") {
  const user = getUserFromRequest(req);
  if (!user) return errorResponse(401, "Not authenticated.");
  // isAdmin check to include admin flag in response
  return jsonResponse(200, { ...user, is_admin: isAdmin(user) });
}
```

`getUserFromRequest` reads the `token` cookie, verifies the JWT signature, and returns the
payload `{ id, email, name }` (or `null` if the token is missing or expired).

If the response is `200 OK`, `checkAuth()` updates the navigation bar with Alice's name
and returns the user object.

### 16.3 Dashboard loads meetings

```
GET /api/meetings
Cookie: token=eyJhbGci...
```

In `meetings.mjs`:

1. `getUserFromRequest` extracts Alice's user info from the cookie.
2. The meeting index is fetched from Blobs: `meetings.get("index")` → `["abc123", "def456"]`.
3. For each meeting ID, the meeting object and invite list are fetched.
4. Meetings are split: those Alice created vs. those she was invited to.
5. Both lists are sorted by `created_at` (newest first).
6. JSON is returned: `{ my_meetings: [...], invited_meetings: [...] }`.

### 16.4 Browser renders the meeting cards

Back in `dashboard.html`, the JavaScript receives the JSON and calls `renderMeetings()`.
This function builds HTML strings for each meeting card and inserts them into the page.

Note the use of `escapeHtml()` before any user-controlled string (like the meeting title)
is inserted into HTML. This prevents XSS attacks.

```js
html += `<h3><a href="/meeting.html?id=${m.id}">${escapeHtml(m.title)}</a></h3>`;
//                                                ^^^^^^^^^^^^ always escape user data
```

---

## 17. Key Patterns Worth Remembering

Having walked through the whole codebase, here are the design patterns you will see over and
over in real-world web apps:

### Separation of concerns
Each file has a clear job: `utils.mjs` for shared helpers, `auth.mjs` for authentication,
`meetings.mjs` for meeting data. This makes code easier to find, understand, and fix.

### DRY — Don't Repeat Yourself
`apiFetch` in `common.js` and `jsonResponse`/`errorResponse` in `utils.mjs` both exist so
the same logic is written once. If the behavior needs to change, you change it in one place.

### Guard clauses / early returns
Every protected route checks authentication first and returns early if it fails:

```js
const user = getUserFromRequest(req);
if (!user) return errorResponse(401, "Not authenticated.");
// rest of the function only runs for authenticated users
```

This pattern (called a "guard clause") keeps the happy path at the top level and avoids
deeply nested `if/else` chains.

### Never trust input
The server always validates data it receives from the browser: required fields are checked,
time formats are matched against a regex, emails are normalized to lowercase, and
user-controlled strings are HTML-escaped before being inserted into HTML. A browser can be
tricked or replaced by a script, so the server cannot assume the data is well-formed.

### Failing gracefully
Calls to the Blobs store are wrapped in `.catch(() => null)` or `.catch(() => [])` so that
a missing key does not crash the entire request. The `apiFetch` function in the browser does
the same — a network error returns a safe object instead of throwing an exception.

### Logging with context
Every log line includes: timestamp, log level, which function produced it, a message, and
relevant IDs (meeting ID, user email). This makes it possible to trace a problem through the
logs even when many users are using the app simultaneously.

---

*End of Codebase Review. If something is unclear, reading the source file alongside this
document is the best way to deepen your understanding — every concept above is directly
visible in the code.*
