import test from "node:test";
import assert from "node:assert/strict";

import remindersHandler from "../netlify/functions/bookings-reminders.mjs";
import { installInMemoryDb, uninstallInMemoryDb, setDefaultTestEnv, responseJson } from "./test-helpers.mjs";

let dbBackend;

test.beforeEach(() => {
  setDefaultTestEnv();
  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.AUTH_FROM_EMAIL = "MeetMe <noreply@example.com>";
  dbBackend = installInMemoryDb();
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      return new Response(JSON.stringify({ id: `resend-${Date.now()}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
});

test.afterEach(() => {
  uninstallInMemoryDb();
  delete global.fetch;
});

function store(name) {
  return dbBackend.createStore(name);
}

test("scheduled reminders process host keys and remain idempotent", async () => {
  const hostId = "scheduled-host-1";
  const bookingId = "scheduled-booking-1";
  const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();

  await store("bookings").setJSON(`host:${hostId}`, [bookingId]);
  await store("bookings").setJSON(`booking:${bookingId}`, {
    id: bookingId,
    status: "confirmed",
    event_title: "Scheduled Reminder Event",
    host_user_id: hostId,
    host_email: "host@example.com",
    host_name: "Host",
    attendee_user_id: "attendee-1",
    attendee_email: "attendee@example.com",
    attendee_name: "Attendee",
    date: "2099-01-01",
    start_time: "09:00",
    end_time: "09:30",
    timezone: "UTC",
    starts_at_utc: startsAt,
    ends_at_utc: endsAt,
    created_at: new Date().toISOString(),
  });

  const first = await remindersHandler(new Request("http://localhost:8888/api/bookings/reminders/run"), {
    cron: "0 * * * *",
  });
  const firstBody = await responseJson(first);
  assert.equal(first.status, 200);
  assert.equal(firstBody.host_count, 1);
  assert.equal(firstBody.sent_count, 1);
  assert.equal(firstBody.failed_count, 0);

  const second = await remindersHandler(new Request("http://localhost:8888/api/bookings/reminders/run"), {
    cron: "0 * * * *",
  });
  const secondBody = await responseJson(second);
  assert.equal(second.status, 200);
  assert.equal(secondBody.sent_count, 0);
  assert.equal(secondBody.failed_count, 0);
});
