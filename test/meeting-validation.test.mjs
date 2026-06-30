import test from "node:test";
import assert from "node:assert/strict";

import {
  validateCreateMeetingBody,
  validateFinalizeBody,
  validateInviteEmails,
} from "../netlify/functions/lib/meeting-validation.mjs";

// ---------------------------------------------------------------------------
// validateCreateMeetingBody
// ---------------------------------------------------------------------------

const VALID_BODY = {
  title: "Team sync",
  meeting_type: "specific_dates",
  dates_or_days: ["2026-07-01", "2026-07-02"],
  timezone: "UTC",
  start_time: "09:00",
  end_time: "17:00",
};

test("validateCreateMeetingBody accepts a valid specific-dates body", () => {
  const result = validateCreateMeetingBody(VALID_BODY);
  assert.equal(result.error, null);
  assert.equal(result.data.normalizedTitle, "Team sync");
  assert.equal(result.data.normalizedMeetingType, "specific_dates");
  assert.deepEqual(result.data.normalizedDatesOrDays, ["2026-07-01", "2026-07-02"]);
});

test("validateCreateMeetingBody accepts a valid days-of-week body", () => {
  const result = validateCreateMeetingBody({
    title: "Weekly standup",
    meeting_type: "days_of_week",
    dates_or_days: ["Monday", "Wednesday", "Friday"],
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.data.normalizedDatesOrDays, ["Monday", "Wednesday", "Friday"]);
});

test("validateCreateMeetingBody rejects missing title", () => {
  const result = validateCreateMeetingBody({ ...VALID_BODY, title: "" });
  assert.ok(result.error);
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /title is required/i);
});

test("validateCreateMeetingBody rejects title over 200 characters", () => {
  const result = validateCreateMeetingBody({ ...VALID_BODY, title: "x".repeat(201) });
  assert.ok(result.error);
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /200/);
});

test("validateCreateMeetingBody rejects description over 2000 characters", () => {
  const result = validateCreateMeetingBody({ ...VALID_BODY, description: "x".repeat(2001) });
  assert.ok(result.error);
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /2000/);
});

test("validateCreateMeetingBody rejects unknown meeting_type", () => {
  const result = validateCreateMeetingBody({ ...VALID_BODY, meeting_type: "quarterly" });
  assert.ok(result.error);
  assert.match(result.error.message, /specific_dates.*days_of_week/i);
});

test("validateCreateMeetingBody rejects empty dates_or_days", () => {
  const result = validateCreateMeetingBody({ ...VALID_BODY, dates_or_days: [] });
  assert.ok(result.error);
  assert.match(result.error.message, /at least one/i);
});

test("validateCreateMeetingBody rejects a malformed date string", () => {
  const result = validateCreateMeetingBody({
    ...VALID_BODY,
    dates_or_days: ["2026-7-1"],
  });
  assert.ok(result.error);
  assert.match(result.error.message, /YYYY-MM-DD/);
});

test("validateCreateMeetingBody rejects an invalid day name", () => {
  const result = validateCreateMeetingBody({
    ...VALID_BODY,
    meeting_type: "days_of_week",
    dates_or_days: ["Monday", "Someday"],
  });
  assert.ok(result.error);
  assert.match(result.error.message, /Someday/);
});

test("validateCreateMeetingBody rejects malformed start_time", () => {
  const result = validateCreateMeetingBody({ ...VALID_BODY, start_time: "9:00" });
  assert.ok(result.error);
  assert.match(result.error.message, /HH:MM/);
});

test("validateCreateMeetingBody rejects malformed end_time", () => {
  const result = validateCreateMeetingBody({ ...VALID_BODY, end_time: "5pm" });
  assert.ok(result.error);
  assert.match(result.error.message, /HH:MM/);
});

test("validateCreateMeetingBody rejects end_time not after start_time", () => {
  const result = validateCreateMeetingBody({
    ...VALID_BODY,
    start_time: "17:00",
    end_time: "09:00",
  });
  assert.ok(result.error);
  assert.match(result.error.message, /after start_time/i);
});

test("validateCreateMeetingBody rejects an invalid timezone", () => {
  const result = validateCreateMeetingBody({ ...VALID_BODY, timezone: "Not/Real" });
  assert.ok(result.error);
  assert.match(result.error.message, /timezone/i);
});

test("validateCreateMeetingBody accepts UTC timezone explicitly", () => {
  const result = validateCreateMeetingBody({ ...VALID_BODY, timezone: "UTC" });
  assert.equal(result.error, null);
});

test("validateCreateMeetingBody deduplicates dates_or_days", () => {
  const result = validateCreateMeetingBody({
    ...VALID_BODY,
    dates_or_days: ["2026-07-01", "2026-07-01", "2026-07-02"],
  });
  assert.equal(result.error, null);
  assert.equal(result.data.normalizedDatesOrDays.length, 2);
});

// ---------------------------------------------------------------------------
// validateFinalizeBody
// ---------------------------------------------------------------------------

test("validateFinalizeBody accepts valid finalize data", () => {
  const result = validateFinalizeBody({
    date_or_day: "2026-07-01",
    time_slot: "09:00",
    duration_minutes: 60,
  });
  assert.equal(result.error, null);
  assert.equal(result.durationMinutes, 60);
});

test("validateFinalizeBody defaults duration_minutes to 60", () => {
  const result = validateFinalizeBody({ date_or_day: "2026-07-01", time_slot: "09:00" });
  assert.equal(result.error, null);
  assert.equal(result.durationMinutes, 60);
});

test("validateFinalizeBody rejects missing date_or_day", () => {
  const result = validateFinalizeBody({ time_slot: "09:00", duration_minutes: 60 });
  assert.ok(result.error);
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /date_or_day.*time_slot/i);
});

test("validateFinalizeBody rejects missing time_slot", () => {
  const result = validateFinalizeBody({ date_or_day: "2026-07-01", duration_minutes: 60 });
  assert.ok(result.error);
  assert.match(result.error.message, /date_or_day.*time_slot/i);
});

test("validateFinalizeBody rejects duration_minutes below minimum", () => {
  const result = validateFinalizeBody({
    date_or_day: "2026-07-01",
    time_slot: "09:00",
    duration_minutes: 5,
  });
  assert.ok(result.error);
  assert.match(result.error.message, /duration_minutes/i);
});

test("validateFinalizeBody rejects duration_minutes above maximum", () => {
  const result = validateFinalizeBody({
    date_or_day: "2026-07-01",
    time_slot: "09:00",
    duration_minutes: 99999,
  });
  assert.ok(result.error);
  assert.match(result.error.message, /duration_minutes/i);
});

// ---------------------------------------------------------------------------
// validateInviteEmails
// ---------------------------------------------------------------------------

test("validateInviteEmails returns empty array for no invites", () => {
  const result = validateInviteEmails(undefined, "creator@example.com");
  assert.equal(result.error, null);
  assert.deepEqual(result.emails, []);
});

test("validateInviteEmails parses comma-separated addresses", () => {
  const result = validateInviteEmails("a@example.com,b@example.com", "creator@example.com");
  assert.equal(result.error, null);
  assert.equal(result.emails.length, 2);
});

test("validateInviteEmails excludes the creator email", () => {
  const result = validateInviteEmails("creator@example.com,a@example.com", "creator@example.com");
  assert.equal(result.error, null);
  assert.deepEqual(result.emails, ["a@example.com"]);
});

test("validateInviteEmails deduplicates addresses", () => {
  const result = validateInviteEmails(
    "a@example.com,a@example.com,b@example.com",
    "creator@example.com"
  );
  assert.equal(result.error, null);
  assert.equal(result.emails.length, 2);
});

test("validateInviteEmails accepts an array input", () => {
  const result = validateInviteEmails(["a@example.com", "b@example.com"], "creator@example.com");
  assert.equal(result.error, null);
  assert.equal(result.emails.length, 2);
});
