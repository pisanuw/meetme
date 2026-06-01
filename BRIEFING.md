# Briefing

- Purpose: MeetMe — a scheduling app combining Doodle-style group availability
  meetings with Calendly-style bookable event types.
- Current scope: Build the full application incrementally from an empty repo,
  one self-contained stage at a time, following `IMPLEMENTATION-PLAN.md`.
- Tech stack: Netlify static hosting + Netlify Functions (Node ESM `.mjs`),
  Netlify Blobs storage, Resend email, Google OAuth + Calendar, vanilla browser
  JS, one hand-written `style.css`.
- Key decisions:
  - No frontend framework; shared layout injected by `static/layout.js`.
  - Shared backend logic lives in `netlify/functions/lib/` and is re-exported
    through a single `utils.mjs` barrel.
  - Sessions are signed JWTs in an `HttpOnly` cookie (Bearer path for mobile).
  - Fail-closed posture: rate limiting and encryption deny on error.
- Non-goals: native mobile apps; non-Google calendar providers.
