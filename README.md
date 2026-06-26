# MeetMe — Joint Meeting Finder

A serverless web application for finding the perfect meeting time across your whole team.
Built with Netlify Functions (Node.js ES modules) and Netlify Blobs for storage — no
traditional server or database required.

[![Netlify Status](https://api.netlify.com/api/v1/badges/ea21e245-ad0e-4e32-a1b0-1fd0360abe5b/deploy-status)](https://app.netlify.com/projects/meetme-2/deploys)
![202 unit tests](https://img.shields.io/badge/unit_tests-202_passing-brightgreen)
![0 type errors](https://img.shields.io/badge/typecheck-0_errors-brightgreen)

**Testing:** 202 backend unit tests (JWT, crypto, rate-limiting, validation, availability, all HTTP route handlers) run with Node's built-in `node:test`. Playwright E2E smoke tests cover booking flows and availability grids. See the [Testing section](#testing) for the full breakdown.

## Features

- **Anonymous meeting creation** – the landing page creates a meeting without sign-up; the organizer gets a participation URL and a separate admin URL to share or keep
- **Passwordless authentication** – users sign in via email magic link or Google OAuth
- **Two scheduling modes** – pick specific calendar dates, or generic days of the week
- **Visual 15-minute availability grid** – click and drag to mark availability fast
- **Group heatmap** – see at a glance when most people are free (white → dark green)
- **Slot detail panel** – hover any heatmap cell to see exactly who is available
- **Per-person breakdown** – all participants can inspect each other's slot counts
- **Reminder emails** – creator can nudge non-responders with one click (account meetings only)
- **Finalization** – creator picks the time, sets duration, adds a note
- **Claim an anonymous meeting** – logged-in users can add a shared meeting to their account, or transfer ownership via the admin link
- **Google Calendar integration** – connect your calendar to see conflicts while filling in availability
- **Bounce notifications** – creator is notified by email when an invitation can't be delivered
- **Admin panel** – view site-wide stats, user list, meeting list, and audit log
- **Feedback page** – users can submit bug reports and feature requests

---

## Quick Start (local development)

### 1. Prerequisites

- [Node.js](https://nodejs.org/) 20 or later (CI runs Node 24; see `engines` in `package.json`)
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

Optionally, if your team maintains an encrypted `.env.asc` via SOPS, you can
decrypt it instead of filling in `.env` by hand (requires SOPS and the team's
dedicated GPG key — see [Environment secrets (SOPS)](#environment-secrets-sops)):

```bash
npm run env:decrypt
```

> Note: `.env.asc` is **not** tracked in this repository. The SOPS workflow is
> opt-in and requires generating a dedicated, rotatable GPG key first (it must
> not be a personal identity key); see the SOPS section for details.

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

## Testing

The test suite has two layers.

### Unit tests (`test/*.test.mjs`) — 202 tests

Node's built-in `node:test` runner, no extra framework needed.

```bash
DISABLE_RATE_LIMIT=1 npm test           # run all unit tests
DISABLE_RATE_LIMIT=1 npm run test:coverage  # with line/branch/function coverage gates
```

Coverage breakdown by layer:

| File | What's tested |
|---|---|
| `test/jwt.test.mjs` | `lib/jwt.mjs` — sign, verify, expiry, tamper, wrong secret, Bearer vs cookie precedence |
| `test/utils.test.mjs` | `lib/crypto.mjs`, `lib/rate-limit.mjs`, `lib/utils-core.mjs` — encrypt/decrypt round-trip, fail-closed behaviour, rate-limit CAS |
| `test/meeting-validation.test.mjs` | `lib/meeting-validation.mjs` — all validation paths for create-meeting and finalize |
| `test/bookings-validation.test.mjs` | `lib/bookings-validation.mjs` — event-type and availability window validation |
| `test/bookings-helpers.test.mjs` | `lib/bookings-helpers.mjs` — time/date helpers, slugify, weekday calculation |
| `test/availability.test.mjs` | `lib/bookings-availability.mjs` — slot building and DST edges |
| `test/api-routes.test.mjs` | HTTP handler integration tests (auth, meeting CRUD, permissions) |
| `test/bookings.test.mjs` | Booking HTTP handler — event types, availability, public booking flow |
| `test/meetings.test.mjs` | Meetings handler — create, list, finalize, leave, delete |
| `test/public-meetings.test.mjs` | Anonymous meeting creation and token-gated access |
| `test/bookings-reminders.test.mjs` | Scheduled reminder sweep |

The `crypto.mjs`, `jwt.mjs`, and `rate-limit.mjs` lib modules are exercised both directly (in `jwt.test.mjs` and `utils.test.mjs`) and indirectly through every HTTP-handler test that signs tokens or hits rate-limited endpoints.

### E2E smoke tests (`test/e2e/`)

Playwright tests that run against a local static server with mocked APIs. Covers booking flows, routing redirects, and availability touch interaction.

```bash
npm run test:e2e:smoke
```

---

## Project Structure

```
meetme/
├── netlify.toml              # Build config: publish = "public", functions = "netlify/functions"
├── package.json              # Node dependencies
├── .env.example              # Template for local environment variables
│                             # (.env.asc, if your team uses SOPS, is NOT tracked here)
│
├── public/                   # Static site root (Netlify publish directory)
│   ├── index.html            # Sign-in page (magic link / Google OAuth)
│   ├── register.html         # Alternative entry point (redirects to index)
│   ├── dashboard.html        # User dashboard: meetings, booking links, my bookings
│   ├── create-meeting.html   # New meeting form
│   ├── meeting.html          # Availability grid, heatmap, finalize
│   ├── email-sent.html       # Shown after requesting a magic link
│   ├── profile.html          # Edit name, timezone, connect Google Calendar
│   ├── admin.html            # Admin-only: stats, users, meetings, event log
│   ├── feedback.html         # User feedback form
│   ├── book.html             # Public booking page (week-view slot picker)
│   ├── booking-setup.html    # Host: create/edit bookable event types
│   ├── booking-availability.html # Host: set available time grid per event type
│   ├── booking-confirmation.html # Shown to guest after booking is confirmed
│   ├── app.html / privacy.html / support.html / 404.html
│   └── static/               # Per-page browser JS plus shared helpers and styles
│       ├── common.js         # Shared helpers (apiFetch, requireAuth, showFlash)
│       ├── layout.js         # Shared header / nav / footer rendering
│       ├── style.css         # All styles (no external CSS dependencies)
│       └── <page>.js         # One module per HTML page (dashboard.js, meeting.js, book.js, ...)
│
├── scripts/
│   └── decrypt-sops-env.mjs  # Node helper: decrypt .env.asc → .env (used by npm run env:decrypt and CI)
│
└── netlify/
    └── functions/            # Netlify Functions (HTTP route handlers)
        ├── utils.mjs         # Barrel re-export of lib/* (env, JWT, crypto, logging, email, DB)
        ├── auth.mjs          # /api/auth/* (profile, logout, feedback, health)
        ├── auth-google.mjs   # /api/auth/google/* (Google OAuth and Calendar)
        ├── auth-helpers.mjs  # Shared auth logic and user-creation helpers
        ├── magic-link.mjs    # /api/auth/magic-link/* (email magic-link sign-in)
        ├── meetings.mjs      # /api/meetings/* (create, list, detail, delete, leave)
        ├── meeting-actions.mjs    # /api/meetings/:id/* (availability, finalize, remind)
        ├── public-meetings.mjs    # /api/public/meetings/* (anonymous meetings, token-gated)
        ├── bookings.mjs      # /api/bookings/* (bookable event types and bookings)
        ├── bookings-reminders.mjs # /api/bookings/reminders/* (scheduled booking reminders)
        ├── calendar.mjs      # /api/calendar/* (Google Calendar free/busy)
        ├── email-preferences.mjs  # /api/email-preferences/* (unsubscribe, no auth)
        ├── admin.mjs         # /api/admin/* (admin panel data)
        ├── webhooks.mjs      # /api/webhooks/* (Resend bounce / complaint handler)
        └── lib/              # Shared modules imported via utils.mjs:
                              #   crypto, rate-limit, env, db, jwt, email, *-store, *-validation
```

---

## Configuration

Set these environment variables in Netlify (Site configuration → Environment variables)
and in your local `.env` file for development:

| Variable                         | Default                | Purpose                                                                                    |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `JWT_SECRET`                     | _(required)_           | Secret used to sign session JWTs — use a long random string                                |
| `TOKEN_ENCRYPTION_KEY`           | _(required)_           | Key for AES-256-GCM encryption of stored OAuth tokens — use a different long random string |
| `APP_URL`                        | inferred from request  | Public base URL, e.g. `https://your-site.netlify.app`                                      |
| `RESEND_API_KEY`                 | _(required for email)_ | API key from [resend.com](https://resend.com)                                              |
| `AUTH_FROM_EMAIL`                | _(required for email)_ | Verified sender address, e.g. `MeetMe <noreply@yourdomain.com>`                            |
| `RESEND_WEBHOOK_SECRET`          | _(optional)_           | Shared secret for the Resend bounce/complaint webhook                                      |
| `BOOKING_REMINDERS_RUN_SECRET`   | _(recommended)_        | Shared secret required for manual calls to `/api/bookings/reminders/run`                   |
| `ALLOW_BOOKING_REMINDER_RUN_NOW` | `false`                | Enables admin-triggered `/api/bookings/reminders/run-now` endpoint when set to `true`      |
| `ADMIN_EMAILS`                   | _(optional)_           | Comma-separated admin addresses, e.g. `alice@example.com,bob@example.com`                  |
| `GOOGLE_CLIENT_ID`               | _(optional)_           | OAuth 2.0 client ID (required for Google sign-in and Calendar)                             |
| `GOOGLE_CLIENT_SECRET`           | _(optional)_           | OAuth 2.0 client secret                                                                    |

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

This project supports an **opt-in** encrypted secrets file (`.env.asc`) managed
with [SOPS](https://github.com/getsops/sops), distinct from Netlify's built-in
environment variable storage.

> **`.env.asc` is not tracked in this repository.** Treat any secret that
> ever appeared in a committed `.env.asc`/`.env.enc` as public and rotate it at
> its provider. Before using the SOPS workflow, generate a **dedicated,
> rotatable** key (not a personal identity key) and keep its private half out of
> git. The policy in [`.sops.yaml`](.sops.yaml) carries a placeholder
> fingerprint until that key exists, so SOPS will refuse to encrypt — by design.

| Context                 | How secrets are supplied                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Netlify deploy**      | Set directly in Netlify UI → Site configuration → Environment variables. `.env.asc` is **not** used.          |
| **Local development**   | Copy `.env.example` and fill in values manually, _or_ decrypt a team `.env.asc` (if your team maintains one). |
| **CI (GitHub Actions)** | The `decrypt-sops-env` composite action decrypts `.env.asc` if present, using a GPG key in a repo secret.     |

#### One-time setup: create a dedicated SOPS key

Prerequisites: [SOPS](https://github.com/getsops/sops#installation) and [GnuPG](https://gnupg.org/download/).

1. Generate a dedicated key (use a project mailbox, never a personal account):

   ```bash
   gpg --quick-generate-key "MeetMe SOPS <sops@your-team.example>" rsa4096 encr never
   ```

2. Note its fingerprint and put it in `.sops.yaml`, replacing the
   `REPLACE_WITH_NEW_DEDICATED_PUBLIC_KEY_FINGERPRINT` placeholder:

   ```bash
   gpg --list-keys --with-colons "MeetMe SOPS" | awk -F: '/^fpr:/{print $10; exit}'
   ```

3. Encrypt your filled-in `.env`:

   ```bash
   sops --encrypt .env > .env.asc
   ```

Share the private key only through your team's secure key store; never commit it.

#### Local decryption (when a team `.env.asc` exists)

1. Import the dedicated private key from your team's secure key store:

   ```bash
   gpg --import path/to/sops-private-key.asc
   ```

2. Decrypt to `.env`:

   ```bash
   npm run env:decrypt
   ```

   The script (`scripts/decrypt-sops-env.mjs`) calls `sops --decrypt`, handles the SOPS
   JSON wrapper, extracts the plain dotenv content, and writes it to `.env` with mode `0600`.

#### CI setup

The workflow in `.github/workflows/ci.yml` calls
`.github/actions/decrypt-sops-env/action.yml`, which:

1. Imports the GPG key from the `SOPS_GPG_PRIVATE_KEY` Actions secret.
2. Runs `node scripts/decrypt-sops-env.mjs .env.asc .env` when `.env.asc` is present.

To enable this in a fork or new repo:

1. Export the dedicated SOPS private key in ASCII-armored form (use the
   fingerprint you generated above):

   ```bash
   gpg --armor --export-secret-keys "<YOUR_DEDICATED_KEY_FINGERPRINT>"
   ```

2. Add the output as a repository secret named **`SOPS_GPG_PRIVATE_KEY`** in
   GitHub → Settings → Secrets and variables → Actions.

If the secret is absent (or no `.env.asc` is present), the decrypt step is skipped
and tests run without secrets (suitable for open-source forks that supply their own
env vars).

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

### Type safety

The project is statically type-checked without being written in TypeScript. This
is a deliberate choice, not an oversight: the frontend ships as plain
`<script src>` modules with **no build step**, and Netlify bundles the backend
functions directly, so keeping `.mjs` preserves a "just deploy the files" model
while still getting compiler-verified types.

- **Backend** (34 `.mjs` files under `netlify/` and `scripts/`) is checked by
  `tsc --checkJs` against `jsconfig.json` plus ambient platform types in
  `types/globals.d.ts`. Run it locally with:

  ```bash
  npm run typecheck
  ```

- **CI gate.** [`scripts/typecheck.mjs`](scripts/typecheck.mjs) runs `tsc` and
  compares the result against a baseline in `types/typecheck-baseline.txt`. Any
  _new_ type error fails the build, and fixing a baselined error forces the
  baseline to shrink, so the type-error count can only go down. The
  `Lint, Typecheck, Format & Syntax Check` job enforces this on every push and PR.

- **Frontend** (`static/*.js`) is syntax-checked in CI with `node -c`; its
  runtime contract is exercised by the Playwright smoke suite.

A full TypeScript migration would mainly add explicit domain types
(`Meeting`, `Booking`, `User`, availability grids) and frontend type coverage,
at the cost of introducing a bundler/transpile step. Those domain types can also
be added incrementally as JSDoc/`.d.ts` without changing the deploy model.

### Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<optional scope>): <description>`, where `type` is one of feat, fix,
docs, style, refactor, perf, test, build, ci, chore, or revert.

Git hooks live in `scripts/hooks/` and are wired up automatically by
`npm install` (the `prepare` script points `core.hooksPath` at them). To
enable them manually:

```bash
git config core.hooksPath scripts/hooks
```

- `pre-commit` runs `gitleaks protect --staged` to block accidental secret commits.
- `commit-msg` enforces the Conventional Commits format above.

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

## Architecture and Design Decisions

### Storage layer

All data is stored in **Netlify Blobs**, a strongly-consistent, globally-replicated key-value store. This was a deliberate MVP choice with real trade-offs:

| What you get | What you give up |
|---|---|
| Zero-ops, zero-config, free tier | No SQL queries — lists and filters happen in memory |
| Strongly-consistent reads | No multi-key transactions |
| Serverless-native | Vendor-specific SDK (`@netlify/blobs`) |

**Acknowledged limitation:** No multi-key transactions means there is no atomic cross-entity operation (e.g., "add a booking and decrement capacity in one commit"). Each write is individually consistent but two related writes can fail independently. For this app's scale this is an acceptable trade-off managed by application-level retries and idempotent write patterns.

**Concurrency — how simultaneous writes are handled:** All participants' availability is stored under a single key per meeting (`meeting:<id>`). Every write goes through `updateJsonWithCas()` in `lib/db.mjs`, which uses a compare-and-swap loop (read value + etag → mutate → conditional `setJSON` with `onlyIfMatch`). If two users submit availability at the same instant, one wins the CAS and the other retries against the updated snapshot. The mutator is a pure function (`filter out my rows, append new rows`) so it produces correct output on every retry — no row from either user is lost. The same pattern guards meeting creation and booking capacity.

#### Storage abstraction layer

No function imports `@netlify/blobs` directly. Every store access goes through `getDb(name)` in `lib/db.mjs`, which returns a `StorageStore` object:

```
StorageStore {
  get(key, { type: "json" })           → Promise<any | null>
  getWithMetadata(key, { type: "json" })→ Promise<{ data, etag } | null>
  setJSON(key, value, opts?)           → Promise<{ modified: boolean }>
  delete(key)                          → Promise<void>
  list(opts?)                          → Promise<{ blobs: [{ key }] }>
}
```

Swapping the backend is a one-line change at startup:

```js
import { createClient } from "@libsql/client";
import { createTursoFactory } from "./lib/db-adapters/turso.mjs";
import { setDbFactory } from "./lib/db.mjs";

setDbFactory(createTursoFactory(createClient({
  url:       process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})));
```

`lib/db-adapters/turso.mjs` is a complete, ready-to-use SQL adapter (Turso / libSQL / embedded SQLite) with the schema and wiring instructions included. No application code changes — the five-method interface is the only contract.

**Data migration path (Blobs → Turso):**
1. Run the schema: `CREATE TABLE kv (store TEXT, key TEXT, value TEXT, etag TEXT, PRIMARY KEY(store, key))`
2. List all Blobs keys per store, read each JSON value, `INSERT INTO kv` — no transformation needed since all values are already JSON and keys are plain strings
3. Set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`, call `setDbFactory(createTursoFactory(client))` at startup
4. Remove `NETLIFY_BLOBS_*` env vars

### Frontend

The frontend is **vanilla HTML + ES module JavaScript** with no build step. Every page is a standalone `.html` file with a corresponding `static/<page>.js` module. Shared behaviour lives in `static/common.js` and `static/layout.js`.

Trade-offs:
- **Pro:** Zero-friction deployment (`netlify deploy` publishes static files directly), no bundler complexity, instant local preview
- **Con:** No tree-shaking, no template inheritance (nav/footer HTML is repeated across pages), onboarding requires reading multiple files to understand the full picture

The trade-off is documented here rather than hidden. If the page count grows substantially or a team joins, the migration path is a static site generator (Astro or Eleventy) — both support the same no-framework JS model with added templating.

---

## Security Notes

- Sessions are stored as signed JWTs in an `HttpOnly` cookie (not accessible from JavaScript)
- Google OAuth tokens are encrypted at rest with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`
- OAuth CSRF protection is implemented via a signed JWT state parameter + cookie comparison
- Magic links are single-use and expire after 15 minutes
- All auth endpoints have per-IP and per-email rate limiting
- Email addresses of participants are only visible to the meeting creator

---

## License

Released under the [MIT License](LICENSE).
