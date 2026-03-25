import { getDb, getUserFromRequest, jsonResponse, errorResponse, log, logRequest, safeJson, validateEmail, generateId, persistEvent } from "./utils.mjs";

const FN = "meetings";

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

  const asArray = (value) => Array.isArray(value) ? value : [];

  const user = getUserFromRequest(req);
  if (!user) return errorResponse(401, "Not authenticated. Please sign in.");

  const url = new URL(req.url);
  const pathParts = url.pathname.replace("/api/meetings", "").split("/").filter(Boolean);

  const meetings = getDb("meetings");
  const invites = getDb("invites");
  const availability = getDb("availability");

  // GET /api/meetings - list dashboard data
  if (req.method === "GET" && pathParts.length === 0) {
    const rawIndexData = await meetings.get("index", { type: "json" }).catch(() => []);
    const indexData = asArray(rawIndexData);
    if (!Array.isArray(rawIndexData)) {
      log("warn", FN, "meetings index is malformed; expected array", { type: typeof rawIndexData });
    }

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
      } else if (meetingInvites.some(i => i.email === user.email)) {
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

    log("info", FN, "meeting created", { meetingId, inviteCount: meetingInvites.length - 1 });
    await persistEvent("info", FN, "meeting created", { creator: user.email, meetingId, title });
    return jsonResponse(200, { success: true, meeting_id: meetingId });
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
    const myAvail = allAvail.filter(a => a.user_id === user.id);
    const mySlots = myAvail.map(a => `${a.date_or_day}_${a.time_slot}`);

    const slotCounts = {};
    for (const a of allAvail) {
      const k = `${a.date_or_day}_${a.time_slot}`;
      slotCounts[k] = (slotCounts[k] || 0) + 1;
    }

    const timeSlots = [];
    const [sh, sm] = meeting.start_time.split(":").map(Number);
    const [eh, em] = meeting.end_time.split(":").map(Number);
    let cur = sh * 60 + sm;
    const end = eh * 60 + em;
    while (cur < end) {
      timeSlots.push(`${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`);
      cur += 30;
    }

    let participants = [];
    if (isCreator) {
      const usersDb = getDb("users");
      for (const inv of meetingInvites) {
        const ua = allAvail.filter(a => a.user_id === inv.user_id);
        let pName = inv.name || inv.email;
        if (inv.user_id) {
          const u = await usersDb.get(inv.email, { type: "json" }).catch(() => null);
          if (u) pName = u.name;
        }
        participants.push({
          email: inv.email,
          name: pName,
          slot_count: ua.length,
          responded: inv.responded,
          slots: ua.map(a => `${a.date_or_day}_${a.time_slot}`),
        });
      }
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

  log("warn", FN, "unmatched route", { method: req.method, pathParts });
  return errorResponse(404, `Route not found.`);
}

export const config = {
  path: ["/api/meetings", "/api/meetings/*"],
};
