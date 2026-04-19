/**
 * bookings-reminders.mjs
 * Scheduled reminder sender for upcoming bookings. Also piggy-backs on the
 * hourly cron to purge anonymous meetings whose 30-day retention window has
 * elapsed (see isAnonymousMeetingExpired in utils.mjs).
 */
import {
  deleteMeetingRecord,
  errorResponse,
  getDb,
  getEnv,
  getMeetingRecord,
  isAnonymousMeetingExpired,
  jsonResponse,
  listMeetingIds,
  log,
  persistEvent,
  secretsEqual,
} from "./utils.mjs";
import { sendUpcomingRemindersForHost } from "./bookings.mjs";

const FN = "bookings-reminders";
const DEFAULT_WINDOW_HOURS = 24;

async function purgeExpiredAnonymousMeetings() {
  const meetings = getDb("meetings");
  const invites = getDb("invites");
  const availability = getDb("availability");

  const ids = await listMeetingIds(meetings);
  let examined = 0;
  let deleted = 0;
  const now = new Date();

  for (const id of ids) {
    examined++;
    const meeting = await getMeetingRecord(meetings, id);
    if (!meeting) continue;
    if (!isAnonymousMeetingExpired(meeting, now)) continue;

    await deleteMeetingRecord(meetings, id);
    await invites.delete(`meeting:${id}`).catch(() => null);
    await availability.delete(`meeting:${id}`).catch(() => null);
    deleted++;

    log("info", FN, "purged expired anonymous meeting", {
      meeting_id: id,
      created_at: meeting.created_at,
      last_activity_at: meeting.last_activity_at,
    });
  }

  if (deleted > 0) {
    await persistEvent("info", FN, "anonymous meetings purged", {
      examined_count: examined,
      deleted_count: deleted,
    });
  }

  return { examined_count: examined, deleted_count: deleted };
}

function getProvidedSecret(req) {
  return (
    req.headers.get("x-booking-reminders-secret") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    ""
  );
}

export default async function handler(req, context) {
  const isCronTrigger = Boolean(context?.cron);
  if (!isCronTrigger) {
    const expectedSecret = getEnv("BOOKING_REMINDERS_RUN_SECRET", "");
    if (!expectedSecret) {
      log("warn", FN, "manual reminders run rejected: BOOKING_REMINDERS_RUN_SECRET missing");
      return errorResponse(500, "Booking reminder run secret is not configured.");
    }

    const providedSecret = getProvidedSecret(req);
    if (!secretsEqual(providedSecret, expectedSecret)) {
      log("warn", FN, "manual reminders run rejected: secret mismatch");
      return errorResponse(403, "Invalid reminder run secret.");
    }
  }

  const bookingsDb = getDb("bookings");

  const listing = await bookingsDb.list().catch(() => ({ blobs: [] }));
  const hostIds = (listing.blobs || [])
    .map((entry) => entry?.key || "")
    .filter((key) => key.startsWith("host:"))
    .map((key) => key.slice("host:".length))
    .filter(Boolean);

  let totalSent = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const hostUserId of [...new Set(hostIds)]) {
    const result = await sendUpcomingRemindersForHost({
      bookingsDb,
      hostUserId,
      actorEmail: "system-scheduler",
      withinHours: DEFAULT_WINDOW_HOURS,
    });

    totalSent += result.sent_count;
    totalSkipped += result.skipped_count;
    totalFailed += result.failed_count;
  }

  await persistEvent("info", FN, "scheduled booking reminders run", {
    host_count: hostIds.length,
    sent_count: totalSent,
    skipped_count: totalSkipped,
    failed_count: totalFailed,
    trigger: isCronTrigger ? "cron" : "manual",
  });

  // Piggy-back anonymous-meeting retention cleanup on the same hourly cron.
  // Isolated in its own try/catch so a cleanup failure never breaks the
  // reminders pipeline.
  let purge = { examined_count: 0, deleted_count: 0 };
  try {
    purge = await purgeExpiredAnonymousMeetings();
  } catch (err) {
    log("error", FN, "anonymous meeting purge failed", { message: err.message });
  }

  log("info", FN, "scheduled reminders complete", {
    host_count: hostIds.length,
    sent_count: totalSent,
    skipped_count: totalSkipped,
    failed_count: totalFailed,
    anon_meetings_examined: purge.examined_count,
    anon_meetings_deleted: purge.deleted_count,
  });

  return jsonResponse(200, {
    success: true,
    host_count: hostIds.length,
    sent_count: totalSent,
    skipped_count: totalSkipped,
    failed_count: totalFailed,
    anon_meetings_examined: purge.examined_count,
    anon_meetings_deleted: purge.deleted_count,
  });
}

export { purgeExpiredAnonymousMeetings };

export const config = {
  schedule: "0 * * * *",
};
