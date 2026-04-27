/**
 * lib/rate-limit.mjs — Simple per-key rate limiter
 *
 * Uses Netlify Blobs to track request counts in a sliding time window.
 * Each {bucket, key} pair gets its own record so different rate limit rules
 * (IP-based, email-based) never interfere with each other.
 */
import { getDb } from "./db.mjs";
import { log } from "./log.mjs";

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
