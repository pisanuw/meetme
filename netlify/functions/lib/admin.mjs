/**
 * lib/admin.mjs — Admin role helpers
 */
import { getEnv } from "./env.mjs";

/**
 * Return `true` if the user's email is listed in the ADMIN_EMAILS environment
 * variable (comma-separated). Comparison is case-insensitive.
 *
 * @param {{ email: string }|null} user
 * @returns {boolean}
 */
export function isAdmin(user) {
  if (!user) return false;
  if (isSuperAdminEmail(user.email || "")) return true;
  return Boolean(user.is_admin);
}

/**
 * Return true if the email belongs to an environment-configured super admin.
 * These users are sourced from ADMIN_EMAILS and should not be removed through UI.
 *
 * @param {string} email
 * @returns {boolean}
 */
export function isSuperAdminEmail(email) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  const adminEmails = getEnv("ADMIN_EMAILS", "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(normalized);
}

/**
 * Return a copy of a user object with sensitive token fields removed.
 * Use this at every public-facing response site that returns a user record to
 * ensure encrypted OAuth tokens are never accidentally serialised to the client.
 *
 * @param {object} user
 * @returns {object}
 */
export function sanitizeUser(user) {
  const safe = { ...(user || {}) };
  delete safe.google_access_token;
  delete safe.google_refresh_token;
  delete safe.google_token_expiry;
  return safe;
}
