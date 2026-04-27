/**
 * lib/utils-core.mjs — Pure utility helpers with no inter-lib dependencies
 *
 * @typedef {object} Meeting
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} creator_id
 * @property {string} creator_name
 * @property {"specific_dates"|"days_of_week"} meeting_type
 * @property {string[]} dates_or_days
 * @property {string} start_time
 * @property {string} end_time
 * @property {string} timezone
 * @property {number} duration_minutes
 * @property {string|null} finalized_date
 * @property {string|null} finalized_slot
 * @property {string} note
 * @property {boolean} is_finalized
 * @property {string} created_at
 */

/**
 * @typedef {object} Invite
 * @property {string} id
 * @property {string} meeting_id
 * @property {string|null} user_id
 * @property {string} email
 * @property {string} name
 * @property {boolean} responded
 */

/**
 * @typedef {object} AvailabilitySlot
 * @property {string} meeting_id
 * @property {string} user_id
 * @property {string} date_or_day
 * @property {string} time_slot
 */

/**
 * @typedef {object} User
 * @property {string}  id
 * @property {string}  email
 * @property {string}  name
 * @property {string}  first_name
 * @property {string}  last_name
 * @property {boolean} profile_complete
 * @property {string}  created_at
 * @property {string}  [timezone]
 * @property {boolean} [calendar_connected]
 */

/**
 * @typedef {object} EventRecord
 * @property {string} ts
 * @property {"info"|"warn"|"error"} level
 * @property {string} fn
 * @property {string} message
 */

import crypto from "node:crypto";

export const LIMITS = {
  TITLE_MAX: 200,
  DESCRIPTION_MAX: 2000,
  MAX_INVITEES: 50,
  NAME_MAX: 100,
  DURATION_MIN: 15,
  DURATION_MAX: 24 * 60,
  FEEDBACK_MESSAGE_MAX: 5000,
  ADMIN_PAGE_DEFAULT: 25,
  ADMIN_PAGE_MAX: 100,
  BOOKING_EVENT_TYPES_MAX: 25,
  BOOKING_EVENT_TITLE_MAX: 120,
  BOOKING_EVENT_DESCRIPTION_MAX: 1200,
  BOOKING_AVAIL_WINDOWS_MAX: 60,
  BOOKING_DURATION_MAX: 180,
  BOOKING_GROUP_CAPACITY_MAX: 100,
  BOOKING_REMINDER_WINDOW_HOURS_MAX: 72,
};

/**
 * Generate a short, URL-safe, roughly time-sortable unique ID.
 * Combines a base-36 timestamp with random characters — not guaranteed to be
 * globally unique but collision probability is negligible for this scale.
 *
 * @returns {string} e.g. "m0u3k4abc123"
 */
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Generate an opaque, hard-to-guess anonymous participant identity.
 * Used for availability/invite records on anonymous meetings where we don't
 * have a logged-in user.id. Stored in availability.user_id as "anon:<id>" so
 * the existing dedup-by-user_id logic continues to work unchanged.
 *
 * @returns {string} e.g. "anon:k0u3k4abc123abc"
 */
export function generateAnonymousParticipantId() {
  return (
    "anon:" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Safely coerce a value to an array.
 * Returns the value itself when it is already an array, otherwise returns [].
 * Use this whenever reading from Netlify Blobs: a malformed or missing record
 * should never cause a crash in calling code.
 *
 * @template T
 * @param {T[]|unknown} value
 * @returns {T[]}
 */
export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Escape a string for safe inclusion in an HTML document.
 * Replaces `&`, `<`, `>`, and `"` with their named HTML entities.
 * Use this on any user-supplied content placed inside HTML markup to prevent
 * Cross-Site Scripting (XSS) attacks.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Compare two secrets in constant time when lengths match.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function secretsEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Build an ordered list of "HH:MM" time-slot strings between startTime and
 * endTime at fixed-minute intervals. The end time itself is excluded.
 *
 * @param {string} startTime - "HH:MM"
 * @param {string} endTime   - "HH:MM"
 * @param {number} [stepMin=15]
 * @returns {string[]}
 */
export function buildTimeSlots(startTime, endTime, stepMin = 15) {
  const [sh, sm] = (startTime || "08:00").split(":").map(Number);
  const [eh, em] = (endTime || "20:00").split(":").map(Number);
  const slots = [];
  let cur = sh * 60 + sm;
  const end = eh * 60 + em;
  while (cur < end) {
    slots.push(
      `${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`
    );
    cur += stepMin;
  }
  return slots;
}

export function localToUTC(dateStr, timeStr, timezone) {
  const localStr = `${dateStr}T${timeStr}:00`;
  const utcCandidate = new Date(localStr + "Z");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};
  fmt.formatToParts(utcCandidate).forEach(({ type, value }) => {
    parts[type] = value;
  });
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const tzStr = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}Z`;
  const tzAsIfUtc = new Date(tzStr);
  const offsetMs = tzAsIfUtc - utcCandidate;
  return new Date(utcCandidate.getTime() - offsetMs);
}

/**
 * Decide whether an anonymous meeting is past the 30-day retention window
 * and eligible for automatic deletion.
 *
 * @param {object} meeting
 * @param {Date}   [now]  Defaults to new Date()
 * @returns {boolean}
 */
export function isAnonymousMeetingExpired(meeting, now = new Date()) {
  if (!meeting || !meeting.anonymous) return false;
  const cutoffMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  const lastActivityStr = meeting.last_activity_at || meeting.created_at;
  const lastActivityMs = lastActivityStr ? Date.parse(lastActivityStr) : NaN;
  if (Number.isFinite(lastActivityMs) && lastActivityMs > cutoffMs) return false;

  if (meeting.meeting_type === "specific_dates" && Array.isArray(meeting.dates_or_days)) {
    const maxDate = [...meeting.dates_or_days]
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
      .sort()
      .pop();
    if (maxDate) {
      const dateMs = Date.parse(`${maxDate}T23:59:59Z`);
      if (Number.isFinite(dateMs) && dateMs > cutoffMs) return false;
    }
  }
  return true;
}
