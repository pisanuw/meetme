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
