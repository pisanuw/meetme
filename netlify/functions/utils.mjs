import { getStore } from "@netlify/blobs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

// ─── Environment ────────────────────────────────────────────────────────────

export function getEnv(name, fallback = "") {
  const fromNetlify = typeof Netlify !== "undefined" && Netlify?.env?.get
    ? Netlify.env.get(name)
    : undefined;
  if (fromNetlify !== undefined && fromNetlify !== null && fromNetlify !== "") {
    return fromNetlify;
  }
  const fromProcess = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (fromProcess !== undefined && fromProcess !== null && fromProcess !== "") {
    return fromProcess;
  }
  return fallback;
}

export function getJwtSecret() {
  return getEnv("JWT_SECRET", "meetsync-dev-secret-change-in-prod");
}

function getEncryptionKey() {
  const raw = getEnv("TOKEN_ENCRYPTION_KEY", "").trim();
  if (raw) {
    const b64 = /^[A-Za-z0-9+/=]+$/.test(raw);
    if (b64) {
      try {
        const decoded = Buffer.from(raw, "base64");
        if (decoded.length >= 32) return decoded.subarray(0, 32);
      } catch {}
    }
    return crypto.createHash("sha256").update(raw).digest();
  }
  return crypto.createHash("sha256").update(getJwtSecret()).digest();
}

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

export function logRequest(fn, req, extra = {}) {
  log("info", fn, `${req.method} ${new URL(req.url).pathname}`, extra);
}

// ─── Database ────────────────────────────────────────────────────────────────

export function getDb(name) {
  return getStore({ name, consistency: "strong" });
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

export function createToken(payload, expiresIn = "7d") {
  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (err) {
    return null;
  }
}

export function verifyTokenVerbose(token) {
  try {
    return { payload: jwt.verify(token, getJwtSecret()), error: null };
  } catch (err) {
    return { payload: null, error: err.name }; // e.g. "TokenExpiredError"
  }
}

export function getUserFromRequest(req) {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (!match) return null;
  return verifyToken(match[1]);
}

// ─── Request helpers ─────────────────────────────────────────────────────────

export async function safeJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function validateEmail(email) {
  const e = (email || "").trim().toLowerCase();
  return e.includes("@") && e.includes(".") ? e : null;
}

// ─── Response helpers ────────────────────────────────────────────────────────

export function jsonResponse(statusCode, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export function errorResponse(statusCode, message, detail = null) {
  const body = { error: message };
  if (detail) body.detail = detail;
  return jsonResponse(statusCode, body);
}

export function setCookie(name, value, maxAge = 7 * 24 * 3600) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export function isAdmin(user) {
  if (!user || !user.email) return false;
  const adminEmails = getEnv("ADMIN_EMAILS", "yusuf.pisan@gmail.com")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes((user.email || "").toLowerCase());
}

// ─── Persistent event log ────────────────────────────────────────────────────
// Store key application events in Netlify Blobs so the admin panel can display them.
// Each event gets its own key (timestamp-prefixed) to avoid write-races.

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

// ─── Simple per-key rate limiter ────────────────────────────────────────────

export async function checkRateLimit({ bucket, key, limit, windowMs }) {
  const safeBucket = (bucket || "default").trim();
  const safeKey = (key || "anonymous").trim().toLowerCase();
  const max = Math.max(1, Number(limit) || 1);
  const windowSize = Math.max(1000, Number(windowMs) || 60_000);

  const db = getDb("rate_limits");
  const recordKey = `${safeBucket}:${safeKey}`;
  const now = Date.now();
  const existing = await db.get(recordKey, { type: "json" }).catch(() => null);

  let record = existing && typeof existing === "object"
    ? existing
    : { window_start: now, count: 0 };

  if ((now - (record.window_start || now)) >= windowSize) {
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
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
