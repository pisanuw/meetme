/**
 * meetings.mjs — CRUD operations for meeting records
 *
 * Routes handled:
 *   GET  /api/meetings              — list the caller's created and invited meetings
 *   POST /api/meetings              — create a new meeting (and send invitation emails)
 *   GET  /api/meetings/:id          — get full meeting detail including availability grid
 *   POST /api/meetings/:id/delete   — delete a meeting (creator only)
 *   POST /api/meetings/:id/leave    — remove yourself from a meeting (invitee only)
 *
 * Data model (Netlify Blobs):
 *   meetings:"m-<epoch>-<id>" — Meeting object (canonical key)
 *   meetings:<id>             — Legacy meeting object key (read-only compatibility)
 *   invites:"meeting:<id>"    — Invite[] for that meeting
 *   invites:"pending:<email>" — string[] of meeting IDs awaiting a not-yet-registered user
 *   availability:"meeting:<id>" — AvailabilitySlot[] (one entry per person per slot)
 *   email_records:<resend_id> — tracking record used by the bounce webhook
 */
import {
  getDb,
  getEnv,
  getUserFromRequest,
  jsonResponse,
  errorResponse,
  log,
  logRequest,
  safeJson,
  validateEmail,
  generateId,
  persistEvent,
  sendEmail,
  asArray,
  escapeHtml,
  buildTimeSlots,
  listMeetingIds,
  getMeetingRecord,
  saveMeetingRecord,
  deleteMeetingRecord,
  createToken,
  verifyMeetingToken,
  MEETING_TOKEN_KINDS,
  LIMITS,
} from "./utils.mjs";
import meetingActionsHandler from "./meeting-actions.mjs";

const FN = "meetings";
const ALLOWED_MEETING_TYPES = new Set(["specific_dates", "days_of_week"]);
const ALLOWED_DAY_NAMES = new Set([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

// Top-level Netlify Function entry point. Wraps everything in a try/catch so
// an unexpected exception always returns a clean JSON error instead of a
// platform-level 500 with no body.
export default async (req, context) => {
  try {
    return await handleRequest(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, "Internal server error.");
  }
};

async function handleRequest(req, _context) {
  logRequest(FN, req);

  // Require a valid session cookie for every endpoint in this function.
  const user = getUserFromRequest(req);
  if (!user) return errorResponse(401, "Not authenticated. Please sign in.");

  const url = new URL(req.url);
  const pathParts = url.pathname.replace("/api/meetings", "").split("/").filter(Boolean);

  // In local Netlify dev, overlapping function route patterns under /api/meetings
  // can dispatch action endpoints here instead of meeting-actions.mjs. Delegate
  // those subroutes explicitly so availability/finalize flows behave the same
  // in every environment.
  if (
    req.method === "POST" &&
    pathParts.length === 2 &&
    new Set(["availability", "finalize", "unfinalize", "remind-pending"]).has(pathParts[1])
  ) {
    return meetingActionsHandler(req, _context);
  }

  const meetings = getDb("meetings");
  const invites = getDb("invites");
  const availability = getDb("availability");

  // POST /api/meetings/claim ────────────────────────────────────────────────
  // Logged-in user is visiting a meeting via a shared participation/admin URL
  // (anonymous flow) and wants to associate it with their account.
  //
  //   • participation token → add user as a participant on the meeting.
  //   • admin token → transfer ownership to the user (creator_id = user.id),
  //     also add them as a participant. Per product decision, the admin
  //     token remains valid afterwards (convenient backup).
  //
  // In both cases, if the browser is also carrying an anonymous participant_id
  // for this meeting, migrate that identity to the user's account so their
  // previously-submitted availability is preserved under their name.
  if (req.method === "POST" && pathParts.length === 1 && pathParts[0] === "claim") {
    const body = await safeJson(req);
    if (body === null) return errorResponse(400, "Request body must be valid JSON.");

    const payload = verifyMeetingToken(body.t || "");
    if (!payload) return errorResponse(401, "Invalid or expired meeting token.");

    const meetingId = payload.meeting_id;
    const meeting = await getMeetingRecord(meetings, meetingId);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);

    const isAdminClaim = payload.kind === MEETING_TOKEN_KINDS.ADMIN;
    const anonParticipantId =
      typeof body.participant_id === "string" ? body.participant_id.trim() : "";

    let meetingInvites = asArray(
      await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );
    let allAvail = asArray(
      await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );

    const userEmail = (user.email || "").toLowerCase();
    const alreadyInvite = meetingInvites.find(
      (i) => i.user_id === user.id || (i.email || "").toLowerCase() === userEmail
    );

    // Migrate any anonymous participant record this browser owns into the
    // user's invite / availability rows. Only allowed if the token matches
    // the meeting the participant_id belongs to (already checked above) and
    // the participant_id actually exists on this meeting.
    if (anonParticipantId) {
      const anonInvite = meetingInvites.find((i) => i.user_id === anonParticipantId);
      if (anonInvite) {
        meetingInvites = meetingInvites.filter((i) => i.user_id !== anonParticipantId);
        allAvail = allAvail.map((a) =>
          a.user_id === anonParticipantId ? { ...a, user_id: user.id } : a
        );
        if (alreadyInvite) {
          // Merge name/responded flag back into the existing invite.
          meetingInvites = meetingInvites.map((i) =>
            i.user_id === user.id || (i.email || "").toLowerCase() === userEmail
              ? {
                  ...i,
                  user_id: user.id,
                  email: user.email,
                  name: i.name || anonInvite.name,
                  responded: i.responded || anonInvite.responded,
                }
              : i
          );
        } else {
          meetingInvites = [
            ...meetingInvites,
            {
              id: generateId(),
              meeting_id: meetingId,
              user_id: user.id,
              email: user.email,
              name: anonInvite.name || user.name,
              responded: anonInvite.responded === true,
              added_via_shared_link: true,
              added_at: new Date().toISOString(),
            },
          ];
        }
      }
    } else if (!alreadyInvite) {
      meetingInvites = [
        ...meetingInvites,
        {
          id: generateId(),
          meeting_id: meetingId,
          user_id: user.id,
          email: user.email,
          name: user.name,
          responded: false,
          added_via_shared_link: true,
          added_at: new Date().toISOString(),
        },
      ];
    } else if (!alreadyInvite.user_id) {
      // Pending invite by email (no user_id yet) → link to user.
      meetingInvites = meetingInvites.map((i) =>
        i === alreadyInvite ? { ...i, user_id: user.id, name: i.name || user.name } : i
      );
    }

    if (isAdminClaim) {
      meeting.creator_id = user.id;
      meeting.creator_name = user.name || meeting.creator_name;
      meeting.anonymous = false;
      meeting.last_activity_at = new Date().toISOString();
      await saveMeetingRecord(meetings, meeting);
    } else {
      meeting.last_activity_at = new Date().toISOString();
      await saveMeetingRecord(meetings, meeting);
    }

    await invites.setJSON(`meeting:${meetingId}`, meetingInvites);
    await availability.setJSON(`meeting:${meetingId}`, allAvail);

    log("info", FN, "meeting claimed", {
      meetingId,
      userId: user.id,
      role: isAdminClaim ? "owner" : "participant",
    });
    await persistEvent("info", FN, "meeting claimed", {
      meeting_id: meetingId,
      user_email: user.email,
      role: isAdminClaim ? "owner" : "participant",
    });
    return jsonResponse(200, {
      success: true,
      meeting_id: meetingId,
      role: isAdminClaim ? "owner" : "participant",
    });
  }

  // GET /api/meetings - list dashboard data
  if (req.method === "GET" && pathParts.length === 0) {
    const meetingIds = await listMeetingIds(meetings);
    const userEmail = (user.email || "").toLowerCase();

    const records = await Promise.all(
      meetingIds.map(async (meetingId) => {
        const [meeting, meetingInvites] = await Promise.all([
          getMeetingRecord(meetings, meetingId),
          invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []),
        ]);
        if (!meeting) return null;
        return { meeting, meetingInvites: asArray(meetingInvites) };
      })
    );

    const myMeetings = [];
    const invitedMeetings = [];

    for (const record of records) {
      if (!record) continue;
      const { meeting, meetingInvites } = record;
      const respondCount = meetingInvites.filter((i) => i.responded).length;
      const inviteCount = meetingInvites.length;

      const myInvite = meetingInvites.find((i) => (i.email || "").toLowerCase() === userEmail);
      const summary = {
        ...meeting,
        respond_count: respondCount,
        invite_count: inviteCount,
      };

      if (meeting.creator_id === user.id) {
        myMeetings.push(summary);
      } else if (myInvite) {
        invitedMeetings.push({ ...summary, user_has_responded: myInvite.responded === true });
      }
    }

    myMeetings.sort((a, b) => b.created_at.localeCompare(a.created_at));
    invitedMeetings.sort((a, b) => b.created_at.localeCompare(a.created_at));

    return jsonResponse(200, { my_meetings: myMeetings, invited_meetings: invitedMeetings });
  }

  // POST /api/meetings - create meeting
  if (req.method === "POST" && pathParts.length === 0) {
    const body = await safeJson(req);
    if (body === null) return errorResponse(400, "Request body must be valid JSON.");
    const {
      title,
      description,
      meeting_type,
      dates_or_days,
      start_time,
      end_time,
      invite_emails,
      timezone,
    } = body;

    const normalizedTitle = String(title || "").trim();
    const normalizedDescription = String(description || "").trim();
    const normalizedMeetingType = String(meeting_type || "specific_dates").trim();
    const normalizedDatesOrDays = [
      ...new Set(
        asArray(dates_or_days)
          .map((v) => String(v || "").trim())
          .filter(Boolean)
      ),
    ];
    const creatorEmail = (user.email || "").toLowerCase();

    if (!normalizedTitle) return errorResponse(400, "Meeting title is required.");
    if (normalizedTitle.length > LIMITS.TITLE_MAX) {
      return errorResponse(400, `Meeting title must be ${LIMITS.TITLE_MAX} characters or fewer.`);
    }
    if (normalizedDescription.length > LIMITS.DESCRIPTION_MAX) {
      return errorResponse(
        400,
        `Description must be ${LIMITS.DESCRIPTION_MAX} characters or fewer.`
      );
    }
    if (!ALLOWED_MEETING_TYPES.has(normalizedMeetingType)) {
      return errorResponse(400, "meeting_type must be either 'specific_dates' or 'days_of_week'.");
    }
    if (normalizedDatesOrDays.length === 0)
      return errorResponse(400, "Select at least one date or day.");
    if (normalizedMeetingType === "specific_dates") {
      const invalidDate = normalizedDatesOrDays.find((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
      if (invalidDate)
        return errorResponse(400, `Invalid date value '${invalidDate}'. Expected YYYY-MM-DD.`);
    } else {
      const invalidDay = normalizedDatesOrDays.find((d) => !ALLOWED_DAY_NAMES.has(d));
      if (invalidDay) return errorResponse(400, `Invalid day value '${invalidDay}'.`);
    }

    const timeRe = /^\d{2}:\d{2}$/;
    if (start_time && !timeRe.test(start_time))
      return errorResponse(400, "start_time must be in HH:MM format.");
    if (end_time && !timeRe.test(end_time))
      return errorResponse(400, "end_time must be in HH:MM format.");
    if (start_time && end_time && start_time >= end_time)
      return errorResponse(400, "end_time must be after start_time.");

    const normalizedTimezone = String(timezone || "UTC").trim();
    const validTimezones = new Set(Intl.supportedValuesOf("timeZone"));
    if (normalizedTimezone !== "UTC" && !validTimezones.has(normalizedTimezone)) {
      return errorResponse(400, "Invalid timezone value.");
    }

    log("info", FN, "creating meeting", { title: normalizedTitle, creator: user.email });

    const meetingId = generateId();
    const meeting = {
      id: meetingId,
      title: normalizedTitle,
      description: normalizedDescription,
      creator_id: user.id,
      creator_name: user.name,
      meeting_type: normalizedMeetingType,
      dates_or_days: normalizedDatesOrDays,
      start_time: start_time || "08:00",
      end_time: end_time || "20:00",
      timezone: normalizedTimezone,
      duration_minutes: 60,
      finalized_date: null,
      finalized_slot: null,
      note: "",
      is_finalized: false,
      created_at: new Date().toISOString(),
    };

    await saveMeetingRecord(meetings, meeting);

    const meetingInvites = [
      {
        id: generateId(),
        meeting_id: meetingId,
        user_id: user.id,
        email: user.email,
        name: user.name,
        responded: false,
      },
    ];

    if (invite_emails) {
      const rawInviteEmails = Array.isArray(invite_emails)
        ? invite_emails.join(",")
        : String(invite_emails);
      const rawEmails = rawInviteEmails.split(/[\n,]+/);
      const emails = [
        ...new Set(rawEmails.map((e) => validateEmail(e)).filter((e) => e && e !== creatorEmail)),
      ];
      if (emails.length > LIMITS.MAX_INVITEES) {
        return errorResponse(
          400,
          `You can invite at most ${LIMITS.MAX_INVITEES} people to one meeting.`
        );
      }
      const users = getDb("users");
      for (const email of emails) {
        const existingUser = await users.get(email, { type: "json" }).catch(() => null);
        meetingInvites.push({
          id: generateId(),
          meeting_id: meetingId,
          user_id: existingUser ? existingUser.id : null,
          email,
          name: existingUser ? existingUser.name : "",
          responded: false,
        });

        if (!existingUser) {
          const pending = asArray(
            await invites.get(`pending:${email}`, { type: "json" }).catch(() => [])
          );
          const nextPending = pending.includes(meetingId) ? pending : [...pending, meetingId];
          await invites.setJSON(`pending:${email}`, nextPending);
        }
      }
    }

    await invites.setJSON(`meeting:${meetingId}`, meetingInvites);

    // ── Send invitation emails ─────────────────────────────────────────────
    // Send to invitees only (never the meeting creator).
    // We store a tracking record keyed by the Resend email ID so the bounce
    // webhook (webhooks.mjs) can look up which meeting was affected and
    // notify the creator.
    const appUrl = getEnv("APP_URL", new URL(req.url).origin);
    const meetingUrl = `${appUrl}/meeting.html?id=${encodeURIComponent(meetingId)}`;
    const emailTracker = getDb("email_records");

    const typeLabel = (meeting.meeting_type || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const datesText = Array.isArray(meeting.dates_or_days) ? meeting.dates_or_days.join(", ") : "";
    const timeRange = `${meeting.start_time || "08:00"} – ${meeting.end_time || "20:00"}${meeting.timezone ? ` (${meeting.timezone})` : ""}`;

    const inviteesOnly = meetingInvites.filter(
      (inv) => (inv.email || "").toLowerCase() !== creatorEmail
    );
    const invite_results = [];
    for (const inv of inviteesOnly) {
      const preferencesToken = createToken(
        {
          id: "email-preferences",
          purpose: "email_preferences",
          email: inv.email,
          organizer_email: user.email,
          meeting_id: meetingId,
          jti: generateId(),
        },
        "365d"
      );
      const globalOptOutUrl = `${appUrl}/api/email-preferences/confirm?token=${encodeURIComponent(preferencesToken)}&action=global_opt_out`;
      const blockOrganizerUrl = `${appUrl}/api/email-preferences/confirm?token=${encodeURIComponent(preferencesToken)}&action=block_organizer`;

      const inviteSubject = `You've been invited to share availability: ${meeting.title}`;
      // Build the email body. escapeHtml() prevents XSS if any user-supplied
      // text (title, name, description) were rendered in an HTML context.
      const inviteHtml = `
        <p>Hello${inv.name ? ` ${inv.name}` : ""},</p>
        <p><strong>${escapeHtml(user.name || user.email)}</strong> has invited you to coordinate a meeting:</p>
        <table cellpadding="0" cellspacing="0" style="margin:16px 0;font-size:14px;">
          <tr><th align="left" style="padding:4px 16px 4px 0;color:#555;white-space:nowrap;">Meeting</th>
              <td>${escapeHtml(meeting.title)}</td></tr>
          ${meeting.description ? `<tr><th align="left" style="padding:4px 16px 4px 0;color:#555;">Description</th><td>${escapeHtml(meeting.description)}</td></tr>` : ""}
          <tr><th align="left" style="padding:4px 16px 4px 0;color:#555;white-space:nowrap;">Type</th>
              <td>${escapeHtml(typeLabel)}</td></tr>
          <tr><th align="left" style="padding:4px 16px 4px 0;color:#555;white-space:nowrap;">${meeting.meeting_type === "days_of_week" ? "Days" : "Dates"}</th>
              <td>${escapeHtml(datesText)}</td></tr>
          <tr><th align="left" style="padding:4px 16px 4px 0;color:#555;white-space:nowrap;">Time range</th>
              <td>${escapeHtml(timeRange)}</td></tr>
        </table>
        <p>
          <a href="${meetingUrl}" style="display:inline-block;background:#1a73e8;color:white;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">
            Open meeting &amp; set availability
          </a>
        </p>
        <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb" />
        <p style="color:#666;font-size:12px;line-height:1.5;">
          Email preferences:<br />
          <a href="${globalOptOutUrl}">Never receive any MeetMe emails again</a><br />
          <a href="${blockOrganizerUrl}">Stop receiving meeting emails from ${escapeHtml(user.name || user.email)}</a>
        </p>
        <p style="color:#888;font-size:12px;">If you weren't expecting this, you can ignore this email.</p>
      `;

      const inviteText = `${user.name || user.email} invited you to coordinate a meeting: "${meeting.title}".\n\nDates/days: ${datesText}\nTime range: ${timeRange}\n\nOpen the meeting and set your availability:\n${meetingUrl}\n\nEmail preferences:\n- Never receive any MeetMe emails again: ${globalOptOutUrl}\n- Stop receiving meeting emails from ${user.name || user.email}: ${blockOrganizerUrl}`;

      const result = await sendEmail({
        to: inv.email,
        subject: inviteSubject,
        html: inviteHtml,
        text: inviteText,
        suppression: {
          category: "meeting",
          organizerEmail: user.email,
        },
        tags: [
          { name: "type", value: "invite" },
          { name: "meeting_id", value: meetingId },
        ],
      });

      invite_results.push({ email: inv.email, ok: result.ok, error: result.error });

      if (result.ok && result.emailId) {
        // Store tracking record keyed by Resend email ID for bounce correlation
        await emailTracker
          .setJSON(result.emailId, {
            meeting_id: meetingId,
            meeting_title: meeting.title,
            creator_email: user.email,
            creator_name: user.name,
            invitee_email: inv.email,
            sent_at: new Date().toISOString(),
          })
          .catch(() => null);
      }

      if (!result.ok) {
        log("warn", FN, "invite email failed", { to: inv.email, meetingId, error: result.error });
      }
    }

    const failedInvites = invite_results.filter((r) => !r.ok);
    log("info", FN, "meeting created", {
      meetingId,
      inviteCount: meetingInvites.length - 1,
      emailsFailed: failedInvites.length,
    });
    await persistEvent("info", FN, "meeting created", {
      creator_email: user.email,
      creator_name: user.name || user.email,
      meeting_id: meetingId,
      meeting_name: normalizedTitle,
    });
    return jsonResponse(200, {
      success: true,
      meeting_id: meetingId,
      invite_results,
      email_failures: failedInvites.map((r) => r.email),
    });
  }

  // GET /api/meetings/:id - get meeting detail
  if (req.method === "GET" && pathParts.length === 1) {
    const meetingId = pathParts[0];
    log("info", FN, "get meeting detail", { meetingId, userId: user.id });

    const meeting = await getMeetingRecord(meetings, meetingId);
    if (!meeting) {
      log("warn", FN, "meeting not found", { meetingId });
      return errorResponse(404, `Meeting '${meetingId}' not found.`);
    }

    let meetingInvites = asArray(
      await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );
    const isCreator = meeting.creator_id === user.id;
    let invite = meetingInvites.find((i) => i.email === user.email);

    if (!isCreator && !invite) {
      const newInvite = {
        id: generateId(),
        meeting_id: meetingId,
        user_id: user.id,
        email: user.email,
        name: user.name,
        responded: false,
        added_via_shared_link: true,
        added_at: new Date().toISOString(),
      };
      meetingInvites = [...meetingInvites, newInvite];
      await invites.setJSON(`meeting:${meetingId}`, meetingInvites);
      invite = newInvite;

      log("info", FN, "participant added via shared link", {
        meetingId,
        email: user.email,
        addedBy: "shared-link",
      });
      await persistEvent("info", FN, "participant added via shared link", {
        meetingId,
        email: user.email,
      });
    }

    const allAvail = asArray(
      await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );

    // Pull out only this user's selected slots for pre-populating the editor.
    const myAvail = allAvail.filter((a) => a.user_id === user.id);
    const mySlots = myAvail.map((a) => `${a.date_or_day}_${a.time_slot}`);

    // Aggregate slot counts across all participants to power the heatmap grid.
    const slotCounts = {};
    for (const a of allAvail) {
      const k = `${a.date_or_day}_${a.time_slot}`;
      slotCounts[k] = (slotCounts[k] || 0) + 1;
    }

    // Build the ordered list of 15-minute time slots between the meeting's
    // start and end times. The front-end uses this to render column headers.
    const timeSlots = buildTimeSlots(meeting.start_time, meeting.end_time);

    // Build the participants list for the "By person" panel.
    // We re-read the user record to pick up any name changes since the invite
    // was created. Email addresses are only sent to the creator to avoid
    // exposing participant contact details to other attendees.
    const usersDb = getDb("users");
    const participants = [];
    for (const inv of meetingInvites) {
      const ua = allAvail.filter((a) => a.user_id === inv.user_id);
      let pName = inv.name || inv.email;
      if (inv.user_id) {
        const u = await usersDb.get(inv.email, { type: "json" }).catch(() => null);
        if (u) pName = u.name;
      }
      const entry = {
        name: pName,
        slot_count: ua.length,
        responded: inv.responded,
        slots: ua.map((a) => `${a.date_or_day}_${a.time_slot}`),
      };
      if (isCreator) entry.email = inv.email;
      participants.push(entry);
    }

    return jsonResponse(200, {
      meeting,
      is_creator: isCreator,
      my_slots: mySlots,
      slot_counts: slotCounts,
      total_invited: meetingInvites.length,
      participants,
      time_slots: timeSlots,
      all_invites: isCreator
        ? meetingInvites
        : meetingInvites.map(({ email: _email, ...rest }) => rest),
      respond_count: meetingInvites.filter((i) => i.responded).length,
      invite_count: meetingInvites.length,
    });
  }

  // POST /api/meetings/:id/delete
  if (req.method === "POST" && pathParts.length === 2 && pathParts[1] === "delete") {
    const meetingId = pathParts[0];
    log("info", FN, "delete meeting", { meetingId, userId: user.id });

    const meeting = await getMeetingRecord(meetings, meetingId);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);
    if (meeting.creator_id !== user.id)
      return errorResponse(403, "Only the meeting creator can delete it.");

    const meetingInvites = asArray(
      await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );
    for (const inv of meetingInvites) {
      if (!inv?.email || inv.user_id) continue;
      const pendingKey = `pending:${String(inv.email).toLowerCase()}`;
      const pending = asArray(await invites.get(pendingKey, { type: "json" }).catch(() => []));
      const nextPending = pending.filter((id) => id !== meetingId);
      if (nextPending.length > 0) await invites.setJSON(pendingKey, nextPending);
      else await invites.delete(pendingKey).catch(() => null);
    }

    await deleteMeetingRecord(meetings, meetingId);
    await invites.delete(`meeting:${meetingId}`);
    await availability.delete(`meeting:${meetingId}`);

    log("info", FN, "meeting deleted", { meetingId });
    await persistEvent("warn", FN, "meeting deleted", { deletedBy: user.email, meetingId });
    return jsonResponse(200, { success: true });
  }

  // POST /api/meetings/:id/leave
  if (req.method === "POST" && pathParts.length === 2 && pathParts[1] === "leave") {
    const meetingId = pathParts[0];
    log("info", FN, "leave meeting", { meetingId, userId: user.id });

    const meeting = await getMeetingRecord(meetings, meetingId);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);
    if (meeting.creator_id === user.id)
      return errorResponse(
        403,
        "Meeting creators cannot leave their own meeting. Use delete instead."
      );

    const meetingInvites = asArray(
      await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );
    const userEmail = user.email.toLowerCase();
    const isInvited = meetingInvites.some((i) => (i.email || "").toLowerCase() === userEmail);
    if (!isInvited) return errorResponse(403, "You are not an invitee of this meeting.");

    // Remove the user's invite entry
    const updatedInvites = meetingInvites.filter(
      (i) => (i.email || "").toLowerCase() !== userEmail
    );
    await invites.setJSON(`meeting:${meetingId}`, updatedInvites);

    // Also remove the user's availability entries for this meeting
    const allAvail = asArray(
      await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );
    const updatedAvail = allAvail.filter((a) => a.user_id !== user.id);
    await availability.setJSON(`meeting:${meetingId}`, updatedAvail);

    log("info", FN, "user left meeting", { meetingId, userId: user.id });
    await persistEvent("info", FN, "user left meeting", { meetingId, email: user.email });
    return jsonResponse(200, { success: true });
  }

  log("warn", FN, "unmatched route", { method: req.method, pathParts });
  return errorResponse(404, `Route not found.`);
}

export const config = {
  path: ["/api/meetings", "/api/meetings/*"],
};
