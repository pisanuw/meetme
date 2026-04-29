import crypto from "node:crypto";
import {
  getDb,
  createToken,
  jsonResponse,
  errorResponse,
  setCookie,
  log,
  logRequest,
  safeJson,
  validateEmail,
  persistEvent,
  isRateLimitEnabled,
  checkRateLimit,
  sendEmail,
  getAppUrl,
  LIMITS
} from "./utils.mjs";
import { sanitizeNextPath, redirectResponse, getClientIp, getOrCreateUser, linkPendingInvites } from "./auth-helpers.mjs";

const FN = "magic-link";

const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_LENGTH = 16;
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function generateMagicToken() {
  const bytes = crypto.randomBytes(TOKEN_LENGTH);
  return Array.from(bytes, b => TOKEN_CHARS[b % TOKEN_CHARS.length]).join("");
}

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

export default async function handleMagicLink(req, context) {
  const path = context.params["0"] || "";
  logRequest(FN, req, { path });

  if (req.method === "GET" && path === "magic-link/verify") {
    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";

    if (!token) {
      log("warn", FN, "magic-link/verify called with no token");
      return redirectResponse("/?error=invalid-link");
    }

    const loginTokens = getDb("login_tokens");
    const tokenRecord = await loginTokens.get(token, { type: "json" }).catch(() => null);

    if (!tokenRecord) {
      log("warn", FN, "magic link token not found in store");
      return redirectResponse("/?error=invalid-link");
    }
    if (tokenRecord.used) {
      log("warn", FN, "magic link already used", { email: tokenRecord.email });
      return redirectResponse("/?error=link-already-used");
    }
    if (Date.now() > new Date(tokenRecord.expires_at).getTime()) {
      log("warn", FN, "magic link expired", { email: tokenRecord.email });
      return redirectResponse("/?error=link-expired");
    }

    await loginTokens.setJSON(token, {
      ...tokenRecord,
      used: true,
      used_at: new Date().toISOString(),
    });

    const { user, isNew } = await getOrCreateUser(tokenRecord.email, tokenRecord.name || "");
    if (!user) {
      log("error", FN, "getOrCreateUser returned null during magic link verify", {
        email: tokenRecord.email,
      });
      return redirectResponse("/?error=invalid-link");
    }

    await linkPendingInvites(tokenRecord.email, user);

    const appToken = createToken(user);
    log("info", FN, "magic link sign-in successful", { email: user.email, isNew });
    await persistEvent("info", FN, "sign-in", {
      sign_in_method: "magic-link",
      email: user.email,
      name: user.name || user.email,
      is_new_user: !!isNew,
    });
    const returnTo = sanitizeNextPath(tokenRecord.next || "");
    const dest = isNew || !user.profile_complete ? "/profile.html?setup=1" : returnTo || "/dashboard.html";
    return redirectResponse(dest, { "Set-Cookie": setCookie("token", appToken) });
  }

  if (req.method === "POST" && path === "magic-link/request") {
    const body = await safeJson(req);
    if (body === null) {
      return errorResponse(400, "Request body must be valid JSON.");
    }
    const emailKey = validateEmail(body.email || "");
    const name = (body.name || "").trim();
    const next = sanitizeNextPath(body.next || "");

    if (!emailKey) {
      return errorResponse(400, "A valid email address is required.");
    }
    if (name.length > LIMITS.NAME_MAX) {
      return errorResponse(400, `Name must be ${LIMITS.NAME_MAX} characters or fewer.`);
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

    await getOrCreateUser(emailKey, name);

    const token = generateMagicToken();
    const loginTokens = getDb("login_tokens");
    await loginTokens.setJSON(token, {
      email: emailKey,
      name,
      next,
      expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      used: false,
      created_at: new Date().toISOString(),
    });

    const link = `${getAppUrl(req)}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;

    log("info", FN, "magic link generated", { email: emailKey });

    const sendResult = await sendMagicLinkEmail(emailKey, link);
    if (!sendResult.ok) {
      return errorResponse(500, sendResult.error);
    }

    return jsonResponse(200, { success: true, message: "Check your email for a sign-in link." });
  }

  return null;
}