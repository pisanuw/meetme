/**
 * lib/webhook-sig.mjs — Svix / Standard Webhooks signature verification
 *
 * Resend (like Stripe, Clerk and others) authenticates webhook deliveries by
 * signing them, not by sending a shared secret we chose. There is no way to
 * attach a custom header to a Resend webhook, so signature verification is the
 * only mechanism that works for real deliveries.
 *
 * The scheme (Svix, also published as "Standard Webhooks"):
 *   signed content = `${id}.${timestamp}.${rawBody}`
 *   signature      = base64(HMAC-SHA256(key, signedContent))
 *   key            = base64-decoded portion of the `whsec_…` signing secret
 *
 * The signature header carries a space-separated list of `v<n>,<signature>`
 * pairs so secrets can be rotated without downtime; any matching v1 entry is
 * accepted. Headers are read under both the `svix-` and `webhook-` prefixes
 * because the spec renamed them and Resend has sent both.
 */
import crypto from "node:crypto";

// Replay window. Svix's own default; signatures older or newer than this are
// rejected so a captured delivery cannot be replayed indefinitely.
const DEFAULT_TOLERANCE_SEC = 300;

/**
 * Read a webhook header under either the `svix-` or `webhook-` prefix.
 *
 * @param {Headers} headers
 * @param {string} suffix - "id", "timestamp" or "signature"
 * @returns {string}
 */
function getWebhookHeader(headers, suffix) {
  return headers.get(`svix-${suffix}`) || headers.get(`webhook-${suffix}`) || "";
}

/**
 * Decode a `whsec_`-prefixed signing secret into raw HMAC key bytes.
 * Secrets without the prefix are treated as raw base64, which is how the
 * Resend dashboard sometimes displays them.
 *
 * @param {string} signingSecret
 * @returns {Buffer|null} Key bytes, or null if the secret is unusable
 */
function decodeSigningKey(signingSecret) {
  const raw = (signingSecret || "").trim();
  if (!raw) return null;
  const b64 = raw.startsWith("whsec_") ? raw.slice("whsec_".length) : raw;
  const key = Buffer.from(b64, "base64");
  return key.length > 0 ? key : null;
}

/**
 * Compare two base64 signatures in constant time.
 * Returns false on a length mismatch rather than throwing.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function signaturesEqual(a, b) {
  const bufA = Buffer.from(a, "base64");
  const bufB = Buffer.from(b, "base64");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Svix-signed webhook delivery.
 *
 * Fails closed: every error path returns ok:false with a `reason` suitable for
 * logging. The reason is deliberately coarse so it can be logged without
 * telling an attacker which part of their forgery was wrong.
 *
 * @param {object} args
 * @param {string} args.rawBody - Exact request body bytes as text, unparsed
 * @param {Headers} args.headers
 * @param {string} args.signingSecret - The `whsec_…` secret from Resend
 * @param {number} [args.toleranceSec=300]
 * @param {number} [args.nowSec] - Override for tests
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifyWebhookSignature({
  rawBody,
  headers,
  signingSecret,
  toleranceSec = DEFAULT_TOLERANCE_SEC,
  nowSec = Math.floor(Date.now() / 1000),
}) {
  const key = decodeSigningKey(signingSecret);
  if (!key) return { ok: false, reason: "no-signing-secret" };

  const id = getWebhookHeader(headers, "id");
  const timestamp = getWebhookHeader(headers, "timestamp");
  const signatureHeader = getWebhookHeader(headers, "signature");
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: "missing-signature-headers" };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "bad-timestamp" };
  if (Math.abs(nowSec - sentAt) > toleranceSec) {
    return { ok: false, reason: "timestamp-outside-tolerance" };
  }

  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`, "utf8")
    .digest("base64");

  // The header may list several versioned signatures; only v1 is defined.
  const matched = signatureHeader
    .split(" ")
    .filter(Boolean)
    .some((entry) => {
      const [version, signature] = entry.split(",");
      return version === "v1" && signature && signaturesEqual(signature, expected);
    });

  return matched ? { ok: true } : { ok: false, reason: "signature-mismatch" };
}
