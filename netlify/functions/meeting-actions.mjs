/**
 * meeting-actions.mjs — Per-meeting action endpoints
 *
 * Routes handled (all require POST + valid session):
 *   POST /api/meetings/:id/availability    — save this user's availability slots
 *   POST /api/meetings/:id/finalize        — mark a meeting as finalized + notify participants (creator only)
 *   POST /api/meetings/:id/unfinalize      — revert finalization (creator only)
 *   POST /api/meetings/:id/remind-pending  — email non-responders (creator only)
 *
 * Slot key format: "<date_or_day>_<HH:MM>"
 *   e.g. "2024-03-15_09:00" (specific dates) or "Monday_14:00" (days of week)
 */
import {
  getDb,
  getUserFromRequest,
  jsonResponse,
  errorResponse,
  log,
  logRequest,
  safeJson,
  persistEvent,
  sendEmail,
  asArray,
  escapeHtml,
  buildTimeSlots,
  getAppUrl,
  createToken,
  generateId,
  getMeetingRecord,
  saveMeetingRecord,
  LIMITS,
} from "./utils.mjs";
import { validateFinalizeBody } from "./lib/meeting-validation.mjs";

const FN = "meeting-actions";

function buildEmailPreferenceLinks(appUrl, recipientEmail, organizerEmail, meetingId) {
  const token = createToken(
    {
      id: "email-preferences",
      purpose: "email_preferences",
      email: recipientEmail,
      organizer_email: organizerEmail,
      meeting_id: meetingId,
      jti: generateId(),
    },
    "365d"
  );

  return {
    globalOptOutUrl: `${appUrl}/api/email-preferences/confirm?token=${encodeURIComponent(token)}&action=global_opt_out`,
    blockOrganizerUrl: `${appUrl}/api/email-preferences/confirm?token=${encodeURIComponent(token)}&action=block_organizer`,
  };
}

// Top-level entry point — catch-all for unhandled exceptions.
export default async (req, context) => {
  try {
    return await handleMeetingActions(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, "Internal server error.");
  }
};

async function handleMeetingActions(req, _context) {
  logRequest(FN, req);

  // All routes in this function require authentication and POST method.
  const user = getUserFromRequest(req);
  if (!user) return errorResponse(401, "Not authenticated. Please sign in.");
  if (req.method !== "POST") return errorResponse(405, `Method ${req.method} not allowed.`);

  const url = new URL(req.url);
  const path = url.pathname;

  const meetings = getDb("meetings");
  const invites = getDb("invites");
  const availability = getDb("availability");

  // POST /api/meetings/:id/availability ────────────────────────────────────
  // Replace the caller's saved slots for a meeting.  Any slots that reference
  // dates/times outside the meeting's configured range are silently dropped
  // (they could be stale front-end data) and a warning is logged.
  const availMatch = path.match(/^\/api\/meetings\/([^/]+)\/availability$/);
  if (availMatch) {
    const meetingId = availMatch[1];
    log("info", FN, "submit availability", { meetingId, userId: user.id });

    const meeting = await getMeetingRecord(meetings, meetingId);
    if (!meeting) {
      log("warn", FN, "meeting not found for availability", { meetingId });
      return errorResponse(404, `Meeting '${meetingId}' not found.`);
    }

    const meetingInvites = asArray(
      await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );
    const invite = meetingInvites.find((i) => i.email === user.email);
    if (meeting.creator_id !== user.id && !invite) {
      log("warn", FN, "unauthorized availability submission", { meetingId, userId: user.id });
      return errorResponse(403, "You are not a participant of this meeting.");
    }

    const body = await safeJson(req);
    if (body === null) return errorResponse(400, "Request body must be valid JSON.");
    const slots = Array.isArray(body.slots) ? body.slots : [];

    const allAvail = asArray(
      await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );
    const otherAvail = allAvail.filter((a) => a.user_id !== user.id);

    const validDates = new Set(meeting.dates_or_days);
    const validTimes = new Set(buildTimeSlots(meeting.start_time, meeting.end_time));

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
        newAvail.push({ meeting_id: meetingId, user_id: user.id, date_or_day: dod, time_slot: ts });
      } else {
        skipped++;
      }
    }
    if (skipped > 0) log("warn", FN, "slots skipped (invalid date/time)", { meetingId, skipped });

    const updatedAvail = [...otherAvail, ...newAvail];
    await availability.setJSON(`meeting:${meetingId}`, updatedAvail);

    if (invite) {
      const updatedInvites = meetingInvites.map((i) =>
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

  // POST /api/meetings/:id/finalize ─────────────────────────────────────────
  // Lock a meeting to a specific date/time slot chosen by the creator.
  // After finalization the grid becomes read-only for all participants.
  const finalizeMatch = path.match(/^\/api\/meetings\/([^/]+)\/finalize$/);
  if (finalizeMatch) {
    const meetingId = finalizeMatch[1];
    log("info", FN, "finalize meeting", { meetingId, userId: user.id });

    const meeting = await getMeetingRecord(meetings, meetingId);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);
    if (meeting.creator_id !== user.id)
      return errorResponse(403, "Only the meeting creator can finalize it.");

    const body = await safeJson(req);
    if (body === null) return errorResponse(400, "Request body must be valid JSON.");
    const finalizeValidation = validateFinalizeBody(body);
    if (finalizeValidation.error) {
      return errorResponse(finalizeValidation.error.status, finalizeValidation.error.message);
    }
    const { durationMinutes } = finalizeValidation;

    meeting.finalized_date = body.date_or_day;
    meeting.finalized_slot = body.time_slot;
    meeting.duration_minutes = durationMinutes;
    meeting.note = body.note || "";
    meeting.is_finalized = true;
    await saveMeetingRecord(meetings, meeting);

    const meetingInvites = asArray(
      await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );
    const recipients = [
      ...new Set(meetingInvites.map((i) => (i?.email || "").trim().toLowerCase()).filter(Boolean)),
    ];
    const appUrl = getAppUrl(req);
    const meetingUrl = `${appUrl}/meeting.html?id=${encodeURIComponent(meetingId)}`;
    const whenText = `${body.date_or_day} at ${body.time_slot} (${meeting.timezone || "UTC"})`;
    const durationText = `${meeting.duration_minutes} minute${meeting.duration_minutes === 1 ? "" : "s"}`;

    let sentCount = 0;
    let failedCount = 0;
    const failures = [];

    for (const email of recipients) {
      const links = buildEmailPreferenceLinks(appUrl, email, user.email, meetingId);
      const result = await sendEmail({
        to: email,
        subject: `Finalized: ${meeting.title}`,
        html: `
          <p>Hello,</p>
          <p><strong>${escapeHtml(meeting.title)}</strong> has been finalized.</p>
          <p><strong>When:</strong> ${escapeHtml(whenText)}<br />
             <strong>Duration:</strong> ${escapeHtml(durationText)}</p>
          ${meeting.note ? `<p><strong>Note from organizer:</strong><br />${escapeHtml(meeting.note)}</p>` : ""}
          <p><a href="${meetingUrl}">Open meeting details</a></p>
          <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb" />
          <p style="color:#666;font-size:12px;line-height:1.5;">
            Email preferences:<br />
            <a href="${links.globalOptOutUrl}">Never receive any MeetMe emails again</a><br />
            <a href="${links.blockOrganizerUrl}">Stop receiving meeting emails from this organizer</a>
          </p>
        `,
        text: [
          `"${meeting.title}" has been finalized.`,
          `When: ${whenText}`,
          `Duration: ${durationText}`,
          ...(meeting.note ? [`Note from organizer: ${meeting.note}`] : []),
          "",
          `Open meeting details: ${meetingUrl}`,
          "",
          "Email preferences:",
          `- Never receive any MeetMe emails again: ${links.globalOptOutUrl}`,
          `- Stop receiving meeting emails from this organizer: ${links.blockOrganizerUrl}`,
        ].join("\n"),
        suppression: {
          category: "meeting",
          organizerEmail: user.email,
        },
        tags: [
          { name: "type", value: "finalized" },
          { name: "meeting_id", value: meetingId },
        ],
      });

      if (result.ok) {
        sentCount += 1;
      } else {
        failedCount += 1;
        failures.push({ email, error: result.error });
        log("warn", FN, "finalize email failed", { meetingId, email, error: result.error });
      }
    }

    await persistEvent("info", FN, "meeting finalized", {
      meetingId,
      meeting_name: meeting.title,
      finalized_date: body.date_or_day,
      finalized_slot: body.time_slot,
      sent_count: sentCount,
      failed_count: failedCount,
      triggered_by: user.email,
    });

    log("info", FN, "meeting finalized", {
      meetingId,
      date: body.date_or_day,
      slot: body.time_slot,
      sentCount,
      failedCount,
    });
    return jsonResponse(200, {
      success: true,
      sent_count: sentCount,
      failed_count: failedCount,
      failures,
    });
  }

  // POST /api/meetings/:id/unfinalize
  const unfinalizeMatch = path.match(/^\/api\/meetings\/([^/]+)\/unfinalize$/);
  if (unfinalizeMatch) {
    const meetingId = unfinalizeMatch[1];
    log("info", FN, "unfinalize meeting", { meetingId, userId: user.id });

    const meeting = await getMeetingRecord(meetings, meetingId);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);
    if (meeting.creator_id !== user.id)
      return errorResponse(403, "Only the meeting creator can unfinalize it.");

    meeting.is_finalized = false;
    meeting.finalized_date = null;
    meeting.finalized_slot = null;
    await saveMeetingRecord(meetings, meeting);

    log("info", FN, "meeting unfinalized", { meetingId });
    return jsonResponse(200, { success: true });
  }

  // POST /api/meetings/:id/remind-pending
  const remindMatch = path.match(/^\/api\/meetings\/([^/]+)\/remind-pending$/);
  if (remindMatch) {
    const meetingId = remindMatch[1];
    log("info", FN, "send reminder emails", { meetingId, userId: user.id });

    const meeting = await getMeetingRecord(meetings, meetingId);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);
    if (meeting.creator_id !== user.id) {
      return errorResponse(403, "Only the meeting creator can send reminders.");
    }

    const meetingInvites = asArray(
      await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );
    const pending = meetingInvites.filter((i) => !i.responded && i.email && i.email !== user.email);

    if (pending.length === 0) {
      return jsonResponse(200, {
        success: true,
        sent_count: 0,
        failed_count: 0,
        message: "Everyone has already responded.",
      });
    }

    const appUrl = getAppUrl(req);
    const meetingUrl = `${appUrl}/meeting.html?id=${encodeURIComponent(meetingId)}`;
    let sentCount = 0;
    let failedCount = 0;
    const failures = [];

    for (const inv of pending) {
      const links = buildEmailPreferenceLinks(appUrl, inv.email, user.email, meetingId);
      // Build reminder email using the shared sendEmail helper (utils.mjs).
      const whenText = `${meeting.start_time || "08:00"} - ${meeting.end_time || "20:00"} (${meeting.timezone || "UTC"})`;
      const result = await sendEmail({
        to: inv.email,
        subject: `Reminder: Share your availability for ${meeting.title}`,
        html: `
          <p>Hello,</p>
          <p>This is a reminder to share your availability for <strong>${meeting.title}</strong>.</p>
          <p><strong>Time range:</strong> ${whenText}</p>
          <p><a href="${meetingUrl}">Open meeting and submit availability</a></p>
          <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb" />
          <p style="color:#666;font-size:12px;line-height:1.5;">
            Email preferences:<br />
            <a href="${links.globalOptOutUrl}">Never receive any MeetMe emails again</a><br />
            <a href="${links.blockOrganizerUrl}">Stop receiving meeting emails from this organizer</a>
          </p>
          <p>Thanks!</p>
        `,
        text: [
          "Hello,",
          "",
          `This is a reminder to share your availability for ${meeting.title}.`,
          `Time range: ${whenText}`,
          "",
          `Open meeting and submit availability: ${meetingUrl}`,
          "",
          "Email preferences:",
          `- Never receive any MeetMe emails again: ${links.globalOptOutUrl}`,
          `- Stop receiving meeting emails from this organizer: ${links.blockOrganizerUrl}`,
          "",
          "Thanks!",
        ].join("\n"),
        suppression: {
          category: "meeting",
          organizerEmail: user.email,
        },
        tags: [
          { name: "type", value: "reminder" },
          { name: "meeting_id", value: meetingId },
        ],
      });

      if (result.ok) {
        sentCount += 1;
      } else {
        failedCount += 1;
        failures.push({ email: inv.email, error: result.error });
        log("warn", FN, "reminder email failed", {
          meetingId,
          email: inv.email,
          error: result.error,
        });
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
  path: [
    "/api/meetings/*/availability",
    "/api/meetings/*/finalize",
    "/api/meetings/*/unfinalize",
    "/api/meetings/*/remind-pending",
  ],
};
