import { getDb, hashPassword, checkPassword, createToken, getUserFromRequest, jsonResponse, setCookie, clearCookie, generateId } from "./utils.mjs";

export default async (req, context) => {
  const path = context.params["0"] || "";

  if (req.method === "GET" && (path === "me" || path === "")) {
    const user = getUserFromRequest(req);
    if (!user) return jsonResponse(401, { error: "Not authenticated" });
    return jsonResponse(200, { id: user.id, email: user.email, name: user.name });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const body = await req.json();

  if (path === "register") {
    const { email, name, password, confirm_password } = body;
    if (!email || !name || !password) {
      return jsonResponse(400, { error: "All fields are required." });
    }
    if (password !== confirm_password) {
      return jsonResponse(400, { error: "Passwords do not match." });
    }
    if (password.length < 6) {
      return jsonResponse(400, { error: "Password must be at least 6 characters." });
    }

    const users = getDb("users");
    const emailKey = email.trim().toLowerCase();

    const existing = await users.get(emailKey, { type: "json" }).catch(() => null);
    if (existing) {
      return jsonResponse(400, { error: "Email already registered." });
    }

    const user = {
      id: generateId(),
      email: emailKey,
      name: name.trim(),
      password_hash: hashPassword(password),
      created_at: new Date().toISOString(),
    };

    await users.setJSON(emailKey, user);

    // Link pending invites
    const invites = getDb("invites");
    const pendingList = await invites.get(`pending:${emailKey}`, { type: "json" }).catch(() => null);
    if (pendingList && Array.isArray(pendingList)) {
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

    const token = createToken(user);
    return jsonResponse(200, { success: true, user: { id: user.id, email: user.email, name: user.name } }, {
      "Set-Cookie": setCookie("token", token),
    });
  }

  if (path === "login") {
    const { email, password } = body;
    const emailKey = (email || "").trim().toLowerCase();

    const users = getDb("users");
    const user = await users.get(emailKey, { type: "json" }).catch(() => null);

    if (!user || !checkPassword(password, user.password_hash)) {
      return jsonResponse(401, { error: "Invalid email or password." });
    }

    const token = createToken(user);
    return jsonResponse(200, { success: true, user: { id: user.id, email: user.email, name: user.name } }, {
      "Set-Cookie": setCookie("token", token),
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
