import test from "node:test";
import assert from "node:assert/strict";

import { buildTimeSlots, secretsEqual } from "../netlify/functions/utils.mjs";

test("buildTimeSlots creates 15-minute slots excluding end time", () => {
  const slots = buildTimeSlots("09:00", "10:00");
  assert.deepEqual(slots, ["09:00", "09:15", "09:30", "09:45"]);
});

test("buildTimeSlots supports custom step", () => {
  const slots = buildTimeSlots("09:00", "10:00", 30);
  assert.deepEqual(slots, ["09:00", "09:30"]);
});

test("secretsEqual returns true for identical secrets", () => {
  assert.equal(secretsEqual("abc123", "abc123"), true);
});

test("secretsEqual returns false for mismatched secrets", () => {
  assert.equal(secretsEqual("abc123", "abc124"), false);
  assert.equal(secretsEqual("short", "longer"), false);
});
