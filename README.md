# MeetSync — Joint Meeting Finder

A Flask web application for finding the perfect meeting time across your whole team.

## Features

- **Email/password authentication** – users register once and can join any meeting they're invited to
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
| `SECRET_KEY` | `dev-secret-change-in-prod`  | Flask session signing    |

For production, also switch `SQLALCHEMY_DATABASE_URI` to PostgreSQL and use a proper WSGI server (gunicorn, etc.).

---

## How the Grid Works

- **Group heatmap view** — cell color represents the fraction of invited participants who are free
  - ⬜ No one → 🟩 Light green (few) → 🟢 Dark green (everyone)
- **My availability view** — click or click-and-drag to select/deselect time blocks; saves automatically
- **By-person view** (creator only) — use the dropdown to inspect a single participant's slots
- **Finalize** (creator only) — while in heatmap view, click any cell to open the finalize panel; set duration, add a note, confirm. All participants can then download the `.ics` invite.
