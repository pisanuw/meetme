import { clearDbFactoryForTests, setDbFactoryForTests } from "../netlify/functions/utils.mjs";

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createStoreBackend() {
  const stores = new Map();

  function getStoreMap(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function createStore(name) {
    const bucket = getStoreMap(name);
    return {
      async get(key, options = {}) {
        if (!bucket.has(key)) return null;
        const value = bucket.get(key);
        if (options.type === "json") return deepClone(value);
        return typeof value === "string" ? value : JSON.stringify(value);
      },
      async setJSON(key, value) {
        bucket.set(key, deepClone(value));
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

export function setDefaultTestEnv() {
  process.env.JWT_SECRET = "test-jwt-secret";
  process.env.APP_URL = "http://localhost:8888";
  process.env.DISABLE_RATE_LIMIT =
    process.env.TEST_RATE_LIMIT_MODE === "on" ? "" : "true";
  process.env.COOKIE_SECURE = "false";
  process.env.ADMIN_EMAILS = "admin@example.com";
  delete process.env.RESEND_API_KEY;
  delete process.env.AUTH_FROM_EMAIL;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
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
