import { clearDbFactoryForTests, setDbFactoryForTests } from "../netlify/functions/utils.mjs";

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createStoreBackend() {
  const stores = new Map();
  // Monotonic counter backing the etags used for conditional writes (CAS).
  let writeSeq = 0;

  function getStoreMap(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function serialize(value, options) {
    if (options.type === "json") return deepClone(value);
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  function createStore(name) {
    const bucket = getStoreMap(name); // Map<key, { value, etag }>
    return {
      async get(key, options = {}) {
        if (!bucket.has(key)) return null;
        return serialize(bucket.get(key).value, options);
      },
      async getWithMetadata(key, options = {}) {
        if (!bucket.has(key)) return null;
        const entry = bucket.get(key);
        return { data: serialize(entry.value, options), etag: entry.etag, metadata: {} };
      },
      // Mirrors @netlify/blobs conditional writes: onlyIfNew / onlyIfMatch
      // gate the write and the result reports whether it was applied.
      async setJSON(key, value, opts = {}) {
        const current = bucket.has(key) ? bucket.get(key) : null;
        if (opts.onlyIfNew && current) return { modified: false };
        if (opts.onlyIfMatch && (!current || current.etag !== opts.onlyIfMatch)) {
          return { modified: false };
        }
        const etag = `etag-${(writeSeq += 1)}`;
        bucket.set(key, { value: deepClone(value), etag });
        return { modified: true, etag };
      },
      async delete(key) {
        bucket.delete(key);
      },
      async list() {
        return {
          blobs: [...bucket.keys()].map((key) => ({ key })),
        };
      },
    };
  }

  return {
    stores,
    createStore,
    clearAll() {
      stores.clear();
    },
  };
}

export function installInMemoryDb() {
  const backend = createStoreBackend();
  setDbFactoryForTests((name) => backend.createStore(name));
  return backend;
}

export function uninstallInMemoryDb() {
  clearDbFactoryForTests();
}

// Base-64 of a 32-byte key ("0123456789abcdef0123456789abcdef").
export const TEST_TOKEN_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

export function setDefaultTestEnv() {
  process.env.JWT_SECRET = "test-jwt-secret";
  process.env.TOKEN_ENCRYPTION_KEY = TEST_TOKEN_ENCRYPTION_KEY;
  process.env.APP_URL = "http://localhost:8888";
  process.env.DISABLE_RATE_LIMIT = process.env.TEST_RATE_LIMIT_MODE === "on" ? "" : "true";
  process.env.COOKIE_SECURE = "false";
  process.env.ADMIN_EMAILS = "admin@example.com";
  delete process.env.RESEND_API_KEY;
  delete process.env.AUTH_FROM_EMAIL;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.BOOKING_REMINDERS_RUN_SECRET;
}

export function makeJsonRequest(url, { method = "GET", body, headers = {} } = {}) {
  const mergedHeaders = { ...headers };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    if (!mergedHeaders["Content-Type"]) mergedHeaders["Content-Type"] = "application/json";
  }
  return new Request(url, {
    method,
    headers: mergedHeaders,
    body: payload,
  });
}

export async function responseJson(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
