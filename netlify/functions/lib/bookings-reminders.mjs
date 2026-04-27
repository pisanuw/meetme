/**
 * bookings-reminders.mjs — Upcoming-booking reminder sending for a host.
 */
import { asArray, sendEmail, escapeHtml, LIMITS } from "../utils.mjs";
import { DEFAULT_REMINDER_WINDOW_HOURS } from "./bookings-helpers.mjs";

export function normalizeReminderWindowHours(input) {
  const requested = Number.parseInt(String(input || DEFAULT_REMINDER_WINDOW_HOURS), 10);
  if (!Number.isFinite(requested)) return DEFAULT_REMINDER_WINDOW_HOURS;
  return Math.max(1, Math.min(requested, LIMITS.BOOKING_REMINDER_WINDOW_HOURS_MAX));
}

export async function sendBookingReminderEmails(booking, bookingId) {
  const hostHtml = `
    <p>Hello ${escapeHtml(booking.host_name || booking.host_email)},</p>
    <p>Reminder: <strong>${escapeHtml(booking.event_title)}</strong> starts soon.</p>
    <p><strong>When:</strong> ${escapeHtml(booking.date)} at ${escapeHtml(booking.start_time)} (${escapeHtml(booking.timezone || "UTC")})</p>
    <p><strong>Attendee:</strong> ${escapeHtml(booking.attendee_name || booking.attendee_email)}</p>
  `;

  const attendeeHtml = `
    <p>Hello ${escapeHtml(booking.attendee_name || booking.attendee_email)},</p>
    <p>Reminder: your booking starts soon.</p>
    <p><strong>Event:</strong> ${escapeHtml(booking.event_title)}</p>
    <p><strong>When:</strong> ${escapeHtml(booking.date)} at ${escapeHtml(booking.start_time)} (${escapeHtml(booking.timezone || "UTC")})</p>
    <p><strong>Host:</strong> ${escapeHtml(booking.host_name || booking.host_email)}</p>
  `;

  const [hostResult, attendeeResult] = await Promise.all([
    sendEmail({
      to: booking.host_email,
      subject: `Reminder: ${booking.event_title}`,
      html: hostHtml,
      text: `Reminder: ${booking.event_title} at ${booking.date} ${booking.start_time}.`,
      tags: [
        { name: "type", value: "booking_reminder" },
        { name: "booking_id", value: bookingId },
      ],
    }),
    sendEmail({
      to: booking.attendee_email,
      subject: `Reminder: ${booking.event_title}`,
      html: attendeeHtml,
      text: `Reminder: ${booking.event_title} at ${booking.date} ${booking.start_time}.`,
      tags: [
        { name: "type", value: "booking_reminder" },
        { name: "booking_id", value: bookingId },
      ],
    }),
  ]);

  return {
    ok: Boolean(hostResult?.ok) && Boolean(attendeeResult?.ok),
    host_result: hostResult,
    attendee_result: attendeeResult,
  };
}

export async function sendUpcomingRemindersForHost({
  bookingsDb,
  hostUserId,
  actorEmail = "system",
  withinHours = DEFAULT_REMINDER_WINDOW_HOURS,
}) {
  const windowHours = normalizeReminderWindowHours(withinHours);
  const now = Date.now();
  const cutoff = now + windowHours * 3600 * 1000;
  const hostIds = asArray(await bookingsDb.get(`host:${hostUserId}`, { type: "json" }).catch(() => []));

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const reminderIds = [];

  for (const bookingId of hostIds) {
    const booking = await bookingsDb.get(`booking:${bookingId}`, { type: "json" }).catch(() => null);
    if (!booking || booking.status !== "confirmed") {
      skippedCount += 1;
      continue;
    }

    const startTs = new Date(booking.starts_at_utc || "").getTime();
    if (!Number.isFinite(startTs) || startTs <= now || startTs > cutoff) {
      skippedCount += 1;
      continue;
    }

    const reminderKey = `reminder:${bookingId}`;
    const reminderState = await bookingsDb.get(reminderKey, { type: "json" }).catch(() => null);
    if (reminderState?.sent_at) {
      skippedCount += 1;
      continue;
    }

    const delivery = await sendBookingReminderEmails(booking, bookingId);
    if (!delivery.ok) {
      failedCount += 1;
      continue;
    }

    await bookingsDb.setJSON(reminderKey, {
      sent_at: new Date().toISOString(),
      sent_by: actorEmail,
      booking_id: bookingId,
    });

    reminderIds.push(bookingId);
    sentCount += 1;
  }

  return {
    sent_count: sentCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    reminder_booking_ids: reminderIds,
    within_hours: windowHours,
  };
}
