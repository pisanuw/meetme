# Changes

Format: `YYYY-MM-DD [type] description` (max 200 chars). Types: decision, plan, doc, scope, code, note.

2026-06-01 [plan] Start MeetMe build from empty repo following the staged implementation plan; fixed stack: Netlify static + Functions, Blobs, Resend, Google, vanilla JS.
2026-06-01 [code] Stage 1: static shell — index landing, style.css design system, shared nav/footer (layout.js), common.js helper stub; netlify.toml publish config.
2026-06-02 [code] Stage 2: serverless runtime — lib/http + lib/log helpers, utils.mjs barrel, auth.mjs health endpoint, /api/_ function routing, custom 404 page + fallback redirect.
2026-06-03 [code] Stage 3: persistence — lib/db (Netlify Blobs JSON wrapper), lib/env (env validation), lib/utils-core (ids/time helpers), lib/user-store (user records keyed by normalized email).
2026-06-03 [code] Stage 4: sessions — lib/jwt (sign/verify JWT, getUserFromRequest from cookie or Bearer), auth.mjs me/profile/logout endpoints, HttpOnly token cookie. JWT_SECRET fails closed.
2026-06-04 [code] Stage 5: email — lib/email single sendEmail() choke-point over the Resend API, escapeHtml for user content, type tags, dev logging; suppression-aware preference helpers.
2026-06-05 [code] Stage 6: passwordless login — magic-link.mjs request/verify (16-char single-use token, 15-min TTL), auth-helpers getOrCreateUser; auth.mjs delegates magic-link/_ routes.
2026-06-06 [code] Stage 7: auth UI + client helpers — login/register/email-sent pages; common.js apiFetch/checkAuth/requireAuth/showFlash/escapeHtml and the account nav dropdown.
2026-06-07 [code] Stage 8: profile — profile.html/js with name + timezone auto-detect, profile-complete setup hint and skip-for-now, backed by auth.mjs GET/POST profile.
2026-06-08 [code] Stage 9: rate limiting — lib/rate-limit sliding-window counters via atomic compare-and-swap on Blobs (etag retry), fail-closed on store error, honors DISABLE_RATE_LIMIT.
2026-06-08 [code] Stage 10: meetings model — meeting-validation + meeting-store; meetings.mjs POST create (with invite + pending:<email> index) and GET :id; create-meeting page (specific-dates/days-of-week).
2026-06-09 [code] Stage 11: dashboard — meetings.mjs GET /api/meetings returns created + invited; dashboard.html/js with My meetings / Invited sections; landing redirects signed-in users here.
2026-06-10 [code] Stage 12: availability grid — meeting-actions.mjs POST :id/availability (validates slot range, marks responded); meeting.html/js edit mode with 15-min click-and-drag select.
2026-06-11 [code] Stage 13: heatmap — meeting.js view mode with white-to-green coloring, legend, per-slot who's-free detail panel, by-person overlay, and timezone display toggle.
2026-06-12 [code] Stage 14: finalize — meeting-actions.mjs finalize/unfinalize (creator-only, emails participants); meeting.js cell-click finalize panel (duration + note), Finalized badge.
2026-06-13 [code] Stage 15: lifecycle — invite emails on creation; meeting-actions remind-pending; meetings.mjs leave + delete; meeting.js remind / leave controls and dashboard wiring.
2026-06-13 [code] Stage 16: anonymous meetings — public-meetings.mjs anon create + token-gated detail/availability (signed PARTICIPATION + ADMIN JWTs); landing page shows share + one-time admin URLs.
2026-06-14 [code] Stage 17: claim + retention — meetings.mjs POST /api/meetings/claim migrates anon availability into an account; 30-day inactivity expiry rule; claim banner in meeting.js.
2026-06-15 [code] Stage 18: Google sign-in — auth-google.mjs start (signed state + oauth_state cookie CSRF, next/mobile) and callback (verify, exchange, userinfo, session); auth.mjs delegates google/\*.
2026-06-16 [code] Stage 19: encryption at rest — lib/crypto encrypt/decrypt with AES-256-GCM (enc:v1:iv:tag:ct), reads legacy plaintext, throws on missing/weak TOKEN_ENCRYPTION_KEY (no JWT_SECRET fallback).
2026-06-17 [code] Stage 20: calendar free/busy — auth-google calendar OAuth (encrypted tokens) + disconnect; calendar.mjs status + busy with ~60s-buffer token refresh; meeting.js Load-busy-times overlay.
2026-06-18 [code] Stage 21: event types — bookings-store + bookings-validation; bookings.mjs GET/POST event-types + delete (cascade); booking-setup page (one-on-one or group with capacity/day window).
2026-06-18 [code] Stage 22: availability windows — lib/bookings-availability + booking_availability store (weekly | specific_dates); bookings.mjs availability GET/POST; booking-availability click-and-drag grid.
2026-06-19 [code] Stage 23: public booking — bookings-helpers (slot math) + bookings-calendar (conflict lookup); bookings.mjs page/:slug, slots, book (capacity + post-write reconciliation); book page.
2026-06-20 [code] Stage 24: booking lifecycle — confirmation/cancel + host/mine lists + emails; bookings-reminders manual send + hourly scheduled sweep (idempotent via reminder:<id>); confirmation page.
2026-06-21 [code] Stage 25: admin + audit — lib/events persistEvent to events store; lib/admin + admin.mjs (stats, users CRUD, admin toggle, meetings, event log, impersonate); admin.html/js tabs.
2026-06-22 [code] Stage 26: comms + legal — email-preferences signed-link opt-out/block (no login); webhooks.mjs signed Resend bounce/complaint -> notify creator; feedback form; support/privacy/app pages.
2026-06-23 [code] Stage 27: account deletion + hardening — auth.mjs POST account/delete removes user + all data; netlify.toml security headers + strict CSP (no inline scripts) on every response.
2026-06-23 [code] Stage 28: tests — node --test suites for routes and lib (run with DISABLE_RATE_LIMIT) + a rate-limit-enabled variant; Playwright smoke tests over a static server with mocked APIs.
2026-06-24 [code] Stage 29: CI gates + hooks — eslint (max-warnings 0), prettier check, tsc --checkJs typecheck with baseline; ci.yml runs test/lint/typecheck/format/e2e; gitleaks + Conventional Commits hooks.
2026-06-25 [doc] Stage 30: release readiness — .env.example, SOPS workflow (.sops.yaml placeholder key, decrypt script + composite action), .gitleaks.toml, full README, MIT LICENSE, staging smoke script.
2026-06-25 [note] All 30 stages complete; every feature in the implementation plan inventory is implemented.

2026-06-25 [code] Test gap closed: add test/jwt.test.mjs (sign/verify/expiry/tamper/wrong-secret/Bearer-vs-cookie precedence) and test/availability.test.mjs (normalizeAvailabilityConfig, buildSlotCandidates edges, localToUTC DST); wire test:coverage gate (lines78/branch50/funcs50) into CI test-default job.

2026-06-25 [doc] Ran /code-improve whole-repo sweep -> CODE-IMPROVE-REPORT.md (report-only, no source changes): 1 medium + 5 low findings, ~15 simplification proposals, audits clean; 3 reviewer claims verified false and dropped.
