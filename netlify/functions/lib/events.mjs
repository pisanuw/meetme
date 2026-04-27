/**
 * lib/events.mjs — Persistent event log
 *
 * Key application events are persisted to Netlify Blobs so the admin panel can
 * display an audit trail without external infrastructure (no database required).
 * Each event gets a unique key (timestamp + random suffix) to avoid write races.
 */
import { getDb } from "./db.mjs";

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
