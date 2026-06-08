/**
 * lib/rate-limit.mjs — Simple per-key rate limiter
 *
 * Uses Netlify Blobs to track request counts in a sliding time window.
 * Each {bucket, key} pair gets its own record so different rate limit rules
 * (IP-based, email-based) never interfere with each other.
 */
import { getDb } from "./db.mjs";
import { log } from "./log.mjs";

// How many times to retry the compare-and-swap when a concurrent request
// updates the same counter between our read and write.
const MAX_CAS_ATTEMPTS = 5;

/**
 * Check and increment a rate limit counter for a given bucket + key.
 *
 * The increment is atomic: it reads the current record with its etag and
 * writes back with a conditional (compare-and-swap) put, retrying on
 * contention. This prevents the read-modify-write race where two concurrent
 * requests both observe the same count and each effectively doubles the limit.
 *
 * Fails CLOSED by default. These checks guard auth endpoints, so if the
 * backing store is unavailable a request is denied rather than waved through —
 * a broken limiter must not silently become an open door. Callers that
 * genuinely prefer availability over protection can opt in with failOpen.
 *
 * @param {object} opts
 * @param {string} opts.bucket    - Logical group, e.g. "auth_magic_link_ip"
 * @param {string} opts.key       - The value being limited, e.g. an IP address
 * @param {number} opts.limit     - Maximum allowed requests within the window
 * @param {number} opts.windowMs  - Window size in milliseconds
 * @param {boolean} [opts.failOpen=false] - Allow the request if the store errors
 * @returns {Promise<{ ok: boolean, retryAfterSec: number, remaining: number }>}
 */
export async function checkRateLimit({ bucket, key, limit, windowMs, failOpen = false }) {
  const safeBucket = (bucket || "default").trim();
  const safeKey = (key || "anonymous").trim().toLowerCase();
  const max = Math.max(1, Number(limit) || 1);
  const windowSize = Math.max(1000, Number(windowMs) || 60_000);

  const db = getDb("rate_limits");
  const recordKey = `${safeBucket}:${safeKey}`;

  try {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const now = Date.now();
      // getWithMetadata returns null for a missing key and throws on a real
      // store failure (which the outer catch turns into a fail-closed deny).
      const existing = await db.getWithMetadata(recordKey, { type: "json" });
      const etag = existing?.etag;

      let record =
        existing?.data && typeof existing.data === "object"
          ? existing.data
          : { window_start: now, count: 0 };

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

      const next = { window_start: record.window_start || now, count: (record.count || 0) + 1 };
      // Conditional write: only commit if the record is unchanged since our
      // read (onlyIfMatch), or still absent (onlyIfNew). Otherwise retry.
      const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const result = await db.setJSON(recordKey, next, writeOpts);
      if (result?.modified) {
        return {
          ok: true,
          retryAfterSec: 0,
          remaining: Math.max(0, max - next.count),
        };
      }
      // Lost the race; another request committed first. Re-read and retry.
    }

    // Persistent contention — deny rather than risk overshooting the limit.
    log("warn", "utils", "rate limit CAS contention; denying request", { bucket, key });
    return { ok: false, retryAfterSec: 1, remaining: 0 };
  } catch (err) {
    const isDev = process.env.NETLIFY_DEV === "true" || process.env.DISABLE_RATE_LIMIT === "true";
    log(isDev ? "warn" : "error", "utils", "rate limit store unavailable", {
      bucket,
      key,
      error: err.message,
      failOpen,
    });
    if (failOpen) {
      return { ok: true, retryAfterSec: 0, remaining: Number(limit) || 1 };
    }
    return { ok: false, retryAfterSec: 5, remaining: 0 };
  }
}
