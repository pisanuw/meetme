// @ts-nocheck — reference implementation; @libsql/client is an optional dep
// not installed in this repo. Add it with: npm install @libsql/client
/**
 * db-adapters/turso.mjs — Turso (libSQL / SQLite) adapter for StorageStore
 *
 * This file is a drop-in replacement for the default Netlify Blobs backend.
 * It implements the same five-method {@link StorageStore} interface so that
 * every function (auth, meetings, bookings, …) works unchanged.
 *
 * ─── Schema ──────────────────────────────────────────────────────────────────
 *
 * One table stores all named buckets ("stores") in a single KV layout:
 *
 *   CREATE TABLE IF NOT EXISTS kv (
 *     store TEXT NOT NULL,
 *     key   TEXT NOT NULL,
 *     value TEXT NOT NULL,           -- JSON-serialised payload
 *     etag  TEXT NOT NULL,           -- opaque version tag for compare-and-swap
 *     PRIMARY KEY (store, key)
 *   );
 *   CREATE INDEX IF NOT EXISTS kv_store_prefix ON kv (store, key);
 *
 * Run these two statements once before wiring in the adapter.  No other
 * schema changes are needed to support the full application.
 *
 * ─── Wiring in (replace Blobs at startup) ────────────────────────────────────
 *
 *   // At the top of your function entry-point, before the first request:
 *   import { createClient } from "@libsql/client";
 *   import { createTursoFactory } from "./lib/db-adapters/turso.mjs";
 *   import { setDbFactory } from "./lib/db.mjs";
 *
 *   const tursoClient = createClient({
 *     url:       process.env.TURSO_DATABASE_URL,   // libsql://your-db.turso.io
 *     authToken: process.env.TURSO_AUTH_TOKEN,
 *   });
 *   setDbFactory(createTursoFactory(tursoClient));
 *
 * ─── Why this is enough for a migration ──────────────────────────────────────
 *
 * The application never calls Blobs SDK methods directly.  Every store access
 * goes through `getDb(name)` in lib/db.mjs, which returns a StorageStore
 * object.  Replacing the factory is the only change required in production
 * code; all business logic, HTTP handlers, and tests continue working without
 * modification.
 *
 * Data migration (Blobs → Turso) is a one-time offline script: list all Blobs
 * keys, read each value, INSERT INTO kv.  Because all values are already JSON
 * and keys are plain strings, no transformation is needed.
 *
 * ─── Dependency ──────────────────────────────────────────────────────────────
 *
 * Requires `@libsql/client` (Turso's official Node driver):
 *   npm install @libsql/client
 *
 * Also works with any libSQL-compatible server (embedded SQLite via
 * `file:local.db`, a self-hosted sqld instance, etc.).
 */

import crypto from "node:crypto";

/** @returns {string} 16-character random hex etag */
function newEtag() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Escape special LIKE characters in a prefix so they are matched literally.
 * @param {string} s
 * @returns {string}
 */
function escapeLike(s) {
  return s.replace(/[%_\\]/g, "\\$&");
}

/**
 * Create a {@link StorageStore} backed by a single `kv` table row namespace.
 *
 * @param {import("@libsql/client").Client} client - libSQL client
 * @param {string} storeName - Bucket name (e.g. "meetings", "users")
 * @returns {import("../db.mjs").StorageStore}
 */
export function createTursoStore(client, storeName) {
  return {
    /**
     * Read a JSON value by key.  Returns null when absent.
     * @param {string} key
     * @returns {Promise<any>}
     */
    async get(key) {
      const rs = await client.execute({
        sql: "SELECT value FROM kv WHERE store = ? AND key = ?",
        args: [storeName, key],
      });
      if (rs.rows.length === 0) return null;
      return JSON.parse(/** @type {string} */ (rs.rows[0].value));
    },

    /**
     * Read a JSON value together with its etag for compare-and-swap writes.
     * Returns null when absent.
     * @param {string} key
     * @returns {Promise<{ data: any, etag: string }|null>}
     */
    async getWithMetadata(key) {
      const rs = await client.execute({
        sql: "SELECT value, etag FROM kv WHERE store = ? AND key = ?",
        args: [storeName, key],
      });
      if (rs.rows.length === 0) return null;
      return {
        data: JSON.parse(/** @type {string} */ (rs.rows[0].value)),
        etag: /** @type {string} */ (rs.rows[0].etag),
      };
    },

    /**
     * Write a JSON value, optionally with a compare-and-swap condition.
     *
     * - Unconditional (no opts): upsert — always succeeds.
     * - `opts.onlyIfNew`:  INSERT OR IGNORE — succeeds only when key is absent.
     * - `opts.onlyIfMatch`: UPDATE WHERE etag = ? — succeeds only when the
     *   stored etag matches, i.e. no concurrent writer has changed the value.
     *
     * Returns `{ modified: true }` on success, `{ modified: false }` when the
     * CAS condition was not met (the caller should re-read and retry).
     *
     * @param {string} key
     * @param {any} value
     * @param {{ onlyIfMatch?: string, onlyIfNew?: boolean }} [opts]
     * @returns {Promise<{ modified: boolean }>}
     */
    async setJSON(key, value, opts = {}) {
      const etag = newEtag();
      const serialized = JSON.stringify(value);

      if (opts.onlyIfNew) {
        const rs = await client.execute({
          sql: "INSERT OR IGNORE INTO kv (store, key, value, etag) VALUES (?, ?, ?, ?)",
          args: [storeName, key, serialized, etag],
        });
        return { modified: rs.rowsAffected > 0 };
      }

      if (opts.onlyIfMatch) {
        const rs = await client.execute({
          sql: "UPDATE kv SET value = ?, etag = ? WHERE store = ? AND key = ? AND etag = ?",
          args: [serialized, etag, storeName, key, opts.onlyIfMatch],
        });
        return { modified: rs.rowsAffected > 0 };
      }

      // Unconditional upsert.
      await client.execute({
        sql: `INSERT INTO kv (store, key, value, etag) VALUES (?, ?, ?, ?)
              ON CONFLICT(store, key) DO UPDATE
              SET value = excluded.value, etag = excluded.etag`,
        args: [storeName, key, serialized, etag],
      });
      return { modified: true };
    },

    /**
     * Delete a key.  No-op when absent.
     * @param {string} key
     * @returns {Promise<void>}
     */
    async delete(key) {
      await client.execute({
        sql: "DELETE FROM kv WHERE store = ? AND key = ?",
        args: [storeName, key],
      });
    },

    /**
     * List all keys, optionally filtered by prefix.
     * Returns `{ blobs: [{ key }, …] }` — the same shape as Netlify Blobs.
     * @param {{ prefix?: string }} [opts]
     * @returns {Promise<{ blobs: Array<{ key: string }> }>}
     */
    async list(opts = {}) {
      const prefix = opts.prefix || "";
      const rs = await client.execute(
        prefix
          ? {
              sql: "SELECT key FROM kv WHERE store = ? AND key LIKE ? ESCAPE '\\'",
              args: [storeName, escapeLike(prefix) + "%"],
            }
          : {
              sql: "SELECT key FROM kv WHERE store = ?",
              args: [storeName],
            }
      );
      return { blobs: rs.rows.map((r) => ({ key: /** @type {string} */ (r.key) })) };
    },
  };
}

/**
 * Create a `getDb()`-compatible factory backed by Turso.
 *
 * Pass the returned factory to `setDbFactory()` once at process startup:
 *
 * ```js
 * import { createClient } from "@libsql/client";
 * import { createTursoFactory } from "./lib/db-adapters/turso.mjs";
 * import { setDbFactory } from "./lib/db.mjs";
 *
 * setDbFactory(createTursoFactory(createClient({
 *   url:       process.env.TURSO_DATABASE_URL,
 *   authToken: process.env.TURSO_AUTH_TOKEN,
 * })));
 * ```
 *
 * @param {import("@libsql/client").Client} client
 * @returns {(name: string) => import("../db.mjs").StorageStore}
 */
export function createTursoFactory(client) {
  return (name) => createTursoStore(client, name);
}
