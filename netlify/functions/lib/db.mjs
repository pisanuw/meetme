/**
 * lib/db.mjs — Netlify Blobs database access with test injection support
 */
import { getStore } from "@netlify/blobs";

// Test-only DB factory override. Allows route integration tests to run fully
// in-memory without relying on external Netlify Blobs infrastructure.
let dbFactoryForTests = null;

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

// How many times to retry the compare-and-swap when a concurrent writer updates
// the same key between our read and write.
const MAX_CAS_ATTEMPTS = 5;

/**
 * Atomically read-modify-write a JSON value under a single Blobs key.
 *
 * Reads the current value with its etag, applies `mutate` to produce the next
 * value, then commits with a conditional put (compare-and-swap). If a concurrent
 * writer changed the key between our read and write, re-reads and retries up to
 * MAX_CAS_ATTEMPTS. This prevents the lost-update race where two requests both
 * read the same array, each append, and the second write clobbers the first.
 *
 * `mutate` MUST be a pure function of the current value: it can be invoked more
 * than once (on retry) against an updated snapshot, so it must not rely on state
 * captured at the time of the first read.
 *
 * Throws if the store is unavailable (getWithMetadata/setJSON reject) or if
 * contention persists past MAX_CAS_ATTEMPTS — callers' top-level handlers turn
 * that into a 500 rather than silently dropping the write.
 *
 * @template T
 * @param {{ getWithMetadata: Function, setJSON: Function }} db - Blobs store
 * @param {string} key - The blob key to update
 * @param {(current: T) => T} mutate - Produces the next value from the current one
 * @param {{ defaultValue?: T }} [opts] - Value to start from when the key is absent
 * @returns {Promise<T>} The value that was committed
 */
export async function updateJsonWithCas(db, key, mutate, { defaultValue = null } = {}) {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const existing = await db.getWithMetadata(key, { type: "json" });
    const etag = existing?.etag;
    const current = existing?.data ?? defaultValue;
    const next = mutate(current);
    const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const result = await db.setJSON(key, next, writeOpts);
    if (result?.modified) return next;
    // Lost the race; another writer committed first. Re-read and retry.
  }
  throw new Error(`updateJsonWithCas: persistent write contention on key "${key}"`);
}
