# MeetSync — Joint Meeting Finder

A Flask web application for finding the perfect meeting time across your whole team.

## Features

- **Passwordless authentication** – users sign in via email magic link or Google OAuth
- **Two scheduling modes** – pick specific calendar dates, or generic days of the week
- **Visual 30-minute availability grid** – click and drag to mark availability fast
- **Group heatmap** – see at a glance when most people are free (white → dark green)
- **Per-person breakdown** – meeting creator can see exactly how many slots each person has given
- **Finalization** – creator picks the time, sets duration, adds a note
- **iCalendar download** – all participants can download a `.ics` calendar invite

---

## Quick Start

### 1. Install dependencies

```bash
cd meeting_app
pip install -r requirements.txt
```

### 2. Run the app

```bash
python app.py
```

Open **http://localhost:5000** in your browser.

### 3. First use

1. Register an account at `/register`
2. Create a meeting → choose specific dates or days of the week
3. Enter invited email addresses (one per line)
4. Share the meeting URL with invitees – they register/login and fill in their availability
5. As the creator, view the heatmap, inspect per-person availability, then click any time slot in the heatmap to finalize

---

## Project Structure

```
meeting_app/
├── app.py                  # Flask app, models, routes
├── requirements.txt
├── README.md
├── templates/
│   ├── base.html           # Navbar, flash messages
│   ├── login.html
│   ├── register.html
│   ├── dashboard.html
│   ├── create_meeting.html # Date picker + day selector
│   └── meeting.html        # Availability grid page
└── static/
    ├── style.css           # All styles (no external dependencies)
    └── app.js              # Grid rendering, drag selection, heatmap
```

---

## Configuration

Set these environment variables before running in production:

| Variable     | Default                      | Purpose                  |
|--------------|------------------------------|--------------------------|
| `JWT_SECRET` | `meetsync-dev-secret-change-in-prod` | JWT signing secret |
| `APP_URL` | inferred from request | Public app URL used in sign-in links |
| `RESEND_API_KEY` | _(required for magic-link email)_ | Resend API key for delivering login links |
| `AUTH_FROM_EMAIL` | _(required for magic-link email)_ | Verified sender email/domain in Resend |
| `GOOGLE_CLIENT_ID` | _(required for Google sign-in)_ | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | _(required for Google sign-in)_ | OAuth client secret |

Use `.env.example` as the template for local development values.

### Netlify Auth Setup Checklist

1. In Netlify, open **Site configuration → Environment variables** and set all variables listed above.
2. In Google Cloud Console, create an OAuth 2.0 Web Client and add this **Authorized redirect URI**:
  - `https://<your-netlify-domain>/api/auth/google/callback`
3. In Resend, verify your sending domain/email and set `AUTH_FROM_EMAIL` to that verified sender.
4. Deploy the site and test:
  - Request an email sign-in link from `/`
  - Sign in with Google from `/` or `/register.html`
5. For local testing with Netlify dev, copy `.env.example` to `.env` and fill in real values.

### Troubleshooting Auth

- **Google error: `redirect_uri_mismatch`**
  - Ensure the OAuth client in Google Cloud has this exact URI in **Authorized redirect URIs**:
    - `https://<your-netlify-domain>/api/auth/google/callback`
  - Make sure `APP_URL` in Netlify matches your public site URL (same protocol/domain).
  - After changing Google OAuth settings, wait a minute and retry sign-in.

- **Google sign-in returns to `/` with auth error**
  - Confirm both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set in Netlify.
  - Verify the credentials belong to the same OAuth app where the redirect URI was added.
  - If you rotated secrets, trigger a new deploy so functions use updated values.

- **Resend error sending magic link (sender/domain)**
  - Verify your sending domain or sender identity in Resend.
  - Set `AUTH_FROM_EMAIL` to that verified sender (for example: `MeetSync <noreply@yourdomain.com>`).
  - Confirm `RESEND_API_KEY` is valid and has permission to send from that domain.

- **Magic link email not received**
  - Check spam/junk first.
  - Confirm `APP_URL` points to the same deployed site users are visiting.
  - Request a fresh link; each link expires quickly and is single-use.

- **Check which env vars are missing**
  - Open `/api/auth/health` on your deployed site.
  - The response shows only presence/absence for required auth variables (no secret values).
  - Use the `missing` list to update Netlify environment variables, then redeploy.

For production, also switch `SQLALCHEMY_DATABASE_URI` to PostgreSQL and use a proper WSGI server (gunicorn, etc.).

---

## How the Grid Works

- **Group heatmap view** — cell color represents the fraction of invited participants who are free
  - ⬜ No one → 🟩 Light green (few) → 🟢 Dark green (everyone)
- **My availability view** — click or click-and-drag to select/deselect time blocks; saves automatically
- **By-person view** (creator only) — use the dropdown to inspect a single participant's slots
- **Finalize** (creator only) — while in heatmap view, click any cell to open the finalize panel; set duration, add a note, confirm. All participants can then download the `.ics` invite.
