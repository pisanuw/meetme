# MeetMe — Joint Meeting Finder

A serverless web application for finding the perfect meeting time across your whole team.
Built with Netlify Functions (Node.js ES modules) and Netlify Blobs for storage — no
traditional server or database required.

## Features

- **Passwordless authentication** – users sign in via email magic link or Google OAuth
- **Two scheduling modes** – pick specific calendar dates, or generic days of the week
- **Visual 15-minute availability grid** – click and drag to mark availability fast
- **Group heatmap** – see at a glance when most people are free (white → dark green)
- **Slot detail panel** – hover any heatmap cell to see exactly who is available
- **Per-person breakdown** – all participants can inspect each other's slot counts
- **Reminder emails** – creator can nudge non-responders with one click
- **Finalization** – creator picks the time, sets duration, adds a note
- **Google Calendar integration** – connect your calendar to see conflicts while filling in availability
- **Bounce notifications** – creator is notified by email when an invitation can't be delivered
- **Admin panel** – view site-wide stats, user list, meeting list, and audit log
- **Feedback page** – users can submit bug reports and feature requests

---

## Quick Start (local development)

### 1. Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- [Netlify CLI](https://docs.netlify.com/cli/get-started/): `npm install -g netlify-cli`

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env and fill in real values (see Configuration section below)
```

If the repository ships a pre-encrypted `.env.enc` file, you can decrypt it instead
(requires SOPS and the GPG key — see [Environment secrets (SOPS)](#environment-secrets-sops)):

```bash
npm run env:decrypt
```

### 4. Run locally

```bash
netlify dev
```

Open **http://localhost:8888** in your browser.

### 5. First use

1. Go to `http://localhost:8888` and request a magic link sign-in
2. Check the Netlify dev console — the magic link URL is printed there in development
3. Create a meeting → choose specific dates or days of the week
4. Enter invited email addresses (one per line)
5. Share the meeting URL with invitees — they sign in and fill in their availability
6. As the creator, view the heatmap, inspect per-person availability, then click any slot to finalize

---

## Project Structure

```
meetme/
├── netlify.toml              # Build config and Netlify Function settings
├── package.json              # Node dependencies
├── .env.example              # Template for local environment variables
├── .env.enc                  # SOPS-encrypted secrets (see Environment secrets section)
│
├── index.html                # Sign-in page (magic link / Google OAuth)
├── register.html             # Alternative entry point (redirects to index)
├── dashboard.html            # User dashboard: meetings, booking links, my bookings
├── create-meeting.html       # New meeting form
├── meeting.html              # Availability grid, heatmap, finalize
├── email-sent.html           # Shown after requesting a magic link
├── profile.html              # Edit name, timezone, connect Google Calendar
├── admin.html                # Admin-only: stats, users, meetings, event log
├── feedback.html             # User feedback form
├── book.html                 # Public booking page (week-view slot picker)
├── booking-setup.html        # Host: create/edit bookable event types
├── booking-availability.html # Host: set available time grid per event type
├── booking-links.html        # Host: manage public booking link slugs
├── booking-confirmation.html # Shown to guest after booking is confirmed
│
├── scripts/
│   └── decrypt-sops-env.mjs  # Node helper: decrypt .env.enc → .env (used by npm run env:decrypt and CI)
│
├── static/
│   ├── common.js             # Shared JS helpers (apiFetch, requireAuth, showFlash)
│   └── style.css             # All styles (no external CSS dependencies)
│
└── netlify/
    └── functions/
        ├── utils.mjs          # Shared helpers: env, JWT, crypto, logging, email, DB
        ├── auth.mjs           # /api/auth/* — profile, logout, feedback, health
        ├── auth-google.mjs    # /api/auth/google/* — Google OAuth and Calendar
        ├── magic-link.mjs     # /api/auth/magic-link/* — Email magic link sign-in
        ├── auth-helpers.mjs   # Shared auth logic and user creation helpers
        ├── meetings.mjs       # /api/meetings/* — create, list, detail, delete, leave
        ├── meeting-actions.mjs # /api/meetings/* — availability, finalize, remind
        ├── bookings.mjs       # /api/bookings/* — bookable event types and bookings
        ├── calendar.mjs       # /api/calendar/* — Google Calendar free/busy
        ├── admin.mjs          # /api/admin/* — admin panel data
        └── webhooks.mjs       # /api/webhooks/* — Resend bounce/complaint handler
```

---

## Configuration

Set these environment variables in Netlify (Site configuration → Environment variables)
and in your local `.env` file for development:

| Variable                | Default                | Purpose                                                                                    |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `JWT_SECRET`            | _(required)_           | Secret used to sign session JWTs — use a long random string                                |
| `TOKEN_ENCRYPTION_KEY`  | _(required)_           | Key for AES-256-GCM encryption of stored OAuth tokens — use a different long random string |
| `APP_URL`               | inferred from request  | Public base URL, e.g. `https://your-site.netlify.app`                                      |
| `RESEND_API_KEY`        | _(required for email)_ | API key from [resend.com](https://resend.com)                                              |
| `AUTH_FROM_EMAIL`       | _(required for email)_ | Verified sender address, e.g. `MeetMe <noreply@yourdomain.com>`                            |
| `RESEND_WEBHOOK_SECRET` | _(optional)_           | Shared secret for the Resend bounce/complaint webhook                                      |
| `BOOKING_REMINDERS_RUN_SECRET` | _(recommended)_   | Shared secret required for manual calls to `/api/bookings/reminders/run`                    |
| `ALLOW_BOOKING_REMINDER_RUN_NOW` | `false`          | Enables admin-triggered `/api/bookings/reminders/run-now` endpoint when set to `true`       |
| `ADMIN_EMAILS`          | _(optional)_           | Comma-separated admin addresses, e.g. `alice@example.com,bob@example.com`                  |
| `GOOGLE_CLIENT_ID`      | _(optional)_           | OAuth 2.0 client ID (required for Google sign-in and Calendar)                             |
| `GOOGLE_CLIENT_SECRET`  | _(optional)_           | OAuth 2.0 client secret                                                                    |

Generate strong secrets with:

```bash
openssl rand -hex 32
```

Use `.env.example` as the template for local development values.

### Netlify Setup Checklist

1. In Netlify, open **Site configuration → Environment variables** and set all variables above.
2. In Google Cloud Console, create an OAuth 2.0 Web Client and add these **Authorized redirect URIs**:
   - `https://<your-netlify-domain>/api/auth/google/callback`
   - `https://<your-netlify-domain>/api/auth/google/calendar-callback`
3. In Resend, verify your sending domain and set `AUTH_FROM_EMAIL` to that verified sender.
4. _(Optional)_ In Resend → Webhooks, add endpoint:

- URL: `https://<your-netlify-domain>/api/webhooks/resend`
- Header: `x-webhook-secret: <RESEND_WEBHOOK_SECRET>`
- Subscribe to: `email.bounced`, `email.complained`

5. Configure booking reminder scheduler secret:
  - Set `BOOKING_REMINDERS_RUN_SECRET` in Netlify.
  - Hourly cron runs execute automatically.
  - Manual runs must include header `x-booking-reminders-secret: <BOOKING_REMINDERS_RUN_SECRET>`.

6. Deploy and test:
   - Request a magic link from `/`
   - Open `/api/auth/health` to verify all env vars are detected

### Environment secrets (SOPS)

The repository optionally ships an encrypted secrets file (`.env.enc`) managed with
[SOPS](https://github.com/getsops/sops). This is distinct from Netlify's built-in
environment variable storage:

| Context | How secrets are supplied |
|---------|--------------------------|
| **Netlify deploy** | Set directly in Netlify UI → Site configuration → Environment variables. `.env.enc` is **not** used. |
| **Local development** | Decrypt `.env.enc` into `.env`, _or_ copy `.env.example` and fill in values manually. |
| **CI (GitHub Actions)** | The `decrypt-sops-env` composite action decrypts `.env.enc` using a GPG key stored as a repository secret. |

#### Local decryption

Prerequisites: [SOPS](https://github.com/getsops/sops#installation) and [GnuPG](https://gnupg.org/download/).

1. Import the GPG private key (obtain from your team's secure key store):

   ```bash
   gpg --import path/to/private-key.asc
   ```

   The key fingerprint used for this repo is `B1315A2CEAEFA6505F9C5365FFF1B4E2D6C1C779`.

2. Decrypt to `.env`:

   ```bash
   npm run env:decrypt
   ```

   The script (`scripts/decrypt-sops-env.mjs`) calls `sops --decrypt`, handles the SOPS
   JSON wrapper, extracts the plain dotenv content, and writes it to `.env` with mode `0600`.

3. _(Optional)_ To re-encrypt changes after editing `.env`:

   ```bash
   sops --encrypt .env > .env.enc
   ```

#### CI setup

The workflow in `.github/workflows/ci.yml` calls
`.github/actions/decrypt-sops-env/action.yml`, which:

1. Imports the GPG key from the `SOPS_GPG_PRIVATE_KEY` Actions secret.
2. Runs `node scripts/decrypt-sops-env.mjs .env.enc .env`.

To enable this in a fork or new repo:

1. Export the GPG private key in ASCII-armored form:

   ```bash
   gpg --armor --export-secret-keys B1315A2CEAEFA6505F9C5365FFF1B4E2D6C1C779
   ```

2. Add the output as a repository secret named **`SOPS_GPG_PRIVATE_KEY`** in
   GitHub → Settings → Secrets and variables → Actions.

If the secret is absent, the decrypt step is skipped and tests run without secrets
(suitable for open-source forks that supply their own env vars).

---

### Should do before production launch

These are strongly recommended hardening steps before opening the app to real users:

1. **Add and verify a custom 404 page**

- `404.html` should exist at the site root (included in this repo)
- After deploy, open a non-existent URL like `/does-not-exist` and verify the custom page renders

2. **Verify bounce/complaint webhook behavior end-to-end**

- In Resend → Webhooks, ensure your endpoint is configured with `RESEND_WEBHOOK_SECRET`
- Confirm subscriptions include `email.bounced` and `email.complained`
- Trigger a test event and verify creator notification + event log entry in `/admin.html`

3. **Enable production observability**

- Enable Netlify Function logs monitoring (or a log drain/third-party monitor)
- Set alerting for repeated `error` events from `/api/auth/*`, `/api/meetings/*`, and `/api/webhooks/*`
- Review `/admin.html` event logs regularly during the first week after launch

### Troubleshooting Auth

- **Google error: `redirect_uri_mismatch`**
  - Ensure the Google Cloud OAuth client has the exact redirect URI above in **Authorized redirect URIs**.
  - Make sure `APP_URL` in Netlify matches your public site URL exactly (same protocol and domain).
  - After changing Google OAuth settings, wait a minute and retry.

- **Google sign-in returns to `/` with an error**
  - Confirm both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set in Netlify.
  - Verify the credentials belong to the same OAuth app where the redirect URI was added.
  - If you rotated secrets, redeploy so the functions pick up the updated values.

- **Magic link email not received**
  - Check spam/junk first.
  - Verify your Resend sending domain and confirm `AUTH_FROM_EMAIL` matches.
  - Each link expires in 15 minutes and can only be used once — request a fresh one.

- **Check which env vars are missing**
  - Open `/api/auth/health` on your deployed site.
  - The response shows only presence/absence (never secret values).
  - Use the `missing` list to identify what to add in Netlify, then redeploy.

### Docker / Dev Container Troubleshooting

If you run `netlify dev` inside Docker or a VS Code dev container, you may see
errors like:

- `Function auth has returned an error: connect ECONNREFUSED 127.0.0.1:<random-port>`
- `this function has crashed`

In this scenario, function code may execute and log normally, but the local
Netlify function runtime callback can fail in the container network namespace.

Recommended approach:

1. **Run Netlify dev on the host machine** (outside Docker) for full function testing.
2. Keep editing code in the container if preferred, but use host `netlify dev` for auth/function flows.
3. For local Google OAuth testing, set:
   - `APP_URL=http://localhost:8888`
   - Redirect URIs in Google Cloud Console:
     - `http://localhost:8888/api/auth/google/callback`
     - `http://localhost:8888/api/auth/google/calendar-callback`

If you must run inside Docker, use deployed Netlify preview/production for
auth/function validation and limit container-local checks to static/UI behavior.

### esbuild Platform Mismatch (Docker + macOS)

If `npm run dev` fails with a message like:

- `You installed esbuild for another platform than the one you're currently using`

you are likely reusing `node_modules` between Linux (Docker) and macOS.

Fix on macOS:

```bash
npm run fix:deps
```

Prevention:

1. Do not share `node_modules` between host and container.
2. Install dependencies separately in each environment (`npm ci` on each side).

### Quality checks

```bash
npm run predeploy-check
npm run format:check
```

Additional smoke layers:

```bash
# Browser smoke (Playwright, local static server + mocked API routes)
npm run test:e2e:smoke

# Full local predeploy gate
npm run predeploy:full

# Staging/API smoke against a deployed URL
BASE_URL=https://your-preview.netlify.app npm run smoke:staging
```

CI automation for staging smoke:

- `Staging Smoke (auto)` runs on push and on a daily schedule **when** repository
  secret `STAGING_BASE_URL` is set.
- Optional `STAGING_ADMIN_TOKEN` enables the admin stats check in that smoke run.

### Latest predeployment check (2026-04-01)

- `npm run lint`: pass
- `npm test`: pass (61/61)
- `TEST_RATE_LIMIT_MODE=on npm test`: pass (61/61)
- `npm run test:e2e:smoke`: pass (14/14)
- `Staging Smoke (manual)` can still be triggered via **Run workflow** using
  `workflow_dispatch` inputs.

### Required Branch Protection (must enable)

To prevent broken deploys, protect your default branch (for example `main`) and
require passing CI before merge.

In GitHub: **Settings → Branches → Add branch protection rule**

Use these settings:

1. **Require a pull request before merging**: enabled
2. **Require status checks to pass before merging**: enabled
3. Add required checks:

- `Test (default mode)`
- `Test (rate limit enabled)`

4. **Require branches to be up to date before merging**: enabled
5. **Do not allow bypassing the above settings**: enabled (for admins too)

These checks are produced by the workflow in `.github/workflows/ci.yml`.
If either check fails, merging should be blocked.

### Release Checklist (before every deploy)

Use this checklist every time to avoid shipping untested changes:

1. Pull latest default branch and verify your branch is up to date.
2. Run locally:

```bash
npm run predeploy:full
```

3. Open a Pull Request and wait for both required checks to pass:

- `Test (default mode)`
- `Test (rate limit enabled)`
- `Test (e2e smoke)`

4. Merge the Pull Request into the protected default branch.
5. Deploy **only from the protected default branch** (never from an unmerged local branch).
6. After deploy, smoke test critical flows:

- Magic-link sign in
- Google sign in
- Create meeting
- Submit availability
- Finalize meeting

---

## How the Grid Works

- **Group heatmap view** — cell color represents the fraction of invited participants who are free
  - ⬜ No one available → 🟩 Some people → 🟢 Everyone available
  - Hover a cell to see exactly who is available and who hasn't responded
- **My availability view** — click or click-and-drag to select/deselect 15-minute blocks; saves on button click
- **By-person view** — click any participant's row to see only their availability overlaid on the grid
- **Finalize** (creator only) — while in heatmap view, click any cell to open the finalize panel; set duration, add a note, confirm

---

## Security Notes

- Sessions are stored as signed JWTs in an `HttpOnly` cookie (not accessible from JavaScript)
- Google OAuth tokens are encrypted at rest with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`
- OAuth CSRF protection is implemented via a signed JWT state parameter + cookie comparison
- Magic links are single-use and expire after 15 minutes
- All auth endpoints have per-IP and per-email rate limiting
- Email addresses of participants are only visible to the meeting creator
