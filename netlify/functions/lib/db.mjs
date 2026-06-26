/**
 * lib/db.mjs — Storage abstraction layer
 *
 * All persistent state in the application goes through this module.  The
 * production backend is Netlify Blobs, but every function uses only the
 * `StorageStore` interface below — never the Blobs SDK directly.  Swapping
 * to a different backend (SQL, KV, …) means writing a factory that returns
 * an object satisfying `StorageStore` and calling `setDbFactory()` once at
 * startup.  No application code changes.
 *
 * See `lib/db-adapters/turso.mjs` for a drop-in SQL (Turso / libSQL) adapter.
 */

/**
 * @typedef {object} StorageStore
 * A minimal, backend-agnostic store interface.  All methods are async.
 *
 * The interface intentionally matches the Netlify Blobs `Store` surface so
 * that the Blobs implementation satisfies it with zero wrapping.  Alternative
 * adapters must implement the same five methods.
 *
 * @property {(key: string, opts: { type: "json" }) => Promise<any>} get
 *   Read a JSON value by key.  Returns `null` when absent.
 * @property {(key: string, opts: { type: "json" }) => Promise<{ data: any, etag: string }|null>} getWithMetadata
 *   Read a JSON value together with its opaque `etag` for compare-and-swap writes.
 *   Returns `null` when absent.
 * @property {(key: string, value: any, opts?: { onlyIfMatch?: string, onlyIfNew?: boolean }) => Promise<{ modified: boolean }|void>} setJSON
 *   Write a JSON value.  When `opts.onlyIfMatch` is set, the write is
 *   conditional on the stored etag matching (compare-and-swap).  When
 *   `opts.onlyIfNew` is set, the write succeeds only if the key is absent.
 *   Returns `{ modified: true }` on success, `{ modified: false }` when the
 *   condition was not met (lost the race).
 * @property {(key: string) => Promise<void>} delete
 *   Remove a key.  No-op when absent.
 * @property {(opts?: { prefix?: string }) => Promise<{ blobs: Array<{ key: string }> }>} list
 *   List all keys, optionally filtered by a key prefix.
 */

import { getStore } from "@netlify/blobs";

// Active factory — returns a StorageStore for a named bucket.
// Starts as null; getDb() falls back to Netlify Blobs when null.
let activeDbFactory = null;

/**
 * Get a store for a named bucket.
 *
 * Returns a {@link StorageStore} backed by whichever adapter is active.
 * Known bucket names: meetings, invites, availability, users, events,
 * rate_limits, login_tokens, email_records, bookings, event_types,
 * booking_availability, email_preferences.
 *
 * @param {string} name - Bucket name
 */
export function getDb(name) {
  if (activeDbFactory) return activeDbFactory(name);
  return getStore({ name, consistency: "strong" });
}

/**
 * Replace the storage backend for all subsequent `getDb()` calls.
 *
 * Call this once at process startup (before any request is handled) to
 * plug in an alternative adapter.  See `lib/db-adapters/turso.mjs` for a
 * ready-to-use SQL implementation.
 *
 * @param {((name: string) => StorageStore) | null} factory
 *   A function that accepts a bucket name and returns a StorageStore, or
 *   `null` to restore the default Netlify Blobs backend.
 */
export function setDbFactory(factory) {
  activeDbFactory = factory;
}

/**
 * Install an in-memory DB factory for tests.
 * Alias for `setDbFactory` kept for backward compatibility with the test suite.
 *
 * @param {(name: string) => StorageStore} factory
 */
export function setDbFactoryForTests(factory) {
  setDbFactory(factory);
}

/** Reset to the default Netlify Blobs backend. */
export function clearDbFactoryForTests() {
  setDbFactory(null);
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
