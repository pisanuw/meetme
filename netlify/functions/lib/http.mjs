/**
 * lib/http.mjs — HTTP request/response helpers and URL utilities
 */
import { getEnv } from "./env.mjs";

/**
 * Parse the request body as JSON without throwing.
 * Returns `null` when the body is absent or malformed — callers should
 * respond with 400 in that case.
 *
 * @param {Request} req
 * @returns {Promise<object|null>}
 */
export async function safeJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * Normalise and lightly validate an email address.
 * Returns the lower-cased email on success, or `null` when the input is
 * clearly not an email (missing "@" or ".").
 * Note: this is a heuristic check, not RFC-5321 validation.
 *
 * @param {string} email
 * @returns {string|null}
 */
export function validateEmail(email) {
  const e = (email || "").trim().toLowerCase();
  if (!e) return null;
  if (e.length > 254) return null;
  // Practical validation: require exactly one @, no spaces, and a basic domain suffix.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

/**
 * Build a JSON HTTP response.
 *
 * @param {number} statusCode
 * @param {object} body
 * @param {object} [extraHeaders] - E.g. `{ "Set-Cookie": ... }`
 * @returns {Response}
 */
export function jsonResponse(statusCode, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/**
 * Build a JSON error response with a consistent `{ error, detail? }` shape.
 *
 * @param {number} statusCode
 * @param {string} message - Human-readable error description
 * @param {string|null} [detail] - Optional extra context (e.g. exception message)
 * @returns {Response}
 */
export function errorResponse(statusCode, message, detail = null) {
  const body = { error: message };
  if (detail) body.detail = detail;
  return jsonResponse(statusCode, body);
}

/**
 * Decide whether Set-Cookie should include the Secure attribute.
 */
function shouldUseSecureCookies() {
  const override = getEnv("COOKIE_SECURE", "auto").trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;

  const appUrl = getEnv("APP_URL", "").trim();
  if (appUrl) {
    try {
      const parsed = new URL(appUrl);
      if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return false;
      return parsed.protocol === "https:";
    } catch {
      // Ignore malformed APP_URL and continue to fallback checks.
    }
  }

  if (getEnv("NETLIFY_DEV", "").trim().toLowerCase() === "true") return false;
  return true;
}

/**
 * Build an HTTP `Set-Cookie` header value for the session token.
 *
 * @param {string} name
 * @param {string} value
 * @param {number} [maxAge] - Lifetime in seconds (default: 7 days)
 * @returns {string}
 */
export function setCookie(name, value, maxAge = 7 * 24 * 3600) {
  const secure = shouldUseSecureCookies() ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

/**
 * Build a `Set-Cookie` header that immediately expires (clears) the named cookie.
 *
 * @param {string} name
 * @returns {string}
 */
export function clearCookie(name) {
  const secure = shouldUseSecureCookies() ? "; Secure" : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

/**
 * Return the application's public base URL.
 * Reads APP_URL from the environment, falling back to the origin of the
 * incoming request. Centralised here so both auth.mjs and meeting-actions.mjs
 * use the same resolution logic.
 *
 * @param {Request} req
 * @returns {string}
 */
export function getAppUrl(req) {
  const requestOrigin = new URL(req.url).origin;
  const appUrl = getEnv("APP_URL", "").trim();
  const isNetlifyDev = getEnv("NETLIFY_DEV", "").trim().toLowerCase() === "true";

  if (!appUrl) return requestOrigin;

  // Safety for local Netlify Dev: ignore production APP_URL values to avoid
  // broken localhost OAuth redirects when .env contains deployed settings.
  if (isNetlifyDev) {
    try {
      const parsed = new URL(appUrl);
      const host = parsed.hostname.toLowerCase();
      const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!isLocalHost) return requestOrigin;
    } catch {
      return requestOrigin;
    }
  }

  return appUrl;
}
