/**
 * ui-utils.mjs — Pure utility functions for the MeetMe frontend.
 *
 * All functions here are pure (no DOM, no module state, no globals).
 * They are shared between booking-availability.js, meeting.js, and
 * the Node.js unit-test suite (test/frontend-utils.test.mjs).
 *
 * Imported by page scripts as an ES module:
 *   import { toMinutes, ... } from '/static/ui-utils.mjs';
 *
 * Imported by tests as a regular Node.js ES module:
 *   import { toMinutes, ... } from '../public/static/ui-utils.mjs';
 */

// ── Time helpers ────────────────────────────────────────────────────────────

/**
 * Convert a "HH:MM" string to total minutes from midnight.
 * @param {string} timeStr
 * @returns {number}
 */
export function toMinutes(timeStr) {
  const [h, m] = String(timeStr || "00:00")
    .split(":")
    .map(Number);
  return h * 60 + m;
}

/**
 * Convert minutes-from-midnight back to a zero-padded "HH:MM" string.
 * @param {number} mins
 * @param {number} [stepMinutes=15] - slot granularity used to clamp the value
 * @returns {string}
 */
export function fromMinutes(mins, stepMinutes = 15) {
  const dayMinutes = 24 * 60;
  const safe = Math.max(0, Math.min(dayMinutes - stepMinutes, mins));
  const hh = String(Math.floor(safe / 60)).padStart(2, "0");
  const mm = String(safe % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Format a "HH:MM" 24-hour time string as "H:MM AM/PM".
 * @param {string} time - "HH:MM"
 * @returns {string}
 */
export function fmtTime12h(time) {
  const [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ── Slot key helpers ────────────────────────────────────────────────────────

/**
 * Compose a unique slot key from a column key and a time string.
 * The separator is "|" and column keys must not contain "|".
 * @param {string} columnKey - weekday name ("Monday") or ISO date ("2025-06-01")
 * @param {string} time - "HH:MM"
 * @returns {string}
 */
export function slotKey(columnKey, time) {
  return `${columnKey}|${time}`;
}

/**
 * Decompose a slot key produced by {@link slotKey}.
 * @param {string} key
 * @returns {{ columnKey: string, time: string }}
 */
export function splitSlotKey(key) {
  const i = key.lastIndexOf("|");
  if (i === -1) return { columnKey: "", time: "" };
  return {
    columnKey: key.slice(0, i),
    time: key.slice(i + 1),
  };
}

// ── Availability data helpers ───────────────────────────────────────────────

/**
 * Normalise a raw availability response from the API, supplying safe defaults.
 * @param {object} [data]
 * @returns {{ mode: string, start_date: string, end_date: string, windows: object[] }}
 */
export function normalizeAvailabilityResponse(data = {}) {
  return {
    mode: data.mode === "specific_dates" ? "specific_dates" : "weekly",
    start_date: data.start_date || "",
    end_date: data.end_date || "",
    windows: Array.isArray(data.windows) ? data.windows : [],
  };
}

/**
 * Convert a list of availability windows into a Set of slot keys.
 *
 * This is the pure, stateless equivalent of the page-level
 * `applyWindowsToSelectedSlots()` — callers pass in all required state as
 * arguments so the function is fully testable in Node.js.
 *
 * @param {object[]} windows - API window objects with start_time/end_time plus
 *   either `date` (specific_dates mode) or `day_of_week` (weekly mode)
 * @param {string} mode - "specific_dates" | "weekly"
 * @param {string[]} columnKeys - ordered list of valid column identifiers
 * @param {number} [stepMinutes=15]
 * @returns {Set<string>}
 */
export function applyWindowsToSlots(windows, mode, columnKeys, stepMinutes = 15) {
  const dayMinutes = 24 * 60;
  const newSelected = new Set();
  const columnSet = new Set(columnKeys);

  windows.forEach((windowItem) => {
    const columnKey = mode === "specific_dates" ? windowItem.date : windowItem.day_of_week;
    if (!columnKey || !columnSet.has(columnKey)) return;

    const start = Math.max(0, Math.min(dayMinutes, toMinutes(windowItem.start_time || "00:00")));
    const end = Math.max(0, Math.min(dayMinutes, toMinutes(windowItem.end_time || "00:00")));
    if (end <= start) return;

    for (let mins = start; mins < end; mins += stepMinutes) {
      newSelected.add(slotKey(columnKey, fromMinutes(mins, stepMinutes)));
    }
  });

  return newSelected;
}

/**
 * Convert a Set of selected slot keys into a list of contiguous time windows.
 *
 * This is the pure, stateless equivalent of the page-level
 * `collectWindowsFromSelectedSlots()`.
 *
 * @param {Set<string>} selectedSlots
 * @param {string} mode - "specific_dates" | "weekly"
 * @param {string} timezone - IANA timezone string
 * @param {number} [stepMinutes=15]
 * @returns {object[]}
 */
export function collectWindowsFromSlots(selectedSlots, mode, timezone, stepMinutes = 15) {
  const byColumn = new Map();

  selectedSlots.forEach((key) => {
    const { columnKey, time } = splitSlotKey(key);
    if (!columnKey || !time) return;
    if (!byColumn.has(columnKey)) byColumn.set(columnKey, []);
    byColumn.get(columnKey).push(toMinutes(time));
  });

  const windows = [];

  byColumn.forEach((minuteList, columnKey) => {
    minuteList.sort((a, b) => a - b);
    if (!minuteList.length) return;

    let runStart = minuteList[0];
    let runEnd = runStart + stepMinutes;

    for (let i = 1; i < minuteList.length; i += 1) {
      const current = minuteList[i];
      if (current === runEnd) {
        runEnd += stepMinutes;
      } else {
        const windowPayload = {
          start_time: fromMinutes(runStart, stepMinutes),
          end_time: fromMinutes(runEnd, stepMinutes),
          timezone,
        };
        if (mode === "specific_dates") windowPayload.date = columnKey;
        else windowPayload.day_of_week = columnKey;
        windows.push(windowPayload);

        runStart = current;
        runEnd = current + stepMinutes;
      }
    }

    const lastWindow = {
      start_time: fromMinutes(runStart, stepMinutes),
      end_time: fromMinutes(runEnd, stepMinutes),
      timezone,
    };
    if (mode === "specific_dates") lastWindow.date = columnKey;
    else lastWindow.day_of_week = columnKey;
    windows.push(lastWindow);
  });

  return windows;
}

// ── Meeting heatmap ─────────────────────────────────────────────────────────

/**
 * Map a slot vote count to a green-intensity CSS colour string.
 *
 * @param {number} count - number of participants who selected this slot
 * @param {number} totalParticipants - total invited (used as denominator)
 * @returns {string} CSS colour value
 */
export function heatColor(count, totalParticipants) {
  if (!count || count === 0) return "#f5f5f5";
  const ratio = Math.min(count / Math.max(totalParticipants, 1), 1);
  if (ratio <= 0) return "#f5f5f5";
  if (ratio <= 0.2) return "#e8f5e9";
  if (ratio <= 0.4) return "#c8e6c9";
  if (ratio <= 0.65) return "#81c784";
  if (ratio <= 0.85) return "#4caf50";
  return "#2e7d32";
}

// ── Timezone conversion ─────────────────────────────────────────────────────

/**
 * Convert a slot's time from one IANA timezone to another.
 *
 * Uses `Intl.DateTimeFormat` to resolve the UTC offset of `fromTz` on the
 * given date, then formats the result in `toTz`.  Returns `null` when the
 * conversion is a no-op (same timezone) or an error occurs.
 *
 * @param {string} date - ISO date "YYYY-MM-DD"
 * @param {string} time - "HH:MM"
 * @param {string} fromTz - source IANA timezone
 * @param {string} toTz - target IANA timezone
 * @returns {string|null} "HH:MM" in `toTz`, or null
 */
export function convertSlotTime(date, time, fromTz, toTz) {
  try {
    if (!date.includes("-") || fromTz === toTz) return null;
    const [y, mo, d] = date.split("-").map(Number);
    const [h, m] = time.split(":").map(Number);
    const utcRef = Date.UTC(y, mo - 1, d, h, m);
    const refDate = new Date(utcRef);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: fromTz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(refDate);
    const get = (partType) => parseInt(parts.find((p) => p.type === partType)?.value || "0");
    const offsetMins = get("hour") * 60 + get("minute") - (h * 60 + m);
    const trueUtc = utcRef - offsetMins * 60000;
    return new Intl.DateTimeFormat("en-US", {
      timeZone: toTz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(trueUtc));
  } catch {
    return null;
  }
}
