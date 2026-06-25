import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAvailabilityConfig,
  buildSlotCandidates,
} from "../netlify/functions/lib/bookings-availability.mjs";
import { localToUTC } from "../netlify/functions/lib/utils-core.mjs";

// 2026-06-25 is a Thursday when resolved at UTC noon, matching getWeekdayForDate.
const THURSDAY = "2026-06-25";

test("normalizeAvailabilityConfig wraps a bare windows array as weekly", () => {
  const windows = [{ day_of_week: "Thursday", start_time: "09:00", end_time: "10:00" }];
  const config = normalizeAvailabilityConfig(windows, "America/New_York");
  assert.equal(config.mode, "weekly");
  assert.equal(config.timezone, "America/New_York");
  assert.equal(config.start_date, "");
  assert.deepEqual(config.windows, windows);
});

test("normalizeAvailabilityConfig falls back to weekly for an unknown mode", () => {
  const config = normalizeAvailabilityConfig(
    { mode: "monthly", windows: [], timezone: "  " },
    "UTC"
  );
  assert.equal(config.mode, "weekly");
  assert.equal(config.timezone, "UTC"); // a blank timezone uses the fallback
});

test("buildSlotCandidates generates 15-minute starts that fit the duration", () => {
  const eventType = { duration_minutes: 30, timezone: "UTC" };
  const config = {
    mode: "weekly",
    windows: [{ day_of_week: "Thursday", start_time: "09:00", end_time: "10:00" }],
  };
  // A 30-min meeting in 09:00-10:00: 09:00, 09:15, 09:30 (09:45 would end at 10:15).
  assert.deepEqual(buildSlotCandidates(eventType, config, THURSDAY), ["09:00", "09:15", "09:30"]);
});

test("buildSlotCandidates excludes a slot whose duration overruns the window", () => {
  const eventType = { duration_minutes: 60, timezone: "UTC" };
  const config = {
    mode: "weekly",
    windows: [{ day_of_week: "Thursday", start_time: "09:00", end_time: "09:45" }],
  };
  // No 60-minute slot fits inside a 45-minute window.
  assert.deepEqual(buildSlotCandidates(eventType, config, THURSDAY), []);
});

test("buildSlotCandidates merges, sorts, and dedupes overlapping windows", () => {
  const eventType = { duration_minutes: 15, timezone: "UTC" };
  const config = {
    mode: "weekly",
    windows: [
      { day_of_week: "Thursday", start_time: "09:30", end_time: "10:00" },
      { day_of_week: "Thursday", start_time: "09:00", end_time: "09:45" },
    ],
  };
  // The 09:30/09:45 overlap must not be duplicated, and the result is sorted.
  assert.deepEqual(buildSlotCandidates(eventType, config, THURSDAY), [
    "09:00",
    "09:15",
    "09:30",
    "09:45",
  ]);
});

test("buildSlotCandidates ignores windows for other weekdays", () => {
  const eventType = { duration_minutes: 15, timezone: "UTC" };
  const config = {
    mode: "weekly",
    windows: [{ day_of_week: "Monday", start_time: "09:00", end_time: "12:00" }],
  };
  assert.deepEqual(buildSlotCandidates(eventType, config, THURSDAY), []);
});

test("buildSlotCandidates in specific_dates mode only uses matching dates", () => {
  const eventType = { duration_minutes: 30, timezone: "UTC" };
  const config = {
    mode: "specific_dates",
    windows: [
      { date: THURSDAY, start_time: "09:00", end_time: "10:00" },
      { date: "2026-06-26", start_time: "13:00", end_time: "17:00" },
    ],
  };
  assert.deepEqual(buildSlotCandidates(eventType, config, THURSDAY), ["09:00", "09:15", "09:30"]);
});

test("buildSlotCandidates returns nothing for a date outside the configured range", () => {
  const eventType = { duration_minutes: 30, timezone: "UTC" };
  const config = {
    mode: "weekly",
    start_date: "2026-07-01",
    end_date: "2026-07-31",
    windows: [{ day_of_week: "Thursday", start_time: "09:00", end_time: "17:00" }],
  };
  assert.deepEqual(buildSlotCandidates(eventType, config, THURSDAY), []);
});

test("localToUTC honors DST offsets at the slot boundary", () => {
  // America/New_York is UTC-4 in July (EDT) and UTC-5 in January (EST).
  assert.equal(
    localToUTC("2026-07-01", "12:00", "America/New_York").toISOString(),
    "2026-07-01T16:00:00.000Z"
  );
  assert.equal(
    localToUTC("2026-01-15", "12:00", "America/New_York").toISOString(),
    "2026-01-15T17:00:00.000Z"
  );
});
