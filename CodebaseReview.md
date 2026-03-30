# MeetMe - Codebase Review

Last reviewed: 2026-03-29

This document is an engineering handoff snapshot of the current repository state.
It focuses on architecture, behavior, quality signals, and concrete risks.

## 1. Project Purpose and Current Scope

MeetMe is now two products in one repository:

- Group meeting coordination (multi-person availability grid plus finalize flow).
- Personal booking links (event types, host availability windows, public booking pages, reminders).

Both are served as static pages plus Netlify Functions APIs.

## 2. Stack and Runtime Model

- Frontend: static HTML plus vanilla JS plus shared CSS under `static/`.
- Backend: Netlify Functions, Node ESM (`.mjs`).
- Data store: Netlify Blobs key-value stores (`@netlify/blobs`).
- Auth: JWT cookie sessions plus magic link plus Google OAuth.
- Email: Resend API.
- Calendar: Google Calendar free/busy integration.
- CI and test tooling: Node test runner, Playwright smoke tests, ESLint, Prettier.

No framework, no ORM, no migration system, no background worker outside Netlify scheduled function.

## 3. Top-Level Architecture

### Frontend layers

- Page HTML files (for example `meeting.html`, `booking-setup.html`) render containers and forms.
- Shared runtime helpers in `static/common.js`:
  - `apiFetch`, `checkAuth`, `requireAuth`, flash banners, nav updates.
- Shared footer and shell helper in `static/layout.js`.
- Per-page scripts in `static/*.js` implement behavior.

### Backend layers

- Route handlers in `netlify/functions/*.mjs`.
- Shared platform and security primitives in `netlify/functions/utils.mjs`.
- Function routing configured via each file's exported `config.path` or `config.schedule`.

### Deployment and HTTP security

- `netlify.toml` uses `node_bundler = "esbuild"` and serves static publish root `.`.
- Unknown routes redirect to `404.html` via explicit 404 redirect.
- Security headers globally applied:
  - CSP (`default-src 'self'`, no inline scripts).
  - HSTS, X-Frame-Options DENY, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.

## 4. Backend Route Map

### Auth and profile (`netlify/functions/auth.mjs`, `auth-google.mjs`)

- `GET /api/auth/health`
- `POST /api/auth/magic-link/request`
- `GET /api/auth/magic-link/verify`
- `GET /api/auth/google/start`
- `GET /api/auth/google/callback`
- `GET /api/auth/google/calendar-start`
- `GET /api/auth/google/calendar-callback`
- `POST /api/auth/google/calendar-disconnect`
- `GET /api/auth/me`
- `GET/POST /api/auth/profile`
- `POST /api/auth/logout`
- `POST /api/auth/feedback`
- `GET/POST /api/auth/email-preferences`
- `POST /api/auth/impersonation/stop`

Notable behavior:

- Magic links are one-time (`login_tokens` store, `used` flag).
- OAuth state is JWT plus cookie validated (CSRF protection).
- `health` endpoint redacts per-variable detail from non-admin callers.
- Feedback and auth endpoints have optional blob-backed rate limits.

### Meetings (`netlify/functions/meetings.mjs`, `meeting-actions.mjs`)

- `GET /api/meetings` list mine plus invited.
- `POST /api/meetings` create meeting plus invite emails.
- `GET /api/meetings/:id` meeting detail plus participants plus slot counts.
- `POST /api/meetings/:id/delete`
- `POST /api/meetings/:id/leave`
- `POST /api/meetings/:id/availability`
- `POST /api/meetings/:id/finalize`
- `POST /api/meetings/:id/unfinalize`
- `POST /api/meetings/:id/remind-pending`

Notable behavior:

- `meetings.mjs` delegates action subroutes to `meeting-actions.mjs`.
- Availability writes replace caller's rows while preserving other participants.
- Finalize, unfinalize, and reminder permissions are creator-only.

### Bookings (`netlify/functions/bookings.mjs`)

- Event types:
  - `GET /api/bookings/event-types`
  - `POST /api/bookings/event-types`
  - `POST /api/bookings/event-types/:id/delete`
- Availability (per event type):
  - `GET /api/bookings/availability?event_type_id=...`
  - `POST /api/bookings/availability`
- Public booking page:
  - `GET /api/bookings/page/:ownerSlug`
  - `GET /api/bookings/page/:ownerSlug/slots?event_type_id=...&date=YYYY-MM-DD`
  - `POST /api/bookings/page/:ownerSlug/book` (requires signed-in attendee)
- Booking management:
  - `GET /api/bookings/host`
  - `GET /api/bookings/mine`
  - `GET /api/bookings/:id`
  - `POST /api/bookings/:id/cancel`
- Reminder operations:
  - `POST /api/bookings/reminders/send` (host scoped)
  - `POST /api/bookings/reminders/run-now` (admin plus env gate)

Notable behavior:

- Public host slugs are generated and indexed in users store.
- Booking write includes best-effort post-write over-capacity rollback.
- Slot filtering includes host Google Calendar busy times when connected.

### Booking scheduler (`netlify/functions/bookings-reminders.mjs`)

- Scheduled hourly (`schedule: "0 * * * *"`).
- Manual invocation allowed only with `BOOKING_REMINDERS_RUN_SECRET` when not cron.

### Calendar (`netlify/functions/calendar.mjs`)

- `GET /api/calendar/busy?meeting_id=...`
- `GET /api/calendar/status`

### Admin (`netlify/functions/admin.mjs`)

- `GET /api/admin/stats`
- `GET /api/admin/users`
- `GET /api/admin/users/:email`
- `POST /api/admin/users`
- `POST /api/admin/users/admin`
- `POST /api/admin/users/delete`
- `POST /api/admin/impersonate`
- `GET /api/admin/meetings`
- `GET /api/admin/events`

### Webhooks and preference confirmation

- `POST /api/webhooks/resend` (`netlify/functions/webhooks.mjs`)
- `GET /api/email-preferences/confirm` (`netlify/functions/email-preferences.mjs`)
- `POST /api/email-preferences/apply` (`netlify/functions/email-preferences.mjs`)

## 5. Data Model (Netlify Blobs)

Primary stores used by `utils.getDb(name)`:

- `users`
- `meetings`
- `invites`
- `availability`
- `bookings`
- `events` (audit and event log)
- `login_tokens`
- `rate_limits`
- `email_preferences`
- `email_records` (Resend id correlation for bounce handling)

Important key patterns:

- Meetings:
  - `meetings:{meetingId}` (logical, stored as blob key `meetingId`)
  - `invites:meeting:{meetingId}`
  - `availability:meeting:{meetingId}`
  - `invites:pending:{email}`
- Bookings:
  - `event_type:{eventTypeId}`
  - `owner:{ownerUserId}` -> eventType id list
  - `owner:{ownerUserId}:event_type:{eventTypeId}` -> availability config
  - `booking:{bookingId}`
  - `slot:{eventTypeId}:{date}:{startTime}` -> booking id list
  - `host:{hostUserId}` and `attendee:{attendeeUserId}`
- Users:
  - user by email key
  - booking slug index key: `booking_public_slug:{slug}` -> email

## 6. Frontend Surface (Pages and Scripts)

Meeting flow pages:

- `index.html` + `static/index.js` (magic link request plus google start)
- `dashboard.html` + `static/dashboard.js`
- `create-meeting.html` + `static/create-meeting.js`
- `meeting.html` + `static/meeting.js`
- `profile.html` + `static/profile.js`
- `admin.html` + `static/admin.js`
- `feedback.html` + `static/feedback.js`

Booking flow pages:

- `booking-setup.html` + `static/booking-setup.js`
- `booking-availability.html` + `static/booking-availability.js`
- `booking-links.html` + `static/booking-links.js`
- `book.html` + `static/book.js`
- `bookings.html` + `static/bookings.js`
- `booking-confirmation.html` + `static/booking-confirmation.js`

Cross-page behavior:

- All pages include `static/common.js` and use cookie-based API calls (`credentials: include`).
- `requireAuth()` redirects unauthenticated users to `/?next=...`.
- `checkAuth()` mutates nav and shows booking and admin links conditionally.

## 7. Security and Hardening Snapshot

Implemented controls currently in code:

- Strong JWT secret required (`getJwtSecret()` throws if missing).
- Cookie defaults: HttpOnly plus SameSite=Lax, secure auto by environment.
- OAuth state validation and callback path sanitization.
- Webhook secret verification using constant-time compare (`secretsEqual`).
- Email suppression preferences (global opt-out plus per-organizer block).
- Structured logging plus persisted audit events.
- Input validation on titles, durations, dates, times, emails.
- Generic 500 handling wrappers on function entry points.

Tradeoff:

- Rate limiting fails open if blob store is unavailable (availability over strict protection).

## 8. Test and CI Status

### What is covered

- Unit tests: shared utils.
- API integration tests: auth, meetings, admin, calendar, webhooks, email preferences.
- Booking integration tests: event types, per-event availability, booking create and cancel, reminders.
- Scheduler function tests for cron and manual secret behavior.
- Playwright smoke tests:
  - Public pages
  - Create-meeting submit
  - Booking flow and reminder UI actions
- GitHub Actions (`.github/workflows/ci.yml`):
  - `npm audit --omit=dev`
  - `npm test` in default and rate-limit-enabled modes
  - Playwright smoke
  - Optional staging smoke (manual and auto when secret URL is configured)

### Actual local command results (2026-03-29)

- `npm test`: pass (54/54).
- `npm run test:e2e:smoke`: pass (5/5).
- `npm run lint`: fail.

Current lint blockers:

- Parsing error in `static/booking-setup.js` due duplicate function declarations.
- Unused vars warnings in `static/booking-availability.js` indicating incomplete or unused event type selection plumbing.

## 9. Current Risks and Gaps

Priority order reflects impact plus likelihood.

1. Frontend parse error in booking setup (high)

- `static/booking-setup.js` declares `resetEventForm` and `renderEventTypes` twice.
- ESLint reports a hard parsing error; this can block script execution depending on browser parse behavior.

2. Booking availability API contract mismatch risk (high)

- Backend requires `GET /api/bookings/availability?event_type_id=...`.
- `static/booking-availability.js` currently calls `GET /api/bookings/availability` without `event_type_id`.
- `static/booking-setup.js` also contains availability fetches without that query param.
- Expected runtime outcome: 400 responses and broken availability loading in booking screens.

3. Frontend coverage gap (medium)

- Current Playwright smoke does not exercise `booking-setup.html` and `booking-availability.html`.
- This likely allowed the parse error plus contract drift to land undetected.

4. Local quality gate inconsistency (medium)

- Docs and scripts present robust checks, but `predeploy-check` currently fails due the lint blocker above.
- Team should treat lint as required before merge and deploy.

5. Large single-file frontend scripts (medium, maintainability)

- `static/meeting.js`, `static/admin.js`, and `static/booking-setup.js` are large and multi-responsibility.
- This increases merge conflict probability and regression risk.

## 10. Recommended Immediate Work Plan

1. Fix booking setup script integrity

- Remove duplicate section in `static/booking-setup.js`.
- Re-run `npm run lint` until clean.

2. Align booking availability client-server contract

- Ensure all GET calls to `/api/bookings/availability` include a selected `event_type_id`.
- Use query param from selected event type or URL `eventType` value.

3. Expand smoke coverage

- Add Playwright smoke spec for:
  - `booking-setup.html` load plus event type CRUD path stubs.
  - `booking-availability.html` load plus fetch with event type query.

4. Add a simple frontend syntax gate in CI

- Keep lint as a required status check.
- Optionally add a script to parse all `static/*.js` to fail on syntax errors before e2e.

## 11. Developer Onboarding Notes

Primary commands:

- `npm install`
- `npm run dev`
- `npm test`
- `npm run test:e2e:smoke`
- `npm run lint`

Environment variables with highest operational impact:

- `JWT_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `RESEND_API_KEY`
- `AUTH_FROM_EMAIL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `ADMIN_EMAILS`
- `BOOKING_REMINDERS_RUN_SECRET`
- `ALLOW_BOOKING_REMINDER_RUN_NOW`
- `RESEND_WEBHOOK_SECRET`

Debug tip:

- `GET /api/auth/health` gives env presence checks (full detail only for admin-authenticated callers).

## 12. Bottom Line

Backend architecture is cohesive and test-backed, with significant hardening already in place.
The highest-risk issues are currently in booking frontend scripts (duplicate code and API drift), and those are not yet covered by smoke tests.

If you are taking over this repository, start by making booking setup and booking availability lint-clean and green under smoke tests, then continue feature work.
