import { getDb, asArray, saveUserRecord, generateId, log, getAppUrl } from "./utils.mjs";

const FN = "auth-helpers";

export function sanitizeNextPath(raw) {
  const value = String(raw || "").trim();
  if (!value.startsWith("/")) return "";
  if (value.startsWith("//")) return "";
  if (value.includes("\n") || value.includes("\r")) return "";
  return value;
}

export function redirectResponse(location, extraHeaders = {}) {
  return new Response("", {
    status: 302,
    headers: { Location: location, ...extraHeaders },
  });
}

export function getClientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

export function getGoogleRedirectUri(req) {
  return `${getAppUrl(req)}/api/auth/google/callback`;
}

export async function linkPendingInvites(emailKey, user) {
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

  await invites.delete(`pending:${emailKey}`).catch(() => null);
}

export async function getOrCreateUser(email, preferredName = "") {
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

  user = await saveUserRecord(users, user);
  await linkPendingInvites(emailKey, user);
  log("info", FN, "new user created", { email: emailKey, id: user.id });
  return { user, isNew: true };
}