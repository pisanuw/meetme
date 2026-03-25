import { getDb, getEnv, createToken, verifyToken, getUserFromRequest, jsonResponse, setCookie, clearCookie, generateId } from "./utils.mjs";

function getAppUrl(req) {
  return getEnv("APP_URL", new URL(req.url).origin);
}

function getGoogleRedirectUri(req) {
  return `${getAppUrl(req)}/api/auth/google/callback`;
}

async function linkPendingInvites(emailKey, user) {
  const invites = getDb("invites");
  const pendingList = await invites.get(`pending:${emailKey}`, { type: "json" }).catch(() => null);
  if (!pendingList || !Array.isArray(pendingList)) return;

  for (const meetingId of pendingList) {
    const meetingInvites = await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []);
    const updated = meetingInvites.map(inv => {
      if (inv.email === emailKey) {
        return { ...inv, user_id: user.id, name: inv.name || user.name };
      }
      return inv;
    });
    await invites.setJSON(`meeting:${meetingId}`, updated);
  }
}

async function getOrCreateUser(email, preferredName = "") {
  const users = getDb("users");
  const emailKey = (email || "").trim().toLowerCase();
  if (!emailKey || !emailKey.includes("@")) return null;

  let user = await users.get(emailKey, { type: "json" }).catch(() => null);
  if (user) {
    return user;
  }

  const fallbackName = emailKey.split("@")[0] || "MeetSync User";
  user = {
    id: generateId(),
    email: emailKey,
    name: (preferredName || "").trim() || fallbackName,
    created_at: new Date().toISOString(),
  };

  await users.setJSON(emailKey, user);
  await linkPendingInvites(emailKey, user);
  return user;
}

async function sendMagicLinkEmail(email, link) {
  const apiKey = getEnv("RESEND_API_KEY");
  const fromEmail = getEnv("AUTH_FROM_EMAIL");

  if (!apiKey || !fromEmail) {
    return { ok: false, error: "Email delivery is not configured. Set RESEND_API_KEY and AUTH_FROM_EMAIL." };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [email],
      subject: "Your MeetSync sign-in link",
      html: `<p>Sign in to MeetSync by clicking the secure link below:</p><p><a href="${link}">Sign in to MeetSync</a></p><p>This link expires in 15 minutes and can only be used once.</p>`,
      text: `Sign in to MeetSync: ${link}\n\nThis link expires in 15 minutes and can only be used once.`,
    }),
  });

  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    return { ok: false, error: payload || "Failed to send magic link email." };
  }

  return { ok: true };
}

function redirectResponse(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, ...extraHeaders },
  });
}

export default async (req, context) => {
  const path = context.params["0"] || "";

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
    const payload = verifyToken(token);

    if (!payload || payload.purpose !== "magic_link" || !payload.jti || !payload.email) {
      return redirectResponse("/?error=invalid-link");
    }

    const loginTokens = getDb("login_tokens");
    const tokenRecord = await loginTokens.get(payload.jti, { type: "json" }).catch(() => null);

    if (!tokenRecord || tokenRecord.used || tokenRecord.email !== payload.email) {
      return redirectResponse("/?error=invalid-link");
    }

    await loginTokens.setJSON(payload.jti, {
      ...tokenRecord,
      used: true,
      used_at: new Date().toISOString(),
    });

    const user = await getOrCreateUser(payload.email, payload.name || "");
    if (!user) {
      return redirectResponse("/?error=invalid-link");
    }

    const appToken = createToken(user);
    return redirectResponse("/dashboard.html", {
      "Set-Cookie": setCookie("token", appToken),
    });
  }

  if (req.method === "GET" && path === "google/start") {
    const googleClientId = getEnv("GOOGLE_CLIENT_ID");
    if (!googleClientId) {
      return redirectResponse("/?error=google-not-configured");
    }

    const returnTo = "/dashboard.html";
    const stateToken = createToken({
      id: "oauth-state",
      email: "oauth-state@meetsync.local",
      name: "oauth",
      purpose: "google_oauth_state",
      return_to: returnTo,
      jti: generateId(),
    }, "10m");

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", googleClientId);
    authUrl.searchParams.set("redirect_uri", getGoogleRedirectUri(req));
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("prompt", "select_account");
    authUrl.searchParams.set("state", stateToken);

    return redirectResponse(authUrl.toString(), {
      "Set-Cookie": setCookie("oauth_state", stateToken, 10 * 60),
    });
  }

  if (req.method === "GET" && path === "google/callback") {
    const googleClientId = getEnv("GOOGLE_CLIENT_ID");
    const googleClientSecret = getEnv("GOOGLE_CLIENT_SECRET");
    if (!googleClientId || !googleClientSecret) {
      return redirectResponse("/?error=google-not-configured");
    }

    const url = new URL(req.url);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const cookie = req.headers.get("cookie") || "";
    const stateMatch = cookie.match(/(?:^|;\s*)oauth_state=([^;]+)/);
    const stateFromCookie = stateMatch ? stateMatch[1] : "";

    const statePayload = verifyToken(state);
    if (!code || !state || !stateFromCookie || state !== stateFromCookie || !statePayload || statePayload.purpose !== "google_oauth_state") {
      return redirectResponse("/?error=google-auth-failed");
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: getGoogleRedirectUri(req),
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      return redirectResponse("/?error=google-auth-failed");
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return redirectResponse("/?error=google-auth-failed");
    }

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userInfoRes.ok) {
      return redirectResponse("/?error=google-auth-failed");
    }

    const googleUser = await userInfoRes.json();
    const email = (googleUser.email || "").trim().toLowerCase();
    const isVerified = !!googleUser.email_verified;
    if (!email || !isVerified) {
      return redirectResponse("/?error=google-email-not-verified");
    }

    const user = await getOrCreateUser(email, googleUser.name || "");
    if (!user) {
      return redirectResponse("/?error=google-auth-failed");
    }

    const appToken = createToken(user);
    return redirectResponse(statePayload.return_to || "/dashboard.html", {
      "Set-Cookie": setCookie("token", appToken),
    });
  }

  if (req.method === "GET" && (path === "me" || path === "")) {
    const user = getUserFromRequest(req);
    if (!user) return jsonResponse(401, { error: "Not authenticated" });
    return jsonResponse(200, { id: user.id, email: user.email, name: user.name });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const body = await req.json();

  if (path === "magic-link/request") {
    const emailKey = (body.email || "").trim().toLowerCase();
    const name = (body.name || "").trim();

    if (!emailKey || !emailKey.includes("@")) {
      return jsonResponse(400, { error: "A valid email is required." });
    }

    await getOrCreateUser(emailKey, name);

    const jti = generateId();
    const loginTokens = getDb("login_tokens");
    await loginTokens.setJSON(jti, {
      email: emailKey,
      used: false,
      created_at: new Date().toISOString(),
    });

    const token = createToken({
      id: "magic-link",
      email: emailKey,
      name,
      purpose: "magic_link",
      jti,
    }, "15m");
    const link = `${getAppUrl(req)}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;

    const sendResult = await sendMagicLinkEmail(emailKey, link);
    if (!sendResult.ok) {
      return jsonResponse(500, { error: sendResult.error || "Could not send sign-in link." });
    }

    return jsonResponse(200, { success: true, message: "Check your email for a sign-in link." });
  }

  if (path === "login" || path === "register") {
    return jsonResponse(410, {
      error: "Email/password auth is disabled. Use email sign-in link or Google login.",
    });
  }

  if (path === "logout") {
    return jsonResponse(200, { success: true }, {
      "Set-Cookie": clearCookie("token"),
    });
  }

  return jsonResponse(404, { error: "Not found" });
};

export const config = {
  path: "/api/auth/*",
};
