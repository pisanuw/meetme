/**
 * utils.mjs — Shared helpers for all Netlify Functions
 *
 * This module is the single source of truth for cross-cutting concerns:
 *   • Environment variable access   (getEnv)
 *   • Token encryption / decryption  (encryptSecret / decryptSecret, AES-256-GCM)
 *   • Structured logging             (log, logRequest)
 *   • Netlify Blobs database access  (getDb)
 *   • JWT creation and verification  (createToken, verifyToken)
 *   • HTTP request / response helpers (safeJson, jsonResponse, errorResponse, …)
 *   • Rate limiting                  (checkRateLimit)
 *   • Email delivery via Resend      (sendEmail)
 *   • Miscellaneous utilities        (generateId, asArray, escapeHtml)
 *
 * Design principle: every Netlify Function file imports only what it needs from
 * here, making dependencies explicit and eliminating copy-pasted helpers.
 */
import { getStore } from "@netlify/blobs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

// ─── Environment ────────────────────────────────────────────────────────────

/**
 * Read an environment variable, trying Netlify's runtime first and then
 * Node's `process.env` as a fallback (useful in local dev with a .env file).
 *
 * @param {string} name     - Variable name, e.g. "JWT_SECRET"
 * @param {string} fallback - Value returned when the variable is absent
 * @returns {string}
 */
export function getEnv(name, fallback = "") {
  const fromNetlify =
    typeof Netlify !== "undefined" && Netlify?.env?.get ? Netlify.env.get(name) : undefined;
  if (fromNetlify !== undefined && fromNetlify !== null && fromNetlify !== "") {
    return fromNetlify;
  }
  const fromProcess = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (fromProcess !== undefined && fromProcess !== null && fromProcess !== "") {
    return fromProcess;
  }
  return fallback;
}

/** Returns the JWT signing secret. Throws if JWT_SECRET is not configured. */
export function getJwtSecret() {
  const secret = getEnv("JWT_SECRET", "").trim();
  if (!secret) {
    throw new Error("Missing JWT_SECRET environment variable.");
  }
  return secret;
}

/**
 * Returns true when rate limiting should be enforced.
 * Set DISABLE_RATE_LIMIT=true in your local .env to skip rate checks during
 * development. This variable must NEVER be set in production.
 *
 * @returns {boolean}
 */
export function isRateLimitEnabled() {
  return getEnv("DISABLE_RATE_LIMIT", "") !== "true";
}

/**
 * Derives a 256-bit AES key from TOKEN_ENCRYPTION_KEY (base-64 encoded).
 * Falls back to a SHA-256 hash of the JWT secret so the app remains
 * functional even without a dedicated encryption key set.
 * Internal — not exported.
 */
function getEncryptionKey() {
  const raw = getEnv("TOKEN_ENCRYPTION_KEY", "").trim();
  if (raw) {
    const b64 = /^[A-Za-z0-9+/=]+$/.test(raw);
    if (b64) {
      try {
        const decoded = Buffer.from(raw, "base64");
        if (decoded.length >= 32) return decoded.subarray(0, 32);
      } catch {
        // Ignore invalid base64 and fall back to hashing raw input.
      }
    }
    return crypto.createHash("sha256").update(raw).digest();
  }
  return crypto.createHash("sha256").update(getJwtSecret()).digest();
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * The output format is `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`.
 * Passing an empty string returns an empty string (no-op).
 *
 * @param {string} plainText
 * @returns {string} Encrypted token, or "" if input is empty
 */
export function encryptSecret(plainText) {
  const input = (plainText || "").toString();
  if (!input) return "";
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(input, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt a value produced by `encryptSecret`.
 * Returns the original plaintext, or "" on any failure (wrong key, tampered
 * ciphertext, unrecognised format, etc.).
 * Values that do not start with "enc:v1:" are returned as-is, allowing
 * unencrypted legacy values to be read transparently.
 *
 * @param {string} cipherText
 * @returns {string}
 */
export function decryptSecret(cipherText) {
  const input = (cipherText || "").toString();
  if (!input) return "";
  if (!input.startsWith("enc:v1:")) return input;

  const parts = input.split(":");
  if (parts.length !== 5) return "";

  try {
    const iv = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const encrypted = Buffer.from(parts[4], "base64");
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return "";
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────
// All log lines go to stdout/stderr and appear in Netlify → Functions → Logs.
// Using structured JSON makes it easy to grep / filter in production.

/**
 * Emit a structured JSON log line.
 *
 * @param {"info"|"warn"|"error"} level - Severity level
 * @param {string} fn      - Name of the calling function file, e.g. "meetings"
 * @param {string} message - Human-readable description
 * @param {object} [extra] - Any additional key-value pairs to include
 */
export function log(level, fn, message, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    fn,
    msg: message,
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Log an incoming HTTP request (method + path). Call once at the top of each
 * route handler so every request appears in the function logs.
 *
 * @param {string} fn  - Calling function name
 * @param {Request} req
 * @param {object} [extra]
 */
export function logRequest(fn, req, extra = {}) {
  log("info", fn, `${req.method} ${new URL(req.url).pathname}`, extra);
}

// ─── Database ────────────────────────────────────────────────────────────────
// Netlify Blobs is a key/value store. Each named store is independent.
// `consistency: "strong"` ensures reads always reflect the latest write.

/**
 * Get a strongly-consistent Netlify Blobs store by name.
 * Known stores: meetings, invites, availability, users, events,
 *               rate_limits, login_tokens, email_records.
 *
 * @param {string} name - Blob store name
 * @returns {import("@netlify/blobs").Store}
 */
export function getDb(name) {
  if (dbFactoryForTests) return dbFactoryForTests(name);
  return getStore({ name, consistency: "strong" });
}

// Test-only DB factory override. Allows route integration tests to run fully
// in-memory without relying on external Netlify Blobs infrastructure.
let dbFactoryForTests = null;

/**
 * Install an in-memory DB factory for tests.
 *
 * @param {(name: string) => { get: Function, setJSON: Function, delete: Function, list: Function }} factory
 */
export function setDbFactoryForTests(factory) {
  dbFactoryForTests = factory;
}

/** Reset the test DB factory override. */
export function clearDbFactoryForTests() {
  dbFactoryForTests = null;
}

// ─── JWT ─────────────────────────────────────────────────────────────────────
// JWTs are signed with JWT_SECRET and stored in an HttpOnly cookie named "token".
// The payload mirrors the user object (id, email, name) so most requests do
// not need a separate database lookup to identify the caller.

/**
 * Sign a JWT with the application secret.
 *
 * @param {object} payload   - Data to embed (typically the user object)
 * @param {string} expiresIn - Expiry string accepted by jsonwebtoken, e.g. "7d", "15m"
 * @returns {string} Signed JWT
 */
export function createToken(payload, expiresIn = "7d") {
  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

/**
 * Verify a JWT and return its decoded payload, or `null` if invalid/expired.
 *
 * @param {string} token
 * @returns {object|null}
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}

/**
 * Like `verifyToken` but also returns the error name so callers can
 * distinguish "expired" from "invalid signature".
 *
 * @param {string} token
 * @returns {{ payload: object|null, error: string|null }}
 */
export function verifyTokenVerbose(token) {
  try {
    return { payload: jwt.verify(token, getJwtSecret()), error: null };
  } catch (err) {
    return { payload: null, error: err.name }; // e.g. "TokenExpiredError"
  }
}

/**
 * Extract and verify the session JWT from the incoming request's Cookie header.
 * Returns the decoded user payload, or `null` if the request is unauthenticated.
 *
 * @param {Request} req
 * @returns {object|null} Decoded JWT payload (user object) or null
 */
export function getUserFromRequest(req) {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (!match) return null;
  return verifyToken(match[1]);
}

// ─── Request helpers ─────────────────────────────────────────────────────────

/**
 * Parse the request body as JSON without throwing.
 * Returns `null` when the body is absent or malformed — callers should
 * respond with 400 in that case.
 *
 * @param {Request} req
 * @returns {Promise<object|null>}
 */
export async function safeJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * Normalise and lightly validate an email address.
 * Returns the lower-cased email on success, or `null` when the input is
 * clearly not an email (missing "@" or ".").
 * Note: this is a heuristic check, not RFC-5321 validation.
 *
 * @param {string} email
 * @returns {string|null}
 */
export function validateEmail(email) {
  const e = (email || "").trim().toLowerCase();
  if (!e) return null;
  if (e.length > 254) return null;
  // Practical validation: require exactly one @, no spaces, and a basic domain suffix.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function emailPreferenceKey(email) {
  return `email:${normalizeEmail(email)}`;
}

/**
 * Load persisted email preferences for a recipient.
 *
 * @param {string} recipientEmail
 * @returns {Promise<{ email: string, global_opt_out: boolean, blocked_organizers: string[], updated_at: string|null }>}
 */
export async function getEmailPreferences(recipientEmail) {
  const email = normalizeEmail(recipientEmail);
  const base = {
    email,
    global_opt_out: false,
    blocked_organizers: [],
    updated_at: null,
  };

  if (!email) return base;

  const prefsDb = getDb("email_preferences");
  const raw = await prefsDb.get(emailPreferenceKey(email), { type: "json" }).catch(() => null);
  if (!raw || typeof raw !== "object") return base;

  const blocked = asArray(raw.blocked_organizers)
    .map((item) => normalizeEmail(item))
    .filter(Boolean);

  return {
    email,
    global_opt_out: raw.global_opt_out === true,
    blocked_organizers: [...new Set(blocked)],
    updated_at: raw.updated_at || null,
  };
}

/**
 * Persist recipient email preferences.
 *
 * @param {string} recipientEmail
 * @param {{ global_opt_out?: boolean, blocked_organizers?: string[] }} updates
 * @returns {Promise<{ email: string, global_opt_out: boolean, blocked_organizers: string[], updated_at: string }>}
 */
export async function saveEmailPreferences(recipientEmail, updates = {}) {
  const current = await getEmailPreferences(recipientEmail);
  const blocked = Array.isArray(updates.blocked_organizers)
    ? updates.blocked_organizers
    : current.blocked_organizers;

  const next = {
    email: current.email,
    global_opt_out:
      typeof updates.global_opt_out === "boolean" ? updates.global_opt_out : current.global_opt_out,
    blocked_organizers: [
      ...new Set(
        asArray(blocked)
          .map((item) => normalizeEmail(item))
          .filter(Boolean)
      ),
    ],
    updated_at: new Date().toISOString(),
  };

  if (!next.email) return next;

  const prefsDb = getDb("email_preferences");
  await prefsDb.setJSON(emailPreferenceKey(next.email), next);
  return next;
}

/**
 * Determine whether email delivery should be suppressed for a recipient.
 *
 * @param {object} opts
 * @param {string} opts.recipientEmail
 * @param {"general"|"meeting"} [opts.category]
 * @param {string} [opts.organizerEmail]
 * @returns {Promise<{ suppress: boolean, reason: string|null }>}
 */
export async function shouldSuppressEmailDelivery({
  recipientEmail,
  category = "general",
  organizerEmail = "",
} = {}) {
  const recipient = normalizeEmail(recipientEmail);
  if (!recipient) return { suppress: false, reason: null };

  const prefs = await getEmailPreferences(recipient);
  if (prefs.global_opt_out) {
    return { suppress: true, reason: "global_opt_out" };
  }

  const organizer = normalizeEmail(organizerEmail);
  if (category === "meeting" && organizer && prefs.blocked_organizers.includes(organizer)) {
    return { suppress: true, reason: "organizer_blocked" };
  }

  return { suppress: false, reason: null };
}

// ─── Response helpers ────────────────────────────────────────────────────────

/**
 * Build a JSON HTTP response.
 *
 * @param {number} statusCode
 * @param {object} body
 * @param {object} [extraHeaders] - E.g. `{ "Set-Cookie": ... }`
 * @returns {Response}
 */
export function jsonResponse(statusCode, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/**
 * Build a JSON error response with a consistent `{ error, detail? }` shape.
 *
 * @param {number} statusCode
 * @param {string} message - Human-readable error description
 * @param {string|null} [detail] - Optional extra context (e.g. exception message)
 * @returns {Response}
 */
export function errorResponse(statusCode, message, detail = null) {
  const body = { error: message };
  if (detail) body.detail = detail;
  return jsonResponse(statusCode, body);
}

/**
 * Decide whether Set-Cookie should include the Secure attribute.
 *
 * Rules:
 *   1) COOKIE_SECURE=true  -> always Secure
 *   2) COOKIE_SECURE=false -> never Secure
 *   3) auto (default):
 *      - disable Secure on localhost/127.0.0.1 APP_URL
 *      - disable Secure in Netlify dev
 *      - otherwise enable Secure
 *
 * @returns {boolean}
 */
function shouldUseSecureCookies() {
  const override = getEnv("COOKIE_SECURE", "auto").trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;

  const appUrl = getEnv("APP_URL", "").trim();
  if (appUrl) {
    try {
      const parsed = new URL(appUrl);
      if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return false;
      return parsed.protocol === "https:";
    } catch {
      // Ignore malformed APP_URL and continue to fallback checks.
    }
  }

  if (getEnv("NETLIFY_DEV", "").trim().toLowerCase() === "true") return false;
  return true;
}

/**
 * Build an HTTP `Set-Cookie` header value for the session token.
 * Cookies are HttpOnly (not accessible from JavaScript) and use
 * SameSite=Lax to prevent most CSRF attacks.
 * The Secure attribute is enabled in production and automatically disabled
 * in local HTTP development (or can be overridden via COOKIE_SECURE).
 *
 * @param {string} name
 * @param {string} value
 * @param {number} [maxAge] - Lifetime in seconds (default: 7 days)
 * @returns {string}
 */
export function setCookie(name, value, maxAge = 7 * 24 * 3600) {
  const secure = shouldUseSecureCookies() ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

/**
 * Build a `Set-Cookie` header that immediately expires (clears) the named cookie.
 *
 * @param {string} name
 * @returns {string}
 */
export function clearCookie(name) {
  const secure = shouldUseSecureCookies() ? "; Secure" : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

// ─── Application URL ─────────────────────────────────────────────────────────

/**
 * Return the application's public base URL.
 * Reads APP_URL from the environment, falling back to the origin of the
 * incoming request. Centralised here so both auth.mjs and meeting-actions.mjs
 * use the same resolution logic.
 *
 * @param {Request} req
 * @returns {string}
 */
export function getAppUrl(req) {
  const requestOrigin = new URL(req.url).origin;
  const appUrl = getEnv("APP_URL", "").trim();
  const isNetlifyDev = getEnv("NETLIFY_DEV", "").trim().toLowerCase() === "true";

  if (!appUrl) return requestOrigin;

  // Safety for local Netlify Dev: ignore production APP_URL values to avoid
  // broken localhost OAuth redirects when .env contains deployed settings.
  if (isNetlifyDev) {
    try {
      const parsed = new URL(appUrl);
      const host = parsed.hostname.toLowerCase();
      const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!isLocalHost) return requestOrigin;
    } catch {
      return requestOrigin;
    }
  }

  return appUrl;
}

// ─── Admin ───────────────────────────────────────────────────────────────────

/**
 * Return `true` if the user's email is listed in the ADMIN_EMAILS environment
 * variable (comma-separated). Comparison is case-insensitive.
 *
 * @param {{ email: string }|null} user
 * @returns {boolean}
 */
export function isAdmin(user) {
  if (!user) return false;
  if (isSuperAdminEmail(user.email || "")) return true;
  return Boolean(user.is_admin);
}

/**
 * Return true if the email belongs to an environment-configured super admin.
 * These users are sourced from ADMIN_EMAILS and should not be removed through UI.
 *
 * @param {string} email
 * @returns {boolean}
 */
export function isSuperAdminEmail(email) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  const adminEmails = getEnv("ADMIN_EMAILS", "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(normalized);
}

/**
 * Return a copy of a user object with sensitive token fields removed.
 * Use this at every public-facing response site that returns a user record to
 * ensure encrypted OAuth tokens are never accidentally serialised to the client.
 *
 * @param {object} user
 * @returns {object}
 */
export function sanitizeUser(user) {
  const safe = { ...(user || {}) };
  delete safe.google_access_token;
  delete safe.google_refresh_token;
  delete safe.google_token_expiry;
  return safe;
}

// ─── Persistent event log ────────────────────────────────────────────────────
// Key application events are persisted to Netlify Blobs so the admin panel can
// display an audit trail without external infrastructure (no database required).
// Each event gets a unique key (timestamp + random suffix) to avoid write races.

/**
 * Write an event record to the "events" blob store.
 * Failures are silently swallowed so a logging error never breaks a request.
 *
 * @param {"info"|"warn"|"error"} level
 * @param {string} fn      - Function file that generated the event
 * @param {string} message
 * @param {object} [extra] - Arbitrary additional context
 */
export async function persistEvent(level, fn, message, extra = {}) {
  try {
    const eventsDb = getDb("events");
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await eventsDb.setJSON(id, {
      ts: new Date().toISOString(),
      level,
      fn,
      message,
      ...extra,
    });
  } catch (err) {
    console.error("persistEvent failed:", err.message);
  }
}

// ─── Simple per-key rate limiter ─────────────────────────────────────────────
// Uses Netlify Blobs to track request counts in a sliding time window.
// Each {bucket, key} pair gets its own record so different rate limit rules
// (IP-based, email-based) never interfere with each other.

/**
 * Check and increment a rate limit counter for a given bucket + key.
 *
 * @param {object} opts
 * @param {string} opts.bucket    - Logical group, e.g. "auth_magic_link_ip"
 * @param {string} opts.key       - The value being limited, e.g. an IP address
 * @param {number} opts.limit     - Maximum allowed requests within the window
 * @param {number} opts.windowMs  - Window size in milliseconds
 * @returns {Promise<{ ok: boolean, retryAfterSec: number, remaining: number }>}
 */
export async function checkRateLimit({ bucket, key, limit, windowMs }) {
  try {
    const safeBucket = (bucket || "default").trim();
    const safeKey = (key || "anonymous").trim().toLowerCase();
    const max = Math.max(1, Number(limit) || 1);
    const windowSize = Math.max(1000, Number(windowMs) || 60_000);

    const db = getDb("rate_limits");
    const recordKey = `${safeBucket}:${safeKey}`;
    const now = Date.now();
    const existing = await db.get(recordKey, { type: "json" }).catch(() => null);

    let record =
      existing && typeof existing === "object" ? existing : { window_start: now, count: 0 };

    if (now - (record.window_start || now) >= windowSize) {
      record = { window_start: now, count: 0 };
    }

    if ((record.count || 0) >= max) {
      const retryMs = windowSize - (now - record.window_start);
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)),
        remaining: 0,
      };
    }

    record.count = (record.count || 0) + 1;
    await db.setJSON(recordKey, record);
    return {
      ok: true,
      retryAfterSec: 0,
      remaining: Math.max(0, max - record.count),
    };
  } catch (err) {
    // Fail open if the backing store is temporarily unavailable.
    // This avoids hard auth failures in local/dev environments where the
    // Netlify Blobs sandbox process can occasionally be unreachable.
    log("warn", "utils", "rate limit store unavailable; allowing request", {
      bucket,
      key,
      error: err.message,
    });
    return {
      ok: true,
      retryAfterSec: 0,
      remaining: Number(limit) || 1,
    };
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * @typedef {object} Meeting
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} creator_id
 * @property {string} creator_name
 * @property {"specific_dates"|"days_of_week"} meeting_type
 * @property {string[]} dates_or_days
 * @property {string} start_time
 * @property {string} end_time
 * @property {string} timezone
 * @property {number} duration_minutes
 * @property {string|null} finalized_date
 * @property {string|null} finalized_slot
 * @property {string} note
 * @property {boolean} is_finalized
 * @property {string} created_at
 */

/**
 * @typedef {object} Invite
 * @property {string} id
 * @property {string} meeting_id
 * @property {string|null} user_id
 * @property {string} email
 * @property {string} name
 * @property {boolean} responded
 */

/**
 * @typedef {object} AvailabilitySlot
 * @property {string} meeting_id
 * @property {string} user_id
 * @property {string} date_or_day
 * @property {string} time_slot
 */

/**
 * @typedef {object} User
 * @property {string}  id
 * @property {string}  email
 * @property {string}  name
 * @property {string}  first_name
 * @property {string}  last_name
 * @property {boolean} profile_complete
 * @property {string}  created_at
 * @property {string}  [timezone]
 * @property {boolean} [calendar_connected]
 */

/**
 * @typedef {object} EventRecord
 * @property {string} ts
 * @property {"info"|"warn"|"error"} level
 * @property {string} fn
 * @property {string} message
 */

const MEETING_KEY_PATTERN = /^m-(\d{13})-([a-z0-9]+)$/i;

function extractMeetingIdFromKey(key) {
  const value = String(key || "");
  const prefixed = value.match(MEETING_KEY_PATTERN);
  if (prefixed) return prefixed[2];
  if (!value || value.includes(":")) return "";
  return value;
}

/**
 * Build the canonical meeting-record key.
 *
 * Format: `m-<epoch_ms>-<meeting_id>`
 *
 * @param {string} createdAtIso
 * @param {string} meetingId
 * @returns {string}
 */
export function buildMeetingRecordKey(createdAtIso, meetingId) {
  const epoch = Date.parse(createdAtIso || "") || Date.now();
  const ts = String(epoch).padStart(13, "0");
  return `m-${ts}-${meetingId}`;
}

/**
 * List all meeting IDs from the meetings blob store.
 * Supports both legacy keys (`<meeting_id>`) and canonical keys
 * (`m-<epoch_ms>-<meeting_id>`).
 *
 * @param {import("@netlify/blobs").Store} meetingsDb
 * @returns {Promise<string[]>}
 */
export async function listMeetingIds(meetingsDb) {
  const listing = await meetingsDb.list().catch(() => ({ blobs: [] }));
  return [
    ...new Set(
      asArray(listing?.blobs)
        .map((b) => extractMeetingIdFromKey(b?.key))
        .filter(Boolean)
    ),
  ];
}

/**
 * Load a meeting by ID from canonical key format, with legacy fallback.
 *
 * @param {import("@netlify/blobs").Store} meetingsDb
 * @param {string} meetingId
 * @returns {Promise<object|null>}
 */
export async function getMeetingRecord(meetingsDb, meetingId) {
  const id = String(meetingId || "").trim();
  if (!id) return null;

  const listing = await meetingsDb.list().catch(() => ({ blobs: [] }));
  const canonicalKeys = asArray(listing?.blobs)
    .map((b) => String(b?.key || ""))
    .filter((key) => key.endsWith(`-${id}`) && MEETING_KEY_PATTERN.test(key))
    .sort((a, b) => b.localeCompare(a));

  for (const key of canonicalKeys) {
    const record = await meetingsDb.get(key, { type: "json" }).catch(() => null);
    if (record && record.id === id) return record;
  }

  const legacy = await meetingsDb.get(id, { type: "json" }).catch(() => null);
  if (legacy && legacy.id === id) return legacy;
  return null;
}

/**
 * Persist a meeting using the canonical key format.
 *
 * @param {import("@netlify/blobs").Store} meetingsDb
 * @param {object} meeting
 * @returns {Promise<void>}
 */
export async function saveMeetingRecord(meetingsDb, meeting) {
  const id = String(meeting?.id || "").trim();
  if (!id) throw new Error("Meeting record must include an id.");
  const createdAt = String(meeting?.created_at || "").trim() || new Date().toISOString();
  const key = buildMeetingRecordKey(createdAt, id);
  await meetingsDb.setJSON(key, {
    ...meeting,
    id,
    created_at: createdAt,
  });
}

/**
 * Delete all storage entries for a meeting ID (canonical and legacy).
 *
 * @param {import("@netlify/blobs").Store} meetingsDb
 * @param {string} meetingId
 * @returns {Promise<void>}
 */
export async function deleteMeetingRecord(meetingsDb, meetingId) {
  const id = String(meetingId || "").trim();
  if (!id) return;

  await meetingsDb.delete(id).catch(() => null);
  const listing = await meetingsDb.list().catch(() => ({ blobs: [] }));
  const keys = asArray(listing?.blobs)
    .map((b) => String(b?.key || ""))
    .filter((key) => key.endsWith(`-${id}`) && MEETING_KEY_PATTERN.test(key));
  await Promise.all(keys.map((key) => meetingsDb.delete(key).catch(() => null)));
}

/**
 * Generate a short, URL-safe, roughly time-sortable unique ID.
 * Combines a base-36 timestamp with random characters — not guaranteed to be
 * globally unique but collision probability is negligible for this scale.
 *
 * @returns {string} e.g. "m0u3k4abc123"
 */
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Generate an opaque, hard-to-guess anonymous participant identity.
 * Used for availability/invite records on anonymous meetings where we don't
 * have a logged-in user.id. Stored in availability.user_id as "anon:<id>" so
 * the existing dedup-by-user_id logic continues to work unchanged.
 *
 * @returns {string} e.g. "anon:k0u3k4abc123abc"
 */
export function generateAnonymousParticipantId() {
  // Two random chunks + time component ≈ 80 bits of entropy; practically
  // impossible to guess but still URL-safe base36.
  return (
    "anon:" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

export const MEETING_TOKEN_KINDS = Object.freeze({
  PARTICIPATION: "meeting_participation",
  ADMIN: "meeting_admin",
});

/**
 * Verify a meeting-scoped JWT (participation or admin token) and return its
 * decoded payload, or null if invalid/expired or of the wrong kind.
 *
 * Unlike the session token, these tokens carry a `meeting_id` and `kind`
 * claim and are embedded in shareable URLs, not cookies.
 *
 * @param {string} token
 * @param {string} [expectedKind] One of MEETING_TOKEN_KINDS, or undefined to accept either.
 * @returns {{ kind: string, meeting_id: string }|null}
 */
export function verifyMeetingToken(token, expectedKind) {
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || typeof payload !== "object") return null;
  if (!payload.meeting_id || typeof payload.meeting_id !== "string") return null;
  const kindValues = Object.values(MEETING_TOKEN_KINDS);
  if (!kindValues.includes(payload.kind)) return null;
  if (expectedKind && payload.kind !== expectedKind) return null;
  return payload;
}

/**
 * Decide whether an anonymous meeting is past the 30-day retention window
 * and eligible for automatic deletion.
 *
 * Retention rules (per product decision):
 *   • Non-anonymous meetings never auto-expire.
 *   • For specific-dates meetings, keep the meeting alive while any listed
 *     date is still within 30 days of "now".
 *   • `last_activity_at` (updated on availability writes / finalize) extends
 *     the window; new activity keeps the meeting alive.
 *
 * @param {object} meeting
 * @param {Date}   [now]  Defaults to new Date()
 * @returns {boolean}
 */
export function isAnonymousMeetingExpired(meeting, now = new Date()) {
  if (!meeting || !meeting.anonymous) return false;
  const cutoffMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  const lastActivityStr = meeting.last_activity_at || meeting.created_at;
  const lastActivityMs = lastActivityStr ? Date.parse(lastActivityStr) : NaN;
  if (Number.isFinite(lastActivityMs) && lastActivityMs > cutoffMs) return false;

  if (meeting.meeting_type === "specific_dates" && Array.isArray(meeting.dates_or_days)) {
    const maxDate = [...meeting.dates_or_days]
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
      .sort()
      .pop();
    if (maxDate) {
      const dateMs = Date.parse(`${maxDate}T23:59:59Z`);
      if (Number.isFinite(dateMs) && dateMs > cutoffMs) return false;
    }
  }
  return true;
}

/**
 * Safely coerce a value to an array.
 * Returns the value itself when it is already an array, otherwise returns [].
 * Use this whenever reading from Netlify Blobs: a malformed or missing record
 * should never cause a crash in calling code.
 *
 * @template T
 * @param {T[]|unknown} value
 * @returns {T[]}
 */
export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSlug(value) {
  const base = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "user";
}

async function resolveUniqueBookingPublicSlug(usersDb, desiredSlug, email) {
  const baseSlug = normalizeSlug(desiredSlug || String(email || "").split("@")[0]);
  let candidate = baseSlug;
  let suffix = 2;

  while (true) {
    const mapped = await usersDb
      .get(`booking_public_slug:${candidate}`, { type: "json" })
      .catch(() => null);
    const mappedEmail = normalizeEmail(mapped?.email || mapped);
    if (!mappedEmail || mappedEmail === email) return candidate;
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

export async function saveUserRecord(usersDb, userRecord) {
  const email = validateEmail(userRecord?.email || "") || normalizeEmail(userRecord?.email || "");
  if (!email) throw new Error("User record must include a valid email.");

  const existing = await usersDb.get(email, { type: "json" }).catch(() => null);
  const previousSlug = String(existing?.booking_public_slug || "")
    .trim()
    .toLowerCase();
  const bookingPublicSlug = await resolveUniqueBookingPublicSlug(
    usersDb,
    userRecord?.booking_public_slug || existing?.booking_public_slug || email.split("@")[0],
    email
  );

  const next = {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...(userRecord && typeof userRecord === "object" ? userRecord : {}),
    email,
    booking_public_slug: bookingPublicSlug,
  };

  await usersDb.setJSON(email, next);
  await usersDb.setJSON(`booking_public_slug:${bookingPublicSlug}`, { email });

  if (previousSlug && previousSlug !== bookingPublicSlug) {
    const mapped = await usersDb
      .get(`booking_public_slug:${previousSlug}`, { type: "json" })
      .catch(() => null);
    const mappedEmail = normalizeEmail(mapped?.email || mapped);
    if (!mappedEmail || mappedEmail === email) {
      await usersDb.delete(`booking_public_slug:${previousSlug}`).catch(() => null);
    }
  }

  return next;
}

export async function deleteUserRecord(usersDb, email) {
  const normalizedEmail = validateEmail(email || "") || normalizeEmail(email || "");
  if (!normalizedEmail) return;

  const existing = await usersDb.get(normalizedEmail, { type: "json" }).catch(() => null);
  const slug = String(existing?.booking_public_slug || "")
    .trim()
    .toLowerCase();

  await usersDb.delete(normalizedEmail).catch(() => null);

  if (slug) {
    const mapped = await usersDb
      .get(`booking_public_slug:${slug}`, { type: "json" })
      .catch(() => null);
    const mappedEmail = normalizeEmail(mapped?.email || mapped);
    if (!mappedEmail || mappedEmail === normalizedEmail) {
      await usersDb.delete(`booking_public_slug:${slug}`).catch(() => null);
    }
  }
}

export async function findUserByBookingPublicSlug(usersDb, ownerSlug) {
  const slug = normalizeSlug(ownerSlug);
  if (!slug) return null;

  const mapped = await usersDb
    .get(`booking_public_slug:${slug}`, { type: "json" })
    .catch(() => null);
  const mappedEmail = normalizeEmail(mapped?.email || mapped);
  if (mappedEmail) {
    const user = await usersDb.get(mappedEmail, { type: "json" }).catch(() => null);
    if (
      user &&
      String(user.booking_public_slug || "")
        .trim()
        .toLowerCase() === slug
    )
      return user;
    await usersDb.delete(`booking_public_slug:${slug}`).catch(() => null);
  }

  const listing = await usersDb.list().catch(() => ({ blobs: [] }));
  for (const entry of asArray(listing?.blobs)) {
    const key = entry?.key;
    if (!key || key.includes(":")) continue;
    const user = await usersDb.get(key, { type: "json" }).catch(() => null);
    if (!user) continue;
    const saved = await saveUserRecord(usersDb, user).catch(() => null);
    if (saved && saved.booking_public_slug === slug) return saved;
  }

  return null;
}

/**
 * Build an ordered list of "HH:MM" time-slot strings between startTime and
 * endTime at fixed-minute intervals. The end time itself is excluded.
 *
 * @param {string} startTime - "HH:MM"
 * @param {string} endTime   - "HH:MM"
 * @param {number} [stepMin=15]
 * @returns {string[]}
 */
export function buildTimeSlots(startTime, endTime, stepMin = 15) {
  const [sh, sm] = (startTime || "08:00").split(":").map(Number);
  const [eh, em] = (endTime || "20:00").split(":").map(Number);
  const slots = [];
  let cur = sh * 60 + sm;
  const end = eh * 60 + em;
  while (cur < end) {
    slots.push(
      `${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`
    );
    cur += stepMin;
  }
  return slots;
}

export function localToUTC(dateStr, timeStr, timezone) {
  const localStr = `${dateStr}T${timeStr}:00`;
  const utcCandidate = new Date(localStr + "Z");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};
  fmt.formatToParts(utcCandidate).forEach(({ type, value }) => {
    parts[type] = value;
  });
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const tzStr = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}Z`;
  const tzAsIfUtc = new Date(tzStr);
  const offsetMs = tzAsIfUtc - utcCandidate;
  return new Date(utcCandidate.getTime() - offsetMs);
}

/**
 * Compare two secrets in constant time when lengths match.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function secretsEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Escape a string for safe inclusion in an HTML document.
 * Replaces `&`, `<`, `>`, and `"` with their named HTML entities.
 * Use this on any user-supplied content placed inside HTML markup to prevent
 * Cross-Site Scripting (XSS) attacks.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Email delivery (Resend) ──────────────────────────────────────────────────
// All outbound email flows through this single helper so that:
//   • API key and sender address are read from one place
//   • Error handling is consistent across features (invites, reminders, feedback)
//   • Swapping email providers only requires changing this one function

/**
 * Send an email via the Resend API.
 *
 * Requires environment variables:
 *   RESEND_API_KEY    — API key from resend.com
 *   AUTH_FROM_EMAIL   — Verified sender address, e.g. "MeetMe <noreply@example.com>"
 *
 * @param {object} opts
 * @param {string|string[]} opts.to      - Recipient address(es)
 * @param {string}          opts.subject
 * @param {string}          opts.html    - HTML body
 * @param {string}          opts.text    - Plain-text fallback
 * @param {string}          [opts.replyTo] - Reply-To address
 * @param {Array<{name:string,value:string}>} [opts.tags] - Resend tags for analytics
 * @param {{ category?: "general"|"meeting", organizerEmail?: string }} [opts.suppression]
 * @returns {Promise<{ ok: boolean, emailId?: string, error?: string }>}
 */
export async function sendEmail({ to, subject, html, text, replyTo, tags, suppression } = {}) {
  const apiKey = getEnv("RESEND_API_KEY");
  const fromEmail = getEnv("AUTH_FROM_EMAIL");
  if (!apiKey || !fromEmail) {
    return {
      ok: false,
      error: "Email delivery is not configured (RESEND_API_KEY / AUTH_FROM_EMAIL missing).",
    };
  }
  try {
    const siteUrl =
      getEnv("APP_URL", "").trim() ||
      getEnv("URL", "").trim() ||
      getEnv("DEPLOY_PRIME_URL", "").trim();
    const normalizedSiteUrl = siteUrl.replace(/\/+$/, "");
    const htmlFooter = normalizedSiteUrl
      ? `\n<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;" /><p style="margin:0;color:#6b7280;font-size:12px;">MeetMe: <a href="${escapeHtml(normalizedSiteUrl)}" style="color:#1976d2;">${escapeHtml(normalizedSiteUrl)}</a></p>`
      : "";
    const textFooter = normalizedSiteUrl ? `\n\n---\nMeetMe: ${normalizedSiteUrl}` : "";

    const htmlWithFooter = `${String(html || "")}${htmlFooter}`;
    const textWithFooter = `${String(text || "")}${textFooter}`;

    const recipients = (Array.isArray(to) ? to : [to])
      .map((item) => normalizeEmail(item))
      .filter(Boolean);

    const suppressedRecipients = [];
    const deliverableRecipients = [];

    for (const recipient of recipients) {
      const suppressionResult = await shouldSuppressEmailDelivery({
        recipientEmail: recipient,
        category: suppression?.category || "general",
        organizerEmail: suppression?.organizerEmail || "",
      });
      if (suppressionResult.suppress) {
        suppressedRecipients.push({ email: recipient, reason: suppressionResult.reason });
      } else {
        deliverableRecipients.push(recipient);
      }
    }

    if (deliverableRecipients.length === 0) {
      return {
        ok: false,
        error: "Email suppressed by recipient preference.",
        suppressed_recipients: suppressedRecipients,
      };
    }

    const payload = {
      from: fromEmail,
      to: deliverableRecipients,
      subject,
      html: htmlWithFooter,
      text: textWithFooter,
    };
    if (replyTo) payload.reply_to = replyTo;
    if (tags && tags.length) payload.tags = tags;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Resend API error (HTTP ${res.status}): ${body.slice(0, 200)}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, emailId: data.id, suppressed_recipients: suppressedRecipients };
  } catch (err) {
    return { ok: false, error: `Email send failed: ${err.message}` };
  }
}

export const LIMITS = {
  TITLE_MAX: 200,
  DESCRIPTION_MAX: 2000,
  MAX_INVITEES: 50,
  NAME_MAX: 100,
  DURATION_MIN: 15,
  DURATION_MAX: 24 * 60,
  FEEDBACK_MESSAGE_MAX: 5000,
  ADMIN_PAGE_DEFAULT: 25,
  ADMIN_PAGE_MAX: 100,
  BOOKING_EVENT_TYPES_MAX: 25,
  BOOKING_EVENT_TITLE_MAX: 120,
  BOOKING_EVENT_DESCRIPTION_MAX: 1200,
  BOOKING_AVAIL_WINDOWS_MAX: 60,
  BOOKING_DURATION_MAX: 180,
  BOOKING_GROUP_CAPACITY_MAX: 100,
  BOOKING_REMINDER_WINDOW_HOURS_MAX: 72,
};
