import test from "node:test";
import assert from "node:assert/strict";

import authHandler from "../netlify/functions/auth.mjs";
import meetingsHandler from "../netlify/functions/meetings.mjs";
import meetingActionsHandler from "../netlify/functions/meeting-actions.mjs";
import adminHandler from "../netlify/functions/admin.mjs";
import calendarHandler from "../netlify/functions/calendar.mjs";
import webhooksHandler from "../netlify/functions/webhooks.mjs";
import emailPreferencesHandler from "../netlify/functions/email-preferences.mjs";
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

test("auth email preferences get and update for signed-in user", async () => {
  const token = createToken({ id: "u-pref", email: "prefs@example.com", name: "Prefs User" });

  const getReq = new Request("http://localhost:8888/api/auth/email-preferences", {
    method: "GET",
    headers: { cookie: `token=${token}` },
  });
  const getRes = await authHandler(getReq, { params: { 0: "email-preferences" } });
  const getBody = await responseJson(getRes);
  assert.equal(getRes.status, 200);
  assert.equal(getBody.global_opt_out, false);
  assert.deepEqual(getBody.blocked_organizers, []);

  const postReq = makeJsonRequest("http://localhost:8888/api/auth/email-preferences", {
    method: "POST",
    headers: { cookie: `token=${token}` },
    body: {
      global_opt_out: true,
      blocked_organizers: ["organizer@example.com", "ORGANIZER@example.com"],
    },
  });
  const postRes = await authHandler(postReq, { params: { 0: "email-preferences" } });
  const postBody = await responseJson(postRes);
  assert.equal(postRes.status, 200);
  assert.equal(postBody.success, true);
  assert.equal(postBody.global_opt_out, true);
  assert.deepEqual(postBody.blocked_organizers, ["organizer@example.com"]);

  const prefsInDb = await store("email_preferences").get("email:prefs@example.com", { type: "json" });
  assert.equal(prefsInDb.global_opt_out, true);
  assert.deepEqual(prefsInDb.blocked_organizers, ["organizer@example.com"]);
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

test("meeting detail redacts all_invites emails for non-creators", async () => {
  const creator = { id: "u-creator-privacy", email: "creator-privacy@example.com", name: "Creator" };
  const invitee = { id: "u-invitee-privacy", email: "friend@example.com", name: "Friend" };

  const meetingId = await createMeetingAs(creator);

  const inviteeDetailReq = new Request(`http://localhost:8888/api/meetings/${meetingId}`, {
    method: "GET",
    headers: { cookie: authCookie(invitee) },
  });
  const inviteeDetailRes = await meetingsHandler(inviteeDetailReq, {});
  const inviteeBody = await responseJson(inviteeDetailRes);

  assert.equal(inviteeDetailRes.status, 200);
  assert.equal(Array.isArray(inviteeBody.all_invites), true);
  assert.equal(inviteeBody.all_invites.length > 0, true);
  for (const inv of inviteeBody.all_invites) {
    assert.equal(Object.prototype.hasOwnProperty.call(inv, "email"), false);
  }

  const creatorDetailReq = new Request(`http://localhost:8888/api/meetings/${meetingId}`, {
    method: "GET",
    headers: { cookie: authCookie(creator) },
  });
  const creatorDetailRes = await meetingsHandler(creatorDetailReq, {});
  const creatorBody = await responseJson(creatorDetailRes);

  assert.equal(creatorDetailRes.status, 200);
  assert.equal(Array.isArray(creatorBody.all_invites), true);
  assert.equal(creatorBody.all_invites.some((inv) => inv.email === "friend@example.com"), true);
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

test("email preferences confirm and apply global opt-out", async () => {
  const token = createToken(
    {
      id: "email-preferences",
      purpose: "email_preferences",
      email: "recipient@example.com",
      organizer_email: "organizer@example.com",
      jti: "pref-jti-1",
    },
    "10m"
  );

  const confirmReq = new Request(
    `http://localhost:8888/api/email-preferences/confirm?token=${encodeURIComponent(token)}&action=global_opt_out`,
    { method: "GET" }
  );
  const confirmRes = await emailPreferencesHandler(confirmReq, {});
  const confirmHtml = await confirmRes.text();
  assert.equal(confirmRes.status, 200);
  assert.match(confirmHtml, /Confirm email preference/i);

  const applyReq = new Request("http://localhost:8888/api/email-preferences/apply", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, action: "global_opt_out" }).toString(),
  });
  const applyRes = await emailPreferencesHandler(applyReq, {});
  const applyHtml = await applyRes.text();
  assert.equal(applyRes.status, 200);
  assert.match(applyHtml, /Preference updated/i);

  const prefs = await store("email_preferences").get("email:recipient@example.com", { type: "json" });
  assert.equal(prefs.global_opt_out, true);
});

test("meeting invite is suppressed for global email opt-out recipient", async () => {
  const creator = { id: "u-optout-creator", email: "creator-optout@example.com", name: "Creator" };
  process.env.RESEND_API_KEY = "re_test";
  process.env.AUTH_FROM_EMAIL = "MeetMe <noreply@example.com>";

  await store("email_preferences").setJSON("email:friend@example.com", {
    email: "friend@example.com",
    global_opt_out: true,
    blocked_organizers: [],
    updated_at: new Date().toISOString(),
  });

  let resendCallCount = 0;
  global.fetch = async (url) => {
    if (String(url).includes("api.resend.com/emails")) {
      resendCallCount += 1;
      return new Response(JSON.stringify({ id: `resend-${Date.now()}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(creator) },
    body: {
      title: "Suppression Test",
      description: "Global opt-out recipient",
      meeting_type: "days_of_week",
      dates_or_days: ["Monday"],
      start_time: "09:00",
      end_time: "10:00",
      invite_emails: "friend@example.com",
      timezone: "UTC",
    },
  });
  const res = await meetingsHandler(req, {});
  const body = await responseJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.invite_results.length, 1);
  assert.equal(body.invite_results[0].ok, false);
  assert.match(body.invite_results[0].error || "", /suppressed/i);
  assert.equal(resendCallCount, 0);
});

test("meeting invite is suppressed when recipient blocks organizer", async () => {
  const creator = { id: "u-block-creator", email: "creator-block@example.com", name: "Creator" };
  process.env.RESEND_API_KEY = "re_test";
  process.env.AUTH_FROM_EMAIL = "MeetMe <noreply@example.com>";

  await store("email_preferences").setJSON("email:friend@example.com", {
    email: "friend@example.com",
    global_opt_out: false,
    blocked_organizers: ["creator-block@example.com"],
    updated_at: new Date().toISOString(),
  });

  let resendCallCount = 0;
  global.fetch = async (url) => {
    if (String(url).includes("api.resend.com/emails")) {
      resendCallCount += 1;
      return new Response(JSON.stringify({ id: `resend-${Date.now()}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(creator) },
    body: {
      title: "Organizer Block Test",
      description: "Recipient blocked organizer",
      meeting_type: "days_of_week",
      dates_or_days: ["Tuesday"],
      start_time: "09:00",
      end_time: "10:00",
      invite_emails: "friend@example.com",
      timezone: "UTC",
    },
  });
  const res = await meetingsHandler(req, {});
  const body = await responseJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.invite_results.length, 1);
  assert.equal(body.invite_results[0].ok, false);
  assert.match(body.invite_results[0].error || "", /suppressed/i);
  assert.equal(resendCallCount, 0);
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

test("meetings handler delegates action subroutes when availability hits /api/meetings/*", async () => {
  const creator = { id: "u10b", email: "creator10b@example.com", name: "Creator 10B" };
  const invitee = { id: "u11b", email: "friend@example.com", name: "Friend B" };
  const meetingId = await createMeetingAs(creator);

  const availabilityReq = makeJsonRequest(
    `http://localhost:8888/api/meetings/${meetingId}/availability`,
    {
      method: "POST",
      headers: { cookie: authCookie(invitee) },
      body: { slots: ["Monday_09:00"] },
    }
  );

  const availabilityRes = await meetingsHandler(availabilityReq, {});
  const availabilityBody = await responseJson(availabilityRes);

  assert.equal(availabilityRes.status, 200);
  assert.equal(availabilityBody.success, true);

  const availabilityRows = await store("availability").get(`meeting:${meetingId}`, { type: "json" });
  assert.equal(Array.isArray(availabilityRows), true);
  assert.equal(availabilityRows.length, 1);
  assert.equal(availabilityRows[0].user_id, invitee.id);
  assert.equal(availabilityRows[0].date_or_day, "Monday");
  assert.equal(availabilityRows[0].time_slot, "09:00");
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

test("admin users and meetings endpoints support pagination metadata", async () => {
  const token = createToken({ id: "a4", email: "admin@example.com", name: "Admin" });

  await store("users").setJSON("admin@example.com", {
    id: "a4",
    email: "admin@example.com",
    name: "Admin",
    first_name: "Admin",
    last_name: "User",
    profile_complete: true,
    created_at: new Date("2026-03-01T00:00:00Z").toISOString(),
    is_admin: true,
  });
  await store("users").setJSON("one@example.com", {
    id: "u-one",
    email: "one@example.com",
    name: "One Example",
    first_name: "One",
    last_name: "Example",
    profile_complete: true,
    created_at: new Date("2026-03-02T00:00:00Z").toISOString(),
  });
  await store("users").setJSON("two@example.com", {
    id: "u-two",
    email: "two@example.com",
    name: "Two Example",
    first_name: "Two",
    last_name: "Example",
    profile_complete: true,
    created_at: new Date("2026-03-03T00:00:00Z").toISOString(),
  });

  await store("meetings").setJSON("m-page-1", {
    id: "m-page-1",
    title: "Alpha Meeting",
    creator_id: "u-one",
    creator_name: "One Example",
    meeting_type: "days_of_week",
    dates_or_days: ["Monday"],
    start_time: "09:00",
    end_time: "10:00",
    timezone: "UTC",
    is_finalized: false,
    finalized_date: null,
    finalized_slot: null,
    created_at: new Date("2026-03-03T00:00:00Z").toISOString(),
  });
  await store("meetings").setJSON("m-page-2", {
    id: "m-page-2",
    title: "Beta Meeting",
    creator_id: "u-two",
    creator_name: "Two Example",
    meeting_type: "days_of_week",
    dates_or_days: ["Tuesday"],
    start_time: "09:00",
    end_time: "10:00",
    timezone: "UTC",
    is_finalized: false,
    finalized_date: null,
    finalized_slot: null,
    created_at: new Date("2026-03-04T00:00:00Z").toISOString(),
  });
  await store("invites").setJSON("meeting:m-page-1", []);
  await store("invites").setJSON("meeting:m-page-2", []);

  const usersReq = new Request("http://localhost:8888/api/admin/users?page=2&page_size=1", {
    method: "GET",
    headers: { cookie: `token=${token}` },
  });
  const usersRes = await adminHandler(usersReq, { params: { 0: "users" } });
  const usersBody = await responseJson(usersRes);
  assert.equal(usersRes.status, 200);
  assert.equal(usersBody.users.length, 1);
  assert.equal(usersBody.pagination.page, 2);
  assert.equal(usersBody.pagination.page_size, 1);
  assert.equal(usersBody.pagination.total >= 3, true);

  const meetingsReq = new Request(
    "http://localhost:8888/api/admin/meetings?page=1&page_size=1&q=beta",
    {
      method: "GET",
      headers: { cookie: `token=${token}` },
    }
  );
  const meetingsRes = await adminHandler(meetingsReq, { params: { 0: "meetings" } });
  const meetingsBody = await responseJson(meetingsRes);
  assert.equal(meetingsRes.status, 200);
  assert.equal(meetingsBody.meetings.length, 1);
  assert.equal(meetingsBody.meetings[0].title, "Beta Meeting");
  assert.equal(meetingsBody.pagination.total, 1);
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
