/**
 * auth-google.mjs — Google OAuth sign-in and Google Calendar OAuth helpers
 *
 * Exported entry point: handleGoogleAuthRoute({ req, path, ... })
 *
 * Routes handled (via auth.mjs delegation):
 *   GET  google/start              — begin Google sign-in OAuth flow
 *   GET  google/callback           — handle Google sign-in callback
 *   GET  google/calendar-start     — begin Google Calendar OAuth flow
 *   GET  google/calendar-callback  — handle Calendar OAuth callback
 *
 * Security model:
 *   - OAuth CSRF protection via signed JWT state parameter + cookie comparison
 *   - Access and refresh tokens are AES-256-GCM encrypted before storage
 *   - Rate limiting for google/start and google/calendar-start is enforced
 *     when isRateLimitEnabled() returns true (controlled by DISABLE_RATE_LIMIT env var)
 */
import {
  getDb,
  getEnv,
  createToken,
  verifyToken,
  getUserFromRequest,
  jsonResponse,
  errorResponse,
  setCookie,
  generateId,
  log,
  logRequest,
  persistEvent,
  validateEmail,
  encryptSecret,
  decryptSecret,
  isRateLimitEnabled,
  checkRateLimit,
  saveUserRecord,
} from "./utils.mjs";
import { sanitizeNextPath, redirectResponse, getClientIp, getGoogleRedirectUri, getOrCreateUser } from "./auth-helpers.mjs";

const FN = "auth-google";

export default async function handleGoogleAuthRoute(req, context) {
  const path = context.params["0"] || "";

  if (req.method === "GET" && path === "google/start") {
    const url = new URL(req.url);
    const next = sanitizeNextPath(url.searchParams.get("next") || "");

    if (isRateLimitEnabled()) {
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
    }

    const googleClientId = getEnv("GOOGLE_CLIENT_ID");
    if (!googleClientId) {
      log("error", FN, "GOOGLE_CLIENT_ID is not set");
      return redirectResponse("/?error=google-not-configured");
    }

    const redirectUri = getGoogleRedirectUri(req);
    const stateToken = createToken(
      {
        id: "oauth-state",
        email: "oauth-state@meetme.local",
        name: "oauth",
        purpose: "google_oauth_state",
        return_to: next || "/dashboard.html",
        jti: generateId(),
      },
      "10m"
    );

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", googleClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("prompt", "select_account");
    authUrl.searchParams.set("state", stateToken);

    log("info", FN, "google oauth start", { redirect_uri: redirectUri });
    return redirectResponse(authUrl.toString(), {
      "Set-Cookie": setCookie("oauth_state", stateToken, 10 * 60),
    });
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
      log(
        "warn",
        FN,
        "oauth_state cookie missing — possible CSRF or cookie blocked by browser"
      );
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
        body: new URLSearchParams({
          code,
          client_id: googleClientId,
          client_secret: googleClientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
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
      log("error", FN, "google token exchange returned no access_token", {
        keys: Object.keys(tokenData),
      });
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
    await persistEvent("info", FN, "sign-in", {
      sign_in_method: "google",
      email: user.email,
      name: user.name || user.email,
      is_new_user: !!isNew,
    });
    const safeReturnTo = sanitizeNextPath(statePayload.return_to || "") || "/dashboard.html";
    const dest = isNew || !user.profile_complete ? "/profile.html?setup=1" : safeReturnTo;
    return redirectResponse(dest, { "Set-Cookie": setCookie("token", appToken) });
  }

  if (req.method === "GET" && path === "google/calendar-start") {
    const calUser = getUserFromRequest(req);
    if (!calUser) return redirectResponse("/?error=not-authenticated");

    if (isRateLimitEnabled()) {
      const userRate = await checkRateLimit({
        bucket: "auth_calendar_start_user",
        key: calUser.email,
        limit: 8,
        windowMs: 15 * 60 * 1000,
      });
      if (!userRate.ok) {
        return redirectResponse(
          `/profile.html?error=calendar-rate-limited&retry=${userRate.retryAfterSec}`
        );
      }
    }

    const googleClientId = getEnv("GOOGLE_CLIENT_ID");
    if (!googleClientId) return redirectResponse("/profile.html?error=google-not-configured");

    const redirectUri = getGoogleRedirectUri(req).replace("/callback", "/calendar-callback");
    const stateToken = createToken(
      {
        id: "oauth-state",
        email: calUser.email,
        name: "calendar-connect",
        purpose: "google_calendar_state",
        return_to: "/profile.html?calendar=connected",
        jti: generateId(),
      },
      "10m"
    );

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", googleClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.readonly");
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", stateToken);
    authUrl.searchParams.set("login_hint", calUser.email);

    log("info", FN, "google calendar connect start", {
      email: calUser.email,
      redirect_uri: redirectUri,
    });
    return redirectResponse(authUrl.toString(), {
      "Set-Cookie": setCookie("gcal_state", stateToken, 10 * 60),
    });
  }

  if (req.method === "GET" && path === "google/calendar-callback") {
    const googleClientId = getEnv("GOOGLE_CLIENT_ID");
    const googleClientSecret = getEnv("GOOGLE_CLIENT_SECRET");
    if (!googleClientId || !googleClientSecret)
      return redirectResponse("/profile.html?error=google-not-configured");

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

    const redirectUri = getGoogleRedirectUri(req).replace("/callback", "/calendar-callback");
    let tokenRes;
    try {
      tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: googleClientId,
          client_secret: googleClientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
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

    dbUser.google_access_token = encryptSecret(tokenData.access_token || "");
    const refreshPlain =
      tokenData.refresh_token || decryptSecret(dbUser.google_refresh_token) || "";
    dbUser.google_refresh_token = encryptSecret(refreshPlain);
    dbUser.google_token_expiry = Date.now() + (tokenData.expires_in || 3600) * 1000;
    dbUser.calendar_connected = true;
    await saveUserRecord(usersDb, dbUser);

    await persistEvent("info", FN, "calendar connected", { email: calUser.email });
    log("info", FN, "google calendar connected", { email: calUser.email });
    return redirectResponse("/profile.html?calendar=connected");
  }

  if (req.method === "POST" && path === "google/calendar-disconnect") {
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
    await saveUserRecord(users, user);

    await persistEvent("info", FN, "calendar disconnected", { email: user.email });
    return jsonResponse(200, { success: true, message: "Google Calendar disconnected." });
  }

  return null;
}
