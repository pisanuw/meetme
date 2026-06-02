/**
 * auth.mjs — Authentication and account routes (path relative to /api/auth/)
 *
 * Routes handled so far:
 *   GET  health   — environment variable presence check (never returns values)
 *
 * More routes (me, logout, profile, magic-link, google, …) are added in later
 * stages. Netlify maps every /api/auth/* request here via the config below.
 */
import { jsonResponse, errorResponse, log, logRequest } from "./utils.mjs";

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

  // ── GET /api/auth/health ──────────────────────────────────────────────────
  // Returns which required environment variables are present. Never returns the
  // secret values — only boolean "is it set?" checks — so it is safe to call
  // when diagnosing a misconfigured deployment.
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

  return errorResponse(404, `Auth route '${path}' not found.`);
}

export const config = {
  path: "/api/auth/*",
};
