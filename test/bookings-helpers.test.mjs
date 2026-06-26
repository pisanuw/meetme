import test from "node:test";
import assert from "node:assert/strict";

import {
  toMinutes,
  isValidTime,
  isValidDate,
  isDateInRange,
  slugify,
  getWeekdayForDate,
} from "../netlify/functions/lib/bookings-helpers.mjs";

// ---------------------------------------------------------------------------
// toMinutes
// ---------------------------------------------------------------------------

test("toMinutes converts HH:MM to total minutes", () => {
  assert.equal(toMinutes("00:00"), 0);
  assert.equal(toMinutes("01:30"), 90);
  assert.equal(toMinutes("09:00"), 540);
  assert.equal(toMinutes("23:59"), 23 * 60 + 59);
});

// ---------------------------------------------------------------------------
// isValidTime
// ---------------------------------------------------------------------------

test("isValidTime accepts valid 24-hour times", () => {
  assert.ok(isValidTime("00:00"));
  assert.ok(isValidTime("09:00"));
  assert.ok(isValidTime("23:59"));
  assert.ok(isValidTime("12:30"));
});

test("isValidTime rejects malformed strings", () => {
  assert.equal(isValidTime("9:00"), false);
  assert.equal(isValidTime("9am"), false);
  assert.equal(isValidTime(""), false);
  assert.equal(isValidTime(null), false);
});

test("isValidTime rejects out-of-range values", () => {
  assert.equal(isValidTime("24:00"), false);
  assert.equal(isValidTime("12:60"), false);
});

// ---------------------------------------------------------------------------
// isValidDate
// ---------------------------------------------------------------------------

test("isValidDate accepts YYYY-MM-DD format", () => {
  assert.ok(isValidDate("2026-07-01"));
  assert.ok(isValidDate("2000-01-31"));
});

test("isValidDate rejects non-YYYY-MM-DD strings", () => {
  assert.equal(isValidDate("2026-7-1"), false);
  assert.equal(isValidDate("07/01/2026"), false);
  assert.equal(isValidDate(""), false);
  assert.equal(isValidDate(null), false);
});

test("isValidDate rejects out-of-range month/day", () => {
  assert.equal(isValidDate("2026-00-01"), false);
  assert.equal(isValidDate("2026-13-01"), false);
  assert.equal(isValidDate("2026-01-00"), false);
  assert.equal(isValidDate("2026-01-32"), false);
});

// ---------------------------------------------------------------------------
// isDateInRange
// ---------------------------------------------------------------------------

test("isDateInRange returns true when date is within range", () => {
  assert.ok(isDateInRange("2026-07-15", "2026-07-01", "2026-07-31"));
});

test("isDateInRange returns true for boundary dates", () => {
  assert.ok(isDateInRange("2026-07-01", "2026-07-01", "2026-07-31"));
  assert.ok(isDateInRange("2026-07-31", "2026-07-01", "2026-07-31"));
});

test("isDateInRange returns false outside range", () => {
  assert.equal(isDateInRange("2026-06-30", "2026-07-01", "2026-07-31"), false);
  assert.equal(isDateInRange("2026-08-01", "2026-07-01", "2026-07-31"), false);
});

test("isDateInRange returns true when no start/end provided", () => {
  assert.ok(isDateInRange("2026-07-15", null, null));
  assert.ok(isDateInRange("2026-07-15", "", ""));
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

test("slugify lowercases and replaces spaces", () => {
  assert.equal(slugify("Jane Doe"), "jane-doe");
});

test("slugify strips leading and trailing hyphens", () => {
  assert.equal(slugify("  hello world  "), "hello-world");
});

test("slugify replaces non-alphanumeric runs with a single hyphen", () => {
  assert.equal(slugify("hello...world"), "hello-world");
});

test("slugify returns 'user' for empty/blank input", () => {
  assert.equal(slugify(""), "user");
  assert.equal(slugify(null), "user");
  assert.equal(slugify("!!!"), "user");
});

// ---------------------------------------------------------------------------
// getWeekdayForDate
// ---------------------------------------------------------------------------

test("getWeekdayForDate returns correct weekday regardless of timezone", () => {
  // 2026-06-01 is a Monday
  assert.equal(getWeekdayForDate("2026-06-01"), "Monday");
  // 2026-06-07 is a Sunday
  assert.equal(getWeekdayForDate("2026-06-07"), "Sunday");
  // 2026-07-04 is a Saturday
  assert.equal(getWeekdayForDate("2026-07-04"), "Saturday");
});
