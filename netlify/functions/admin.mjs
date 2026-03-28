/**
 * admin.mjs — Admin-only dashboard API
 *
 * All routes require the caller to be both authenticated and listed in
 * the ADMIN_EMAILS environment variable. Non-admin requests are rejected
 * with a 403 before any data is read.
 *
 * Routes handled (all require admin):
 *   GET  /api/admin/stats    — site-wide counts (users, meetings, events)
 *   GET  /api/admin/users    — paginated user list
 *   GET  /api/admin/meetings — paginated meeting list with participation details
 *   GET  /api/admin/events   — recent audit log entries
 *   POST /api/admin/users/:email/make-admin    — grant admin to a user (future use)
 *   POST /api/admin/meetings/:id/delete        — force-delete any meeting
 */
import {
  getDb,
  getUserFromRequest,
  jsonResponse,
  errorResponse,
  isAdmin,
  isSuperAdminEmail,
  persistEvent,
  log,
  logRequest,
  safeJson,
  validateEmail,
  generateId,
  asArray,
  createToken,
  setCookie,
  listMeetingIds,
  sanitizeUser,
  saveUserRecord,
  deleteUserRecord,
} from "./utils.mjs";

const FN = "admin";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function parsePagination(url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Number.parseInt(url.searchParams.get("page_size") || `${DEFAULT_PAGE_SIZE}`, 10) ||
        DEFAULT_PAGE_SIZE
    )
  );
  const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
  return { page, pageSize, query };
}

function buildPagination(total, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  return {
    page: safePage,
    page_size: pageSize,
    total,
    total_pages: totalPages,
    has_prev: safePage > 1,
    has_next: safePage < totalPages,
  };
}

export default async (req, context) => {
  try {
    return await handleAdmin(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, "Internal server error.");
  }
};

async function handleAdmin(req, context) {
  logRequest(FN, req);

  const tokenUser = getUserFromRequest(req);
  if (!tokenUser) return errorResponse(401, "Not authenticated. Please sign in.");
  const usersDb = getDb("users");
  const dbUser = await usersDb.get(tokenUser.email, { type: "json" }).catch(() => null);
  const user = dbUser || tokenUser;
  if (!isAdmin(user)) return errorResponse(403, "Admin access required.");

  const url = new URL(req.url);
  const path = (context.params["0"] || "").replace(/^\/+/, "").replace(/\/+$/, "");

  // ─── GET /api/admin/stats ─────────────────────────────────────────────────
  if (req.method === "GET" && path === "stats") {
    const meetings = getDb("meetings");
    const usersDb = getDb("users");
    const meetingIds = await listMeetingIds(meetings);
    const userList = await usersDb.list().catch(() => ({ blobs: [] }));
    const eventsDb = getDb("events");
    const eventList = await eventsDb.list().catch(() => ({ blobs: [] }));
    return jsonResponse(200, {
      total_meetings: meetingIds.length,
      total_users: asArray(userList?.blobs).length,
      total_events: asArray(eventList?.blobs).length,
    });
  }

  // ─── GET /api/admin/users ────────────────────────────────────────────────
  if (req.method === "GET" && path === "users") {
    const { page, pageSize, query } = parsePagination(url);
    const list = await usersDb.list().catch(() => ({ blobs: [] }));
    const users = (
      await Promise.all(
        asArray(list?.blobs).map(({ key: email }) =>
          usersDb.get(email, { type: "json" }).catch(() => null)
        )
      )
    )
      .filter(Boolean)
      .map((u) => {
        const safe = sanitizeUser(u);
        safe.is_super_admin = isSuperAdminEmail(u.email);
        safe.is_admin = safe.is_super_admin || !!u.is_admin;
        return safe;
      });
    const filtered = users
      .filter((u) => {
        if (!query) return true;
        return [u.email, u.first_name, u.last_name, u.name]
          .map((value) => String(value || "").toLowerCase())
          .some((value) => value.includes(query));
      })
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    const pagination = buildPagination(filtered.length, page, pageSize);
    const offset = (pagination.page - 1) * pagination.page_size;
    return jsonResponse(200, {
      users: filtered.slice(offset, offset + pagination.page_size),
      pagination,
    });
  }

  // ─── GET /api/admin/users/:email ────────────────────────────────────────
  const userPathMatch = path.match(/^users\/([^/]+)$/);
  if (req.method === "GET" && userPathMatch) {
    const email = decodeURIComponent(userPathMatch[1]).toLowerCase();
    if (!email) return errorResponse(400, "email is required.");

    const invites = getDb("invites");
    const meetings = getDb("meetings");
    const availability = getDb("availability");

    const u = await usersDb.get(email, { type: "json" }).catch(() => null);
    if (!u) return errorResponse(404, `User '${email}' not found.`);

    const safeUser = sanitizeUser(u);
    safeUser.is_super_admin = isSuperAdminEmail(u.email);
    safeUser.is_admin = safeUser.is_super_admin || !!u.is_admin;

    const index = await listMeetingIds(meetings);
    const createdMeetings = [];
    const invitedMeetings = [];

    for (const mid of index) {
      const m = await meetings.get(mid, { type: "json" }).catch(() => null);
      if (!m) continue;

      const meetingInvites = asArray(
        await invites.get(`meeting:${mid}`, { type: "json" }).catch(() => [])
      );
      const inv = meetingInvites.find((i) => i.email === email);

      if (m.creator_id === u.id) {
        const avList = asArray(
          await availability.get(`meeting:${mid}`, { type: "json" }).catch(() => [])
        );
        const myAvail = avList.filter((a) => a.user_id === u.id);
        createdMeetings.push({
          id: m.id,
          title: m.title,
          created_at: m.created_at,
          invite_count: meetingInvites.length,
          respond_count: meetingInvites.filter((i) => i.responded).length,
          is_finalized: m.is_finalized,
          my_slot_count: myAvail.length,
        });
      } else if (inv) {
        const avList = asArray(
          await availability.get(`meeting:${mid}`, { type: "json" }).catch(() => [])
        );
        const myAvail = avList.filter((a) => a.user_id === u.id);
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
    return jsonResponse(200, {
      user: safeUser,
      created_meetings: createdMeetings,
      invited_meetings: invitedMeetings,
    });
  }

  // ─── POST /api/admin/users — create or update user ──────────────────────
  if (req.method === "POST" && path === "users") {
    const body = await safeJson(req);
    if (!body) return errorResponse(400, "Request body must be valid JSON.");

    const email = validateEmail(body.email || "");
    if (!email) return errorResponse(400, "A valid email address is required.");

    let u = await usersDb.get(email, { type: "json" }).catch(() => null);

    if (u) {
      const firstName =
        body.first_name !== undefined ? (body.first_name || "").trim() : u.first_name;
      const lastName = body.last_name !== undefined ? (body.last_name || "").trim() : u.last_name;
      const name =
        body.name !== undefined
          ? (body.name || "").trim() || u.name
          : [firstName, lastName].filter(Boolean).join(" ") || u.name;

      u = {
        ...u,
        first_name: firstName || "",
        last_name: lastName || "",
        name,
        profile_complete: true,
      };
      const savedUser = await saveUserRecord(usersDb, u);
      await persistEvent("info", FN, "admin updated user", { admin: user.email, target: email });
      log("info", FN, "admin updated user", { admin: user.email, target: email });
      return jsonResponse(200, { success: true, user: savedUser });
    } else {
      const firstName = (body.first_name || "").trim();
      const lastName = (body.last_name || "").trim();
      const name = (
        body.name ||
        [firstName, lastName].filter(Boolean).join(" ") ||
        email.split("@")[0]
      ).trim();
      u = {
        id: generateId(),
        email,
        name,
        first_name: firstName,
        last_name: lastName,
        profile_complete: !!firstName,
        is_admin: false,
        created_at: new Date().toISOString(),
        created_by_admin: true,
      };
      const savedUser = await saveUserRecord(usersDb, u);
      await persistEvent("info", FN, "admin created user", { admin: user.email, target: email });
      log("info", FN, "admin created user", { admin: user.email, target: email });
      return jsonResponse(201, { success: true, created: true, user: savedUser });
    }
  }

  // ─── POST /api/admin/users/admin ─────────────────────────────────────────
  if (req.method === "POST" && path === "users/admin") {
    const body = await safeJson(req);
    if (!body) return errorResponse(400, "Request body must be valid JSON.");

    const email = validateEmail(body.email || "");
    if (!email) return errorResponse(400, "A valid email address is required.");

    const makeAdmin = body.is_admin !== false;
    if (isSuperAdminEmail(email) && !makeAdmin) {
      return errorResponse(400, "Super admins defined in ADMIN_EMAILS cannot be removed.");
    }

    const target = await usersDb.get(email, { type: "json" }).catch(() => null);
    if (!target) return errorResponse(404, `User '${email}' not found.`);

    target.is_admin = makeAdmin;
    const savedTarget = await saveUserRecord(usersDb, target);

    await persistEvent("warn", FN, makeAdmin ? "admin granted user admin role" : "admin revoked user admin role", {
      admin: user.email,
      target: email,
      is_admin: makeAdmin,
    });

    return jsonResponse(200, {
      success: true,
      user: {
        ...sanitizeUser(savedTarget),
        is_super_admin: isSuperAdminEmail(savedTarget.email),
        is_admin: isSuperAdminEmail(savedTarget.email) || !!savedTarget.is_admin,
      },
    });
  }

  // ─── POST /api/admin/users/delete ────────────────────────────────────────
  if (req.method === "POST" && path === "users/delete") {
    const body = await safeJson(req);
    if (!body) return errorResponse(400, "Request body must be valid JSON.");
    const email = (body.email || "").trim().toLowerCase();
    if (!email) return errorResponse(400, "email is required.");
    if (isSuperAdminEmail(email)) {
      return errorResponse(400, "Cannot delete a super admin account.");
    }

    const u = await usersDb.get(email, { type: "json" }).catch(() => null);
    if (!u) return errorResponse(404, `User '${email}' not found.`);

    await deleteUserRecord(usersDb, email);
    await persistEvent("warn", FN, "admin deleted user", { admin: user.email, target: email });
    log("info", FN, "admin deleted user", { admin: user.email, target: email });
    return jsonResponse(200, { success: true });
  }

  // ─── POST /api/admin/impersonate ─────────────────────────────────────────
  // Allows an admin to temporarily act as a specific user and experience the
  // app exactly as that user would. The issued JWT includes impersonation
  // metadata so the session can be restored via /api/auth/impersonation/stop.
  if (req.method === "POST" && path === "impersonate") {
    const body = await safeJson(req);
    if (!body) return errorResponse(400, "Request body must be valid JSON.");

    const targetEmail = validateEmail(body.email || "");
    if (!targetEmail) return errorResponse(400, "A valid target email is required.");
    if (targetEmail === (user.email || "").toLowerCase()) {
      return errorResponse(400, "You are already signed in as this user.");
    }

    const targetUser = await usersDb.get(targetEmail, { type: "json" }).catch(() => null);
    if (!targetUser) return errorResponse(404, `User '${targetEmail}' not found.`);

    const tokenPayload = {
      id: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      first_name: targetUser.first_name || "",
      last_name: targetUser.last_name || "",
      profile_complete: !!targetUser.profile_complete,
      timezone: targetUser.timezone || "",
      is_impersonated: true,
      impersonator_email: user.email,
      impersonator_name: user.name || user.email,
    };

    const token = createToken(tokenPayload);
    await persistEvent("warn", FN, "admin started impersonation", {
      admin_email: user.email,
      admin_name: user.name || user.email,
      target_email: targetUser.email,
      target_name: targetUser.name || targetUser.email,
    });

    return jsonResponse(
      200,
      {
        success: true,
        impersonating: {
          email: targetUser.email,
          name: targetUser.name || targetUser.email,
        },
      },
      {
        "Set-Cookie": setCookie("token", token),
      }
    );
  }

  // ─── GET /api/admin/meetings ──────────────────────────────────────────────
  if (req.method === "GET" && path === "meetings") {
    const { page, pageSize, query } = parsePagination(url);
    const meetings = getDb("meetings");
    const invites = getDb("invites");
    const index = await listMeetingIds(meetings);
    const loaded = await Promise.all(
      index.map(async (mid) => {
        const [m, inv] = await Promise.all([
          meetings.get(mid, { type: "json" }).catch(() => null),
          invites.get(`meeting:${mid}`, { type: "json" }).catch(() => []),
        ]);
        if (!m) return null;
        const meetingInvites = asArray(inv);
        return {
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
          respond_count: meetingInvites.filter((i) => i.responded).length,
          invitees: meetingInvites.map((i) => ({
            email: i.email,
            name: i.name,
            responded: i.responded,
          })),
        };
      })
    );
    const result = loaded
      .filter(Boolean)
      .filter((meeting) => {
        if (!query) return true;
        return [meeting.title, meeting.creator_name, meeting.timezone, meeting.meeting_type]
          .map((value) => String(value || "").toLowerCase())
          .some((value) => value.includes(query));
      })
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    const pagination = buildPagination(result.length, page, pageSize);
    const offset = (pagination.page - 1) * pagination.page_size;
    return jsonResponse(200, {
      meetings: result.slice(offset, offset + pagination.page_size),
      pagination,
    });
  }

  // ─── GET /api/admin/events ────────────────────────────────────────────────
  if (req.method === "GET" && path === "events") {
    const eventsDb = getDb("events");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
    const list = await eventsDb.list().catch(() => ({ blobs: [] }));
    // Keys are timestamp-prefixed so lexicographic desc = newest first
    const sorted = [...asArray(list?.blobs)]
      .sort((a, b) => b.key.localeCompare(a.key))
      .slice(0, limit);
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
