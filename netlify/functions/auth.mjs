/**
 * auth.mjs — Authentication and user account management
 *
 * Routes handled (path relative to /api/auth/):
 *   GET  health                   — environment variable presence check
 *   GET  me                       — return current user (from JWT cookie)
 *   GET  profile                  — return full user profile from the database
 *   POST profile                  — update name, timezone, profile_complete flag
 *   POST magic-link/request       — send a one-time sign-in link via email
 *   GET  magic-link/verify        — verify magic link token and set session cookie
 *   GET  google/start             — begin Google OAuth flow (sign-in)
 *   GET  google/callback          — handle Google OAuth callback
 *   GET  google/calendar-start    — begin Google Calendar OAuth flow
 *   GET  google/calendar-callback — handle Calendar OAuth callback
 *   POST google/calendar-disconnect — revoke calendar access
 *   POST logout                   — clear session cookie
 *   POST feedback                 — send user feedback to admin email addresses
 *
 * Security model:
 *   - Sessions are stored as signed JWTs in an HttpOnly cookie (not localStorage)
 *   - Magic links use a single-use JTI stored in Netlify Blobs
 *   - OAuth state is verified with a signed JWT + matching cookie (CSRF protection)
 *   - Sensitive tokens (Google OAuth) are AES-256-GCM encrypted at rest
 *   - All auth endpoints have per-IP and per-email rate limiting
 */
import {
  getDb,
  getEnv,
  createToken,
  getUserFromRequest,
  jsonResponse,
  errorResponse,
  setCookie,
  clearCookie,
  log,
  logRequest,
  safeJson,
  validateEmail,
  persistEvent,
  isAdmin,
  checkRateLimit,
  isRateLimitEnabled,
  decryptSecret,
  sendEmail,
  asArray,
  escapeHtml,
  getEmailPreferences,
  saveEmailPreferences,
  saveUserRecord,
  LIMITS,
} from "./utils.mjs";
import magicLinkHandler from "./magic-link.mjs";
import googleAuthHandler from "./auth-google.mjs";
import { getClientIp } from "./auth-helpers.mjs";

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

  if (path.startsWith("magic-link/")) {
    const res = await magicLinkHandler(req, context);
    if (res) return res;
  }
  if (path.startsWith("google/")) {
    const res = await googleAuthHandler(req, context);
    if (res) return res;
  }

  // ── GET /api/auth/health ──────────────────────────────────────────────────
  // Returns a JSON object showing which required environment variables are set.
  // Never returns the secret values — only boolean "is it present?" checks.
  // Useful for diagnosing misconfigured Netlify deployments.
  // Anonymous callers receive only a binary ok/not-ok status; the per-variable
  // breakdown is restricted to authenticated admins to avoid disclosing which
  // third-party integrations are configured.
  if (req.method === "GET" && path === "health") {
    const checks = {
      jwt_secret: !!getEnv("JWT_SECRET"),
      app_url: !!getEnv("APP_URL"),
      resend_api_key: !!getEnv("RESEND_API_KEY"),
      auth_from_email: !!getEnv("AUTH_FROM_EMAIL"),
      google_client_id: !!getEnv("GOOGLE_CLIENT_ID"),
      google_client_secret: !!getEnv("GOOGLE_CLIENT_SECRET"),
    };

    const missing = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([key]) => key);

    const currentUser = getUserFromRequest(req);
    if (!isAdmin(currentUser)) {
      return jsonResponse(200, {
        ok: missing.length === 0,
        note: "Sign in as an admin to see per-variable details.",
      });
    }

    return jsonResponse(200, {
      ok: missing.length === 0,
      checks,
      missing,
      note: "This endpoint never returns secret values; only presence checks.",
    });
  }

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
      calendar_connected: !!(user.calendar_connected && decryptSecret(user.google_access_token)),
    });
  }

  if (req.method === "GET" && (path === "me" || path === "")) {
    const tokenUser = getUserFromRequest(req);
    if (!tokenUser) return errorResponse(401, "Not authenticated. Please sign in.");
    const users = getDb("users");
    const user = (await users.get(tokenUser.email, { type: "json" }).catch(() => null)) || tokenUser;
    return jsonResponse(200, {
      id: user.id,
      email: user.email,
      name: user.name,
      is_admin: isAdmin(user),
      is_impersonated: !!user.is_impersonated,
      impersonator_email: user.impersonator_email || null,
      impersonator_name: user.impersonator_name || null,
    });
  }

  if (req.method === "GET" && path === "email-preferences") {
    const tokenUser = getUserFromRequest(req);
    if (!tokenUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const prefs = await getEmailPreferences(tokenUser.email);
    return jsonResponse(200, {
      email: prefs.email,
      global_opt_out: prefs.global_opt_out,
      blocked_organizers: prefs.blocked_organizers,
      updated_at: prefs.updated_at,
    });
  }

  if (req.method !== "POST") {
    return errorResponse(405, `Method ${req.method} not allowed.`);
  }

  if (path === "impersonation/stop") {
    const tokenUser = getUserFromRequest(req);
    if (!tokenUser) return errorResponse(401, "Not authenticated. Please sign in.");
    if (!tokenUser.is_impersonated || !tokenUser.impersonator_email) {
      return errorResponse(403, "This session is not impersonating another user.");
    }

    const usersDb = getDb("users");
    const adminUser = await usersDb
      .get(tokenUser.impersonator_email, { type: "json" })
      .catch(() => null);
    if (!adminUser || !isAdmin(adminUser)) {
      return errorResponse(403, "Cannot restore admin session. Please sign in again.");
    }

    const adminToken = createToken(adminUser);
    await persistEvent("warn", FN, "admin stopped impersonation", {
      admin_email: adminUser.email,
      admin_name: adminUser.name || adminUser.email,
      previous_user_email: tokenUser.email,
      previous_user_name: tokenUser.name || tokenUser.email,
    });

    return jsonResponse(
      200,
      { success: true, message: "Returned to admin session." },
      {
        "Set-Cookie": setCookie("token", adminToken),
      }
    );
  }

  const body = await safeJson(req);
  if (body === null) {
    return errorResponse(400, "Request body must be valid JSON.");
  }

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

  if (path === "email-preferences") {
    const tokenUser = getUserFromRequest(req);
    if (!tokenUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const globalOptOut = body.global_opt_out === true;
    const blockedOrganizers = asArray(body.blocked_organizers)
      .map((item) => validateEmail(item || ""))
      .filter(Boolean);

    const prefs = await saveEmailPreferences(tokenUser.email, {
      global_opt_out: globalOptOut,
      blocked_organizers: blockedOrganizers,
    });

    await persistEvent("info", FN, "user updated email preferences", {
      email: tokenUser.email,
      global_opt_out: prefs.global_opt_out,
      blocked_organizers_count: prefs.blocked_organizers.length,
    });

    return jsonResponse(200, {
      success: true,
      email: prefs.email,
      global_opt_out: prefs.global_opt_out,
      blocked_organizers: prefs.blocked_organizers,
      updated_at: prefs.updated_at,
    });
  }

  if (path === "login" || path === "register") {
    return errorResponse(
      410,
      "Email/password auth is disabled. Use the email sign-in link or Google."
    );
  }

  if (path === "logout") {
    log("info", FN, "user logged out");
    return jsonResponse(200, { success: true }, { "Set-Cookie": clearCookie("token") });
  }

  if (path === "feedback") {
    const senderName = (body.name || "").trim();
    const senderEmail = validateEmail(body.email || "");
    const feedbackType = (body.type || "other").trim();
    const message = (body.message || "").trim();

    if (isRateLimitEnabled()) {
      const ip = getClientIp(req);
      const ipRate = await checkRateLimit({
        bucket: "auth_feedback_ip",
        key: ip,
        limit: 6,
        windowMs: 15 * 60 * 1000,
      });
      if (!ipRate.ok) {
        return jsonResponse(429, {
          error: "Too many feedback submissions from this network. Please try again later.",
          retry_after_seconds: ipRate.retryAfterSec,
        });
      }

      const emailRate = await checkRateLimit({
        bucket: "auth_feedback_email",
        key: senderEmail || "unknown",
        limit: 5,
        windowMs: 60 * 60 * 1000,
      });
      if (!emailRate.ok) {
        return jsonResponse(429, {
          error: "Too many feedback submissions from this email. Please try again later.",
          retry_after_seconds: emailRate.retryAfterSec,
        });
      }
    }

    if (!senderEmail) {
      return errorResponse(400, "A valid email address is required.");
    }
    if (senderName.length > LIMITS.NAME_MAX) {
      return errorResponse(
        400,
        `Name must be ${LIMITS.NAME_MAX} characters or fewer.`
      );
    }
    if (!message) {
      return errorResponse(400, "Message is required.");
    }
    if (message.length > LIMITS.FEEDBACK_MESSAGE_MAX) {
      return errorResponse(
        400,
        `Message must be ${LIMITS.FEEDBACK_MESSAGE_MAX} characters or fewer.`
      );
    }

    const adminEmails = getEnv("ADMIN_EMAILS", "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    if (adminEmails.length === 0) {
      log("warn", FN, "feedback not sent: ADMIN_EMAILS is not configured");
      return errorResponse(500, "Feedback email delivery is not configured on this server.");
    }

    const typeLabels = {
      bug: "Bug Report",
      feature: "Feature Request",
      question: "Question",
      other: "General Feedback",
    };
    const typeLabel = typeLabels[feedbackType] || "Feedback";
    const subject = `[MeetMe Feedback] ${typeLabel} from ${senderName || senderEmail}`;

    // escapeHtml() prevents XSS if message content were ever rendered in HTML.
    const escapedMessage = escapeHtml(message);
    const html = `
      <h2 style="margin:0 0 16px">MeetMe Feedback &mdash; ${typeLabel}</h2>
      <table style="font-size:14px;border-collapse:collapse;width:100%">
        <tr><th style="text-align:left;padding:6px 12px 6px 0;color:#555">From</th>
            <td style="padding:6px 0">${senderName ? `${escapeHtml(senderName)} &lt;${escapeHtml(senderEmail)}&gt;` : escapeHtml(senderEmail)}</td></tr>
        <tr><th style="text-align:left;padding:6px 12px 6px 0;color:#555">Type</th>
            <td style="padding:6px 0">${typeLabel}</td></tr>
      </table>
      <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb">
      <h3 style="margin:0 0 8px;font-size:14px;color:#555">Message</h3>
      <p style="white-space:pre-wrap;font-size:14px;line-height:1.6">${escapedMessage}</p>
    `;
    const text = `MeetMe Feedback (${typeLabel})\nFrom: ${senderName || senderEmail} <${senderEmail}>\n\n${message}`;

    const result = await sendEmail({
      to: adminEmails,
      subject,
      html,
      text,
      replyTo: senderEmail,
      tags: [{ name: "type", value: "feedback" }],
    });

    if (!result.ok) {
      log("error", FN, "feedback email failed", { error: result.error });
      return errorResponse(500, "Could not send feedback email at this time.");
    }

    log("info", FN, "feedback sent", { from: senderEmail, type: feedbackType });
    await persistEvent("info", FN, "feedback received", { from: senderEmail, type: feedbackType });
    return jsonResponse(200, { success: true, message: "Feedback sent. Thank you!" });
  }

  return errorResponse(404, `Auth route '${path}' not found.`);
}

export const config = {
  path: "/api/auth/*",
};
