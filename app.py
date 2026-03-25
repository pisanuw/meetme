from flask import (Flask, render_template, redirect, url_for, request,
                   flash, jsonify, make_response, session)
from flask_sqlalchemy import SQLAlchemy
from flask_login import (LoginManager, UserMixin, login_user, logout_user,
                         login_required, current_user)
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta, date
import json
import os
import uuid

try:
    from icalendar import Calendar, Event as ICalEvent
    import pytz
    HAS_ICAL = True
except ImportError:
    HAS_ICAL = False

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-change-in-prod')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///meetings.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.login_message = 'Please log in to continue.'
login_manager.login_message_category = 'info'


# ─────────────────────────────────────────────
#  MODELS
# ─────────────────────────────────────────────

class User(UserMixin, db.Model):
    id            = db.Column(db.Integer, primary_key=True)
    email         = db.Column(db.String(120), unique=True, nullable=False)
    name          = db.Column(db.String(100), nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)

    meetings_created = db.relationship('Meeting', backref='creator', lazy=True)
    invitations      = db.relationship('MeetingInvite', backref='user', lazy=True)
    availabilities   = db.relationship('Availability', backref='user', lazy=True)

    def set_password(self, pw):
        self.password_hash = generate_password_hash(pw)

    def check_password(self, pw):
        return check_password_hash(self.password_hash, pw)


class Meeting(db.Model):
    id               = db.Column(db.Integer, primary_key=True)
    title            = db.Column(db.String(200), nullable=False)
    description      = db.Column(db.Text, default='')
    creator_id       = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    # 'specific_dates' | 'days_of_week'
    meeting_type     = db.Column(db.String(20), nullable=False)
    # JSON list of "YYYY-MM-DD" or day-names
    dates_or_days    = db.Column(db.Text, nullable=False)
    start_time       = db.Column(db.String(5), default='08:00')
    end_time         = db.Column(db.String(5), default='20:00')
    duration_minutes = db.Column(db.Integer, default=60)
    finalized_date   = db.Column(db.String(20), nullable=True)
    finalized_slot   = db.Column(db.String(5),  nullable=True)
    note             = db.Column(db.Text, default='')
    is_finalized     = db.Column(db.Boolean, default=False)
    created_at       = db.Column(db.DateTime, default=datetime.utcnow)

    invites        = db.relationship('MeetingInvite', backref='meeting',
                                     lazy=True, cascade='all, delete-orphan')
    availabilities = db.relationship('Availability', backref='meeting',
                                     lazy=True, cascade='all, delete-orphan')

    @property
    def dates_list(self):
        return json.loads(self.dates_or_days)

    @property
    def time_slots(self):
        slots = []
        sh, sm = map(int, self.start_time.split(':'))
        eh, em = map(int, self.end_time.split(':'))
        cur = sh * 60 + sm
        end = eh * 60 + em
        while cur < end:
            slots.append(f"{cur // 60:02d}:{cur % 60:02d}")
            cur += 30
        return slots

    @property
    def respond_count(self):
        return MeetingInvite.query.filter_by(meeting_id=self.id, responded=True).count()

    @property
    def invite_count(self):
        return MeetingInvite.query.filter_by(meeting_id=self.id).count()


class MeetingInvite(db.Model):
    id         = db.Column(db.Integer, primary_key=True)
    meeting_id = db.Column(db.Integer, db.ForeignKey('meeting.id'), nullable=False)
    user_id    = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    email      = db.Column(db.String(120), nullable=False)
    name       = db.Column(db.String(100), default='')
    responded  = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Availability(db.Model):
    id          = db.Column(db.Integer, primary_key=True)
    meeting_id  = db.Column(db.Integer, db.ForeignKey('meeting.id'), nullable=False)
    user_id     = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    date_or_day = db.Column(db.String(20), nullable=False)
    time_slot   = db.Column(db.String(5),  nullable=False)

    __table_args__ = (
        db.UniqueConstraint('meeting_id', 'user_id', 'date_or_day', 'time_slot'),
    )


@login_manager.user_loader
def load_user(uid):
    return User.query.get(int(uid))


# ─────────────────────────────────────────────
#  AUTH ROUTES
# ─────────────────────────────────────────────

@app.route('/')
def index():
    return redirect(url_for('dashboard') if current_user.is_authenticated else url_for('login'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    if request.method == 'POST':
        email    = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        user     = User.query.filter_by(email=email).first()
        if user and user.check_password(password):
            login_user(user, remember=True)
            return redirect(request.args.get('next') or url_for('dashboard'))
        flash('Invalid email or password.', 'danger')
    return render_template('login.html')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    if request.method == 'POST':
        email   = request.form.get('email', '').strip().lower()
        name    = request.form.get('name', '').strip()
        pw      = request.form.get('password', '')
        confirm = request.form.get('confirm_password', '')

        if not all([email, name, pw]):
            flash('All fields are required.', 'danger')
        elif pw != confirm:
            flash('Passwords do not match.', 'danger')
        elif len(pw) < 6:
            flash('Password must be at least 6 characters.', 'danger')
        elif User.query.filter_by(email=email).first():
            flash('Email already registered.', 'danger')
        else:
            u = User(email=email, name=name)
            u.set_password(pw)
            db.session.add(u)
            db.session.flush()
            # Link pending invites
            for inv in MeetingInvite.query.filter_by(email=email).all():
                inv.user_id = u.id
                if not inv.name:
                    inv.name = name
            db.session.commit()
            login_user(u, remember=True)
            flash(f'Welcome, {name}!', 'success')
            return redirect(url_for('dashboard'))
    return render_template('register.html')


@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))


# ─────────────────────────────────────────────
#  DASHBOARD
# ─────────────────────────────────────────────

@app.route('/dashboard')
@login_required
def dashboard():
    my_meetings = Meeting.query.filter_by(creator_id=current_user.id)\
                               .order_by(Meeting.created_at.desc()).all()

    invited = db.session.query(Meeting)\
        .join(MeetingInvite, Meeting.id == MeetingInvite.meeting_id)\
        .filter(MeetingInvite.email == current_user.email,
                Meeting.creator_id != current_user.id)\
        .order_by(Meeting.created_at.desc()).all()

    return render_template('dashboard.html',
                           my_meetings=my_meetings,
                           invited_meetings=invited)


# ─────────────────────────────────────────────
#  CREATE MEETING
# ─────────────────────────────────────────────

@app.route('/meeting/create', methods=['GET', 'POST'])
@login_required
def create_meeting():
    if request.method == 'POST':
        title        = request.form.get('title', '').strip()
        description  = request.form.get('description', '').strip()
        meeting_type = request.form.get('meeting_type', 'specific_dates')
        start_time   = request.form.get('start_time', '08:00')
        end_time     = request.form.get('end_time', '20:00')

        if not title:
            flash('Meeting title is required.', 'danger')
            return render_template('create_meeting.html')

        if meeting_type == 'specific_dates':
            dates = sorted(request.form.getlist('specific_dates'))
            if not dates:
                flash('Select at least one date.', 'danger')
                return render_template('create_meeting.html')
            dates_or_days = json.dumps(dates)
        else:
            day_order = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
            days = sorted(request.form.getlist('days_of_week'),
                          key=lambda d: day_order.index(d) if d in day_order else 7)
            if not days:
                flash('Select at least one day.', 'danger')
                return render_template('create_meeting.html')
            dates_or_days = json.dumps(days)

        meeting = Meeting(
            title=title, description=description,
            creator_id=current_user.id, meeting_type=meeting_type,
            dates_or_days=dates_or_days, start_time=start_time, end_time=end_time
        )
        db.session.add(meeting)
        db.session.flush()

        # Creator is always invited
        db.session.add(MeetingInvite(
            meeting_id=meeting.id, user_id=current_user.id,
            email=current_user.email, name=current_user.name
        ))

        raw_emails = request.form.get('invite_emails', '')
        for line in raw_emails.splitlines():
            e = line.strip().lower()
            if e and '@' in e and e != current_user.email:
                eu = User.query.filter_by(email=e).first()
                db.session.add(MeetingInvite(
                    meeting_id=meeting.id,
                    user_id=eu.id if eu else None,
                    email=e,
                    name=eu.name if eu else ''
                ))

        db.session.commit()
        flash('Meeting created!', 'success')
        return redirect(url_for('meeting_view', meeting_id=meeting.id))

    return render_template('create_meeting.html')


# ─────────────────────────────────────────────
#  MEETING VIEW
# ─────────────────────────────────────────────

@app.route('/meeting/<int:meeting_id>')
@login_required
def meeting_view(meeting_id):
    meeting   = Meeting.query.get_or_404(meeting_id)
    is_creator = meeting.creator_id == current_user.id
    invite     = MeetingInvite.query.filter_by(
                     meeting_id=meeting_id, email=current_user.email).first()

    if not is_creator and not invite:
        flash('You are not invited to this meeting.', 'danger')
        return redirect(url_for('dashboard'))

    my_avail = Availability.query.filter_by(
        meeting_id=meeting_id, user_id=current_user.id).all()
    my_slots = [f"{a.date_or_day}_{a.time_slot}" for a in my_avail]

    all_avail = Availability.query.filter_by(meeting_id=meeting_id).all()
    slot_counts: dict = {}
    for a in all_avail:
        k = f"{a.date_or_day}_{a.time_slot}"
        slot_counts[k] = slot_counts.get(k, 0) + 1

    total_invited = len(meeting.invites)

    # Per-user data (creator only)
    participants = []
    if is_creator:
        for inv in meeting.invites:
            uid = inv.user_id
            if uid:
                ua = Availability.query.filter_by(meeting_id=meeting_id, user_id=uid).all()
                u  = User.query.get(uid)
                participants.append({
                    'email': inv.email,
                    'name':  u.name if u else inv.email,
                    'slot_count': len(ua),
                    'responded': inv.responded,
                    'slots': [f"{a.date_or_day}_{a.time_slot}" for a in ua]
                })
            else:
                participants.append({
                    'email': inv.email,
                    'name':  inv.email,
                    'slot_count': 0,
                    'responded': False,
                    'slots': []
                })

    return render_template('meeting.html',
        meeting=meeting,
        is_creator=is_creator,
        my_slots=my_slots,
        slot_counts=slot_counts,
        total_invited=total_invited,
        participants=participants,
        all_invites=meeting.invites
    )


# ─────────────────────────────────────────────
#  API – AVAILABILITY
# ─────────────────────────────────────────────

@app.route('/api/meeting/<int:meeting_id>/availability', methods=['POST'])
@login_required
def update_availability(meeting_id):
    meeting = Meeting.query.get_or_404(meeting_id)
    invite  = MeetingInvite.query.filter_by(
                  meeting_id=meeting_id, email=current_user.email).first()
    if meeting.creator_id != current_user.id and not invite:
        return jsonify({'error': 'Not authorized'}), 403

    data  = request.get_json()
    slots = data.get('slots', [])

    Availability.query.filter_by(meeting_id=meeting_id, user_id=current_user.id).delete()

    valid_dates = set(meeting.dates_list)
    valid_times = set(meeting.time_slots)

    for sk in slots:
        parts = sk.split('_', 1)
        if len(parts) == 2:
            dod, ts = parts
            if dod in valid_dates and ts in valid_times:
                db.session.add(Availability(
                    meeting_id=meeting_id, user_id=current_user.id,
                    date_or_day=dod, time_slot=ts
                ))

    if invite:
        invite.responded = True

    db.session.commit()

    # Recalculate counts
    slot_counts: dict = {}
    for a in Availability.query.filter_by(meeting_id=meeting_id).all():
        k = f"{a.date_or_day}_{a.time_slot}"
        slot_counts[k] = slot_counts.get(k, 0) + 1

    return jsonify({'success': True, 'slot_counts': slot_counts})


# ─────────────────────────────────────────────
#  API – FINALIZE
# ─────────────────────────────────────────────

@app.route('/api/meeting/<int:meeting_id>/finalize', methods=['POST'])
@login_required
def finalize_meeting(meeting_id):
    meeting = Meeting.query.get_or_404(meeting_id)
    if meeting.creator_id != current_user.id:
        return jsonify({'error': 'Not authorized'}), 403

    data = request.get_json()
    meeting.finalized_date   = data.get('date_or_day')
    meeting.finalized_slot   = data.get('time_slot')
    meeting.duration_minutes = int(data.get('duration_minutes', 60))
    meeting.note             = data.get('note', '')
    meeting.is_finalized     = True
    db.session.commit()
    return jsonify({'success': True})


@app.route('/api/meeting/<int:meeting_id>/unfinalize', methods=['POST'])
@login_required
def unfinalize_meeting(meeting_id):
    meeting = Meeting.query.get_or_404(meeting_id)
    if meeting.creator_id != current_user.id:
        return jsonify({'error': 'Not authorized'}), 403
    meeting.is_finalized   = False
    meeting.finalized_date = None
    meeting.finalized_slot = None
    db.session.commit()
    return jsonify({'success': True})


# ─────────────────────────────────────────────
#  CALENDAR DOWNLOAD
# ─────────────────────────────────────────────

@app.route('/meeting/<int:meeting_id>/calendar.ics')
@login_required
def download_calendar(meeting_id):
    meeting = Meeting.query.get_or_404(meeting_id)
    if not meeting.is_finalized:
        flash('Meeting has not been finalized yet.', 'warning')
        return redirect(url_for('meeting_view', meeting_id=meeting_id))

    invite     = MeetingInvite.query.filter_by(meeting_id=meeting_id,
                                               email=current_user.email).first()
    is_creator = meeting.creator_id == current_user.id
    if not is_creator and not invite:
        return redirect(url_for('dashboard'))

    if not HAS_ICAL:
        flash('icalendar library not installed. Run: pip install icalendar pytz', 'warning')
        return redirect(url_for('meeting_view', meeting_id=meeting_id))

    tz  = pytz.UTC
    cal = Calendar()
    cal.add('prodid', '-//Meeting Finder//EN')
    cal.add('version', '2.0')
    cal.add('method', 'REQUEST')

    ev = ICalEvent()
    ev.add('summary', meeting.title)
    ev.add('description', meeting.note or meeting.description)
    ev.add('uid', str(uuid.uuid4()))

    h, m = map(int, meeting.finalized_slot.split(':'))

    if meeting.meeting_type == 'specific_dates':
        yr, mo, dy = map(int, meeting.finalized_date.split('-'))
        start_dt   = datetime(yr, mo, dy, h, m, tzinfo=tz)
    else:
        day_map = {'Monday':0,'Tuesday':1,'Wednesday':2,'Thursday':3,
                   'Friday':4,'Saturday':5,'Sunday':6}
        target   = day_map.get(meeting.finalized_date, 0)
        today    = date.today()
        ahead    = (target - today.weekday()) % 7 or 7
        nd       = today + timedelta(days=ahead)
        start_dt = datetime(nd.year, nd.month, nd.day, h, m, tzinfo=tz)

    end_dt = start_dt + timedelta(minutes=meeting.duration_minutes)
    ev.add('dtstart', start_dt)
    ev.add('dtend',   end_dt)
    ev.add('dtstamp', datetime.now(tz))

    for inv in meeting.invites:
        ev.add('attendee', f'mailto:{inv.email}')

    cal.add_component(ev)

    resp = make_response(cal.to_ical())
    resp.headers['Content-Type']        = 'text/calendar; charset=utf-8'
    resp.headers['Content-Disposition'] = f'attachment; filename="{meeting.title}.ics"'
    return resp


# ─────────────────────────────────────────────
#  DELETE MEETING
# ─────────────────────────────────────────────

@app.route('/meeting/<int:meeting_id>/delete', methods=['POST'])
@login_required
def delete_meeting(meeting_id):
    meeting = Meeting.query.get_or_404(meeting_id)
    if meeting.creator_id != current_user.id:
        flash('Not authorized.', 'danger')
        return redirect(url_for('dashboard'))
    db.session.delete(meeting)
    db.session.commit()
    flash('Meeting deleted.', 'success')
    return redirect(url_for('dashboard'))


# ─────────────────────────────────────────────
#  BOOT
# ─────────────────────────────────────────────

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True, port=5000)
