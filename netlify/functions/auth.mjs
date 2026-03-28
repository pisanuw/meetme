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
  verifyTokenVerbose,
  getUserFromRequest,
  jsonResponse,
  errorResponse,
  setCookie,
  clearCookie,
  generateId,
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
  getAppUrl,
} from "./utils.mjs";
import { handleGoogleAuthRoute } from "./auth-google.mjs";

const FN = "auth";
const MAX_NAME_LENGTH = 100;

function sanitizeNextPath(raw) {
  const value = String(raw || "").trim();
  if (!value.startsWith("/")) return "";
  if (value.startsWith("//")) return "";
  if (value.includes("\n") || value.includes("\r")) return "";
  return value;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build the Google OAuth redirect URI for sign-in (must match Google Console setting). */
function getGoogleRedirectUri(req) {
  return `${getAppUrl(req)}/api/auth/google/callback`;
}

/**
 * Build a 302 redirect response, optionally with extra headers such as Set-Cookie.
 *
 * @param {string} location
 * @param {object} [extraHeaders]
 * @returns {Response}
 */
function redirectResponse(location, extraHeaders = {}) {
  return new Response("", {
    status: 302,
    headers: { Location: location, ...extraHeaders },
  });
}

/**
 * Extract the client IP address from the forwarded-for header.
 * Used for rate limiting sign-in attempts per IP.
 *
 * @param {Request} req
 * @returns {string}
 */
function getClientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

/**
 * When a user is invited before registering, their invite is stored under
 * `invites:"pending:<email>"`. As soon as they verify a magic link or sign in
 * with Google, this function links those pending invites to their new user ID.
 * The pending blob is deleted afterwards to avoid double-processing on future logins.
 *
 * @param {string} emailKey - Lower-cased email address
 * @param {{ id: string, name: string }} user
 */
async function linkPendingInvites(emailKey, user) {
  const invites = getDb("invites");
  const pendingList = await invites.get(`pending:${emailKey}`, { type: "json" }).catch(() => null);
  if (!pendingList || !Array.isArray(pendingList) || pendingList.length === 0) return;

  for (const meetingId of pendingList) {
    const meetingInvites = asArray(
      await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => [])
    );
    const updated = meetingInvites.map((inv) =>
      inv.email === emailKey ? { ...inv, user_id: user.id, name: inv.name || user.name } : inv
    );
    await invites.setJSON(`meeting:${meetingId}`, updated);
    log("info", FN, "linked pending invite", { email: emailKey, meetingId });
  }

  // Clear the pending list so it is not processed again on subsequent logins
  await invites.delete(`pending:${emailKey}`).catch(() => null);
}

/**
 * Find an existing user by email or create a new one.
 * New user records get a generated ID and a name derived from the email local-part
 * as a reasonable default until the user completes their profile.
 *
 * @param {string} email         - Lower-cased, validated email address
 * @param {string} preferredName - Name hint from the sign-in form or OAuth provider
 * @returns {Promise<{ user: object|null, isNew: boolean }>}
 */
async function getOrCreateUser(email, preferredName = "") {
  const users = getDb("users");
  const emailKey = (email || "").trim().toLowerCase();
  if (!emailKey || !emailKey.includes("@")) return { user: null, isNew: false };

  let user = await users.get(emailKey, { type: "json" }).catch(() => null);
  if (user) {
    log("info", FN, "existing user found", { email: emailKey });
    return { user, isNew: false };
  }

  const fallbackName = emailKey.split("@")[0] || "MeetMe User";
  user = {
    id: generateId(),
    email: emailKey,
    name: (preferredName || "").trim() || fallbackName,
    first_name: "",
    last_name: "",
    profile_complete: false,
    created_at: new Date().toISOString(),
  };

  await users.setJSON(emailKey, user);
  await linkPendingInvites(emailKey, user);
  log("info", FN, "new user created", { email: emailKey, id: user.id });
  return { user, isNew: true };
}

/**
 * Send the one-time magic link email using the shared sendEmail helper.
 * Adds developer-friendly hints to the error message for common Resend API
 * failures (domain not verified, invalid API key, etc.) to ease debugging.
 *
 * @param {string} email - Recipient address
 * @param {string} link  - Full HTTPS magic-link URL
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function sendMagicLinkEmail(email, link) {
  const result = await sendEmail({
    to: email,
    subject: "Your MeetMe sign-in link",
    html: `
      <p>Sign in to MeetMe by clicking the link below:</p>
      <p><a href="${link}">Sign in to MeetMe</a></p>
      <p>This link expires in 15 minutes and can only be used once.</p>
    `,
    text: `Sign in to MeetMe: ${link}\n\nThis link expires in 15 minutes and can only be used once.`,
    tags: [{ name: "type", value: "magic-link" }],
  });

  if (!result.ok) {
    // Add actionable hints for the most common Resend delivery failures.
    let hint = "";
    if (result.error?.includes("HTTP 403")) hint = " (Check sender domain verification in Resend.)";
    if (result.error?.includes("HTTP 401")) hint = " (RESEND_API_KEY may be invalid or expired.)";
    if (result.error?.includes("HTTP 422"))
      hint = " (AUTH_FROM_EMAIL may not be a verified sender.)";
    log("error", FN, "magic link email failed", { to: email, error: result.error });
    return { ok: false, error: (result.error || "Unknown error") + hint };
  }

  log("info", FN, "magic link email sent", { to: email });
  return { ok: true };
}

export default async (req, context) => {
  try {
    return await handleAuth(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { error: err.message, stack: err.stack });
    return errorResponse(500, "Internal server error.", err.message);
  }
};

async function handleAuth(req, context) {
  const path = context.params["0"] || "";
  logRequest(FN, req, { path });

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

  if (req.method === "GET" && path === "magic-link/verify") {
    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";

    if (!token) {
      log("warn", FN, "magic-link/verify called with no token");
      return redirectResponse("/?error=invalid-link");
    }

    const { payload, error: tokenError } = verifyTokenVerbose(token);
    if (!payload) {
      const reason = tokenError === "TokenExpiredError" ? "link-expired" : "invalid-link";
      log("warn", FN, "magic link token invalid", { reason: tokenError });
      return redirectResponse(`/?error=${reason}`);
    }

    if (payload.purpose !== "magic_link" || !payload.jti || !payload.email) {
      log("warn", FN, "magic link token has wrong shape", { purpose: payload.purpose });
      return redirectResponse("/?error=invalid-link");
    }

    const loginTokens = getDb("login_tokens");
    const tokenRecord = await loginTokens.get(payload.jti, { type: "json" }).catch(() => null);

    if (!tokenRecord) {
      log("warn", FN, "magic link jti not found in store", { jti: payload.jti });
      return redirectResponse("/?error=invalid-link");
    }
    if (tokenRecord.used) {
      log("warn", FN, "magic link already used", { jti: payload.jti });
      return redirectResponse("/?error=link-already-used");
    }
    if (tokenRecord.email !== payload.email) {
      log("warn", FN, "magic link email mismatch", { jti: payload.jti });
      return redirectResponse("/?error=invalid-link");
    }

    await loginTokens.setJSON(payload.jti, {
      ...tokenRecord,
      used: true,
      used_at: new Date().toISOString(),
    });

    const { user, isNew } = await getOrCreateUser(payload.email, payload.name || "");
    if (!user) {
      log("error", FN, "getOrCreateUser returned null during magic link verify", {
        email: payload.email,
      });
      return redirectResponse("/?error=invalid-link");
    }

    // Always attempt to link pending invites at verify time — handles the case where
    // the user was invited to a new meeting after their account was already created.
    await linkPendingInvites(payload.email, user);

    const appToken = createToken(user);
    log("info", FN, "magic link sign-in successful", { email: user.email, isNew });
    await persistEvent("info", FN, "sign-in", {
      sign_in_method: "magic-link",
      email: user.email,
      name: user.name || user.email,
      is_new_user: !!isNew,
    });
    const returnTo = sanitizeNextPath(payload.next || "");
    const dest =
      isNew || !user.profile_complete ? "/profile.html?setup=1" : returnTo || "/dashboard.html";
    return redirectResponse(dest, { "Set-Cookie": setCookie("token", appToken) });
  }

  const googleRouteResponse = await handleGoogleAuthRoute({
    req,
    path,
    fnName: FN,
    getAppUrl,
    getGoogleRedirectUri,
    getClientIp,
    checkRateLimit,
    getOrCreateUser,
  });
  if (googleRouteResponse) return googleRouteResponse;

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
    const user =
      (await users.get(tokenUser.email, { type: "json" }).catch(() => null)) || tokenUser;
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

  if (req.method !== "POST") {
    return errorResponse(405, `Method ${req.method} not allowed.`);
  }

  if (path === "google/calendar-disconnect") {
    const tokenUser = getUserFromRequest(req);
    if (!tokenUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const users = getDb("users");
    const user = await users.get(tokenUser.email, { type: "json" }).catch(() => null);
    if (!user) return errorResponse(404, "User record not found.");

    const refreshToken = decryptSecret(user.google_refresh_token);
    const accessToken = decryptSecret(user.google_access_token);
    const tokenToRevoke = refreshToken || accessToken;
    if (tokenToRevoke) {
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: tokenToRevoke }),
        });
      } catch (err) {
        log("warn", FN, "google revoke request failed", { email: user.email, error: err.message });
      }
    }

    user.calendar_connected = false;
    user.google_access_token = "";
    user.google_refresh_token = "";
    user.google_token_expiry = 0;
    await users.setJSON(tokenUser.email, user);

    await persistEvent("info", FN, "calendar disconnected", { email: user.email });
    return jsonResponse(200, { success: true, message: "Google Calendar disconnected." });
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
    if (firstName.length > MAX_NAME_LENGTH || lastName.length > MAX_NAME_LENGTH) {
      return errorResponse(400, `Names must be ${MAX_NAME_LENGTH} characters or fewer.`);
    }

    const users = getDb("users");
    const user = await users.get(tokenUser.email, { type: "json" }).catch(() => null);
    if (!user) return errorResponse(404, "User record not found.");

    user.first_name = firstName;
    user.last_name = lastName;
    user.name = lastName ? `${firstName} ${lastName}` : firstName;
    user.profile_complete = true;
    if (timezone) user.timezone = timezone;
    await users.setJSON(tokenUser.email, user);

    const newToken = createToken(user);
    log("info", FN, "profile updated", { email: user.email, name: user.name });
    return jsonResponse(
      200,
      { success: true, name: user.name },
      { "Set-Cookie": setCookie("token", newToken) }
    );
  }

  if (path === "magic-link/request") {
    const emailKey = validateEmail(body.email || "");
    const name = (body.name || "").trim();
    const next = sanitizeNextPath(body.next || "");

    if (!emailKey) {
      return errorResponse(400, "A valid email address is required.");
    }
    if (name.length > MAX_NAME_LENGTH) {
      return errorResponse(400, `Name must be ${MAX_NAME_LENGTH} characters or fewer.`);
    }

    if (isRateLimitEnabled()) {
      const ip = getClientIp(req);
      const ipRate = await checkRateLimit({
        bucket: "auth_magic_link_ip",
        key: ip,
        limit: 12,
        windowMs: 15 * 60 * 1000,
      });
      if (!ipRate.ok) {
        return jsonResponse(429, {
          error: "Too many sign-in requests from this network. Please wait and try again.",
          retry_after_seconds: ipRate.retryAfterSec,
        });
      }

      const emailRate = await checkRateLimit({
        bucket: "auth_magic_link_email",
        key: emailKey,
        limit: 5,
        windowMs: 15 * 60 * 1000,
      });
      if (!emailRate.ok) {
        return jsonResponse(429, {
          error:
            "Too many sign-in links requested for this email. Please wait before requesting another.",
          retry_after_seconds: emailRate.retryAfterSec,
        });
      }
    }

    await getOrCreateUser(emailKey, name); // pre-create user record; isNew redirect handled at verify step

    const jti = generateId();
    const loginTokens = getDb("login_tokens");
    await loginTokens.setJSON(jti, {
      email: emailKey,
      used: false,
      created_at: new Date().toISOString(),
    });

    const token = createToken(
      { id: "magic-link", email: emailKey, name, purpose: "magic_link", jti, next },
      "15m"
    );
    const link = `${getAppUrl(req)}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;

    log("info", FN, "magic link generated", { email: emailKey });

    const sendResult = await sendMagicLinkEmail(emailKey, link);
    if (!sendResult.ok) {
      return errorResponse(500, sendResult.error);
    }

    return jsonResponse(200, { success: true, message: "Check your email for a sign-in link." });
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

    if (!senderEmail) {
      return errorResponse(400, "A valid email address is required.");
    }
    if (!message) {
      return errorResponse(400, "Message is required.");
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
      return errorResponse(500, `Could not send feedback email: ${result.error}`);
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
