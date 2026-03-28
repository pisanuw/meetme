/**
 * bookings-reminders.mjs
 * Scheduled reminder sender for upcoming bookings.
 */
import { errorResponse, getDb, getEnv, jsonResponse, log, persistEvent, secretsEqual } from "./utils.mjs";
import { sendUpcomingRemindersForHost } from "./bookings.mjs";

const FN = "bookings-reminders";
const DEFAULT_WINDOW_HOURS = 24;

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

  log("info", FN, "scheduled reminders complete", {
    host_count: hostIds.length,
    sent_count: totalSent,
    skipped_count: totalSkipped,
    failed_count: totalFailed,
  });

  return jsonResponse(200, {
    success: true,
    host_count: hostIds.length,
    sent_count: totalSent,
    skipped_count: totalSkipped,
    failed_count: totalFailed,
  });
}

export const config = {
  schedule: "0 * * * *",
};
