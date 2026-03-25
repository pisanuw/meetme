import {
  getDb, getUserFromRequest, jsonResponse, errorResponse, isAdmin, persistEvent,
  log, logRequest, safeJson, validateEmail, generateId,
} from "./utils.mjs";

const FN = "admin";

export default async (req, context) => {
  try {
    return await handleAdmin(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, `Internal server error: ${err.message}`);
  }
};

async function handleAdmin(req, context) {
  logRequest(FN, req);

  const user = getUserFromRequest(req);
  if (!user) return errorResponse(401, "Not authenticated. Please sign in.");
  if (!isAdmin(user)) return errorResponse(403, "Admin access required.");

  const url = new URL(req.url);
  const path = (context.params["0"] || "").replace(/^\/+/, "").replace(/\/+$/, "");

  // ─── GET /api/admin/stats ─────────────────────────────────────────────────
  if (req.method === "GET" && path === "stats") {
    const meetings = getDb("meetings");
    const usersDb = getDb("users");
    const index = await meetings.get("index", { type: "json" }).catch(() => []);
    const userList = await usersDb.list().catch(() => ({ blobs: [] }));
    const eventsDb = getDb("events");
    const eventList = await eventsDb.list().catch(() => ({ blobs: [] }));
    return jsonResponse(200, {
      total_meetings: index.length,
      total_users: userList.blobs.length,
      total_events: eventList.blobs.length,
    });
  }

  // ─── GET /api/admin/users ────────────────────────────────────────────────
  if (req.method === "GET" && path === "users") {
    const usersDb = getDb("users");
    const list = await usersDb.list().catch(() => ({ blobs: [] }));
    const users = [];
    for (const { key: email } of list.blobs) {
      const u = await usersDb.get(email, { type: "json" }).catch(() => null);
      if (u) users.push(u);
    }
    users.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return jsonResponse(200, { users });
  }

  // ─── GET /api/admin/user?email=X ─────────────────────────────────────────
  if (req.method === "GET" && path === "user") {
    const email = (url.searchParams.get("email") || "").toLowerCase();
    if (!email) return errorResponse(400, "email query param required.");

    const usersDb = getDb("users");
    const invites = getDb("invites");
    const meetings = getDb("meetings");
    const availability = getDb("availability");

    const u = await usersDb.get(email, { type: "json" }).catch(() => null);
    if (!u) return errorResponse(404, `User '${email}' not found.`);

    const index = await meetings.get("index", { type: "json" }).catch(() => []);
    const createdMeetings = [];
    const invitedMeetings = [];

    for (const mid of index) {
      const m = await meetings.get(mid, { type: "json" }).catch(() => null);
      if (!m) continue;

      const meetingInvites = await invites.get(`meeting:${mid}`, { type: "json" }).catch(() => []);
      const inv = meetingInvites.find(i => i.email === email);

      if (m.creator_id === u.id) {
        const avList = await availability.get(`meeting:${mid}`, { type: "json" }).catch(() => []);
        const myAvail = avList.filter(a => a.user_id === u.id);
        createdMeetings.push({
          id: m.id,
          title: m.title,
          created_at: m.created_at,
          invite_count: meetingInvites.length,
          respond_count: meetingInvites.filter(i => i.responded).length,
          is_finalized: m.is_finalized,
          my_slot_count: myAvail.length,
        });
      } else if (inv) {
        const avList = await availability.get(`meeting:${mid}`, { type: "json" }).catch(() => []);
        const myAvail = avList.filter(a => a.user_id === u.id);
        invitedMeetings.push({
          id: m.id,
          title: m.title,
          responded: inv.responded,
          created_at: m.created_at,
          creator_name: m.creator_name,
          is_finalized: m.is_finalized,
          my_slot_count: myAvail.length,
        });
      }
    }

    // Remove sensitive fields like tokens before returning
    const safeUser = { ...u };
    delete safeUser.google_access_token;
    delete safeUser.google_refresh_token;

    return jsonResponse(200, {
      user: safeUser,
      created_meetings: createdMeetings,
      invited_meetings: invitedMeetings,
    });
  }

  // ─── POST /api/admin/user — create or update user ─────────────────────────
  if (req.method === "POST" && path === "user") {
    const body = await safeJson(req);
    if (!body) return errorResponse(400, "Request body must be valid JSON.");

    const email = validateEmail(body.email || "");
    if (!email) return errorResponse(400, "A valid email address is required.");

    const usersDb = getDb("users");
    let u = await usersDb.get(email, { type: "json" }).catch(() => null);

    if (u) {
      const firstName = body.first_name !== undefined ? (body.first_name || "").trim() : u.first_name;
      const lastName  = body.last_name  !== undefined ? (body.last_name  || "").trim() : u.last_name;
      const name = body.name !== undefined
        ? (body.name || "").trim() || u.name
        : ([firstName, lastName].filter(Boolean).join(" ") || u.name);

      u = { ...u, first_name: firstName || "", last_name: lastName || "", name, profile_complete: true };
      await usersDb.setJSON(email, u);
      await persistEvent("info", FN, "admin updated user", { admin: user.email, target: email });
      log("info", FN, "admin updated user", { admin: user.email, target: email });
      return jsonResponse(200, { success: true, user: u });
    } else {
      const firstName = (body.first_name || "").trim();
      const lastName  = (body.last_name  || "").trim();
      const name = (body.name || [firstName, lastName].filter(Boolean).join(" ") || email.split("@")[0]).trim();
      u = {
        id: generateId(),
        email,
        name,
        first_name: firstName,
        last_name: lastName,
        profile_complete: !!firstName,
        created_at: new Date().toISOString(),
        created_by_admin: true,
      };
      await usersDb.setJSON(email, u);
      await persistEvent("info", FN, "admin created user", { admin: user.email, target: email });
      log("info", FN, "admin created user", { admin: user.email, target: email });
      return jsonResponse(201, { success: true, user: u });
    }
  }

  // ─── POST /api/admin/user/delete ─────────────────────────────────────────
  if (req.method === "POST" && path === "user/delete") {
    const body = await safeJson(req);
    if (!body) return errorResponse(400, "Request body must be valid JSON.");
    const email = (body.email || "").trim().toLowerCase();
    if (!email) return errorResponse(400, "email is required.");
    if (isAdmin({ email })) return errorResponse(400, "Cannot delete an admin account.");

    const usersDb = getDb("users");
    const u = await usersDb.get(email, { type: "json" }).catch(() => null);
    if (!u) return errorResponse(404, `User '${email}' not found.`);

    await usersDb.delete(email);
    await persistEvent("warn", FN, "admin deleted user", { admin: user.email, target: email });
    log("info", FN, "admin deleted user", { admin: user.email, target: email });
    return jsonResponse(200, { success: true });
  }

  // ─── GET /api/admin/meetings ──────────────────────────────────────────────
  if (req.method === "GET" && path === "meetings") {
    const meetings = getDb("meetings");
    const invites = getDb("invites");
    const index = await meetings.get("index", { type: "json" }).catch(() => []);
    const result = [];
    for (const mid of index) {
      const m = await meetings.get(mid, { type: "json" }).catch(() => null);
      if (!m) continue;
      const meetingInvites = await invites.get(`meeting:${mid}`, { type: "json" }).catch(() => []);
      result.push({
        id: m.id,
        title: m.title,
        creator_id: m.creator_id,
        creator_name: m.creator_name,
        meeting_type: m.meeting_type,
        dates_or_days: m.dates_or_days,
        start_time: m.start_time,
        end_time: m.end_time,
        timezone: m.timezone || "UTC",
        is_finalized: m.is_finalized,
        finalized_date: m.finalized_date,
        finalized_slot: m.finalized_slot,
        created_at: m.created_at,
        invite_count: meetingInvites.length,
        respond_count: meetingInvites.filter(i => i.responded).length,
        invitees: meetingInvites.map(i => ({ email: i.email, name: i.name, responded: i.responded })),
      });
    }
    result.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return jsonResponse(200, { meetings: result });
  }

  // ─── GET /api/admin/events ────────────────────────────────────────────────
  if (req.method === "GET" && path === "events") {
    const eventsDb = getDb("events");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
    const list = await eventsDb.list().catch(() => ({ blobs: [] }));
    // Keys are timestamp-prefixed so lexicographic desc = newest first
    const sorted = [...list.blobs].sort((a, b) => b.key.localeCompare(a.key)).slice(0, limit);
    const events = [];
    for (const { key } of sorted) {
      const ev = await eventsDb.get(key, { type: "json" }).catch(() => null);
      if (ev) events.push(ev);
    }
    return jsonResponse(200, { events });
  }

  log("warn", FN, "unmatched admin route", { method: req.method, path });
  return errorResponse(404, `Admin route '${path}' not found.`);
}

export const config = {
  path: "/api/admin/*",
};
