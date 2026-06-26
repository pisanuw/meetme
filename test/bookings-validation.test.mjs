import test from "node:test";
import assert from "node:assert/strict";

// bookings-validation imports generateId from utils.mjs (the barrel). Set
// JWT_SECRET so that import does not fail the env-guard on getJwtSecret().
process.env.JWT_SECRET = "test-secret-for-bookings-validation";

import {
  validateEventTypeBody,
  validateAvailabilityBody,
} from "../netlify/functions/lib/bookings-validation.mjs";

// Minimal stubs used throughout.
const AUTH_USER = { id: "u_001", email: "host@example.com" };
const CURRENT_USER = { id: "u_001", email: "host@example.com", timezone: "UTC" };
const BASE_EVENT_TYPE_BODY = {
  title: "30-min call",
  event_type: "one_on_one",
  duration_minutes: 30,
  day_start_time: "08:00",
  day_end_time: "20:00",
  timezone: "UTC",
};
const BASE_EVENT_TYPE = {
  id: "et_001",
  timezone: "UTC",
  day_start_time: "08:00",
  day_end_time: "20:00",
  duration_minutes: 30,
};

// ---------------------------------------------------------------------------
// validateEventTypeBody
// ---------------------------------------------------------------------------

test("validateEventTypeBody accepts a valid one-on-one event", () => {
  const result = validateEventTypeBody(BASE_EVENT_TYPE_BODY, AUTH_USER, CURRENT_USER);
  assert.equal(result.error, null);
  assert.equal(result.data.title, "30-min call");
  assert.equal(result.data.durationMinutes, 30);
  assert.equal(result.data.eventKind, "one_on_one");
});

test("validateEventTypeBody accepts a valid group event", () => {
  const result = validateEventTypeBody(
    { ...BASE_EVENT_TYPE_BODY, event_type: "group", group_capacity: 10 },
    AUTH_USER,
    CURRENT_USER
  );
  assert.equal(result.error, null);
  assert.equal(result.data.eventKind, "group");
  assert.equal(result.data.groupCapacity, 10);
});

test("validateEventTypeBody rejects missing title", () => {
  const result = validateEventTypeBody(
    { ...BASE_EVENT_TYPE_BODY, title: "" },
    AUTH_USER,
    CURRENT_USER
  );
  assert.ok(result.error);
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /title is required/i);
});

test("validateEventTypeBody rejects title over 120 characters", () => {
  const result = validateEventTypeBody(
    { ...BASE_EVENT_TYPE_BODY, title: "x".repeat(121) },
    AUTH_USER,
    CURRENT_USER
  );
  assert.ok(result.error);
  assert.match(result.error.message, /120/);
});

test("validateEventTypeBody rejects description over 1200 characters", () => {
  const result = validateEventTypeBody(
    { ...BASE_EVENT_TYPE_BODY, description: "x".repeat(1201) },
    AUTH_USER,
    CURRENT_USER
  );
  assert.ok(result.error);
  assert.match(result.error.message, /1200/);
});

test("validateEventTypeBody rejects unknown event_type", () => {
  const result = validateEventTypeBody(
    { ...BASE_EVENT_TYPE_BODY, event_type: "webinar" },
    AUTH_USER,
    CURRENT_USER
  );
  assert.ok(result.error);
  assert.match(result.error.message, /one_on_one.*group/i);
});

test("validateEventTypeBody rejects duration_minutes below minimum (15)", () => {
  const result = validateEventTypeBody(
    { ...BASE_EVENT_TYPE_BODY, duration_minutes: 5 },
    AUTH_USER,
    CURRENT_USER
  );
  assert.ok(result.error);
  assert.match(result.error.message, /duration_minutes/i);
});

test("validateEventTypeBody rejects duration_minutes above maximum (180)", () => {
  const result = validateEventTypeBody(
    { ...BASE_EVENT_TYPE_BODY, duration_minutes: 999 },
    AUTH_USER,
    CURRENT_USER
  );
  assert.ok(result.error);
  assert.match(result.error.message, /duration_minutes/i);
});

test("validateEventTypeBody rejects group_capacity above 100", () => {
  const result = validateEventTypeBody(
    { ...BASE_EVENT_TYPE_BODY, event_type: "group", group_capacity: 101 },
    AUTH_USER,
    CURRENT_USER
  );
  assert.ok(result.error);
  assert.match(result.error.message, /group_capacity/i);
});

test("validateEventTypeBody rejects creating more than 25 event types", () => {
  const existingIds = Array.from({ length: 25 }, (_, i) => `et_${i}`);
  const result = validateEventTypeBody(
    BASE_EVENT_TYPE_BODY,
    AUTH_USER,
    CURRENT_USER,
    existingIds
  );
  assert.ok(result.error);
  assert.match(result.error.message, /25/);
});

test("validateEventTypeBody allows update when limit is reached (id provided)", () => {
  const existingIds = Array.from({ length: 25 }, (_, i) => `et_${i}`);
  const result = validateEventTypeBody(
    { ...BASE_EVENT_TYPE_BODY, id: "et_0" },
    AUTH_USER,
    CURRENT_USER,
    existingIds
  );
  assert.equal(result.error, null);
});

// ---------------------------------------------------------------------------
// validateAvailabilityBody
// ---------------------------------------------------------------------------

const WEEKLY_BODY = {
  event_type_id: "et_001",
  mode: "weekly",
  windows: [{ day_of_week: "Monday", start_time: "09:00", end_time: "17:00" }],
};

const SPECIFIC_BODY = {
  event_type_id: "et_001",
  mode: "specific_dates",
  start_date: "2026-07-01",
  end_date: "2026-07-31",
  windows: [{ date: "2026-07-15", start_time: "09:00", end_time: "17:00" }],
};

test("validateAvailabilityBody accepts valid weekly windows", () => {
  const result = validateAvailabilityBody(WEEKLY_BODY, BASE_EVENT_TYPE);
  assert.equal(result.error, null);
  assert.equal(result.data.mode, "weekly");
  assert.equal(result.data.windows.length, 1);
  assert.equal(result.data.windows[0].day_of_week, "Monday");
});

test("validateAvailabilityBody accepts valid specific-date windows", () => {
  const result = validateAvailabilityBody(SPECIFIC_BODY, BASE_EVENT_TYPE);
  assert.equal(result.error, null);
  assert.equal(result.data.mode, "specific_dates");
  assert.equal(result.data.windows[0].date, "2026-07-15");
});

test("validateAvailabilityBody rejects missing event_type_id", () => {
  const result = validateAvailabilityBody({ ...WEEKLY_BODY, event_type_id: "" }, BASE_EVENT_TYPE);
  assert.ok(result.error);
  assert.match(result.error.message, /event_type_id is required/i);
});

test("validateAvailabilityBody rejects unknown mode", () => {
  const result = validateAvailabilityBody({ ...WEEKLY_BODY, mode: "monthly" }, BASE_EVENT_TYPE);
  assert.ok(result.error);
  assert.match(result.error.message, /weekly.*specific_dates/i);
});

test("validateAvailabilityBody rejects start_date without end_date", () => {
  const result = validateAvailabilityBody(
    { ...WEEKLY_BODY, start_date: "2026-07-01" },
    BASE_EVENT_TYPE
  );
  assert.ok(result.error);
  assert.match(result.error.message, /both.*provided/i);
});

test("validateAvailabilityBody rejects end_time not after start_time in a window", () => {
  const result = validateAvailabilityBody(
    {
      ...WEEKLY_BODY,
      windows: [{ day_of_week: "Monday", start_time: "17:00", end_time: "09:00" }],
    },
    BASE_EVENT_TYPE
  );
  assert.ok(result.error);
  assert.match(result.error.message, /after start_time/i);
});

test("validateAvailabilityBody rejects invalid day_of_week", () => {
  const result = validateAvailabilityBody(
    {
      ...WEEKLY_BODY,
      windows: [{ day_of_week: "Someday", start_time: "09:00", end_time: "17:00" }],
    },
    BASE_EVENT_TYPE
  );
  assert.ok(result.error);
  assert.match(result.error.message, /Someday/);
});

test("validateAvailabilityBody rejects specific-date window outside date range", () => {
  const result = validateAvailabilityBody(
    {
      ...SPECIFIC_BODY,
      windows: [{ date: "2026-08-01", start_time: "09:00", end_time: "17:00" }],
    },
    BASE_EVENT_TYPE
  );
  assert.ok(result.error);
  assert.match(result.error.message, /within.*date range/i);
});

test("validateAvailabilityBody assigns generated ids to windows", () => {
  const result = validateAvailabilityBody(WEEKLY_BODY, BASE_EVENT_TYPE);
  assert.equal(result.error, null);
  assert.ok(result.data.windows[0].id, "each window gets a generated id");
});
