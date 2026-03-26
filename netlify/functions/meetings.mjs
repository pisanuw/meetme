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
 *   meetings:"index"          — string[] of all meeting IDs
 *   meetings:<id>             — Meeting object
 *   invites:"meeting:<id>"    — Invite[] for that meeting
 *   invites:"pending:<email>" — string[] of meeting IDs awaiting a not-yet-registered user
 *   availability:"meeting:<id>" — AvailabilitySlot[] (one entry per person per slot)
 *   email_records:<resend_id> — tracking record used by the bounce webhook
 */
import {
  getDb, getEnv, getUserFromRequest, jsonResponse, errorResponse,
  log, logRequest, safeJson, validateEmail, generateId,
  persistEvent, sendEmail, asArray, escapeHtml,
} from "./utils.mjs";

const FN = "meetings";

// Top-level Netlify Function entry point. Wraps everything in a try/catch so
// an unexpected exception always returns a clean JSON error instead of a
// platform-level 500 with no body.
export default async (req, context) => {
  try {
    return await handleRequest(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, `Internal server error: ${err.message}`);
  }
};

async function handleRequest(req, context) {
  logRequest(FN, req);

  // Require a valid session cookie for every endpoint in this function.
  const user = getUserFromRequest(req);
  if (!user) return errorResponse(401, "Not authenticated. Please sign in.");

  const url = new URL(req.url);
  const pathParts = url.pathname.replace("/api/meetings", "").split("/").filter(Boolean);

  const meetings = getDb("meetings");
  const invites = getDb("invites");
  const availability = getDb("availability");

  // GET /api/meetings - list dashboard data
  if (req.method === "GET" && pathParts.length === 0) {
    // Defensively read the index: if the blob is absent or malformed,
    // treat it as an empty list. asArray() handles both cases cleanly.
    const rawIndexData = await meetings.get("index", { type: "json" }).catch(() => []);
    if (!Array.isArray(rawIndexData)) {
      log("warn", FN, "meetings index is malformed; expected array", { type: typeof rawIndexData });
    }
    const indexData = asArray(rawIndexData);

    const myMeetings = [];
    const invitedMeetings = [];

    for (const meetingId of indexData) {
      const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
      if (!meeting) continue;

      const meetingInvites = asArray(await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []));
      const respondCount = meetingInvites.filter(i => i.responded).length;
      const inviteCount = meetingInvites.length;

      const summary = {
        ...meeting,
        respond_count: respondCount,
        invite_count: inviteCount,
      };

      if (meeting.creator_id === user.id) {
        myMeetings.push(summary);
      } else if (meetingInvites.some(i => (i.email || '').toLowerCase() === user.email.toLowerCase())) {
        invitedMeetings.push(summary);
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
    const { title, description, meeting_type, dates_or_days, start_time, end_time, invite_emails, timezone } = body;

    if (!title || !title.trim()) return errorResponse(400, "Meeting title is required.");
    if (!dates_or_days || dates_or_days.length === 0) return errorResponse(400, "Select at least one date or day.");

    const timeRe = /^\d{2}:\d{2}$/;
    if (start_time && !timeRe.test(start_time)) return errorResponse(400, "start_time must be in HH:MM format.");
    if (end_time && !timeRe.test(end_time)) return errorResponse(400, "end_time must be in HH:MM format.");
    if (start_time && end_time && start_time >= end_time) return errorResponse(400, "end_time must be after start_time.");

    log("info", FN, "creating meeting", { title, creator: user.email });

    const meetingId = generateId();
    const meeting = {
      id: meetingId,
      title,
      description: description || "",
      creator_id: user.id,
      creator_name: user.name,
      meeting_type: meeting_type || "specific_dates",
      dates_or_days,
      start_time: start_time || "08:00",
      end_time: end_time || "20:00",
      timezone: timezone || "UTC",
      duration_minutes: 60,
      finalized_date: null,
      finalized_slot: null,
      note: "",
      is_finalized: false,
      created_at: new Date().toISOString(),
    };

    await meetings.setJSON(meetingId, meeting);

    const indexData = asArray(await meetings.get("index", { type: "json" }).catch(() => []));
    indexData.push(meetingId);
    await meetings.setJSON("index", indexData);

    const meetingInvites = [{
      id: generateId(),
      meeting_id: meetingId,
      user_id: user.id,
      email: user.email,
      name: user.name,
      responded: false,
    }];

    if (invite_emails) {
      const rawEmails = invite_emails.split(/[\n,]+/);
      const emails = rawEmails.map(e => validateEmail(e)).filter(e => e && e !== user.email);
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
          const pending = asArray(await invites.get(`pending:${email}`, { type: "json" }).catch(() => []));
          pending.push(meetingId);
          await invites.setJSON(`pending:${email}`, pending);
        }
      }
    }

    await invites.setJSON(`meeting:${meetingId}`, meetingInvites);

    // ── Send invitation emails ─────────────────────────────────────────────
    // For each invitee (including the creator), send an HTML invitation email.
    // We store a tracking record keyed by the Resend email ID so the bounce
    // webhook (webhooks.mjs) can look up which meeting was affected and
    // notify the creator.
    const appUrl = getEnv("APP_URL", new URL(req.url).origin);
    const meetingUrl = `${appUrl}/meeting.html?id=${encodeURIComponent(meetingId)}`;
    const emailTracker = getDb("email_records");

    const typeLabel = (meeting.meeting_type || "").replace("_", " ").replace(/\b\w/g, c => c.toUpperCase());
    const datesText = Array.isArray(meeting.dates_or_days) ? meeting.dates_or_days.join(", ") : "";
    const timeRange = `${meeting.start_time || "08:00"} – ${meeting.end_time || "20:00"}${meeting.timezone ? ` (${meeting.timezone})` : ""}`;

    const invite_results = [];
    for (const inv of meetingInvites) {
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
        <p style="color:#888;font-size:12px;">If you weren't expecting this, you can ignore this email.</p>
      `;

      const inviteText = `${user.name || user.email} invited you to coordinate a meeting: "${meeting.title}".\n\nDates/days: ${datesText}\nTime range: ${timeRange}\n\nOpen the meeting and set your availability:\n${meetingUrl}`;

      const result = await sendEmail({
        to: inv.email,
        subject: inviteSubject,
        html: inviteHtml,
        text: inviteText,
        tags: [
          { name: "type", value: "invite" },
          { name: "meeting_id", value: meetingId },
        ],
      });

      invite_results.push({ email: inv.email, ok: result.ok, error: result.error });

      if (result.ok && result.emailId) {
        // Store tracking record keyed by Resend email ID for bounce correlation
        await emailTracker.setJSON(result.emailId, {
          meeting_id: meetingId,
          meeting_title: meeting.title,
          creator_email: user.email,
          creator_name: user.name,
          invitee_email: inv.email,
          sent_at: new Date().toISOString(),
        }).catch(() => null);
      }

      if (!result.ok) {
        log("warn", FN, "invite email failed", { to: inv.email, meetingId, error: result.error });
      }
    }

    const failedInvites = invite_results.filter(r => !r.ok);
    log("info", FN, "meeting created", { meetingId, inviteCount: meetingInvites.length - 1, emailsFailed: failedInvites.length });
    await persistEvent("info", FN, "meeting created", {
      creator_email: user.email,
      creator_name: user.name || user.email,
      meeting_id: meetingId,
      meeting_name: title,
    });
    return jsonResponse(200, {
      success: true,
      meeting_id: meetingId,
      invite_results,
      email_failures: failedInvites.map(r => r.email),
    });
  }

  // GET /api/meetings/:id - get meeting detail
  if (req.method === "GET" && pathParts.length === 1) {
    const meetingId = pathParts[0];
    log("info", FN, "get meeting detail", { meetingId, userId: user.id });

    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) {
      log("warn", FN, "meeting not found", { meetingId });
      return errorResponse(404, `Meeting '${meetingId}' not found.`);
    }

    let meetingInvites = asArray(await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []));
    const isCreator = meeting.creator_id === user.id;
    let invite = meetingInvites.find(i => i.email === user.email);

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

    const allAvail = asArray(await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []));

    // Pull out only this user's selected slots for pre-populating the editor.
    const myAvail = allAvail.filter(a => a.user_id === user.id);
    const mySlots = myAvail.map(a => `${a.date_or_day}_${a.time_slot}`);

    // Aggregate slot counts across all participants to power the heatmap grid.
    const slotCounts = {};
    for (const a of allAvail) {
      const k = `${a.date_or_day}_${a.time_slot}`;
      slotCounts[k] = (slotCounts[k] || 0) + 1;
    }

    // Build the ordered list of 15-minute time slots between the meeting's
    // start and end times. The front-end uses this to render column headers.
    const timeSlots = [];
    const [sh, sm] = meeting.start_time.split(":").map(Number);
    const [eh, em] = meeting.end_time.split(":").map(Number);
    let cur = sh * 60 + sm;
    const end = eh * 60 + em;
    while (cur < end) {
      timeSlots.push(`${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`);
      cur += 15;
    }

    // Build the participants list for the "By person" panel.
    // We re-read the user record to pick up any name changes since the invite
    // was created. Email addresses are only sent to the creator to avoid
    // exposing participant contact details to other attendees.
    const usersDb = getDb("users");
    const participants = [];
    for (const inv of meetingInvites) {
      const ua = allAvail.filter(a => a.user_id === inv.user_id);
      let pName = inv.name || inv.email;
      if (inv.user_id) {
        const u = await usersDb.get(inv.email, { type: "json" }).catch(() => null);
        if (u) pName = u.name;
      }
      const entry = {
        name: pName,
        slot_count: ua.length,
        responded: inv.responded,
        slots: ua.map(a => `${a.date_or_day}_${a.time_slot}`),
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
      all_invites: meetingInvites,
      respond_count: meetingInvites.filter(i => i.responded).length,
      invite_count: meetingInvites.length,
    });
  }

  // POST /api/meetings/:id/delete
  if (req.method === "POST" && pathParts.length === 2 && pathParts[1] === "delete") {
    const meetingId = pathParts[0];
    log("info", FN, "delete meeting", { meetingId, userId: user.id });

    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);
    if (meeting.creator_id !== user.id) return errorResponse(403, "Only the meeting creator can delete it.");

    await meetings.delete(meetingId);
    await invites.delete(`meeting:${meetingId}`);
    await availability.delete(`meeting:${meetingId}`);

    const indexData = asArray(await meetings.get("index", { type: "json" }).catch(() => []));
    const newIndex = indexData.filter(id => id !== meetingId);
    await meetings.setJSON("index", newIndex);

    log("info", FN, "meeting deleted", { meetingId });
    await persistEvent("warn", FN, "meeting deleted", { deletedBy: user.email, meetingId });
    return jsonResponse(200, { success: true });
  }

  // POST /api/meetings/:id/leave
  if (req.method === "POST" && pathParts.length === 2 && pathParts[1] === "leave") {
    const meetingId = pathParts[0];
    log("info", FN, "leave meeting", { meetingId, userId: user.id });

    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);
    if (meeting.creator_id === user.id) return errorResponse(403, "Meeting creators cannot leave their own meeting. Use delete instead.");

    const meetingInvites = asArray(await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []));
    const userEmail = user.email.toLowerCase();
    const isInvited = meetingInvites.some(i => (i.email || '').toLowerCase() === userEmail);
    if (!isInvited) return errorResponse(403, "You are not an invitee of this meeting.");

    // Remove the user's invite entry
    const updatedInvites = meetingInvites.filter(i => (i.email || '').toLowerCase() !== userEmail);
    await invites.setJSON(`meeting:${meetingId}`, updatedInvites);

    // Also remove the user's availability entries for this meeting
    const allAvail = asArray(await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []));
    const updatedAvail = allAvail.filter(a => a.user_id !== user.id);
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
