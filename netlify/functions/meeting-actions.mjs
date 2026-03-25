import {
  getDb, getUserFromRequest, jsonResponse, errorResponse,
  log, logRequest, safeJson, getEnv, persistEvent,
} from "./utils.mjs";

const FN = "meeting-actions";

export default async (req, context) => {
  try {
    return await handleMeetingActions(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, `Internal server error: ${err.message}`);
  }
};

async function handleMeetingActions(req, context) {
  logRequest(FN, req);

  const asArray = (value) => Array.isArray(value) ? value : [];

  const user = getUserFromRequest(req);
  if (!user) return errorResponse(401, "Not authenticated. Please sign in.");
  if (req.method !== "POST") return errorResponse(405, `Method ${req.method} not allowed.`);

  const url = new URL(req.url);
  const path = url.pathname;

  const invites = getDb("invites");
  const availability = getDb("availability");

  function getAppUrl() {
    return getEnv("APP_URL", new URL(req.url).origin);
  }

  async function sendReminderEmail(toEmail, meeting, meetingUrl) {
    const apiKey = getEnv("RESEND_API_KEY");
    const fromEmail = getEnv("AUTH_FROM_EMAIL");
    if (!apiKey || !fromEmail) {
      return { ok: false, error: "Email delivery is not configured (RESEND_API_KEY / AUTH_FROM_EMAIL missing)." };
    }

    const whenText = `${meeting.start_time || "08:00"} - ${meeting.end_time || "20:00"} (${meeting.timezone || "UTC"})`;
    const subject = `Reminder: Share your availability for ${meeting.title}`;
    const html = `
      <p>Hello,</p>
      <p>This is a reminder to share your availability for <strong>${meeting.title}</strong>.</p>
      <p><strong>Time range:</strong> ${whenText}</p>
      <p><a href="${meetingUrl}">Open meeting and submit availability</a></p>
      <p>Thanks!</p>
    `;
    const text = [
      "Hello,",
      "",
      `This is a reminder to share your availability for ${meeting.title}.`,
      `Time range: ${whenText}`,
      "",
      `Open meeting and submit availability: ${meetingUrl}`,
      "",
      "Thanks!",
    ].join("\n");

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [toEmail],
          subject,
          html,
          text,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `Resend failed (HTTP ${res.status})`, detail: body };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Email send failed: ${err.message}` };
    }
  }

  // POST /api/meeting/:id/availability
  const availMatch = path.match(/^\/api\/meeting\/([^/]+)\/availability$/);
  if (availMatch) {
    const meetingId = availMatch[1];
    log("info", FN, "submit availability", { meetingId, userId: user.id });

    const meetings = getDb("meetings");
    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) {
      log("warn", FN, "meeting not found for availability", { meetingId });
      return errorResponse(404, `Meeting '${meetingId}' not found.`);
    }

    const meetingInvites = asArray(await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []));
    const invite = meetingInvites.find(i => i.email === user.email);
    if (meeting.creator_id !== user.id && !invite) {
      log("warn", FN, "unauthorized availability submission", { meetingId, userId: user.id });
      return errorResponse(403, "You are not a participant of this meeting.");
    }

    const body = await safeJson(req);
    if (body === null) return errorResponse(400, "Request body must be valid JSON.");
    const slots = Array.isArray(body.slots) ? body.slots : [];

    const allAvail = asArray(await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []));
    const otherAvail = allAvail.filter(a => a.user_id !== user.id);

    const validDates = new Set(meeting.dates_or_days);
    const validTimes = new Set();
    const [sh, sm] = (meeting.start_time || "08:00").split(":").map(Number);
    const [eh, em] = (meeting.end_time || "20:00").split(":").map(Number);
    let cur = sh * 60 + sm;
    const end = eh * 60 + em;
    while (cur < end) {
      validTimes.add(`${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`);
      cur += 15;
    }

    const newAvail = [];
    let skipped = 0;
    for (const sk of slots) {
      const idx = sk.indexOf("_");
      if (idx === -1) { skipped++; continue; }
      const dod = sk.slice(0, idx);
      const ts = sk.slice(idx + 1);
      if (validDates.has(dod) && validTimes.has(ts)) {
        newAvail.push({ meeting_id: meetingId, user_id: user.id, date_or_day: dod, time_slot: ts });
      } else {
        skipped++;
      }
    }
    if (skipped > 0) log("warn", FN, "slots skipped (invalid date/time)", { meetingId, skipped });

    const updatedAvail = [...otherAvail, ...newAvail];
    await availability.setJSON(`meeting:${meetingId}`, updatedAvail);

    if (invite) {
      const updatedInvites = meetingInvites.map(i =>
        i.email === user.email ? { ...i, responded: true } : i
      );
      await invites.setJSON(`meeting:${meetingId}`, updatedInvites);
    }

    const slotCounts = {};
    for (const a of updatedAvail) {
      const k = `${a.date_or_day}_${a.time_slot}`;
      slotCounts[k] = (slotCounts[k] || 0) + 1;
    }

    log("info", FN, "availability saved", { meetingId, newSlots: newAvail.length });
    return jsonResponse(200, { success: true, slot_counts: slotCounts });
  }

  // POST /api/meeting/:id/finalize
  const finalizeMatch = path.match(/^\/api\/meeting\/([^/]+)\/finalize$/);
  if (finalizeMatch) {
    const meetingId = finalizeMatch[1];
    log("info", FN, "finalize meeting", { meetingId, userId: user.id });

    const meetings = getDb("meetings");
    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);
    if (meeting.creator_id !== user.id) return errorResponse(403, "Only the meeting creator can finalize it.");

    const body = await safeJson(req);
    if (body === null) return errorResponse(400, "Request body must be valid JSON.");
    if (!body.date_or_day || !body.time_slot) {
      return errorResponse(400, "Both 'date_or_day' and 'time_slot' are required to finalize.");
    }

    meeting.finalized_date = body.date_or_day;
    meeting.finalized_slot = body.time_slot;
    meeting.duration_minutes = parseInt(body.duration_minutes || 60);
    meeting.note = body.note || "";
    meeting.is_finalized = true;
    await meetings.setJSON(meetingId, meeting);

    log("info", FN, "meeting finalized", { meetingId, date: body.date_or_day, slot: body.time_slot });
    return jsonResponse(200, { success: true });
  }

  // POST /api/meeting/:id/unfinalize
  const unfinalizeMatch = path.match(/^\/api\/meeting\/([^/]+)\/unfinalize$/);
  if (unfinalizeMatch) {
    const meetingId = unfinalizeMatch[1];
    log("info", FN, "unfinalize meeting", { meetingId, userId: user.id });

    const meetings = getDb("meetings");
    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);
    if (meeting.creator_id !== user.id) return errorResponse(403, "Only the meeting creator can unfinalize it.");

    meeting.is_finalized = false;
    meeting.finalized_date = null;
    meeting.finalized_slot = null;
    await meetings.setJSON(meetingId, meeting);

    log("info", FN, "meeting unfinalized", { meetingId });
    return jsonResponse(200, { success: true });
  }

  // POST /api/meeting/:id/remind-pending
  const remindMatch = path.match(/^\/api\/meeting\/([^/]+)\/remind-pending$/);
  if (remindMatch) {
    const meetingId = remindMatch[1];
    log("info", FN, "send reminder emails", { meetingId, userId: user.id });

    const meetings = getDb("meetings");
    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);
    if (meeting.creator_id !== user.id) {
      return errorResponse(403, "Only the meeting creator can send reminders.");
    }

    const meetingInvites = asArray(await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []));
    const pending = meetingInvites.filter(i => !i.responded && i.email && i.email !== user.email);

    if (pending.length === 0) {
      return jsonResponse(200, {
        success: true,
        sent_count: 0,
        failed_count: 0,
        message: "Everyone has already responded.",
      });
    }

    const meetingUrl = `${getAppUrl()}/meeting.html?id=${encodeURIComponent(meetingId)}`;
    let sentCount = 0;
    let failedCount = 0;
    const failures = [];

    for (const inv of pending) {
      const result = await sendReminderEmail(inv.email, meeting, meetingUrl);
      if (result.ok) {
        sentCount += 1;
      } else {
        failedCount += 1;
        failures.push({ email: inv.email, error: result.error });
        log("warn", FN, "reminder email failed", { meetingId, email: inv.email, error: result.error });
      }
    }

    await persistEvent("info", FN, "reminders sent", {
      meetingId,
      sent_count: sentCount,
      failed_count: failedCount,
      triggered_by: user.email,
    });

    return jsonResponse(200, {
      success: true,
      sent_count: sentCount,
      failed_count: failedCount,
      message: `Sent ${sentCount} reminder${sentCount === 1 ? "" : "s"}.`,
      failures,
    });
  }

  log("warn", FN, "unmatched route", { method: req.method, path });
  return errorResponse(404, `Route '${path}' not found.`);
}

export const config = {
  path: "/api/meeting/*",
};
