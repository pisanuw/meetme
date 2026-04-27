import test from "node:test";
import assert from "node:assert/strict";

import meetingsHandler from "../netlify/functions/meetings.mjs";
import { createToken, MEETING_TOKEN_KINDS } from "../netlify/functions/utils.mjs";
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

async function seedUser({ id, email, name, timezone = "UTC" }) {
  await store("users").setJSON(email, {
    id,
    email,
    name,
    timezone,
    created_at: new Date().toISOString(),
  });
}

const ALICE = { id: "user-alice", email: "alice@example.com", name: "Alice" };
const BOB   = { id: "user-bob",   email: "bob@example.com",   name: "Bob"   };

test.beforeEach(() => {
  setDefaultTestEnv();
  dbBackend = installInMemoryDb();
  // Stub fetch so sendEmail calls don't hit the real Resend API
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("api.resend.com")) {
      return new Response(JSON.stringify({ id: `resend-mock-${Date.now()}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
});

test.afterEach(() => {
  uninstallInMemoryDb();
  delete global.fetch;
});

// ─── Authentication ────────────────────────────────────────────────────────

test("unauthenticated request is rejected with 401", async () => {
  const req = makeJsonRequest("http://localhost:8888/api/meetings");
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 401);
  const body = await responseJson(res);
  assert.ok(body.error, "should have error field");
});

// ─── GET /api/meetings — list ──────────────────────────────────────────────

test("list returns empty arrays when no meetings exist", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    headers: { cookie: authCookie(ALICE) },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.deepEqual(body.my_meetings, []);
  assert.deepEqual(body.invited_meetings, []);
});

test("list returns meetings created by the caller in my_meetings", async () => {
  await seedUser(ALICE);
  // Create a meeting first
  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Alice's Meeting",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
    },
  });
  const createRes = await meetingsHandler(createReq, {});
  assert.equal(createRes.status, 200);

  const listReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    headers: { cookie: authCookie(ALICE) },
  });
  const listRes = await meetingsHandler(listReq, {});
  assert.equal(listRes.status, 200);
  const body = await responseJson(listRes);
  assert.equal(body.my_meetings.length, 1);
  assert.equal(body.my_meetings[0].title, "Alice's Meeting");
  assert.deepEqual(body.invited_meetings, []);
});

test("list shows invited meetings for invitee", async () => {
  await seedUser(ALICE);
  await seedUser(BOB);

  // Alice creates meeting and invites Bob
  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Team Sync",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-07-01"],
      invite_emails: [BOB.email],
    },
  });
  await meetingsHandler(createReq, {});

  // Bob lists meetings
  const listReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    headers: { cookie: authCookie(BOB) },
  });
  const listRes = await meetingsHandler(listReq, {});
  assert.equal(listRes.status, 200);
  const body = await responseJson(listRes);
  assert.equal(body.invited_meetings.length, 1);
  assert.equal(body.invited_meetings[0].title, "Team Sync");
  assert.deepEqual(body.my_meetings, []);
});

// ─── POST /api/meetings — create ──────────────────────────────────────────

test("create requires a title", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: { meeting_type: "specific_dates", dates_or_days: ["2025-06-01"] },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.match(body.error, /title/i);
});

test("create rejects invalid meeting_type", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: { title: "Bad type", meeting_type: "random", dates_or_days: ["2025-06-01"] },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.match(body.error, /meeting_type/i);
});

test("create rejects when dates_or_days is empty", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: { title: "No dates", meeting_type: "specific_dates", dates_or_days: [] },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.match(body.error, /date or day/i);
});

test("create rejects malformed date in specific_dates mode", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Bad date",
      meeting_type: "specific_dates",
      dates_or_days: ["June 1"],
    },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.match(body.error, /YYYY-MM-DD/i);
});

test("create rejects invalid day name in days_of_week mode", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Bad day",
      meeting_type: "days_of_week",
      dates_or_days: ["Mon"],  // must be "Monday"
    },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.match(body.error, /day/i);
});

test("create rejects when start_time format is wrong", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Bad time",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
      start_time: "8:00",  // must be 08:00
    },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.match(body.error, /start_time/i);
});

test("create rejects when end_time is before start_time", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Time order",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
      start_time: "17:00",
      end_time: "09:00",
    },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.match(body.error, /end_time/i);
});

test("create rejects invalid timezone", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Bad tz",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
      timezone: "Mars/Olympus",
    },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.match(body.error, /timezone/i);
});

test("create succeeds with minimal valid body", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Simple Meeting",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
    },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.success, true);
  assert.ok(body.meeting_id, "should return a meeting_id");
});

test("create succeeds with days_of_week type", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Weekly Standup",
      meeting_type: "days_of_week",
      dates_or_days: ["Monday", "Wednesday", "Friday"],
      start_time: "09:00",
      end_time: "10:00",
      timezone: "UTC",
    },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.success, true);
  assert.ok(body.meeting_id);
});

test("create with invite_emails adds invitees", async () => {
  await seedUser(ALICE);
  await seedUser(BOB);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "With Guests",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-08-01"],
      invite_emails: [BOB.email],
    },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.ok(Array.isArray(body.invite_results));
  assert.equal(body.invite_results.length, 1);
  assert.equal(body.invite_results[0].email, BOB.email);
});

test("create deduplicates dates_or_days", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Dedup test",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01", "2025-06-01", "2025-06-02"],
    },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 200);
  const createBody = await responseJson(res);

  // Fetch the meeting and verify deduplication
  const getReq = makeJsonRequest(
    `http://localhost:8888/api/meetings/${createBody.meeting_id}`,
    { headers: { cookie: authCookie(ALICE) } }
  );
  const getRes = await meetingsHandler(getReq, {});
  const getBody = await responseJson(getRes);
  assert.equal(getBody.meeting.dates_or_days.length, 2);
});

test("create rejects non-JSON body", async () => {
  await seedUser(ALICE);
  const req = new Request("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: {
      cookie: authCookie(ALICE),
      "Content-Type": "text/plain",
    },
    body: "not json",
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 400);
});

// ─── GET /api/meetings/:id — detail ───────────────────────────────────────

test("get meeting returns 404 for unknown id", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings/no-such-id", {
    headers: { cookie: authCookie(ALICE) },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 404);
});

test("get meeting returns full detail for creator", async () => {
  await seedUser(ALICE);
  // Create meeting
  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Detail test",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-09-01"],
      start_time: "09:00",
      end_time: "11:00",
    },
  });
  const createRes = await meetingsHandler(createReq, {});
  const { meeting_id } = await responseJson(createRes);

  const getReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meeting_id}`, {
    headers: { cookie: authCookie(ALICE) },
  });
  const getRes = await meetingsHandler(getReq, {});
  assert.equal(getRes.status, 200);
  const body = await responseJson(getRes);

  assert.equal(body.meeting.id, meeting_id);
  assert.equal(body.meeting.title, "Detail test");
  assert.equal(body.is_creator, true);
  assert.ok(Array.isArray(body.my_slots));
  assert.ok(typeof body.slot_counts === "object");
  assert.ok(Array.isArray(body.time_slots));
  assert.ok(Array.isArray(body.participants));
  // Creator should see emails in participants
  assert.ok(body.participants.every((p) => "email" in p));
});

test("get meeting hides participant emails from non-creator", async () => {
  await seedUser(ALICE);
  await seedUser(BOB);
  // Alice creates and invites Bob
  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Private",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-10-01"],
      invite_emails: [BOB.email],
    },
  });
  const createRes = await meetingsHandler(createReq, {});
  const { meeting_id } = await responseJson(createRes);

  // Bob fetches meeting detail
  const getReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meeting_id}`, {
    headers: { cookie: authCookie(BOB) },
  });
  const getRes = await meetingsHandler(getReq, {});
  assert.equal(getRes.status, 200);
  const body = await responseJson(getRes);
  assert.equal(body.is_creator, false);
  // Non-creator should not see participant emails
  assert.ok(body.participants.every((p) => !("email" in p)));
});

test("get meeting auto-adds new user via shared link", async () => {
  await seedUser(ALICE);
  await seedUser(BOB);

  // Alice creates meeting without inviting Bob
  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Open Meeting",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-11-01"],
    },
  });
  const createRes = await meetingsHandler(createReq, {});
  const { meeting_id } = await responseJson(createRes);

  // Bob visits via shared link (not invited)
  const getReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meeting_id}`, {
    headers: { cookie: authCookie(BOB) },
  });
  const getRes = await meetingsHandler(getReq, {});
  assert.equal(getRes.status, 200);
  const body = await responseJson(getRes);

  // Bob should now be listed as a participant
  const bobParticipant = body.participants.find((p) => p.name === BOB.name);
  assert.ok(bobParticipant, "Bob should be added as participant");
});

// ─── POST /api/meetings/:id/delete ────────────────────────────────────────

test("delete returns 404 for unknown meeting", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings/no-such/delete", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 404);
});

test("delete is rejected when caller is not the creator", async () => {
  await seedUser(ALICE);
  await seedUser(BOB);

  // Alice creates and invites Bob
  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Delete test",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
      invite_emails: [BOB.email],
    },
  });
  const createRes = await meetingsHandler(createReq, {});
  const { meeting_id } = await responseJson(createRes);

  // Bob tries to delete
  const deleteReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meeting_id}/delete`, {
    method: "POST",
    headers: { cookie: authCookie(BOB) },
  });
  const deleteRes = await meetingsHandler(deleteReq, {});
  assert.equal(deleteRes.status, 403);
  const body = await responseJson(deleteRes);
  assert.match(body.error, /creator/i);
});

test("delete succeeds for creator and removes meeting from list", async () => {
  await seedUser(ALICE);

  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "To be deleted",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
    },
  });
  const createRes = await meetingsHandler(createReq, {});
  const { meeting_id } = await responseJson(createRes);

  // Delete it
  const deleteReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meeting_id}/delete`, {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
  });
  const deleteRes = await meetingsHandler(deleteReq, {});
  assert.equal(deleteRes.status, 200);
  const deleteBody = await responseJson(deleteRes);
  assert.equal(deleteBody.success, true);

  // Verify it's gone
  const getReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meeting_id}`, {
    headers: { cookie: authCookie(ALICE) },
  });
  const getRes = await meetingsHandler(getReq, {});
  assert.equal(getRes.status, 404);
});

// ─── POST /api/meetings/:id/leave ─────────────────────────────────────────

test("leave returns 404 for unknown meeting", async () => {
  await seedUser(BOB);
  const req = makeJsonRequest("http://localhost:8888/api/meetings/no-such/leave", {
    method: "POST",
    headers: { cookie: authCookie(BOB) },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 404);
});

test("creator cannot leave their own meeting", async () => {
  await seedUser(ALICE);

  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Creator leave test",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
    },
  });
  const createRes = await meetingsHandler(createReq, {});
  const { meeting_id } = await responseJson(createRes);

  const leaveReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meeting_id}/leave`, {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
  });
  const leaveRes = await meetingsHandler(leaveReq, {});
  assert.equal(leaveRes.status, 403);
  const body = await responseJson(leaveRes);
  assert.match(body.error, /creator/i);
});

test("non-invitee cannot leave a meeting", async () => {
  await seedUser(ALICE);
  await seedUser(BOB);

  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "No Bob here",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
    },
  });
  const createRes = await meetingsHandler(createReq, {});
  const { meeting_id } = await responseJson(createRes);

  const leaveReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meeting_id}/leave`, {
    method: "POST",
    headers: { cookie: authCookie(BOB) },
  });
  const leaveRes = await meetingsHandler(leaveReq, {});
  assert.equal(leaveRes.status, 403);
});

test("invitee can leave a meeting", async () => {
  await seedUser(ALICE);
  await seedUser(BOB);

  // Alice creates and invites Bob
  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Leaveable",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
      invite_emails: [BOB.email],
    },
  });
  const createRes = await meetingsHandler(createReq, {});
  const { meeting_id } = await responseJson(createRes);

  // Bob leaves
  const leaveReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meeting_id}/leave`, {
    method: "POST",
    headers: { cookie: authCookie(BOB) },
  });
  const leaveRes = await meetingsHandler(leaveReq, {});
  assert.equal(leaveRes.status, 200);
  const leaveBody = await responseJson(leaveRes);
  assert.equal(leaveBody.success, true);

  // Bob is no longer in the meeting
  const getReq = makeJsonRequest(`http://localhost:8888/api/meetings/${meeting_id}`, {
    headers: { cookie: authCookie(ALICE) },
  });
  const getRes = await meetingsHandler(getReq, {});
  const getBody = await responseJson(getRes);
  const bobEntry = getBody.participants.find((p) => p.email === BOB.email);
  assert.equal(bobEntry, undefined, "Bob should no longer be a participant");
});

// ─── POST /api/meetings/claim ──────────────────────────────────────────────

test("claim with invalid token returns 401", async () => {
  await seedUser(BOB);
  const req = makeJsonRequest("http://localhost:8888/api/meetings/claim", {
    method: "POST",
    headers: { cookie: authCookie(BOB) },
    body: { t: "not-a-valid-token" },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 401);
});

test("claim with non-JSON body returns 400", async () => {
  await seedUser(BOB);
  const req = new Request("http://localhost:8888/api/meetings/claim", {
    method: "POST",
    headers: {
      cookie: authCookie(BOB),
      "Content-Type": "text/plain",
    },
    body: "bad",
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 400);
});

test("claim with participation token adds user as participant", async () => {
  await seedUser(ALICE);
  await seedUser(BOB);

  // Alice creates meeting
  const createReq = makeJsonRequest("http://localhost:8888/api/meetings", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
    body: {
      title: "Claim test",
      meeting_type: "specific_dates",
      dates_or_days: ["2025-06-01"],
    },
  });
  const createRes = await meetingsHandler(createReq, {});
  const { meeting_id } = await responseJson(createRes);

  // Generate a participation token for this meeting
  const { createToken: mkToken, MEETING_TOKEN_KINDS: KINDS } = await import(
    "../netlify/functions/utils.mjs"
  );
  const participationToken = mkToken({
    meeting_id,
    kind: KINDS.PARTICIPATION,
  });

  // Bob claims via the participation token
  const claimReq = makeJsonRequest("http://localhost:8888/api/meetings/claim", {
    method: "POST",
    headers: { cookie: authCookie(BOB) },
    body: { t: participationToken },
  });
  const claimRes = await meetingsHandler(claimReq, {});
  assert.equal(claimRes.status, 200);
  const claimBody = await responseJson(claimRes);
  assert.equal(claimBody.success, true);
  assert.equal(claimBody.role, "participant");
  assert.equal(claimBody.meeting_id, meeting_id);
});

// ─── Misc / edge-cases ───────────────────────────────────────────────────

test("unknown route returns 404", async () => {
  await seedUser(ALICE);
  const req = makeJsonRequest("http://localhost:8888/api/meetings/some-id/unknown-action", {
    method: "POST",
    headers: { cookie: authCookie(ALICE) },
  });
  const res = await meetingsHandler(req, {});
  assert.equal(res.status, 404);
});
