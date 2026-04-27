/**
 * bookings-availability.mjs — Availability config normalization, slot generation, and
 * composing a booking-ready slot list accounting for calendar conflicts and capacity.
 */
import { asArray, localToUTC } from "../utils.mjs";
import {
  SLOT_STEP_MINUTES,
  ALLOWED_AVAILABILITY_MODES,
  toMinutes,
  isDateInRange,
  getWeekdayForDate,
  getAvailabilityKey,
} from "./bookings-helpers.mjs";
import { fetchBusyPeriodsForDate } from "./bookings-calendar.mjs";

export function normalizeAvailabilityConfig(raw, fallbackTimezone = "UTC") {
  if (Array.isArray(raw)) {
    return {
      mode: "weekly",
      start_date: "",
      end_date: "",
      timezone: fallbackTimezone,
      windows: raw,
    };
  }

  const mode = String(raw?.mode || "weekly").trim();
  const normalizedMode = ALLOWED_AVAILABILITY_MODES.has(mode) ? mode : "weekly";

  return {
    mode: normalizedMode,
    start_date: String(raw?.start_date || "").trim(),
    end_date: String(raw?.end_date || "").trim(),
    timezone: String(raw?.timezone || fallbackTimezone).trim() || fallbackTimezone,
    windows: asArray(raw?.windows),
  };
}

export async function loadAvailabilityConfig(availabilityDb, ownerId, eventTypeId, fallbackTimezone = "UTC") {
  if (!eventTypeId) {
    return normalizeAvailabilityConfig([], fallbackTimezone);
  }

  const specific = await availabilityDb
    .get(getAvailabilityKey(ownerId, eventTypeId), { type: "json" })
    .catch(() => null);
  if (specific) return normalizeAvailabilityConfig(specific, fallbackTimezone);

  const legacy = await availabilityDb.get(`owner:${ownerId}`, { type: "json" }).catch(() => null);
  return normalizeAvailabilityConfig(legacy || [], fallbackTimezone);
}

export function buildSlotCandidates(eventType, availabilityConfig, dateStr) {
  const config = normalizeAvailabilityConfig(availabilityConfig, eventType.timezone || "UTC");
  if (!isDateInRange(dateStr, config.start_date, config.end_date)) return [];

  const eventTz = eventType.timezone || "UTC";
  let dayWindows = [];

  if (config.mode === "specific_dates") {
    dayWindows = config.windows.filter((w) => String(w.date || "").trim() === dateStr);
  } else {
    const dayName = getWeekdayForDate(dateStr, eventTz);
    dayWindows = config.windows.filter((w) => w.day_of_week === dayName);
  }

  const slots = [];
  for (const window of dayWindows) {
    const startMinutes = toMinutes(window.start_time);
    const endMinutes = toMinutes(window.end_time);
    for (
      let cur = startMinutes;
      cur + eventType.duration_minutes <= endMinutes;
      cur += SLOT_STEP_MINUTES
    ) {
      const hh = String(Math.floor(cur / 60)).padStart(2, "0");
      const mm = String(cur % 60).padStart(2, "0");
      slots.push(`${hh}:${mm}`);
    }
  }

  return [...new Set(slots)].sort();
}

export async function buildSlotsResponse({ eventType, dateStr, availabilityConfig, bookingsDb, usersDb, hostUser }) {
  const candidates = buildSlotCandidates(eventType, availabilityConfig, dateStr);
  if (candidates.length === 0) return { slots: [], blocked_by_calendar: [] };

  const firstStart = candidates[0];
  const lastStart = candidates[candidates.length - 1];
  const endMin = toMinutes(lastStart) + eventType.duration_minutes;
  const lastEnd = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;

  const busyPeriods = await fetchBusyPeriodsForDate(
    usersDb,
    hostUser,
    eventType.timezone || "UTC",
    dateStr,
    firstStart,
    lastEnd
  );

  const available = [];
  const blockedByCalendar = [];

  for (const slot of candidates) {
    const slotKey = `slot:${eventType.id}:${dateStr}:${slot}`;
    const slotBookingIds = asArray(await bookingsDb.get(slotKey, { type: "json" }).catch(() => []));

    let confirmedCount = 0;
    for (const bookingId of slotBookingIds) {
      const booking = await bookingsDb.get(`booking:${bookingId}`, { type: "json" }).catch(() => null);
      if (booking?.status === "confirmed") confirmedCount += 1;
    }
    if (confirmedCount >= (eventType.group_capacity || 1)) continue;

    const slotStartMs = localToUTC(dateStr, slot, eventType.timezone || "UTC").getTime();
    const slotEndMs = slotStartMs + eventType.duration_minutes * 60 * 1000;
    const overlapsBusy = busyPeriods.some((p) => slotStartMs < p.end && slotEndMs > p.start);

    if (overlapsBusy) {
      blockedByCalendar.push(slot);
      continue;
    }
    available.push(slot);
  }

  return { slots: available, blocked_by_calendar: blockedByCalendar };
}
