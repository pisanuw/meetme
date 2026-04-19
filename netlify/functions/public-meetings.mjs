/**
 * public-meetings.mjs — Anonymous, unauthenticated meeting endpoints
 *
 * These routes intentionally do NOT require a session cookie. Access is gated
 * by a JWT embedded in the shared URL (participation or admin token). The
 * corresponding authenticated endpoints live in meetings.mjs and meeting-actions.mjs.
 *
 * Routes handled:
 *   POST /api/public/meetings                       — create a new anonymous meeting
 *   GET  /api/public/meetings/:id?t=<token>         — meeting detail (participation or admin token)
 *   POST /api/public/meetings/:id/availability      — save participant slots + name
 *   POST /api/public/meetings/:id/finalize          — admin-only
 *   POST /api/public/meetings/:id/unfinalize        — admin-only
 *   POST /api/public/meetings/:id/delete            — admin-only
 *
 * Data-model notes:
 *   • Anonymous meetings are stored in the same `meetings` blob store as
 *     logged-in meetings, with `creator_id: null` and `anonymous: true`.
 *   • Anonymous participants use `user_id: "anon:<opaqueId>"` in invites and
 *     availability, which keeps existing dedup logic working unchanged.
 *   • The server mints participant IDs on first submit and returns them to
 *     the browser, which persists them in localStorage so subsequent edits
 *     update the same record. Clients never submit a participant_id the
 *     server hasn't seen.
 */
import {
  getDb,
  getAppUrl,
  jsonResponse,
  errorResponse,
  log,
  logRequest,
  safeJson,
  asArray,
  buildTimeSlots,
  generateId,
  generateAnonymousParticipantId,
  persistEvent,
  getMeetingRecord,
  saveMeetingRecord,
  deleteMeetingRecord,
  createToken,
  verifyMeetingToken,
  getUserFromRequest,
  MEETING_TOKEN_KINDS,
  LIMITS,
} from "./utils.mjs";

const FN = "public-meetings";
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

export default async (req, context) => {
  try {
    return await handleRequest(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, "Internal server error.");
  }
};

async function handleRequest(req) {
  logRequest(FN, req);
  const url = new URL(req.url);
  const pathParts = url.pathname.replace("/api/public/meetings", "").split("/").filter(Boolean);

  // POST /api/public/meetings — create anonymous meeting
  if (req.method === "POST" && pathParts.length === 0) {
    return handleCreateAnonymous(req);
  }

  // /api/public/meetings/:id[/<action>]
  if (pathParts.length >= 1) {
    const meetingId = pathParts[0];
    const action = pathParts[1] || null;

    if (req.method === "GET" && action === null) {
      return handleGetMeeting(req, url, meetingId);
    }
    if (req.method === "POST" && action === "availability") {
      return handleSubmitAvailability(req, meetingId);
    }
    if (req.method === "POST" && action === "finalize") {
      return handleFinalize(req, meetingId);
    }
    if (req.method === "POST" && action === "unfinalize") {
      return handleUnfinalize(req, meetingId);
    }
    if (req.method === "POST" && action === "delete") {
      return handleDelete(req, meetingId);
    }
  }

  return errorResponse(404, "Route not found.");
}

/* ─── Create anonymous meeting ───────────────────────────────────────────── */

async function handleCreateAnonymous(req) {
  const body = await safeJson(req);
  if (body === null) return errorResponse(400, "Request body must be valid JSON.");

  const {
    title,
    description,
    meeting_type,
    dates_or_days,
    start_time,
    end_time,
    timezone,
    creator_name,
  } = body;

  const normalizedTitle = String(title || "").trim();
  const normalizedDescription = String(description || "").trim();
  const normalizedMeetingType = String(meeting_type || "specific_dates").trim();
  const normalizedCreatorName = String(creator_name || "")
    .trim()
    .slice(0, LIMITS.NAME_MAX);
  const normalizedDatesOrDays = [
    ...new Set(
      asArray(dates_or_days)
        .map((v) => String(v || "").trim())
        .filter(Boolean)
    ),
  ];

  if (!normalizedTitle) return errorResponse(400, "Meeting title is required.");
  if (normalizedTitle.length > LIMITS.TITLE_MAX) {
    return errorResponse(400, `Meeting title must be ${LIMITS.TITLE_MAX} characters or fewer.`);
  }
  if (normalizedDescription.length > LIMITS.DESCRIPTION_MAX) {
    return errorResponse(400, `Description must be ${LIMITS.DESCRIPTION_MAX} characters or fewer.`);
  }
  if (!ALLOWED_MEETING_TYPES.has(normalizedMeetingType)) {
    return errorResponse(400, "meeting_type must be either 'specific_dates' or 'days_of_week'.");
  }
  if (normalizedDatesOrDays.length === 0) {
    return errorResponse(400, "Select at least one date or day.");
  }
  if (normalizedMeetingType === "specific_dates") {
    const invalidDate = normalizedDatesOrDays.find((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
    if (invalidDate) {
      return errorResponse(400, `Invalid date value '${invalidDate}'. Expected YYYY-MM-DD.`);
    }
  } else {
    const invalidDay = normalizedDatesOrDays.find((d) => !ALLOWED_DAY_NAMES.has(d));
    if (invalidDay) return errorResponse(400, `Invalid day value '${invalidDay}'.`);
  }

  const timeRe = /^\d{2}:\d{2}$/;
  if (start_time && !timeRe.test(start_time)) {
    return errorResponse(400, "start_time must be in HH:MM format.");
  }
  if (end_time && !timeRe.test(end_time)) {
    return errorResponse(400, "end_time must be in HH:MM format.");
  }
  if (start_time && end_time && start_time >= end_time) {
    return errorResponse(400, "end_time must be after start_time.");
  }

  const normalizedTimezone = String(timezone || "UTC").trim();
  const validTimezones = new Set(Intl.supportedValuesOf("timeZone"));
  if (normalizedTimezone !== "UTC" && !validTimezones.has(normalizedTimezone)) {
    return errorResponse(400, "Invalid timezone value.");
  }

  const meetingId = generateId();
  const nowIso = new Date().toISOString();
  const meeting = {
    id: meetingId,
    title: normalizedTitle,
    description: normalizedDescription,
    creator_id: null,
    creator_name: normalizedCreatorName || "Anonymous organizer",
    anonymous: true,
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
    created_at: nowIso,
    last_activity_at: nowIso,
  };

  const meetings = getDb("meetings");
  const invites = getDb("invites");
  await saveMeetingRecord(meetings, meeting);
  await invites.setJSON(`meeting:${meetingId}`, []);

  const participationToken = createToken(
    { kind: MEETING_TOKEN_KINDS.PARTICIPATION, meeting_id: meetingId, jti: generateId() },
    "365d"
  );
  const adminToken = createToken(
    { kind: MEETING_TOKEN_KINDS.ADMIN, meeting_id: meetingId, jti: generateId() },
    "365d"
  );

  const appUrl = getAppUrl(req);
  const participationUrl = `${appUrl}/meeting.html?id=${encodeURIComponent(meetingId)}&t=${encodeURIComponent(participationToken)}`;
  const adminUrl = `${appUrl}/meeting.html?id=${encodeURIComponent(meetingId)}&t=${encodeURIComponent(adminToken)}`;

  log("info", FN, "anonymous meeting created", { meetingId, title: normalizedTitle });
  await persistEvent("info", FN, "anonymous meeting created", {
    meeting_id: meetingId,
    meeting_name: normalizedTitle,
  });

  return jsonResponse(200, {
    success: true,
    meeting_id: meetingId,
    participation_token: participationToken,
    admin_token: adminToken,
    participation_url: participationUrl,
    admin_url: adminUrl,
  });
}

/* ─── Token helpers ──────────────────────────────────────────────────────── */

function tokenFromRequest(url, body) {
  return (body && typeof body.t === "string" && body.t) || url.searchParams.get("t") || "";
}

function assertTokenForMeeting(token, meetingId, { requireAdmin = false } = {}) {
  const payload = verifyMeetingToken(token, requireAdmin ? MEETING_TOKEN_KINDS.ADMIN : undefined);
  if (!payload) {
    return { error: errorResponse(401, "Invalid or expired meeting token.") };
  }
  if (payload.meeting_id !== meetingId) {
    return { error: errorResponse(403, "Token is not valid for this meeting.") };
  }
  return { payload };
}

/* ─── Meeting detail ─────────────────────────────────────────────────────── */

async function handleGetMeeting(req, url, meetingId) {
  const token = tokenFromRequest(url, null);
  const tokenCheck = assertTokenForMeeting(token, meetingId);
  if (tokenCheck.error) return tokenCheck.error;
  const isAdmin = tokenCheck.payload.kind === MEETING_TOKEN_KINDS.ADMIN;

  const meetings = getDb("meetings");
  const invites = getDb("invites");
  const availability = getDb("availability");

  const meeting = await getMeetingRecord(meetings, meetingId);
  if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);

  const meetingInvites = asArray(
    await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
  );
  const allAvail = asArray(
    await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
  );

  const slotCounts = {};
  for (const a of allAvail) {
    const k = `${a.date_or_day}_${a.time_slot}`;
    slotCounts[k] = (slotCounts[k] || 0) + 1;
  }

  // Aggregated per-participant slots for the "By person" panel.
  const participants = meetingInvites.map((inv) => {
    const ua = allAvail.filter((a) => a.user_id === inv.user_id);
    return {
      name: inv.name || "Anonymous",
      slot_count: ua.length,
      responded: inv.responded,
      slots: ua.map((a) => `${a.date_or_day}_${a.time_slot}`),
      // Never expose email here; anonymous flow should not leak contact info.
      participant_id: inv.user_id || null,
    };
  });

  return jsonResponse(200, {
    meeting,
    is_creator: isAdmin,
    is_admin: isAdmin,
    is_anonymous: true,
    my_slots: [], // the client rehydrates from localStorage participant_id
    slot_counts: slotCounts,
    total_invited: meetingInvites.length,
    participants,
    time_slots: buildTimeSlots(meeting.start_time, meeting.end_time),
    respond_count: meetingInvites.filter((i) => i.responded).length,
    invite_count: meetingInvites.length,
  });
}

/* ─── Submit availability ────────────────────────────────────────────────── */

async function handleSubmitAvailability(req, meetingId) {
  const body = await safeJson(req);
  if (body === null) return errorResponse(400, "Request body must be valid JSON.");

  const token = body.t || "";
  const tokenCheck = assertTokenForMeeting(token, meetingId);
  if (tokenCheck.error) return tokenCheck.error;

  const meetings = getDb("meetings");
  const invites = getDb("invites");
  const availability = getDb("availability");

  const meeting = await getMeetingRecord(meetings, meetingId);
  if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);

  const name = String(body.name || "")
    .trim()
    .slice(0, LIMITS.NAME_MAX);
  if (!name) return errorResponse(400, "A display name is required to submit availability.");

  let participantId = typeof body.participant_id === "string" ? body.participant_id.trim() : "";

  let meetingInvites = asArray(
    await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
  );

  // Validate provided participant_id actually belongs to this meeting.
  // This prevents a client from spoofing another participant's identity by
  // guessing/picking an ID we never issued.
  if (participantId) {
    const existing = meetingInvites.find((i) => i.user_id === participantId);
    if (!existing) {
      return errorResponse(
        403,
        "Participant identity not recognized for this meeting. Refresh and try again."
      );
    }
  } else {
    participantId = generateAnonymousParticipantId();
    meetingInvites = [
      ...meetingInvites,
      {
        id: generateId(),
        meeting_id: meetingId,
        user_id: participantId,
        email: null,
        name,
        responded: false,
        anonymous: true,
        added_at: new Date().toISOString(),
      },
    ];
  }

  const slots = Array.isArray(body.slots) ? body.slots : [];
  const validDates = new Set(meeting.dates_or_days);
  const validTimes = new Set(buildTimeSlots(meeting.start_time, meeting.end_time));

  const allAvail = asArray(
    await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
  );
  const otherAvail = allAvail.filter((a) => a.user_id !== participantId);

  const newAvail = [];
  let skipped = 0;
  for (const sk of slots) {
    const idx = sk.indexOf("_");
    if (idx === -1) {
      skipped++;
      continue;
    }
    const dod = sk.slice(0, idx);
    const ts = sk.slice(idx + 1);
    if (validDates.has(dod) && validTimes.has(ts)) {
      newAvail.push({
        meeting_id: meetingId,
        user_id: participantId,
        date_or_day: dod,
        time_slot: ts,
      });
    } else {
      skipped++;
    }
  }
  if (skipped > 0) log("warn", FN, "slots skipped (invalid date/time)", { meetingId, skipped });

  const updatedAvail = [...otherAvail, ...newAvail];
  await availability.setJSON(`meeting:${meetingId}`, updatedAvail);

  const updatedInvites = meetingInvites.map((i) =>
    i.user_id === participantId ? { ...i, name, responded: true } : i
  );
  await invites.setJSON(`meeting:${meetingId}`, updatedInvites);

  // Extend retention on activity
  meeting.last_activity_at = new Date().toISOString();
  await saveMeetingRecord(meetings, meeting);

  const slotCounts = {};
  for (const a of updatedAvail) {
    const k = `${a.date_or_day}_${a.time_slot}`;
    slotCounts[k] = (slotCounts[k] || 0) + 1;
  }

  return jsonResponse(200, {
    success: true,
    participant_id: participantId,
    slot_counts: slotCounts,
  });
}

/* ─── Admin actions ──────────────────────────────────────────────────────── */

async function handleFinalize(req, meetingId) {
  const body = await safeJson(req);
  if (body === null) return errorResponse(400, "Request body must be valid JSON.");

  const tokenCheck = assertTokenForMeeting(body.t || "", meetingId, { requireAdmin: true });
  if (tokenCheck.error) return tokenCheck.error;

  if (!body.date_or_day || !body.time_slot) {
    return errorResponse(400, "Both 'date_or_day' and 'time_slot' are required to finalize.");
  }

  const meetings = getDb("meetings");
  const meeting = await getMeetingRecord(meetings, meetingId);
  if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);

  const durationMinutes = Number.parseInt(body.duration_minutes || 60, 10);
  if (
    !Number.isFinite(durationMinutes) ||
    durationMinutes < LIMITS.DURATION_MIN ||
    durationMinutes > LIMITS.DURATION_MAX
  ) {
    return errorResponse(
      400,
      `duration_minutes must be between ${LIMITS.DURATION_MIN} and ${LIMITS.DURATION_MAX}.`
    );
  }

  meeting.finalized_date = body.date_or_day;
  meeting.finalized_slot = body.time_slot;
  meeting.duration_minutes = durationMinutes;
  meeting.note = body.note || "";
  meeting.is_finalized = true;
  meeting.last_activity_at = new Date().toISOString();
  await saveMeetingRecord(meetings, meeting);

  return jsonResponse(200, { success: true });
}

async function handleUnfinalize(req, meetingId) {
  const body = await safeJson(req);
  if (body === null) return errorResponse(400, "Request body must be valid JSON.");

  const tokenCheck = assertTokenForMeeting(body.t || "", meetingId, { requireAdmin: true });
  if (tokenCheck.error) return tokenCheck.error;

  const meetings = getDb("meetings");
  const meeting = await getMeetingRecord(meetings, meetingId);
  if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);

  meeting.is_finalized = false;
  meeting.finalized_date = null;
  meeting.finalized_slot = null;
  meeting.note = "";
  meeting.last_activity_at = new Date().toISOString();
  await saveMeetingRecord(meetings, meeting);

  return jsonResponse(200, { success: true });
}

async function handleDelete(req, meetingId) {
  const body = await safeJson(req);
  if (body === null) return errorResponse(400, "Request body must be valid JSON.");

  const tokenCheck = assertTokenForMeeting(body.t || "", meetingId, { requireAdmin: true });
  if (tokenCheck.error) return tokenCheck.error;

  const meetings = getDb("meetings");
  const invites = getDb("invites");
  const availability = getDb("availability");

  const meeting = await getMeetingRecord(meetings, meetingId);
  if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);

  await deleteMeetingRecord(meetings, meetingId);
  await invites.delete(`meeting:${meetingId}`).catch(() => null);
  await availability.delete(`meeting:${meetingId}`).catch(() => null);

  log("info", FN, "anonymous meeting deleted by admin token", { meetingId });
  await persistEvent("warn", FN, "anonymous meeting deleted", { meeting_id: meetingId });
  return jsonResponse(200, { success: true });
}

// Exported so unit tests can exercise `getUserFromRequest` integration
// without going through Netlify's route layer.
export { getUserFromRequest };

export const config = {
  path: ["/api/public/meetings", "/api/public/meetings/*"],
};
