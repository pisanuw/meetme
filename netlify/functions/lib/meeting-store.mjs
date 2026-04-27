/**
 * lib/meeting-store.mjs — Meeting record CRUD and meeting-scoped token helpers
 */
import { getDb } from "./db.mjs";
import { verifyToken } from "./jwt.mjs";
import { asArray } from "./utils-core.mjs";

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
