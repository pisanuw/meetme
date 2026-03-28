import test from "node:test";
import assert from "node:assert/strict";

import authHandler from "../netlify/functions/auth.mjs";
import meetingsHandler from "../netlify/functions/meetings.mjs";
import meetingActionsHandler from "../netlify/functions/meeting-actions.mjs";
import adminHandler from "../netlify/functions/admin.mjs";
import calendarHandler from "../netlify/functions/calendar.mjs";
import webhooksHandler from "../netlify/functions/webhooks.mjs";
import { createToken, encryptSecret } from "../netlify/functions/utils.mjs";
import {
  installInMemoryDb,
  uninstallInMemoryDb,
  makeJsonRequest,
  responseJson,
  setDefaultTestEnv,
} from "./test-helpers.mjs";

let dbBackend;

function authCookie(user) {
  return `token=${createToken(user)}`;
}

function store(name) {
  return dbBackend.createStore(name);
}

async function createMeetingAs(user) {
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(user) },
    body: {
      title: "Sprint Planning",
      description: "Weekly sync",
      meeting_type: "days_of_week",
      dates_or_days: ["Monday", "Wednesday"],
      start_time: "09:00",
      end_time: "11:00",
      invite_emails: "friend@example.com",
      timezone: "UTC",
    },
  });
  const res = await meetingsHandler(req, {});
  const body = await responseJson(res);
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  return body.meeting_id;
}

test.beforeEach(() => {
  setDefaultTestEnv();
  dbBackend = installInMemoryDb();
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      return new Response(JSON.stringify({ id: `resend-${Date.now()}` }), { status: 200 });
    }
    if (target.includes("oauth2.googleapis.com/revoke")) {
      return new Response("", { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
});

test.afterEach(() => {
  uninstallInMemoryDb();
  delete global.fetch;
});

test("auth health hides details from anonymous users", async () => {
  const req = new Request("http://localhost:8888/api/auth/health", { method: "GET" });
  const res = await authHandler(req, { params: { 0: "health" } });

  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(typeof body.ok, "boolean");
  assert.equal(body.checks, undefined);
  assert.equal(body.missing, undefined);
});

test("auth me requires authentication", async () => {
  const req = new Request("http://localhost:8888/api/auth/me", { method: "GET" });
  const res = await authHandler(req, { params: { 0: "me" } });

  assert.equal(res.status, 401);
  const body = await responseJson(res);
  assert.match(body.error, /Not authenticated/i);
});

test("auth magic-link request succeeds and persists login token", async () => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.AUTH_FROM_EMAIL = "MeetMe <noreply@example.com>";

  const req = makeJsonRequest("http://localhost:8888/api/auth/magic-link/request", {
    method: "POST",
    body: { email: "newuser@example.com", name: "New User" },
  });
  const res = await authHandler(req, { params: { 0: "magic-link/request" } });

  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.success, true);

  const users = await store("users").get("newuser@example.com", { type: "json" });
  assert.equal(users.email, "newuser@example.com");

  const tokens = await store("login_tokens").list();
  assert.equal(tokens.blobs.length, 1);
});

test("auth magic-link verify sets session cookie", async () => {
  const jti = "jti-1";
  await store("login_tokens").setJSON(jti, {
    email: "verify@example.com",
    used: false,
    created_at: new Date().toISOString(),
  });

  const magicToken = createToken(
    {
      id: "magic-link",
      email: "verify@example.com",
      name: "Verify User",
      purpose: "magic_link",
      jti,
    },
    "15m"
  );

  const req = new Request(
    `http://localhost:8888/api/auth/magic-link/verify?token=${encodeURIComponent(magicToken)}`,
    { method: "GET" }
  );
  const res = await authHandler(req, { params: { 0: "magic-link/verify" } });

  assert.equal(res.status, 302);
  assert.match(res.headers.get("set-cookie") || "", /token=/);
});

test("auth magic-link verify redirects existing users to requested next path", async () => {
  await store("users").setJSON("returning@example.com", {
    id: "u-returning",
    email: "returning@example.com",
    name: "Returning User",
    profile_complete: true,
    created_at: new Date().toISOString(),
  });

  const jti = "jti-next-1";
  await store("login_tokens").setJSON(jti, {
    email: "returning@example.com",
    used: false,
    created_at: new Date().toISOString(),
  });

  const magicToken = createToken(
    {
      id: "magic-link",
      email: "returning@example.com",
      name: "Returning User",
      purpose: "magic_link",
      jti,
      next: "/book.html?host=alice&event=evt1",
    },
    "15m"
  );

  const req = new Request(
    `http://localhost:8888/api/auth/magic-link/verify?token=${encodeURIComponent(magicToken)}`,
    { method: "GET" }
  );
  const res = await authHandler(req, { params: { 0: "magic-link/verify" } });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/book.html?host=alice&event=evt1");
  assert.match(res.headers.get("set-cookie") || "", /token=/);
});

test("auth magic-link request is rate-limited when limits are enabled", async () => {
  process.env.DISABLE_RATE_LIMIT = "";
  process.env.RESEND_API_KEY = "re_test";
  process.env.AUTH_FROM_EMAIL = "MeetMe <noreply@example.com>";

  await store("rate_limits").setJSON("auth_magic_link_email:limited@example.com", {
    window_start: Date.now(),
    count: 5,
  });

  const req = makeJsonRequest("http://localhost:8888/api/auth/magic-link/request", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.1" },
    body: { email: "limited@example.com", name: "Limited" },
  });
  const res = await authHandler(req, { params: { 0: "magic-link/request" } });
  const body = await responseJson(res);

  assert.equal(res.status, 429);
  assert.match(body.error, /Too many sign-in links requested/i);
});

test("auth google callback succeeds with valid state and google responses", async () => {
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";

  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "google-access-token", expires_in: 3600 }),
        { status: 200 }
      );
    }
    if (target.includes("www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(
        JSON.stringify({
          email: "google.user@example.com",
          name: "Google User",
          email_verified: true,
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const state = createToken(
    {
      id: "oauth-state",
      email: "oauth-state@meetme.local",
      name: "oauth",
      purpose: "google_oauth_state",
      return_to: "/dashboard.html",
      jti: "state-jti",
    },
    "10m"
  );

  const req = new Request(
    `http://localhost:8888/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
    {
      method: "GET",
      headers: {
        cookie: `oauth_state=${state}`,
      },
    }
  );

  const res = await authHandler(req, { params: { 0: "google/callback" } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/profile.html?setup=1");
  assert.match(res.headers.get("set-cookie") || "", /token=/);

  const dbUser = await store("users").get("google.user@example.com", { type: "json" });
  assert.equal(dbUser.email, "google.user@example.com");
});

test("auth google callback redirects existing users to state return_to", async () => {
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";

  await store("users").setJSON("google.return@example.com", {
    id: "u-google-return",
    email: "google.return@example.com",
    name: "Google Return",
    profile_complete: true,
    created_at: new Date().toISOString(),
  });

  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "google-access-token", expires_in: 3600 }),
        { status: 200 }
      );
    }
    if (target.includes("www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(
        JSON.stringify({
          email: "google.return@example.com",
          name: "Google Return",
          email_verified: true,
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const state = createToken(
    {
      id: "oauth-state",
      email: "oauth-state@meetme.local",
      name: "oauth",
      purpose: "google_oauth_state",
      return_to: "/book.html?host=alice&event=evt1",
      jti: "state-jti-return",
    },
    "10m"
  );

  const req = new Request(
    `http://localhost:8888/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
    {
      method: "GET",
      headers: {
        cookie: `oauth_state=${state}`,
      },
    }
  );

  const res = await authHandler(req, { params: { 0: "google/callback" } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/book.html?host=alice&event=evt1");
  assert.match(res.headers.get("set-cookie") || "", /token=/);
});

test("meetings create/list/detail/leave lifecycle works", async () => {
  const creator = { id: "u1", email: "creator@example.com", name: "Creator" };
  const invitee = { id: "u2", email: "friend@example.com", name: "Friend" };

  const meetingId = await createMeetingAs(creator);

  const listReq = new Request("http://localhost:8888/api/meetings", {
    method: "GET",
    headers: { cookie: authCookie(creator) },
  });
  const listRes = await meetingsHandler(listReq, {});
  const listBody = await responseJson(listRes);
  assert.equal(listRes.status, 200);
  assert.equal(listBody.my_meetings.length, 1);

  const detailReq = new Request(`http://localhost:8888/api/meetings/${meetingId}`, {
    method: "GET",
    headers: { cookie: authCookie(invitee) },
  });
  const detailRes = await meetingsHandler(detailReq, {});
  const detailBody = await responseJson(detailRes);
  assert.equal(detailRes.status, 200);
  assert.equal(detailBody.meeting.id, meetingId);

  const leaveReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meetingId}/leave`, {
    method: "POST",
    headers: { cookie: authCookie(invitee) },
    body: {},
  });
  const leaveRes = await meetingsHandler(leaveReq, {});
  const leaveBody = await responseJson(leaveRes);
  assert.equal(leaveRes.status, 200);
  assert.equal(leaveBody.success, true);
});

test("meeting creation does not send invite email to creator", async () => {
  const creator = { id: "u1a", email: "creator-self@example.com", name: "Creator Self" };

  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(creator) },
    body: {
      title: "No Self Invite",
      description: "Creator should not receive invite email",
      meeting_type: "days_of_week",
      dates_or_days: ["Monday"],
      start_time: "09:00",
      end_time: "10:00",
      invite_emails: "creator-self@example.com,friend@example.com",
      timezone: "UTC",
    },
  });
  const res = await meetingsHandler(req, {});
  const body = await responseJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.invite_results.length, 1);
  assert.equal(body.invite_results[0].email, "friend@example.com");
});

test("meeting actions availability/finalize/unfinalize/reminder flows", async () => {
  const creator = { id: "u10", email: "creator10@example.com", name: "Creator 10" };
  const invitee = { id: "u11", email: "friend@example.com", name: "Friend" };
  const meetingId = await createMeetingAs(creator);

  const availabilityReq = makeJsonRequest(
    `http://localhost:8888/api/meetings/${meetingId}/availability`,
    {
      method: "POST",
      headers: { cookie: authCookie(invitee) },
      body: { slots: ["Monday_09:00", "Wednesday_09:15"] },
    }
  );
  const availabilityRes = await meetingActionsHandler(availabilityReq, {});
  const availabilityBody = await responseJson(availabilityRes);
  assert.equal(availabilityRes.status, 200);
  assert.equal(availabilityBody.success, true);

  const finalizeForbiddenReq = makeJsonRequest(
    `http://localhost:8888/api/meetings/${meetingId}/finalize`,
    {
      method: "POST",
      headers: { cookie: authCookie(invitee) },
      body: { date_or_day: "Monday", time_slot: "09:00", duration_minutes: 60 },
    }
  );
  const finalizeForbiddenRes = await meetingActionsHandler(finalizeForbiddenReq, {});
  assert.equal(finalizeForbiddenRes.status, 403);

  const finalizeReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meetingId}/finalize`, {
    method: "POST",
    headers: { cookie: authCookie(creator) },
    body: { date_or_day: "Monday", time_slot: "09:00", duration_minutes: 60 },
  });
  const finalizeRes = await meetingActionsHandler(finalizeReq, {});
  const finalizeBody = await responseJson(finalizeRes);
  assert.equal(finalizeRes.status, 200);
  assert.equal(finalizeBody.success, true);

  const unfinalizeReq = makeJsonRequest(
    `http://localhost:8888/api/meetings/${meetingId}/unfinalize`,
    {
      method: "POST",
      headers: { cookie: authCookie(creator) },
      body: {},
    }
  );
  const unfinalizeRes = await meetingActionsHandler(unfinalizeReq, {});
  assert.equal(unfinalizeRes.status, 200);

  const reminderReq = makeJsonRequest(
    `http://localhost:8888/api/meetings/${meetingId}/remind-pending`,
    {
      method: "POST",
      headers: { cookie: authCookie(creator) },
      body: {},
    }
  );
  const reminderRes = await meetingActionsHandler(reminderReq, {});
  const reminderBody = await responseJson(reminderRes);
  assert.equal(reminderRes.status, 200);
  assert.equal(reminderBody.success, true);
});

test("meetings list requires authentication", async () => {
  const req = new Request("http://localhost:8888/api/meetings", { method: "GET" });
  const res = await meetingsHandler(req, {});

  assert.equal(res.status, 401);
  const body = await responseJson(res);
  assert.match(body.error, /Not authenticated/i);
});

test("admin routes reject non-admin users", async () => {
  const token = createToken({ id: "u1", email: "member@example.com", name: "Member" });
  const req = new Request("http://localhost:8888/api/admin/stats", {
    method: "GET",
    headers: { cookie: `token=${token}` },
  });

  const res = await adminHandler(req, { params: { 0: "stats" } });
  assert.equal(res.status, 403);
  const body = await responseJson(res);
  assert.match(body.error, /Admin access required/i);
});

test("admin user create/update/delete + impersonation", async () => {
  const token = createToken({ id: "a1", email: "admin@example.com", name: "Admin" });

  const createReq = makeJsonRequest("http://localhost:8888/api/admin/users", {
    method: "POST",
    headers: { cookie: `token=${token}` },
    body: { email: "member@example.com", first_name: "Member", last_name: "One" },
  });
  const createRes = await adminHandler(createReq, { params: { 0: "users" } });
  const createBody = await responseJson(createRes);
  assert.equal(createRes.status, 201);
  assert.equal(createBody.created, true);

  const updateReq = makeJsonRequest("http://localhost:8888/api/admin/users", {
    method: "POST",
    headers: { cookie: `token=${token}` },
    body: { email: "member@example.com", first_name: "Member", last_name: "Updated" },
  });
  const updateRes = await adminHandler(updateReq, { params: { 0: "users" } });
  assert.equal(updateRes.status, 200);

  const impersonateReq = makeJsonRequest("http://localhost:8888/api/admin/impersonate", {
    method: "POST",
    headers: { cookie: `token=${token}` },
    body: { email: "member@example.com" },
  });
  const impersonateRes = await adminHandler(impersonateReq, { params: { 0: "impersonate" } });
  const impersonateBody = await responseJson(impersonateRes);
  assert.equal(impersonateRes.status, 200);
  assert.equal(impersonateBody.success, true);

  const deleteReq = makeJsonRequest("http://localhost:8888/api/admin/users/delete", {
    method: "POST",
    headers: { cookie: `token=${token}` },
    body: { email: "member@example.com" },
  });
  const deleteRes = await adminHandler(deleteReq, { params: { 0: "users/delete" } });
  const deleteBody = await responseJson(deleteRes);
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteBody.success, true);
});

test("admin can grant and revoke additional admins but not super admins", async () => {
  const token = createToken({ id: "a3", email: "admin@example.com", name: "Admin" });

  const createReq = makeJsonRequest("http://localhost:8888/api/admin/users", {
    method: "POST",
    headers: { cookie: `token=${token}` },
    body: { email: "extra-admin@example.com", first_name: "Extra", last_name: "Admin" },
  });
  const createRes = await adminHandler(createReq, { params: { 0: "users" } });
  assert.equal(createRes.status, 201);

  const grantReq = makeJsonRequest("http://localhost:8888/api/admin/users/admin", {
    method: "POST",
    headers: { cookie: `token=${token}` },
    body: { email: "extra-admin@example.com", is_admin: true },
  });
  const grantRes = await adminHandler(grantReq, { params: { 0: "users/admin" } });
  const grantBody = await responseJson(grantRes);
  assert.equal(grantRes.status, 200);
  assert.equal(grantBody.user.is_admin, true);

  const revokeReq = makeJsonRequest("http://localhost:8888/api/admin/users/admin", {
    method: "POST",
    headers: { cookie: `token=${token}` },
    body: { email: "extra-admin@example.com", is_admin: false },
  });
  const revokeRes = await adminHandler(revokeReq, { params: { 0: "users/admin" } });
  const revokeBody = await responseJson(revokeRes);
  assert.equal(revokeRes.status, 200);
  assert.equal(revokeBody.user.is_admin, false);

  const superRevokeReq = makeJsonRequest("http://localhost:8888/api/admin/users/admin", {
    method: "POST",
    headers: { cookie: `token=${token}` },
    body: { email: "admin@example.com", is_admin: false },
  });
  const superRevokeRes = await adminHandler(superRevokeReq, { params: { 0: "users/admin" } });
  assert.equal(superRevokeRes.status, 400);
});

test("admin stats and events routes work for admins", async () => {
  const token = createToken({ id: "a2", email: "admin@example.com", name: "Admin" });
  const statsReq = new Request("http://localhost:8888/api/admin/stats", {
    method: "GET",
    headers: { cookie: `token=${token}` },
  });
  const statsRes = await adminHandler(statsReq, { params: { 0: "stats" } });
  const statsBody = await responseJson(statsRes);
  assert.equal(statsRes.status, 200);
  assert.equal(typeof statsBody.total_users, "number");

  const eventsReq = new Request("http://localhost:8888/api/admin/events?limit=10", {
    method: "GET",
    headers: { cookie: `token=${token}` },
  });
  const eventsRes = await adminHandler(eventsReq, { params: { 0: "events" } });
  const eventsBody = await responseJson(eventsRes);
  assert.equal(eventsRes.status, 200);
  assert.ok(Array.isArray(eventsBody.events));
});

test("calendar busy route enforces auth and calendar connection", async () => {
  const unauthReq = new Request("http://localhost:8888/api/calendar/busy?meeting_id=m1", {
    method: "GET",
  });
  const unauthRes = await calendarHandler(unauthReq, { params: { 0: "busy" } });
  assert.equal(unauthRes.status, 401);

  const user = { id: "u20", email: "cal@example.com", name: "Cal User" };
  await store("meetings").setJSON("m1", {
    id: "m1",
    meeting_type: "specific_dates",
    dates_or_days: ["2026-04-01"],
    start_time: "09:00",
    end_time: "10:00",
    timezone: "UTC",
  });
  await store("users").setJSON("cal@example.com", {
    ...user,
    calendar_connected: false,
    google_access_token: "",
  });

  const req = new Request("http://localhost:8888/api/calendar/busy?meeting_id=m1", {
    method: "GET",
    headers: { cookie: authCookie(user) },
  });
  const res = await calendarHandler(req, { params: { 0: "busy" } });
  const body = await responseJson(res);
  assert.equal(res.status, 403);
  assert.match(body.error, /not connected/i);
});

test("calendar status route returns connection state", async () => {
  const user = { id: "u21", email: "status@example.com", name: "Status User" };
  await store("users").setJSON("status@example.com", {
    ...user,
    calendar_connected: true,
    google_access_token: encryptSecret("access-token"),
  });

  const req = new Request("http://localhost:8888/api/calendar/status", {
    method: "GET",
    headers: { cookie: authCookie(user) },
  });
  const res = await calendarHandler(req, { params: { 0: "status" } });
  const body = await responseJson(res);
  assert.equal(res.status, 200);
  assert.equal(body.connected, true);
});

test("webhooks resend rejects invalid secret", async () => {
  process.env.RESEND_WEBHOOK_SECRET = "expected-secret";

  const req = makeJsonRequest("http://localhost:8888/api/webhooks/resend", {
    method: "POST",
    headers: { "x-webhook-secret": "wrong-secret" },
    body: { type: "email.bounced", data: { email_id: "missing" } },
  });
  const res = await webhooksHandler(req, { params: { 0: "resend" } });
  assert.equal(res.status, 403);
});

test("webhooks resend handles actionable event", async () => {
  process.env.RESEND_WEBHOOK_SECRET = "expected-secret";
  process.env.APP_URL = "http://localhost:8888";

  await store("email_records").setJSON("mail-1", {
    meeting_id: "m-1",
    meeting_title: "Retro",
    creator_email: "creator@example.com",
    creator_name: "Creator",
    invitee_email: "bounce@example.com",
  });

  const req = makeJsonRequest("http://localhost:8888/api/webhooks/resend", {
    method: "POST",
    headers: { "x-webhook-secret": "expected-secret" },
    body: {
      type: "email.bounced",
      data: {
        email_id: "mail-1",
        bounce: { type: "hard", message: "User unknown" },
      },
    },
  });
  const res = await webhooksHandler(req, { params: { 0: "resend" } });
  const body = await responseJson(res);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
});

test("auth feedback requires configured admin emails", async () => {
  process.env.ADMIN_EMAILS = "";
  const user = { id: "u30", email: "user30@example.com", name: "User 30" };
  const req = makeJsonRequest("http://localhost:8888/api/auth/feedback", {
    method: "POST",
    headers: { cookie: authCookie(user) },
    body: {
      email: "sender@example.com",
      type: "bug",
      message: "Something broke",
    },
  });
  const res = await authHandler(req, { params: { 0: "feedback" } });
  assert.equal(res.status, 500);
});

test("auth logout clears session cookie", async () => {
  const user = { id: "u40", email: "logout@example.com", name: "Logout" };
  const req = makeJsonRequest("http://localhost:8888/api/auth/logout", {
    method: "POST",
    headers: { cookie: authCookie(user) },
    body: {},
  });
  const res = await authHandler(req, { params: { 0: "logout" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") || "", /Max-Age=0/);
});

// ─── auth health — admin visibility ──────────────────────────────────────────

test("auth health exposes checks to authenticated admin", async () => {
  process.env.JWT_SECRET = "test-jwt-secret";
  process.env.ADMIN_EMAILS = "admin@example.com";
  const admin = { id: "adm1", email: "admin@example.com", name: "Admin" };
  await store("users").setJSON("admin@example.com", { ...admin, is_admin: true });

  const req = new Request("http://localhost:8888/api/auth/health", {
    method: "GET",
    headers: { cookie: authCookie(admin) },
  });
  const res = await authHandler(req, { params: { 0: "health" } });
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(typeof body.ok, "boolean");
  assert.ok(typeof body.checks === "object", "admin should see checks object");
  assert.ok(Array.isArray(body.missing), "admin should see missing array");
});

// ─── auth profile — GET ───────────────────────────────────────────────────────

test("auth profile GET requires authentication", async () => {
  const req = new Request("http://localhost:8888/api/auth/profile", { method: "GET" });
  const res = await authHandler(req, { params: { 0: "profile" } });
  assert.equal(res.status, 401);
});

test("auth profile GET returns user profile data", async () => {
  const user = { id: "u50", email: "profile@example.com", name: "Profile User" };
  await store("users").setJSON("profile@example.com", {
    ...user,
    first_name: "Profile",
    last_name: "User",
    timezone: "America/New_York",
    profile_complete: true,
    calendar_connected: false,
    google_access_token: "",
  });

  const req = new Request("http://localhost:8888/api/auth/profile", {
    method: "GET",
    headers: { cookie: authCookie(user) },
  });
  const res = await authHandler(req, { params: { 0: "profile" } });
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.email, "profile@example.com");
  assert.equal(body.first_name, "Profile");
  assert.equal(body.timezone, "America/New_York");
  assert.equal(body.google_access_token, undefined);
});

// ─── auth profile — POST ──────────────────────────────────────────────────────

test("auth profile POST updates name and timezone", async () => {
  const user = { id: "u51", email: "update@example.com", name: "Old Name" };
  await store("users").setJSON("update@example.com", { ...user });

  const req = makeJsonRequest("http://localhost:8888/api/auth/profile", {
    method: "POST",
    headers: { cookie: authCookie(user) },
    body: { first_name: "New", last_name: "Name", timezone: "Europe/London" },
  });
  const res = await authHandler(req, { params: { 0: "profile" } });
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.success, true);
  assert.equal(body.name, "New Name");

  const saved = await store("users").get("update@example.com", { type: "json" });
  assert.equal(saved.first_name, "New");
  assert.equal(saved.timezone, "Europe/London");
  assert.equal(saved.profile_complete, true);
});

test("auth profile POST rejects missing first name", async () => {
  const user = { id: "u52", email: "nofirstname@example.com", name: "No Name" };
  await store("users").setJSON("nofirstname@example.com", { ...user });

  const req = makeJsonRequest("http://localhost:8888/api/auth/profile", {
    method: "POST",
    headers: { cookie: authCookie(user) },
    body: { first_name: "", last_name: "Smith", timezone: "" },
  });
  const res = await authHandler(req, { params: { 0: "profile" } });
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.match(body.error, /first name/i);
});

// ─── auth google/calendar-disconnect ─────────────────────────────────────────

test("auth google/calendar-disconnect clears calendar tokens", async () => {
  const user = { id: "u53", email: "caldisconn@example.com", name: "Cal Disconnect" };
  await store("users").setJSON("caldisconn@example.com", {
    ...user,
    calendar_connected: true,
    google_access_token: "enc:v1:xxx",
    google_refresh_token: "enc:v1:yyy",
    google_token_expiry: 9999999,
  });

  const req = makeJsonRequest("http://localhost:8888/api/auth/google/calendar-disconnect", {
    method: "POST",
    headers: { cookie: authCookie(user) },
    body: {},
  });
  const res = await authHandler(req, { params: { 0: "google/calendar-disconnect" } });
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.success, true);

  const saved = await store("users").get("caldisconn@example.com", { type: "json" });
  assert.equal(saved.calendar_connected, false);
  assert.equal(saved.google_access_token, "");
  assert.equal(saved.google_refresh_token, "");
});

// ─── auth impersonation/stop ──────────────────────────────────────────────────

test("auth impersonation/stop restores admin session", async () => {
  const adminUser = {
    id: "adm2",
    email: "admin2@example.com",
    name: "Admin Two",
    is_admin: true,
  };
  const impersonatedUser = {
    id: "u60",
    email: "victim@example.com",
    name: "Victim",
    is_impersonated: true,
    impersonator_email: "admin2@example.com",
    impersonator_name: "Admin Two",
  };

  process.env.ADMIN_EMAILS = "admin2@example.com";
  await store("users").setJSON("admin2@example.com", adminUser);

  const req = makeJsonRequest("http://localhost:8888/api/auth/impersonation/stop", {
    method: "POST",
    headers: { cookie: authCookie(impersonatedUser) },
    body: {},
  });
  const res = await authHandler(req, { params: { 0: "impersonation/stop" } });
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.success, true);
  assert.match(res.headers.get("set-cookie") || "", /token=/);
});

test("auth impersonation/stop rejects non-impersonated session", async () => {
  const user = { id: "u61", email: "regular@example.com", name: "Regular" };

  const req = makeJsonRequest("http://localhost:8888/api/auth/impersonation/stop", {
    method: "POST",
    headers: { cookie: authCookie(user) },
    body: {},
  });
  const res = await authHandler(req, { params: { 0: "impersonation/stop" } });
  assert.equal(res.status, 403);
});

// ─── magic-link/verify edge cases ────────────────────────────────────────────

test("magic-link verify with no token redirects to /?error=invalid-link", async () => {
  const req = new Request("http://localhost:8888/api/auth/magic-link/verify", { method: "GET" });
  const res = await authHandler(req, { params: { 0: "magic-link/verify" } });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /invalid-link/);
});

test("magic-link verify with bad token redirects to /?error=invalid-link", async () => {
  const req = new Request(
    "http://localhost:8888/api/auth/magic-link/verify?token=not.a.real.token",
    { method: "GET" }
  );
  const res = await authHandler(req, { params: { 0: "magic-link/verify" } });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /invalid-link/);
});

test("magic-link verify with already-used token redirects to /?error=link-already-used", async () => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.AUTH_FROM_EMAIL = "MeetMe <noreply@example.com>";

  // First request the magic link (creates a login token in DB)
  const requestReq = makeJsonRequest("http://localhost:8888/api/auth/magic-link/request", {
    method: "POST",
    body: { email: "reuse@example.com", name: "Reuse User" },
  });
  await authHandler(requestReq, { params: { 0: "magic-link/request" } });

  // Get the JTI from the stored token
  const tokenStore = store("login_tokens");
  const allTokens = await tokenStore.list();
  const jti = allTokens.blobs[0]?.key;
  assert.ok(jti, "token should exist in store");

  const tokenRecord = await tokenStore.get(jti, { type: "json" });

  // Create a valid magic link token and mark it as used
  const { createToken: mkToken } = await import("../netlify/functions/utils.mjs");
  const magicToken = mkToken(
    {
      id: jti,
      email: "reuse@example.com",
      purpose: "magic_link",
      jti,
    },
    "15m"
  );
  await tokenStore.setJSON(jti, { ...tokenRecord, used: true });

  const verifyReq = new Request(
    `http://localhost:8888/api/auth/magic-link/verify?token=${encodeURIComponent(magicToken)}`,
    { method: "GET" }
  );
  const res = await authHandler(verifyReq, { params: { 0: "magic-link/verify" } });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /link-already-used/);
});

// ─── meetings delete ──────────────────────────────────────────────────────────

test("meetings delete — creator can delete a meeting", async () => {
  const creator = { id: "u70", email: "creator70@example.com", name: "Creator 70" };
  await store("users").setJSON("creator70@example.com", creator);

  const meetingId = await createMeetingAs(creator);

  const req = makeJsonRequest(`http://localhost:8888/api/meetings/${meetingId}/delete`, {
    method: "POST",
    headers: { cookie: authCookie(creator) },
    body: {},
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.success, true);

  const gone = await store("meetings").get(meetingId, { type: "json" });
  assert.equal(gone, null);
});

test("meetings delete — non-creator is rejected with 403", async () => {
  const creator = { id: "u71", email: "creator71@example.com", name: "Creator 71" };
  const other = { id: "u72", email: "other72@example.com", name: "Other 72" };
  await store("users").setJSON("creator71@example.com", creator);

  const meetingId = await createMeetingAs(creator);

  const req = makeJsonRequest(`http://localhost:8888/api/meetings/${meetingId}/delete`, {
    method: "POST",
    headers: { cookie: authCookie(other) },
    body: {},
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 403);
});

// ─── meetings leave ───────────────────────────────────────────────────────────

test("meetings leave — invited user can leave a meeting", async () => {
  const creator = { id: "u73", email: "creator73@example.com", name: "Creator 73" };
  const invitee = { id: "u74", email: "friend@example.com", name: "Friend" };
  await store("users").setJSON("creator73@example.com", creator);
  await store("users").setJSON("friend@example.com", invitee);

  const meetingId = await createMeetingAs(creator);

  // Link the invitee's user record to their invite
  const inviteStore = store("invites");
  const meetingInvites = (await inviteStore.get(`meeting:${meetingId}`, { type: "json" })) || [];
  const updatedInvites = meetingInvites.map((inv) =>
    inv.email === "friend@example.com" ? { ...inv, user_id: invitee.id } : inv
  );
  await inviteStore.setJSON(`meeting:${meetingId}`, updatedInvites);

  const req = makeJsonRequest(`http://localhost:8888/api/meetings/${meetingId}/leave`, {
    method: "POST",
    headers: { cookie: authCookie(invitee) },
    body: {},
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.success, true);
});

test("meetings leave — creator cannot leave their own meeting", async () => {
  const creator = { id: "u75", email: "creator75@example.com", name: "Creator 75" };
  await store("users").setJSON("creator75@example.com", creator);

  const meetingId = await createMeetingAs(creator);

  const req = makeJsonRequest(`http://localhost:8888/api/meetings/${meetingId}/leave`, {
    method: "POST",
    headers: { cookie: authCookie(creator) },
    body: {},
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 403);
});

// ─── webhooks — complaint and unknown event types ─────────────────────────────

test("webhooks resend handles spam complaint event", async () => {
  process.env.RESEND_WEBHOOK_SECRET = "expected-secret";
  process.env.RESEND_API_KEY = "re_test";
  process.env.AUTH_FROM_EMAIL = "MeetMe <noreply@example.com>";
  process.env.APP_URL = "http://localhost:8888";

  await store("email_records").setJSON("mail-complaint-1", {
    meeting_id: "m-complaint",
    meeting_title: "Team Sync",
    creator_email: "creator@example.com",
    creator_name: "Creator",
    invitee_email: "spam@example.com",
  });

  const req = makeJsonRequest("http://localhost:8888/api/webhooks/resend", {
    method: "POST",
    headers: { "x-webhook-secret": "expected-secret" },
    body: {
      type: "email.complained",
      data: { email_id: "mail-complaint-1" },
    },
  });
  const res = await webhooksHandler(req, { params: { 0: "resend" } });
  const body = await responseJson(res);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
});

test("webhooks resend acknowledges non-actionable events without acting", async () => {
  process.env.RESEND_WEBHOOK_SECRET = "expected-secret";

  const req = makeJsonRequest("http://localhost:8888/api/webhooks/resend", {
    method: "POST",
    headers: { "x-webhook-secret": "expected-secret" },
    body: { type: "email.delivered", data: { email_id: "mail-delivered" } },
  });
  const res = await webhooksHandler(req, { params: { 0: "resend" } });
  const body = await responseJson(res);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.match(body.message, /no action needed/i);
});

test("webhooks resend with missing email_id returns ok with no-correlation message", async () => {
  process.env.RESEND_WEBHOOK_SECRET = "expected-secret";

  const req = makeJsonRequest("http://localhost:8888/api/webhooks/resend", {
    method: "POST",
    headers: { "x-webhook-secret": "expected-secret" },
    body: { type: "email.bounced", data: {} },
  });
  const res = await webhooksHandler(req, { params: { 0: "resend" } });
  const body = await responseJson(res);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.match(body.message, /no email_id/i);
});

// ─── rate-limiting on IP ──────────────────────────────────────────────────────

test("auth magic-link IP rate-limit blocks excessive requests from same IP", async () => {
  process.env.DISABLE_RATE_LIMIT = "";
  process.env.RESEND_API_KEY = "re_test";
  process.env.AUTH_FROM_EMAIL = "MeetMe <noreply@example.com>";

  await store("rate_limits").setJSON("auth_magic_link_ip:1.2.3.4", {
    window_start: Date.now(),
    count: 12,
  });

  const req = makeJsonRequest("http://localhost:8888/api/auth/magic-link/request", {
    method: "POST",
    headers: { "x-forwarded-for": "1.2.3.4" },
    body: { email: "victim@example.com", name: "Victim" },
  });
  const res = await authHandler(req, { params: { 0: "magic-link/request" } });
  assert.equal(res.status, 429);
});
