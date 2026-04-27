/**
 * bookings-helpers.mjs — Pure utility functions used across booking modules.
 */

export const SLOT_STEP_MINUTES = 15;
export const DEFAULT_REMINDER_WINDOW_HOURS = 24;

export const ALLOWED_AVAILABILITY_MODES = new Set(["weekly", "specific_dates"]);

export const ALLOWED_WEEKDAYS = new Set([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

export const ALLOWED_EVENT_TYPES = new Set(["one_on_one", "group"]);

export function toMinutes(timeStr) {
  const [h, m] = String(timeStr || "").split(":").map(Number);
  return h * 60 + m;
}

export function isValidTime(timeStr) {
  return /^\d{2}:\d{2}$/.test(String(timeStr || ""));
}

export function isValidDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""));
}

export function isDateInRange(dateStr, startDate, endDate) {
  if (!startDate || !endDate) return true;
  return dateStr >= startDate && dateStr <= endDate;
}

export function slugify(value) {
  const base = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "user";
}

export function getWeekdayForDate(dateStr, timezone) {
  const utcNoon = new Date(`${dateStr}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: timezone || "UTC",
  }).format(utcNoon);
}

export function eventTypePublicView(eventType) {
  return {
    id: eventType.id,
    title: eventType.title,
    description: eventType.description,
    event_type: eventType.event_type,
    duration_minutes: eventType.duration_minutes,
    day_start_time: eventType.day_start_time || "08:00",
    day_end_time: eventType.day_end_time || "20:00",
    group_capacity: eventType.group_capacity,
    timezone: eventType.timezone,
  };
}

export function getAvailabilityKey(ownerId, eventTypeId) {
  return `owner:${ownerId}:event_type:${eventTypeId}`;
}
