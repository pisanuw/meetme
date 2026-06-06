/**
 * auth.mjs — Authentication and user account management
 *
 * Routes handled (path relative to /api/auth/):
 *   GET  health    — environment variable presence check (never returns values)
 *   GET  me        — return the current user (from the session JWT)
 *   GET  profile   — return the full user profile from the database
 *   POST profile   — update name, timezone, profile_complete flag
 *   POST logout    — clear the session cookie
 *
 * Security model:
 *   - Sessions are signed JWTs in an HttpOnly cookie (not localStorage)
 *   - getUserFromRequest reads the JWT from the cookie or a Bearer header
 */
import {
  getDb,
  createToken,
  getUserFromRequest,
  jsonResponse,
  errorResponse,
  setCookie,
  clearCookie,
  log,
  logRequest,
  safeJson,
  saveUserRecord,
  LIMITS,
} from "./utils.mjs";
import magicLinkHandler from "./magic-link.mjs";

const FN = "auth";

export default async (req, context) => {
  try {
    return await handleAuth(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { error: err.message, stack: err.stack });
    return errorResponse(500, "Internal server error.");
  }
};

async function handleAuth(req, context) {
  const path = context.params["0"] || "";
  logRequest(FN, req, { path });

  // Delegate the magic-link sub-routes (request / verify) to their handler.
  if (path.startsWith("magic-link/")) {
    const res = await magicLinkHandler(req, context);
    if (res) return res;
  }

  // ── GET /api/auth/health ──────────────────────────────────────────────────
  // Returns which required environment variables are present. Never returns the
  // secret values — only boolean "is it set?" checks.
  if (req.method === "GET" && path === "health") {
    const checks = {
      jwt_secret: !!process.env.JWT_SECRET,
      app_url: !!process.env.APP_URL,
      resend_api_key: !!process.env.RESEND_API_KEY,
      auth_from_email: !!process.env.AUTH_FROM_EMAIL,
      google_client_id: !!process.env.GOOGLE_CLIENT_ID,
      google_client_secret: !!process.env.GOOGLE_CLIENT_SECRET,
    };
    const missing = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([key]) => key);
    return jsonResponse(200, {
      ok: missing.length === 0,
      checks,
      missing,
      note: "This endpoint never returns secret values; only presence checks.",
    });
  }

  // ── GET /api/auth/me ──────────────────────────────────────────────────────
  if (req.method === "GET" && (path === "me" || path === "")) {
    const tokenUser = getUserFromRequest(req);
    if (!tokenUser) return errorResponse(401, "Not authenticated. Please sign in.");
    const users = getDb("users");
    const user =
      (await users.get(tokenUser.email, { type: "json" }).catch(() => null)) || tokenUser;
    return jsonResponse(200, {
      id: user.id,
      email: user.email,
      name: user.name,
      is_admin: !!user.is_admin,
    });
  }

  // ── GET /api/auth/profile ─────────────────────────────────────────────────
  if (req.method === "GET" && path === "profile") {
    const tokenUser = getUserFromRequest(req);
    if (!tokenUser) return errorResponse(401, "Not authenticated. Please sign in.");
    const users = getDb("users");
    const user = await users.get(tokenUser.email, { type: "json" }).catch(() => null);
    if (!user) return errorResponse(404, "User record not found.");
    return jsonResponse(200, {
      id: user.id,
      email: user.email,
      name: user.name,
      first_name: user.first_name || "",
      last_name: user.last_name || "",
      timezone: user.timezone || "",
      profile_complete: !!user.profile_complete,
    });
  }

  if (req.method !== "POST") {
    return errorResponse(405, `Method ${req.method} not allowed.`);
  }

  const body = await safeJson(req);
  if (body === null) {
    return errorResponse(400, "Request body must be valid JSON.");
  }

  // ── POST /api/auth/profile ────────────────────────────────────────────────
  if (path === "profile") {
    const tokenUser = getUserFromRequest(req);
    if (!tokenUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const firstName = (body.first_name || "").trim();
    const lastName = (body.last_name || "").trim();
    const timezone = (body.timezone || "").trim();
    if (!firstName) return errorResponse(400, "First name is required.");
    if (firstName.length > LIMITS.NAME_MAX || lastName.length > LIMITS.NAME_MAX) {
      return errorResponse(400, `Names must be ${LIMITS.NAME_MAX} characters or fewer.`);
    }

    const users = getDb("users");
    const user = await users.get(tokenUser.email, { type: "json" }).catch(() => null);
    if (!user) return errorResponse(404, "User record not found.");

    user.first_name = firstName;
    user.last_name = lastName;
    user.name = lastName ? `${firstName} ${lastName}` : firstName;
    user.profile_complete = true;
    if (timezone) user.timezone = timezone;
    const savedUser = await saveUserRecord(users, user);

    const newToken = createToken(savedUser);
    log("info", FN, "profile updated", { email: savedUser.email, name: savedUser.name });
    return jsonResponse(
      200,
      { success: true, name: savedUser.name },
      { "Set-Cookie": setCookie("token", newToken) }
    );
  }

  // ── POST /api/auth/logout ─────────────────────────────────────────────────
  if (path === "logout") {
    log("info", FN, "user logged out");
    return jsonResponse(200, { success: true }, { "Set-Cookie": clearCookie("token") });
  }

  return errorResponse(404, `Auth route '${path}' not found.`);
}

export const config = {
  path: "/api/auth/*",
};
