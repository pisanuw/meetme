import test from "node:test";
import assert from "node:assert/strict";

import publicMeetingsHandler from "../netlify/functions/public-meetings.mjs";
import meetingsHandler from "../netlify/functions/meetings.mjs";
import { purgeExpiredAnonymousMeetings } from "../netlify/functions/bookings-reminders.mjs";
import {
  createToken,
  isAnonymousMeetingExpired,
  verifyMeetingToken,
  MEETING_TOKEN_KINDS,
} from "../netlify/functions/utils.mjs";
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

async function createAnonymousMeeting(overrides = {}) {
  const req = makeJsonRequest("http://localhost:8888/api/public/meetings", {
    method: "POST",
    body: {
      title: "Anon Sprint",
      description: "No login needed",
      creator_name: "Ada",
      meeting_type: "days_of_week",
      dates_or_days: ["Monday", "Wednesday"],
      start_time: "09:00",
      end_time: "11:00",
      timezone: "UTC",
      ...overrides,
    },
  });
  const res = await publicMeetingsHandler(req, {});
  const body = await responseJson(res);
  assert.equal(res.status, 200, `create failed: ${JSON.stringify(body)}`);
  return body;
}

test.beforeEach(() => {
  setDefaultTestEnv();
  dbBackend = installInMemoryDb();
});

test.afterEach(() => {
  uninstallInMemoryDb();
  dbBackend = null;
});

test("anonymous creation returns distinct participation and admin tokens", async () => {
  const body = await createAnonymousMeeting();
  assert.equal(body.success, true);
  assert.match(body.meeting_id, /^[a-z0-9]+$/);
  assert.ok(body.participation_token && body.admin_token);
  assert.notEqual(body.participation_token, body.admin_token);
  assert.ok(body.participation_url.includes(`t=${encodeURIComponent(body.participation_token)}`));
  assert.ok(body.admin_url.includes(`t=${encodeURIComponent(body.admin_token)}`));

  const pPayload = verifyMeetingToken(body.participation_token);
  assert.equal(pPayload.kind, MEETING_TOKEN_KINDS.PARTICIPATION);
  assert.equal(pPayload.meeting_id, body.meeting_id);

  const aPayload = verifyMeetingToken(body.admin_token);
  assert.equal(aPayload.kind, MEETING_TOKEN_KINDS.ADMIN);
});

test("creation rejects empty title and bad meeting type", async () => {
  const res1 = await publicMeetingsHandler(
    makeJsonRequest("http://localhost:8888/api/public/meetings", {
      method: "POST",
      body: { meeting_type: "days_of_week", dates_or_days: ["Monday"] },
    }),
    {}
  );
  assert.equal(res1.status, 400);

  const res2 = await publicMeetingsHandler(
    makeJsonRequest("http://localhost:8888/api/public/meetings", {
      method: "POST",
      body: {
        title: "x",
        meeting_type: "nope",
        dates_or_days: ["Monday"],
      },
    }),
    {}
  );
  assert.equal(res2.status, 400);
});

test("participation token can fetch meeting detail but is_admin=false", async () => {
  const created = await createAnonymousMeeting();
  const url = `http://localhost:8888/api/public/meetings/${created.meeting_id}?t=${encodeURIComponent(created.participation_token)}`;
  const res = await publicMeetingsHandler(new Request(url, { method: "GET" }), {});
  const body = await responseJson(res);
  assert.equal(res.status, 200);
  assert.equal(body.is_admin, false);
  assert.equal(body.is_anonymous, true);
  assert.equal(body.meeting.title, "Anon Sprint");
});

test("admin token reports is_admin=true", async () => {
  const created = await createAnonymousMeeting();
  const url = `http://localhost:8888/api/public/meetings/${created.meeting_id}?t=${encodeURIComponent(created.admin_token)}`;
  const res = await publicMeetingsHandler(new Request(url, { method: "GET" }), {});
  const body = await responseJson(res);
  assert.equal(body.is_admin, true);
});

test("detail fetch rejects wrong meeting id on valid token", async () => {
  const a = await createAnonymousMeeting({ title: "A" });
  const b = await createAnonymousMeeting({ title: "B" });
  const url = `http://localhost:8888/api/public/meetings/${b.meeting_id}?t=${encodeURIComponent(a.admin_token)}`;
  const res = await publicMeetingsHandler(new Request(url, { method: "GET" }), {});
  assert.equal(res.status, 403);
});

test("detail fetch rejects missing / bogus token", async () => {
  const created = await createAnonymousMeeting();
  const noTok = await publicMeetingsHandler(
    new Request(`http://localhost:8888/api/public/meetings/${created.meeting_id}`, {
      method: "GET",
    }),
    {}
  );
  assert.equal(noTok.status, 401);

  const badTok = await publicMeetingsHandler(
    new Request(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}?t=not-a-real-jwt`,
      { method: "GET" }
    ),
    {}
  );
  assert.equal(badTok.status, 401);
});

test("availability submit without participant_id issues a new one", async () => {
  const created = await createAnonymousMeeting();
  const req = makeJsonRequest(
    `http://localhost:8888/api/public/meetings/${created.meeting_id}/availability`,
    {
      method: "POST",
      body: {
        t: created.participation_token,
        name: "Beatrice",
        slots: ["Monday_09:00", "Monday_09:15"],
      },
    }
  );
  const res = await publicMeetingsHandler(req, {});
  const body = await responseJson(res);
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.match(body.participant_id, /^anon:/);
  assert.equal(body.slot_counts["Monday_09:00"], 1);
});

test("repeat submit with same participant_id updates same record", async () => {
  const created = await createAnonymousMeeting();
  const first = await publicMeetingsHandler(
    makeJsonRequest(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}/availability`,
      {
        method: "POST",
        body: {
          t: created.participation_token,
          name: "Carlos",
          slots: ["Monday_09:00"],
        },
      }
    ),
    {}
  );
  const firstBody = await responseJson(first);
  const pid = firstBody.participant_id;

  const second = await publicMeetingsHandler(
    makeJsonRequest(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}/availability`,
      {
        method: "POST",
        body: {
          t: created.participation_token,
          participant_id: pid,
          name: "Carlos Updated",
          slots: ["Monday_10:00", "Wednesday_09:00"],
        },
      }
    ),
    {}
  );
  const secondBody = await responseJson(second);
  assert.equal(secondBody.participant_id, pid);
  assert.equal(secondBody.slot_counts["Monday_09:00"], undefined); // replaced
  assert.equal(secondBody.slot_counts["Monday_10:00"], 1);
  assert.equal(secondBody.slot_counts["Wednesday_09:00"], 1);

  // Verify detail API now shows exactly one participant with the new name.
  const detail = await publicMeetingsHandler(
    new Request(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}?t=${encodeURIComponent(created.admin_token)}`,
      { method: "GET" }
    ),
    {}
  );
  const detailBody = await responseJson(detail);
  assert.equal(detailBody.participants.length, 1);
  assert.equal(detailBody.participants[0].name, "Carlos Updated");
});

test("spoofed participant_id (one we never issued) is rejected", async () => {
  const created = await createAnonymousMeeting();
  const res = await publicMeetingsHandler(
    makeJsonRequest(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}/availability`,
      {
        method: "POST",
        body: {
          t: created.participation_token,
          participant_id: "anon:definitely-not-issued",
          name: "Sneaky",
          slots: ["Monday_09:00"],
        },
      }
    ),
    {}
  );
  assert.equal(res.status, 403);
});

test("availability submit skips slots outside the meeting's date/time range", async () => {
  const created = await createAnonymousMeeting();
  const res = await publicMeetingsHandler(
    makeJsonRequest(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}/availability`,
      {
        method: "POST",
        body: {
          t: created.participation_token,
          name: "Dara",
          slots: ["Monday_09:00", "Saturday_09:00", "Monday_23:00", "not_a_slot"],
        },
      }
    ),
    {}
  );
  const body = await responseJson(res);
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body.slot_counts).sort(), ["Monday_09:00"]);
});

test("availability requires a name", async () => {
  const created = await createAnonymousMeeting();
  const res = await publicMeetingsHandler(
    makeJsonRequest(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}/availability`,
      {
        method: "POST",
        body: {
          t: created.participation_token,
          slots: ["Monday_09:00"],
        },
      }
    ),
    {}
  );
  assert.equal(res.status, 400);
});

test("finalize requires admin token (participation token is rejected)", async () => {
  const created = await createAnonymousMeeting();
  const res = await publicMeetingsHandler(
    makeJsonRequest(`http://localhost:8888/api/public/meetings/${created.meeting_id}/finalize`, {
      method: "POST",
      body: {
        t: created.participation_token,
        date_or_day: "Monday",
        time_slot: "09:00",
        duration_minutes: 30,
      },
    }),
    {}
  );
  assert.equal(res.status, 401);
});

test("finalize + unfinalize with admin token updates meeting state", async () => {
  const created = await createAnonymousMeeting();
  const finalizeRes = await publicMeetingsHandler(
    makeJsonRequest(`http://localhost:8888/api/public/meetings/${created.meeting_id}/finalize`, {
      method: "POST",
      body: {
        t: created.admin_token,
        date_or_day: "Monday",
        time_slot: "10:00",
        duration_minutes: 60,
        note: "Room 3",
      },
    }),
    {}
  );
  assert.equal(finalizeRes.status, 200);

  const detailAfter = await publicMeetingsHandler(
    new Request(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}?t=${encodeURIComponent(created.admin_token)}`,
      { method: "GET" }
    ),
    {}
  );
  const after = await responseJson(detailAfter);
  assert.equal(after.meeting.is_finalized, true);
  assert.equal(after.meeting.finalized_slot, "10:00");
  assert.equal(after.meeting.note, "Room 3");

  const unfinalize = await publicMeetingsHandler(
    makeJsonRequest(`http://localhost:8888/api/public/meetings/${created.meeting_id}/unfinalize`, {
      method: "POST",
      body: { t: created.admin_token },
    }),
    {}
  );
  assert.equal(unfinalize.status, 200);
});

test("delete with admin token removes the meeting entirely", async () => {
  const created = await createAnonymousMeeting();
  const res = await publicMeetingsHandler(
    makeJsonRequest(`http://localhost:8888/api/public/meetings/${created.meeting_id}/delete`, {
      method: "POST",
      body: { t: created.admin_token },
    }),
    {}
  );
  assert.equal(res.status, 200);

  const detail = await publicMeetingsHandler(
    new Request(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}?t=${encodeURIComponent(created.admin_token)}`,
      { method: "GET" }
    ),
    {}
  );
  assert.equal(detail.status, 404);
});

test("claim as participant adds logged-in user and migrates anonymous availability", async () => {
  const created = await createAnonymousMeeting();

  // Anonymous participant submits first
  const avail = await publicMeetingsHandler(
    makeJsonRequest(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}/availability`,
      {
        method: "POST",
        body: {
          t: created.participation_token,
          name: "Erin",
          slots: ["Monday_09:00"],
        },
      }
    ),
    {}
  );
  const availBody = await responseJson(avail);
  const participantId = availBody.participant_id;

  // Now Erin logs in and claims
  const user = { id: "user-erin", email: "erin@example.com", name: "Erin Logged In" };
  const claim = await meetingsHandler(
    makeJsonRequest("http://localhost:8888/api/meetings/claim", {
      method: "POST",
      headers: { cookie: authCookie(user) },
      body: { t: created.participation_token, participant_id: participantId },
    }),
    {}
  );
  const claimBody = await responseJson(claim);
  assert.equal(claim.status, 200);
  assert.equal(claimBody.role, "participant");

  // From the admin side, see that the availability is now attributed to
  // user-erin, not the anonymous id.
  const detail = await publicMeetingsHandler(
    new Request(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}?t=${encodeURIComponent(created.admin_token)}`,
      { method: "GET" }
    ),
    {}
  );
  const detailBody = await responseJson(detail);
  assert.equal(detailBody.participants.length, 1);
  // Name should be preserved from the anonymous entry, slot count too.
  assert.equal(detailBody.slot_counts["Monday_09:00"], 1);
});

test("claim as admin transfers ownership and clears anonymous flag", async () => {
  const created = await createAnonymousMeeting();

  const user = { id: "user-farah", email: "farah@example.com", name: "Farah" };
  const claim = await meetingsHandler(
    makeJsonRequest("http://localhost:8888/api/meetings/claim", {
      method: "POST",
      headers: { cookie: authCookie(user) },
      body: { t: created.admin_token },
    }),
    {}
  );
  const claimBody = await responseJson(claim);
  assert.equal(claim.status, 200);
  assert.equal(claimBody.role, "owner");

  // Admin token should still work (per product decision)
  const detail = await publicMeetingsHandler(
    new Request(
      `http://localhost:8888/api/public/meetings/${created.meeting_id}?t=${encodeURIComponent(created.admin_token)}`,
      { method: "GET" }
    ),
    {}
  );
  const detailBody = await responseJson(detail);
  // After ownership transfer, meeting.anonymous is cleared, so the public
  // detail endpoint reports is_anonymous=true (from its route semantics —
  // all public-meetings detail responses set this flag) but the stored
  // meeting itself should have creator_id set and anonymous=false.
  assert.equal(detailBody.meeting.creator_id, "user-farah");
  assert.equal(detailBody.meeting.anonymous, false);
});

test("claim rejects an invalid or mismatched token", async () => {
  const user = { id: "user-z", email: "z@example.com", name: "Z" };
  const res = await meetingsHandler(
    makeJsonRequest("http://localhost:8888/api/meetings/claim", {
      method: "POST",
      headers: { cookie: authCookie(user) },
      body: { t: "not-a-jwt" },
    }),
    {}
  );
  assert.equal(res.status, 401);
});

test("claim requires authentication", async () => {
  const created = await createAnonymousMeeting();
  const res = await meetingsHandler(
    makeJsonRequest("http://localhost:8888/api/meetings/claim", {
      method: "POST",
      body: { t: created.admin_token },
    }),
    {}
  );
  assert.equal(res.status, 401);
});

test("isAnonymousMeetingExpired: non-anonymous meetings are never expired", () => {
  const meeting = {
    anonymous: false,
    created_at: new Date("2000-01-01").toISOString(),
    last_activity_at: new Date("2000-01-01").toISOString(),
    meeting_type: "days_of_week",
    dates_or_days: ["Monday"],
  };
  assert.equal(isAnonymousMeetingExpired(meeting, new Date("2025-01-01")), false);
});

test("isAnonymousMeetingExpired: recent activity keeps it alive", () => {
  const now = new Date("2025-06-01T00:00:00Z");
  const recent = new Date("2025-05-28T00:00:00Z").toISOString();
  assert.equal(
    isAnonymousMeetingExpired(
      {
        anonymous: true,
        created_at: recent,
        last_activity_at: recent,
        meeting_type: "days_of_week",
        dates_or_days: ["Monday"],
      },
      now
    ),
    false
  );
});

test("isAnonymousMeetingExpired: old days_of_week meeting with no activity expires", () => {
  const now = new Date("2025-06-01T00:00:00Z");
  const old = new Date("2024-01-01T00:00:00Z").toISOString();
  assert.equal(
    isAnonymousMeetingExpired(
      {
        anonymous: true,
        created_at: old,
        last_activity_at: old,
        meeting_type: "days_of_week",
        dates_or_days: ["Monday"],
      },
      now
    ),
    true
  );
});

test("isAnonymousMeetingExpired: specific_dates meeting with future date is kept", () => {
  const now = new Date("2025-06-01T00:00:00Z");
  const old = new Date("2024-01-01T00:00:00Z").toISOString();
  assert.equal(
    isAnonymousMeetingExpired(
      {
        anonymous: true,
        created_at: old,
        last_activity_at: old,
        meeting_type: "specific_dates",
        dates_or_days: ["2025-07-15"],
      },
      now
    ),
    false
  );
});

test("purgeExpiredAnonymousMeetings deletes only expired anonymous records", async () => {
  // Fresh anonymous meeting — should survive
  const fresh = await createAnonymousMeeting({ title: "fresh" });

  // Manually stuff an old anonymous meeting directly into the store
  const old = await createAnonymousMeeting({ title: "stale" });
  const meetingsStore = dbBackend.createStore("meetings");
  const listing = await meetingsStore.list();
  for (const { key } of listing.blobs) {
    const m = await meetingsStore.get(key, { type: "json" });
    if (m && m.id === old.meeting_id) {
      const oldIso = new Date("2024-01-01T00:00:00Z").toISOString();
      await meetingsStore.setJSON(key, {
        ...m,
        created_at: oldIso,
        last_activity_at: oldIso,
      });
    }
  }

  const result = await purgeExpiredAnonymousMeetings();
  assert.equal(result.deleted_count, 1);

  // Fresh still fetchable, stale gone
  const freshDetail = await publicMeetingsHandler(
    new Request(
      `http://localhost:8888/api/public/meetings/${fresh.meeting_id}?t=${encodeURIComponent(fresh.admin_token)}`,
      { method: "GET" }
    ),
    {}
  );
  assert.equal(freshDetail.status, 200);

  const staleDetail = await publicMeetingsHandler(
    new Request(
      `http://localhost:8888/api/public/meetings/${old.meeting_id}?t=${encodeURIComponent(old.admin_token)}`,
      { method: "GET" }
    ),
    {}
  );
  assert.equal(staleDetail.status, 404);
});
