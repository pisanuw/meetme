/**
 * bookings-validation.mjs — Pure validation helpers for booking route handlers.
 *
 * Each function returns { error: null, data: {...} } on success,
 * or { error: { status, message } } on failure.
 */
import { asArray, generateId, LIMITS } from "../utils.mjs";
import {
  ALLOWED_EVENT_TYPES,
  ALLOWED_AVAILABILITY_MODES,
  ALLOWED_WEEKDAYS,
  isValidTime,
  isValidDate,
  isDateInRange,
  toMinutes,
  slugify,
} from "./bookings-helpers.mjs";

/**
 * Validates and coerces the POST /api/bookings/event-types request body.
 *
 * @returns { error: null, data: eventType } | { error: { status, message } }
 */
export function validateEventTypeBody(body, authUser, currentUser, existingIds = []) {
  const title = String(body.title || "").trim();
  const description = String(body.description || "").trim();
  const eventKind = String(body.event_type || "one_on_one").trim();
  const durationMinutes = Number.parseInt(body.duration_minutes || "30", 10);
  const dayStartTime = String(body.day_start_time || "08:00").trim();
  const dayEndTime = String(body.day_end_time || "20:00").trim();
  const timezone = String(body.timezone || currentUser.timezone || "UTC").trim();
  const groupCapacity = Number.parseInt(
    body.group_capacity || (eventKind === "group" ? "5" : "1"),
    10
  );
  const enabled = body.enabled !== false;
  const eventTypeId = String(body.id || "").trim();

  if (!title) return { error: { status: 400, message: "Event title is required." } };
  if (title.length > LIMITS.BOOKING_EVENT_TITLE_MAX) {
    return { error: { status: 400, message: `Event title must be ${LIMITS.BOOKING_EVENT_TITLE_MAX} characters or fewer.` } };
  }
  if (description.length > LIMITS.BOOKING_EVENT_DESCRIPTION_MAX) {
    return { error: { status: 400, message: `Description must be ${LIMITS.BOOKING_EVENT_DESCRIPTION_MAX} characters or fewer.` } };
  }
  if (!ALLOWED_EVENT_TYPES.has(eventKind)) {
    return { error: { status: 400, message: "event_type must be one_on_one or group." } };
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes < LIMITS.DURATION_MIN || durationMinutes > LIMITS.BOOKING_DURATION_MAX) {
    return { error: { status: 400, message: `duration_minutes must be between ${LIMITS.DURATION_MIN} and ${LIMITS.BOOKING_DURATION_MAX}.` } };
  }
  if (!Number.isFinite(groupCapacity) || groupCapacity < 1 || groupCapacity > LIMITS.BOOKING_GROUP_CAPACITY_MAX) {
    return { error: { status: 400, message: `group_capacity must be between 1 and ${LIMITS.BOOKING_GROUP_CAPACITY_MAX}.` } };
  }
  if (!eventTypeId && existingIds.length >= LIMITS.BOOKING_EVENT_TYPES_MAX) {
    return { error: { status: 400, message: `You can create at most ${LIMITS.BOOKING_EVENT_TYPES_MAX} event types.` } };
  }

  return {
    error: null,
    data: {
      eventTypeId,
      title,
      description,
      eventKind,
      durationMinutes,
      dayStartTime,
      dayEndTime,
      timezone,
      groupCapacity,
      enabled,
    },
  };
}

/**
 * Builds and validates the normalized availability windows for
 * POST /api/bookings/availability.
 *
 * @returns { error: null, data: { payload } } | { error: { status, message } }
 */
export function validateAvailabilityBody(body, eventType) {
  const eventTypeId = String(body.event_type_id || "").trim();
  if (!eventTypeId) return { error: { status: 400, message: "event_type_id is required." } };

  const mode = String(body.mode || "weekly").trim();
  if (!ALLOWED_AVAILABILITY_MODES.has(mode)) {
    return { error: { status: 400, message: "mode must be weekly or specific_dates." } };
  }

  const startDate = String(body.start_date || "").trim();
  const endDate = String(body.end_date || "").trim();
  if ((startDate && !endDate) || (!startDate && endDate)) {
    return { error: { status: 400, message: "start_date and end_date must both be provided when using a date range." } };
  }
  if (startDate && (!isValidDate(startDate) || !isValidDate(endDate))) {
    return { error: { status: 400, message: "start_date and end_date must be in YYYY-MM-DD format." } };
  }
  if (startDate && startDate > endDate) {
    return { error: { status: 400, message: "start_date must be on or before end_date." } };
  }

  const defaultTimezone = String(body.timezone || eventType.timezone || "UTC").trim() || "UTC";
  const windows = asArray(body.windows);
  if (windows.length > LIMITS.BOOKING_AVAIL_WINDOWS_MAX) {
    return { error: { status: 400, message: `You can set at most ${LIMITS.BOOKING_AVAIL_WINDOWS_MAX} availability windows.` } };
  }

  const normalized = [];
  for (const row of windows) {
    const startTime = String(row?.start_time || "").trim();
    const endTime = String(row?.end_time || "").trim();
    const timezone = String(row?.timezone || defaultTimezone).trim() || defaultTimezone;

    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      return { error: { status: 400, message: "start_time and end_time must use HH:MM format." } };
    }
    if (toMinutes(startTime) >= toMinutes(endTime)) {
      return { error: { status: 400, message: "end_time must be after start_time." } };
    }

    if (mode === "specific_dates") {
      const date = String(row?.date || "").trim();
      if (!isValidDate(date)) {
        return { error: { status: 400, message: "Each availability row must include a valid date in YYYY-MM-DD format." } };
      }
      if (!isDateInRange(date, startDate, endDate)) {
        return { error: { status: 400, message: "Availability date must be within the selected date range." } };
      }
      normalized.push({ id: generateId(), date, start_time: startTime, end_time: endTime, timezone });
    } else {
      const dayOfWeek = String(row?.day_of_week || "").trim();
      if (!ALLOWED_WEEKDAYS.has(dayOfWeek)) {
        return { error: { status: 400, message: `Invalid day_of_week '${dayOfWeek}'.` } };
      }
      normalized.push({ id: generateId(), day_of_week: dayOfWeek, start_time: startTime, end_time: endTime, timezone });
    }
  }

  return {
    error: null,
    data: {
      event_type_id: eventTypeId,
      mode,
      start_date: startDate,
      end_date: endDate,
      timezone: defaultTimezone,
      windows: normalized,
      updated_at: new Date().toISOString(),
    },
  };
}
