import {
  getDb,
  getEnv,
  createToken,
  verifyToken,
  getUserFromRequest,
  setCookie,
  generateId,
  log,
  persistEvent,
  validateEmail,
  encryptSecret,
  decryptSecret,
} from "./utils.mjs";

function redirectResponse(location, extraHeaders = {}) {
  return new Response("", {
    status: 302,
    headers: { Location: location, ...extraHeaders },
  });
}

export async function handleGoogleAuthRoute({
  req,
  path,
  fnName,
  getAppUrl,
  getGoogleRedirectUri,
  isLocalDevRequest,
  getClientIp,
  checkRateLimit,
  getOrCreateUser,
}) {
  if (req.method === "GET" && path === "google/start") {
    if (!isLocalDevRequest(req)) {
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
      log("error", fnName, "GOOGLE_CLIENT_ID is not set");
      return redirectResponse("/?error=google-not-configured");
    }

    const redirectUri = getGoogleRedirectUri(req);
    const stateToken = createToken(
      {
        id: "oauth-state",
        email: "oauth-state@meetme.local",
        name: "oauth",
        purpose: "google_oauth_state",
        return_to: "/dashboard.html",
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

    log("info", fnName, "google oauth start", { redirect_uri: redirectUri });
    return redirectResponse(authUrl.toString(), {
      "Set-Cookie": setCookie("oauth_state", stateToken, 10 * 60),
    });
  }

  if (req.method === "GET" && path === "google/callback") {
    const googleClientId = getEnv("GOOGLE_CLIENT_ID");
    const googleClientSecret = getEnv("GOOGLE_CLIENT_SECRET");
    if (!googleClientId || !googleClientSecret) {
      log("error", fnName, "Google env vars missing in callback");
      return redirectResponse("/?error=google-not-configured");
    }

    const url = new URL(req.url);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const googleError = url.searchParams.get("error") || "";

    if (googleError) {
      log("warn", fnName, "Google returned error param", { google_error: googleError });
      return redirectResponse("/?error=google-denied");
    }
    if (!code) {
      log("warn", fnName, "Google callback missing code");
      return redirectResponse("/?error=google-auth-failed");
    }

    const cookie = req.headers.get("cookie") || "";
    const stateMatch = cookie.match(/(?:^|;\s*)oauth_state=([^;]+)/);
    const stateFromCookie = stateMatch ? stateMatch[1] : "";

    if (!stateFromCookie) {
      log(
        "warn",
        fnName,
        "oauth_state cookie missing — possible CSRF or cookie blocked by browser"
      );
      return redirectResponse("/?error=google-state-missing");
    }
    if (state !== stateFromCookie) {
      log("warn", fnName, "oauth state mismatch — possible CSRF");
      return redirectResponse("/?error=google-auth-failed");
    }

    const statePayload = verifyToken(state);
    if (!statePayload || statePayload.purpose !== "google_oauth_state") {
      log("warn", fnName, "oauth state JWT invalid or expired");
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
      log("error", fnName, "google token exchange fetch threw", { error: err.message });
      return redirectResponse("/?error=google-auth-failed");
    }

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      log("error", fnName, "google token exchange failed", { status: tokenRes.status, body });
      return redirectResponse("/?error=google-auth-failed");
    }

    const tokenData = await tokenRes.json().catch(() => ({}));
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      log("error", fnName, "google token exchange returned no access_token", {
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
      log("error", fnName, "google userinfo fetch threw", { error: err.message });
      return redirectResponse("/?error=google-auth-failed");
    }

    if (!userInfoRes.ok) {
      log("error", fnName, "google userinfo failed", { status: userInfoRes.status });
      return redirectResponse("/?error=google-auth-failed");
    }

    const googleUser = await userInfoRes.json().catch(() => ({}));
    const email = validateEmail(googleUser.email || "");
    const isVerified = !!googleUser.email_verified;

    if (!email) {
      log("warn", fnName, "google user has no valid email", { sub: googleUser.sub });
      return redirectResponse("/?error=google-email-missing");
    }
    if (!isVerified) {
      log("warn", fnName, "google user email not verified", { email });
      return redirectResponse("/?error=google-email-not-verified");
    }

    const { user, isNew } = await getOrCreateUser(email, googleUser.name || "");
    if (!user) {
      log("error", fnName, "getOrCreateUser returned null during google callback", { email });
      return redirectResponse("/?error=google-auth-failed");
    }

    const appToken = createToken(user);
    log("info", fnName, "google sign-in successful", { email: user.email, isNew });
    await persistEvent("info", fnName, "sign-in", {
      sign_in_method: "google",
      email: user.email,
      name: user.name || user.email,
      is_new_user: !!isNew,
    });
    const dest =
      isNew || !user.profile_complete
        ? "/profile.html?setup=1"
        : statePayload.return_to || "/dashboard.html";
    return redirectResponse(dest, { "Set-Cookie": setCookie("token", appToken) });
  }

  if (req.method === "GET" && path === "google/calendar-start") {
    const calUser = getUserFromRequest(req);
    if (!calUser) return redirectResponse("/?error=not-authenticated");

    if (!isLocalDevRequest(req)) {
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

    const redirectUri = `${getAppUrl(req)}/api/auth/google/calendar-callback`;
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

    log("info", fnName, "google calendar connect start", {
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

    const redirectUri = `${getAppUrl(req)}/api/auth/google/calendar-callback`;
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
      log("error", fnName, "calendar token exchange threw", { error: err.message });
      return redirectResponse("/profile.html?error=calendar-auth-failed");
    }

    if (!tokenRes.ok) {
      log("error", fnName, "calendar token exchange failed", { status: tokenRes.status });
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
    await usersDb.setJSON(calUser.email, dbUser);

    await persistEvent("info", fnName, "calendar connected", { email: calUser.email });
    log("info", fnName, "google calendar connected", { email: calUser.email });
    return redirectResponse("/profile.html?calendar=connected");
  }

  return null;
}
