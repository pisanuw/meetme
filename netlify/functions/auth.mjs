import {
  getDb, getEnv, createToken, verifyToken, verifyTokenVerbose,
  getUserFromRequest, jsonResponse, errorResponse,
  setCookie, clearCookie, generateId,
  log, logRequest, safeJson, validateEmail, persistEvent,
  isAdmin, checkRateLimit, encryptSecret, decryptSecret,
} from "./utils.mjs";

const FN = "auth";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAppUrl(req) {
  return getEnv("APP_URL", new URL(req.url).origin);
}

function getGoogleRedirectUri(req) {
  return `${getAppUrl(req)}/api/auth/google/callback`;
}

function redirectResponse(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, ...extraHeaders },
  });
}

function getClientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

async function linkPendingInvites(emailKey, user) {
  const invites = getDb("invites");
  const asArray = (value) => Array.isArray(value) ? value : [];
  const pendingList = await invites.get(`pending:${emailKey}`, { type: "json" }).catch(() => null);
  if (!pendingList || !Array.isArray(pendingList) || pendingList.length === 0) return;

  for (const meetingId of pendingList) {
    const meetingInvites = asArray(await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []));
    const updated = meetingInvites.map(inv =>
      inv.email === emailKey ? { ...inv, user_id: user.id, name: inv.name || user.name } : inv
    );
    await invites.setJSON(`meeting:${meetingId}`, updated);
    log("info", FN, "linked pending invite", { email: emailKey, meetingId });
  }

  // Clear the pending list so it is not processed again on subsequent logins
  await invites.delete(`pending:${emailKey}`).catch(() => null);
}

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

async function sendMagicLinkEmail(email, link) {
  const apiKey = getEnv("RESEND_API_KEY");
  const fromEmail = getEnv("AUTH_FROM_EMAIL");

  if (!apiKey) {
    log("error", FN, "RESEND_API_KEY is not set");
    return { ok: false, error: "Email delivery is not configured — RESEND_API_KEY is missing." };
  }
  if (!fromEmail) {
    log("error", FN, "AUTH_FROM_EMAIL is not set");
    return { ok: false, error: "Email delivery is not configured — AUTH_FROM_EMAIL is missing." };
  }

  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: "Your MeetMe sign-in link",
        html: `<p>Sign in to MeetMe by clicking the link below:</p><p><a href="${link}">Sign in to MeetMe</a></p><p>This link expires in 15 minutes and can only be used once.</p>`,
        text: `Sign in to MeetMe: ${link}\n\nThis link expires in 15 minutes and can only be used once.`,
      }),
    });
  } catch (err) {
    log("error", FN, "Resend fetch threw", { error: err.message });
    return { ok: false, error: `Could not reach email delivery service: ${err.message}` };
  }

  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    log("error", FN, "Resend API error", { status: response.status, body: payload });
    let hint = "";
    if (response.status === 403) hint = " (check sender domain verification in Resend)";
    if (response.status === 401) hint = " (RESEND_API_KEY may be invalid or expired)";
    if (response.status === 422) hint = " (AUTH_FROM_EMAIL may not be a verified sender in Resend)";
    return { ok: false, error: `Email delivery failed (HTTP ${response.status})${hint}.` };
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

    await loginTokens.setJSON(payload.jti, { ...tokenRecord, used: true, used_at: new Date().toISOString() });

    const { user, isNew } = await getOrCreateUser(payload.email, payload.name || "");
    if (!user) {
      log("error", FN, "getOrCreateUser returned null during magic link verify", { email: payload.email });
      return redirectResponse("/?error=invalid-link");
    }

    // Always attempt to link pending invites at verify time — handles the case where
    // the user was invited to a new meeting after their account was already created.
    await linkPendingInvites(payload.email, user);

    const appToken = createToken(user);
    log("info", FN, "magic link sign-in successful", { email: user.email, isNew });
    await persistEvent("info", FN, "sign-in", { method: "magic-link", email: user.email, isNew });
    const dest = (isNew || !user.profile_complete) ? "/profile.html?setup=1" : "/dashboard.html";
    return redirectResponse(dest, { "Set-Cookie": setCookie("token", appToken) });
  }

  if (req.method === "GET" && path === "google/start") {
    const ip = getClientIp(req);
    const ipRate = await checkRateLimit({
      bucket: "auth_google_start_ip",
      key: ip,
      limit: 20,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipRate.ok) {
      return redirectResponse(`/?error=rate-limited&retry=${ipRate.retryAfterSec}`);
    }

    const googleClientId = getEnv("GOOGLE_CLIENT_ID");
    if (!googleClientId) {
      log("error", FN, "GOOGLE_CLIENT_ID is not set");
      return redirectResponse("/?error=google-not-configured");
    }

    const redirectUri = getGoogleRedirectUri(req);
    const stateToken = createToken({
      id: "oauth-state",
      email: "oauth-state@meetme.local",
      name: "oauth",
      purpose: "google_oauth_state",
      return_to: "/dashboard.html",
      jti: generateId(),
    }, "10m");

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", googleClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("prompt", "select_account");
    authUrl.searchParams.set("state", stateToken);

    log("info", FN, "google oauth start", { redirect_uri: redirectUri });
    return redirectResponse(authUrl.toString(), { "Set-Cookie": setCookie("oauth_state", stateToken, 10 * 60) });
  }

  if (req.method === "GET" && path === "google/callback") {
    const googleClientId = getEnv("GOOGLE_CLIENT_ID");
    const googleClientSecret = getEnv("GOOGLE_CLIENT_SECRET");
    if (!googleClientId || !googleClientSecret) {
      log("error", FN, "Google env vars missing in callback");
      return redirectResponse("/?error=google-not-configured");
    }

    const url = new URL(req.url);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const googleError = url.searchParams.get("error") || "";

    if (googleError) {
      log("warn", FN, "Google returned error param", { google_error: googleError });
      return redirectResponse("/?error=google-denied");
    }
    if (!code) {
      log("warn", FN, "Google callback missing code");
      return redirectResponse("/?error=google-auth-failed");
    }

    const cookie = req.headers.get("cookie") || "";
    const stateMatch = cookie.match(/(?:^|;\s*)oauth_state=([^;]+)/);
    const stateFromCookie = stateMatch ? stateMatch[1] : "";

    if (!stateFromCookie) {
      log("warn", FN, "oauth_state cookie missing — possible CSRF or cookie blocked by browser");
      return redirectResponse("/?error=google-state-missing");
    }
    if (state !== stateFromCookie) {
      log("warn", FN, "oauth state mismatch — possible CSRF");
      return redirectResponse("/?error=google-auth-failed");
    }

    const statePayload = verifyToken(state);
    if (!statePayload || statePayload.purpose !== "google_oauth_state") {
      log("warn", FN, "oauth state JWT invalid or expired");
      return redirectResponse("/?error=google-state-expired");
    }

    const redirectUri = getGoogleRedirectUri(req);
    let tokenRes;
    try {
      tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: googleClientId, client_secret: googleClientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
      });
    } catch (err) {
      log("error", FN, "google token exchange fetch threw", { error: err.message });
      return redirectResponse("/?error=google-auth-failed");
    }

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      log("error", FN, "google token exchange failed", { status: tokenRes.status, body });
      return redirectResponse("/?error=google-auth-failed");
    }

    const tokenData = await tokenRes.json().catch(() => ({}));
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      log("error", FN, "google token exchange returned no access_token", { keys: Object.keys(tokenData) });
      return redirectResponse("/?error=google-auth-failed");
    }

    let userInfoRes;
    try {
      userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      log("error", FN, "google userinfo fetch threw", { error: err.message });
      return redirectResponse("/?error=google-auth-failed");
    }

    if (!userInfoRes.ok) {
      log("error", FN, "google userinfo failed", { status: userInfoRes.status });
      return redirectResponse("/?error=google-auth-failed");
    }

    const googleUser = await userInfoRes.json().catch(() => ({}));
    const email = validateEmail(googleUser.email || "");
    const isVerified = !!googleUser.email_verified;

    if (!email) {
      log("warn", FN, "google user has no valid email", { sub: googleUser.sub });
      return redirectResponse("/?error=google-email-missing");
    }
    if (!isVerified) {
      log("warn", FN, "google user email not verified", { email });
      return redirectResponse("/?error=google-email-not-verified");
    }

    const { user, isNew } = await getOrCreateUser(email, googleUser.name || "");
    if (!user) {
      log("error", FN, "getOrCreateUser returned null during google callback", { email });
      return redirectResponse("/?error=google-auth-failed");
    }

    const appToken = createToken(user);
    log("info", FN, "google sign-in successful", { email: user.email, isNew });
    await persistEvent("info", FN, "sign-in", { method: "google", email: user.email, isNew });
    const dest = (isNew || !user.profile_complete) ? "/profile.html?setup=1" : (statePayload.return_to || "/dashboard.html");
    return redirectResponse(dest, { "Set-Cookie": setCookie("token", appToken) });
  }

  // ─── GET /api/auth/google/calendar-start ─────────────────────────────────
  if (req.method === "GET" && path === "google/calendar-start") {
    const calUser = getUserFromRequest(req);
    if (!calUser) return redirectResponse("/?error=not-authenticated");

    const userRate = await checkRateLimit({
      bucket: "auth_calendar_start_user",
      key: calUser.email,
      limit: 8,
      windowMs: 15 * 60 * 1000,
    });
    if (!userRate.ok) {
      return redirectResponse(`/profile.html?error=calendar-rate-limited&retry=${userRate.retryAfterSec}`);
    }

    const googleClientId = getEnv("GOOGLE_CLIENT_ID");
    if (!googleClientId) return redirectResponse("/profile.html?error=google-not-configured");

    const redirectUri = `${getAppUrl(req)}/api/auth/google/calendar-callback`;
    const stateToken = createToken({
      id: "oauth-state",
      email: calUser.email,
      name: "calendar-connect",
      purpose: "google_calendar_state",
      return_to: "/profile.html?calendar=connected",
      jti: generateId(),
    }, "10m");

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", googleClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.readonly");
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", stateToken);
    authUrl.searchParams.set("login_hint", calUser.email);

    log("info", FN, "google calendar connect start", { email: calUser.email, redirect_uri: redirectUri });
    return redirectResponse(authUrl.toString(), { "Set-Cookie": setCookie("gcal_state", stateToken, 10 * 60) });
  }

  // ─── GET /api/auth/google/calendar-callback ───────────────────────────────
  if (req.method === "GET" && path === "google/calendar-callback") {
    const googleClientId = getEnv("GOOGLE_CLIENT_ID");
    const googleClientSecret = getEnv("GOOGLE_CLIENT_SECRET");
    if (!googleClientId || !googleClientSecret) return redirectResponse("/profile.html?error=google-not-configured");

    const calUser = getUserFromRequest(req);
    if (!calUser) return redirectResponse("/?error=not-authenticated");

    const url = new URL(req.url);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const googleError = url.searchParams.get("error") || "";

    if (googleError) return redirectResponse("/profile.html?error=calendar-denied");
    if (!code) return redirectResponse("/profile.html?error=calendar-auth-failed");

    const cookie = req.headers.get("cookie") || "";
    const stateMatch = cookie.match(/(?:^|;\s*)gcal_state=([^;]+)/);
    const stateFromCookie = stateMatch ? stateMatch[1] : "";
    if (!stateFromCookie || state !== stateFromCookie) {
      return redirectResponse("/profile.html?error=calendar-state-mismatch");
    }

    const statePayload = verifyToken(state);
    if (!statePayload || statePayload.purpose !== "google_calendar_state") {
      return redirectResponse("/profile.html?error=calendar-state-expired");
    }

    const redirectUri = `${getAppUrl(req)}/api/auth/google/calendar-callback`;
    let tokenRes;
    try {
      tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: googleClientId, client_secret: googleClientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
      });
    } catch (err) {
      log("error", FN, "calendar token exchange threw", { error: err.message });
      return redirectResponse("/profile.html?error=calendar-auth-failed");
    }

    if (!tokenRes.ok) {
      log("error", FN, "calendar token exchange failed", { status: tokenRes.status });
      return redirectResponse("/profile.html?error=calendar-auth-failed");
    }

    const tokenData = await tokenRes.json().catch(() => ({}));
    const usersDb = getDb("users");
    const dbUser = await usersDb.get(calUser.email, { type: "json" }).catch(() => null);
    if (!dbUser) return redirectResponse("/profile.html?error=user-not-found");

    dbUser.google_access_token  = encryptSecret(tokenData.access_token || "");
    const refreshPlain = tokenData.refresh_token || decryptSecret(dbUser.google_refresh_token) || "";
    dbUser.google_refresh_token = encryptSecret(refreshPlain);
    dbUser.google_token_expiry  = Date.now() + (tokenData.expires_in || 3600) * 1000;
    dbUser.calendar_connected   = true;
    await usersDb.setJSON(calUser.email, dbUser);

    await persistEvent("info", FN, "calendar connected", { email: calUser.email });
    log("info", FN, "google calendar connected", { email: calUser.email });
    return redirectResponse("/profile.html?calendar=connected");
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
    const user = getUserFromRequest(req);
    if (!user) return errorResponse(401, "Not authenticated. Please sign in.");
    return jsonResponse(200, { id: user.id, email: user.email, name: user.name, is_admin: isAdmin(user) });
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
    return jsonResponse(200, { success: true, name: user.name }, { "Set-Cookie": setCookie("token", newToken) });
  }

  if (path === "magic-link/request") {
    const emailKey = validateEmail(body.email || "");
    const name = (body.name || "").trim();

    if (!emailKey) {
      return errorResponse(400, "A valid email address is required.");
    }

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
        error: "Too many sign-in links requested for this email. Please wait before requesting another.",
        retry_after_seconds: emailRate.retryAfterSec,
      });
    }

    await getOrCreateUser(emailKey, name); // pre-create user record; isNew redirect handled at verify step

    const jti = generateId();
    const loginTokens = getDb("login_tokens");
    await loginTokens.setJSON(jti, { email: emailKey, used: false, created_at: new Date().toISOString() });

    const token = createToken({ id: "magic-link", email: emailKey, name, purpose: "magic_link", jti }, "15m");
    const link = `${getAppUrl(req)}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;

    log("info", FN, "magic link generated", { email: emailKey });

    const sendResult = await sendMagicLinkEmail(emailKey, link);
    if (!sendResult.ok) {
      return errorResponse(500, sendResult.error);
    }

    return jsonResponse(200, { success: true, message: "Check your email for a sign-in link." });
  }

  if (path === "login" || path === "register") {
    return errorResponse(410, "Email/password auth is disabled. Use the email sign-in link or Google.");
  }

  if (path === "logout") {
    log("info", FN, "user logged out");
    return jsonResponse(200, { success: true }, { "Set-Cookie": clearCookie("token") });
  }

  if (path === "feedback") {
    const senderName    = (body.name    || "").trim();
    const senderEmail   = (body.email   || "").trim();
    const feedbackType  = (body.type    || "other").trim();
    const message       = (body.message || "").trim();

    if (!senderEmail || !senderEmail.includes("@")) {
      return errorResponse(400, "A valid email address is required.");
    }
    if (!message) {
      return errorResponse(400, "Message is required.");
    }

    const adminEmails = getEnv("ADMIN_EMAILS", "").split(",").map(e => e.trim()).filter(Boolean);
    const apiKey    = getEnv("RESEND_API_KEY");
    const fromEmail = getEnv("AUTH_FROM_EMAIL");

    if (!apiKey || !fromEmail || adminEmails.length === 0) {
      log("warn", FN, "feedback not sent: email not configured or no admin emails", { adminEmails });
      return errorResponse(500, "Feedback email delivery is not configured on this server.");
    }

    const typeLabels = { bug: "Bug Report", feature: "Feature Request", question: "Question", other: "General Feedback" };
    const typeLabel  = typeLabels[feedbackType] || "Feedback";
    const subject    = `[MeetMe Feedback] ${typeLabel} from ${senderName || senderEmail}`;
    const html = `
      <h2 style="margin:0 0 16px">MeetMe Feedback &mdash; ${typeLabel}</h2>
      <table style="font-size:14px;border-collapse:collapse;width:100%">
        <tr><th style="text-align:left;padding:6px 12px 6px 0;color:#555">From</th>
            <td style="padding:6px 0">${senderName ? `${senderName} &lt;${senderEmail}&gt;` : senderEmail}</td></tr>
        <tr><th style="text-align:left;padding:6px 12px 6px 0;color:#555">Type</th>
            <td style="padding:6px 0">${typeLabel}</td></tr>
      </table>
      <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb">
      <h3 style="margin:0 0 8px;font-size:14px;color:#555">Message</h3>
      <p style="white-space:pre-wrap;font-size:14px;line-height:1.6">${message.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</p>
    `;

    const text = `MeetMe Feedback (${typeLabel})\nFrom: ${senderName || senderEmail} <${senderEmail}>\n\n${message}`;

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from: fromEmail, to: adminEmails, reply_to: senderEmail, subject, html, text }),
      });
      if (!res.ok) {
        const body2 = await res.text().catch(() => "");
        log("error", FN, "feedback email failed", { status: res.status, body: body2 });
        return errorResponse(500, `Could not send feedback email (HTTP ${res.status}).`);
      }
    } catch (err) {
      log("error", FN, "feedback email threw", { error: err.message });
      return errorResponse(500, `Could not send feedback: ${err.message}`);
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
