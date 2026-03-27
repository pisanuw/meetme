import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTimeSlots,
  secretsEqual,
  validateEmail,
  encryptSecret,
  decryptSecret,
  setCookie,
  clearCookie,
  isRateLimitEnabled,
} from "../netlify/functions/utils.mjs";

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

test("validateEmail normalizes valid email", () => {
  assert.equal(validateEmail("  User@Example.com  "), "user@example.com");
});

test("validateEmail rejects clearly invalid values", () => {
  assert.equal(validateEmail("no-at-symbol"), null);
  assert.equal(validateEmail("user@nodot"), null);
});

test("encryptSecret/decryptSecret round-trip works", () => {
  process.env.JWT_SECRET = "test-secret";
  const encrypted = encryptSecret("super-secret-token");
  assert.match(encrypted, /^enc:v1:/);
  assert.equal(decryptSecret(encrypted), "super-secret-token");
});

test("decryptSecret returns empty string for tampered ciphertext", () => {
  process.env.JWT_SECRET = "test-secret";
  const encrypted = encryptSecret("super-secret-token");
  const tampered = encrypted.slice(0, -2) + "zz";
  assert.equal(decryptSecret(tampered), "");
});

test("isRateLimitEnabled honors DISABLE_RATE_LIMIT flag", () => {
  process.env.DISABLE_RATE_LIMIT = "true";
  assert.equal(isRateLimitEnabled(), false);
  process.env.DISABLE_RATE_LIMIT = "";
  assert.equal(isRateLimitEnabled(), true);
});

test("setCookie uses secure flag override", () => {
  process.env.COOKIE_SECURE = "true";
  const secureCookie = setCookie("token", "abc", 60);
  assert.match(secureCookie, /; Secure/);

  process.env.COOKIE_SECURE = "false";
  const nonSecureCookie = setCookie("token", "abc", 60);
  assert.doesNotMatch(nonSecureCookie, /; Secure/);
});

test("clearCookie keeps same security mode behavior", () => {
  process.env.COOKIE_SECURE = "false";
  const cookie = clearCookie("token");
  assert.match(cookie, /Max-Age=0/);
  assert.doesNotMatch(cookie, /; Secure/);
});
