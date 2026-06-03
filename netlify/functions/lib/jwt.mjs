/**
 * lib/jwt.mjs — JWT creation and verification
 *
 * JWTs are signed with JWT_SECRET and stored in an HttpOnly cookie named "token".
 * The payload mirrors the user object (id, email, name) so most requests do
 * not need a separate database lookup to identify the caller.
 */
import jwt from "jsonwebtoken";
import { getJwtSecret } from "./env.mjs";

/**
 * Sign a JWT with the application secret.
 *
 * @param {object} payload   - Data to embed (typically the user object)
 * @param {string} expiresIn - Expiry string accepted by jsonwebtoken, e.g. "7d", "15m"
 * @returns {string} Signed JWT
 */
export function createToken(payload, expiresIn = "7d") {
  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

/**
 * Verify a JWT and return its decoded payload, or `null` if invalid/expired.
 *
 * @param {string} token
 * @returns {object|null}
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}

/**
 * Like `verifyToken` but also returns the error name so callers can
 * distinguish "expired" from "invalid signature".
 *
 * @param {string} token
 * @returns {{ payload: object|null, error: string|null }}
 */
export function verifyTokenVerbose(token) {
  try {
    return { payload: jwt.verify(token, getJwtSecret()), error: null };
  } catch (err) {
    return { payload: null, error: err.name }; // e.g. "TokenExpiredError"
  }
}

/**
 * Extract and verify the session JWT from the incoming request's Cookie header.
 * Returns the decoded user payload, or `null` if the request is unauthenticated.
 *
 * @param {Request} req
 * @returns {object|null} Decoded JWT payload (user object) or null
 */
export function getUserFromRequest(req) {
  // Check Authorization: Bearer <token> header first (mobile native flows where
  // ASWebAuthenticationSession cookies are not shared with URLSession).
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    return verifyToken(authHeader.slice(7));
  }
  // Fall back to HttpOnly cookie (web and WKWebView flows).
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (!match) return null;
  return verifyToken(match[1]);
}
