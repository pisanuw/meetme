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
  generateId,
  asArray,
  escapeHtml,
  createToken,
  verifyToken,
  verifyTokenVerbose,
  getUserFromRequest,
  safeJson,
  jsonResponse,
  errorResponse,
  getAppUrl,
  isAdmin,
  isSuperAdminEmail,
  sanitizeUser,
  checkRateLimit,
  listMeetingIds,
} from "../netlify/functions/utils.mjs";
import { installInMemoryDb, uninstallInMemoryDb, setDefaultTestEnv } from "./test-helpers.mjs";

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let dbBackend;

test.beforeEach(() => {
  setDefaultTestEnv();
  dbBackend = installInMemoryDb();
});

test.afterEach(() => {
  uninstallInMemoryDb();
});

// ─── buildTimeSlots ───────────────────────────────────────────────────────────

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

// ─── generateId ───────────────────────────────────────────────────────────────

test("generateId returns a non-empty string", () => {
  const id = generateId();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
});

test("generateId generates unique values", () => {
  const ids = new Set(Array.from({ length: 20 }, () => generateId()));
  assert.equal(ids.size, 20);
});

// ─── asArray ─────────────────────────────────────────────────────────────────

test("asArray returns the input unchanged when it is already an array", () => {
  assert.deepEqual(asArray([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(asArray([]), []);
});

test("asArray returns [] for non-array values", () => {
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray("string"), []);
  assert.deepEqual(asArray(42), []);
  assert.deepEqual(asArray({}), []);
});

// ─── escapeHtml ───────────────────────────────────────────────────────────────

test("escapeHtml replaces & < > and quotes", () => {
  assert.equal(escapeHtml("&"), "&amp;");
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  assert.equal(escapeHtml('"hello"'), "&quot;hello&quot;");
});

test("escapeHtml returns empty string for null/undefined", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("escapeHtml leaves safe strings unchanged", () => {
  assert.equal(escapeHtml("hello world"), "hello world");
  assert.equal(escapeHtml("abc123"), "abc123");
});

// ─── createToken / verifyToken / verifyTokenVerbose ───────────────────────────

test("createToken produces a string that verifyToken can decode", () => {
  process.env.JWT_SECRET = "test-jwt-secret";
  const payload = { id: "u1", email: "a@example.com", name: "Alice" };
  const token = createToken(payload);
  assert.equal(typeof token, "string");
  const decoded = verifyToken(token);
  assert.equal(decoded.email, "a@example.com");
});

test("verifyToken returns null for an invalid token", () => {
  process.env.JWT_SECRET = "test-jwt-secret";
  assert.equal(verifyToken("not.a.jwt"), null);
  assert.equal(verifyToken(""), null);
});

test("verifyToken returns null for a token signed with the wrong secret", () => {
  process.env.JWT_SECRET = "secret-a";
  const token = createToken({ id: "u1", email: "a@example.com" });
  process.env.JWT_SECRET = "secret-b";
  assert.equal(verifyToken(token), null);
});

test("verifyTokenVerbose reports error name on failure", () => {
  process.env.JWT_SECRET = "test-jwt-secret";
  const { payload, error } = verifyTokenVerbose("garbage");
  assert.equal(payload, null);
  assert.ok(typeof error === "string" && error.length > 0);
});

test("verifyTokenVerbose returns payload and null error on success", () => {
  process.env.JWT_SECRET = "test-jwt-secret";
  const token = createToken({ id: "u1", email: "b@example.com" });
  const { payload, error } = verifyTokenVerbose(token);
  assert.equal(error, null);
  assert.equal(payload.email, "b@example.com");
});

// ─── getUserFromRequest ───────────────────────────────────────────────────────

test("getUserFromRequest returns user from a valid token cookie", () => {
  process.env.JWT_SECRET = "test-jwt-secret";
  const user = { id: "u1", email: "c@example.com", name: "Carol" };
  const token = createToken(user);
  const req = new Request("http://localhost/", {
    headers: { cookie: `token=${token}` },
  });
  const decoded = getUserFromRequest(req);
  assert.equal(decoded.email, "c@example.com");
});

test("getUserFromRequest returns null when no cookie is present", () => {
  const req = new Request("http://localhost/");
  assert.equal(getUserFromRequest(req), null);
});

test("getUserFromRequest returns null for a malformed token", () => {
  const req = new Request("http://localhost/", {
    headers: { cookie: "token=bad-token-value" },
  });
  assert.equal(getUserFromRequest(req), null);
});

// ─── safeJson ────────────────────────────────────────────────────────────────

test("safeJson parses a valid JSON body", async () => {
  const req = new Request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  const result = await safeJson(req);
  assert.deepEqual(result, { hello: "world" });
});

test("safeJson returns null for an invalid JSON body", async () => {
  const req = new Request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-valid-json{",
  });
  const result = await safeJson(req);
  assert.equal(result, null);
});

// ─── jsonResponse / errorResponse ────────────────────────────────────────────

test("jsonResponse sets correct status and Content-Type", async () => {
  const res = jsonResponse(201, { ok: true });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Content-Type"), "application/json");
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
});

test("jsonResponse passes through extra headers", async () => {
  const res = jsonResponse(200, { ok: true }, { "X-Custom": "header-value" });
  assert.equal(res.headers.get("X-Custom"), "header-value");
});

test("errorResponse sets error field and optional detail", async () => {
  const res = errorResponse(400, "Bad input", "field is missing");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "Bad input");
  assert.equal(body.detail, "field is missing");
});

test("errorResponse omits detail when not provided", async () => {
  const res = errorResponse(404, "Not found");
  const body = await res.json();
  assert.equal(body.error, "Not found");
  assert.equal(body.detail, undefined);
});

// ─── getAppUrl ────────────────────────────────────────────────────────────────

test("getAppUrl returns APP_URL when set and not in Netlify Dev", () => {
  process.env.APP_URL = "https://my-site.netlify.app";
  delete process.env.NETLIFY_DEV;
  const req = new Request("http://localhost:8888/api/auth/me");
  assert.equal(getAppUrl(req), "https://my-site.netlify.app");
  delete process.env.APP_URL;
});

test("getAppUrl falls back to request origin when APP_URL is not set", () => {
  delete process.env.APP_URL;
  delete process.env.NETLIFY_DEV;
  const req = new Request("http://localhost:8888/api/auth/me");
  assert.equal(getAppUrl(req), "http://localhost:8888");
});

test("getAppUrl uses request origin in Netlify Dev when APP_URL points to production", () => {
  process.env.APP_URL = "https://prod-site.netlify.app";
  process.env.NETLIFY_DEV = "true";
  const req = new Request("http://localhost:8888/api/auth/me");
  assert.equal(getAppUrl(req), "http://localhost:8888");
  delete process.env.APP_URL;
  delete process.env.NETLIFY_DEV;
});

test("getAppUrl uses localhost APP_URL even in Netlify Dev", () => {
  process.env.APP_URL = "http://localhost:8888";
  process.env.NETLIFY_DEV = "true";
  const req = new Request("http://localhost:8888/api/auth/me");
  assert.equal(getAppUrl(req), "http://localhost:8888");
  delete process.env.APP_URL;
  delete process.env.NETLIFY_DEV;
});

// ─── isAdmin / isSuperAdminEmail ─────────────────────────────────────────────

test("isAdmin returns false for null user", () => {
  process.env.ADMIN_EMAILS = "admin@example.com";
  assert.equal(isAdmin(null), false);
});

test("isAdmin returns true for user listed in ADMIN_EMAILS", () => {
  process.env.ADMIN_EMAILS = "admin@example.com,other@example.com";
  assert.equal(isAdmin({ email: "admin@example.com" }), true);
  assert.equal(isAdmin({ email: "ADMIN@EXAMPLE.COM" }), true);
});

test("isAdmin returns true for user with is_admin flag", () => {
  process.env.ADMIN_EMAILS = "";
  assert.equal(isAdmin({ email: "regular@example.com", is_admin: true }), true);
});

test("isAdmin returns false for regular user not in ADMIN_EMAILS", () => {
  process.env.ADMIN_EMAILS = "admin@example.com";
  assert.equal(isAdmin({ email: "regular@example.com" }), false);
});

test("isSuperAdminEmail is case-insensitive", () => {
  process.env.ADMIN_EMAILS = "Super@Example.com";
  assert.equal(isSuperAdminEmail("super@example.com"), true);
  assert.equal(isSuperAdminEmail("SUPER@EXAMPLE.COM"), true);
  assert.equal(isSuperAdminEmail("other@example.com"), false);
});

test("isSuperAdminEmail returns false for empty string", () => {
  process.env.ADMIN_EMAILS = "admin@example.com";
  assert.equal(isSuperAdminEmail(""), false);
});

// ─── sanitizeUser ─────────────────────────────────────────────────────────────

test("sanitizeUser removes OAuth token fields", () => {
  const user = {
    id: "u1",
    email: "user@example.com",
    name: "User",
    google_access_token: "secret-access",
    google_refresh_token: "secret-refresh",
    google_token_expiry: 9999,
  };
  const safe = sanitizeUser(user);
  assert.equal(safe.id, "u1");
  assert.equal(safe.email, "user@example.com");
  assert.equal(safe.google_access_token, undefined);
  assert.equal(safe.google_refresh_token, undefined);
  assert.equal(safe.google_token_expiry, undefined);
});

test("sanitizeUser handles null/undefined gracefully", () => {
  const safe = sanitizeUser(null);
  assert.deepEqual(safe, {});
});

// ─── checkRateLimit ───────────────────────────────────────────────────────────

test("checkRateLimit allows requests under the limit", async () => {
  const result = await checkRateLimit({
    bucket: "test_bucket",
    key: "user@example.com",
    limit: 3,
    windowMs: 60_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.remaining, 2);
});

test("checkRateLimit blocks after limit is reached", async () => {
  const opts = { bucket: "test_block", key: "blocker@example.com", limit: 2, windowMs: 60_000 };
  await checkRateLimit(opts);
  await checkRateLimit(opts);
  const result = await checkRateLimit(opts);
  assert.equal(result.ok, false);
  assert.equal(result.remaining, 0);
  assert.ok(result.retryAfterSec > 0);
});

test("checkRateLimit resets after the window expires", async () => {
  const db = dbBackend.createStore("rate_limits");
  await db.setJSON("old_bucket:old@example.com", {
    window_start: Date.now() - 120_000,
    count: 99,
  });
  const result = await checkRateLimit({
    bucket: "old_bucket",
    key: "old@example.com",
    limit: 5,
    windowMs: 60_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.remaining, 4);
});

// ─── listMeetingIds ───────────────────────────────────────────────────────────

test("listMeetingIds returns meeting IDs excluding reserved keys", async () => {
  const meetingsDb = dbBackend.createStore("meetings");
  await meetingsDb.setJSON("meet-abc", { id: "meet-abc" });
  await meetingsDb.setJSON("meet-xyz", { id: "meet-xyz" });
  await meetingsDb.setJSON("index", { ids: [] });
  await meetingsDb.setJSON("invites:meet-abc", []);

  const ids = await listMeetingIds(meetingsDb);
  assert.ok(ids.includes("meet-abc"));
  assert.ok(ids.includes("meet-xyz"));
  assert.ok(!ids.includes("index"));
  assert.ok(!ids.includes("invites:meet-abc"));
});
