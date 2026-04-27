/**
 * lib/env.mjs — Environment variable access
 */

/**
 * Read an environment variable, trying Netlify's runtime first and then
 * Node's `process.env` as a fallback (useful in local dev with a .env file).
 *
 * @param {string} name     - Variable name, e.g. "JWT_SECRET"
 * @param {string} fallback - Value returned when the variable is absent
 * @returns {string}
 */
export function getEnv(name, fallback = "") {
  const fromNetlify =
    typeof Netlify !== "undefined" && Netlify?.env?.get ? Netlify.env.get(name) : undefined;
  if (fromNetlify !== undefined && fromNetlify !== null && fromNetlify !== "") {
    return fromNetlify;
  }
  const fromProcess = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (fromProcess !== undefined && fromProcess !== null && fromProcess !== "") {
    return fromProcess;
  }
  return fallback;
}

/** Returns the JWT signing secret. Throws if JWT_SECRET is not configured. */
export function getJwtSecret() {
  const secret = getEnv("JWT_SECRET", "").trim();
  if (!secret) {
    throw new Error("Missing JWT_SECRET environment variable.");
  }
  return secret;
}

/**
 * Returns true when rate limiting should be enforced.
 * Set DISABLE_RATE_LIMIT=true in your local .env to skip rate checks during
 * development. This variable must NEVER be set in production.
 *
 * @returns {boolean}
 */
export function isRateLimitEnabled() {
  return getEnv("DISABLE_RATE_LIMIT", "") !== "true";
}
