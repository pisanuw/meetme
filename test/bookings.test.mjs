import test from "node:test";
import assert from "node:assert/strict";

import bookingsHandler from "../netlify/functions/bookings.mjs";
import authHandler from "../netlify/functions/auth.mjs";
import { createToken } from "../netlify/functions/utils.mjs";
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
    first_name: name.split(" ")[0] || name,
    last_name: name.split(" ").slice(1).join(" "),
    profile_complete: true,
    timezone,
    calendar_connected: false,
    created_at: new Date().toISOString(),
  });
}

test.beforeEach(() => {
  setDefaultTestEnv();
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

test("booking host can create event type and publish slots", async () => {
  const host = { id: "host1", email: "host@example.com", name: "Host Person" };
  await seedUser(host);

  const createEventReq = makeJsonRequest("http://localhost:8888/api/bookings/event-types", {
    method: "POST",
    headers: { cookie: authCookie(host) },
    body: {
      title: "Intro Call",
      description: "30 minute introduction",
      event_type: "one_on_one",
      duration_minutes: 30,
      timezone: "UTC",
    },
  });
  const createEventRes = await bookingsHandler(createEventReq, {});
  const createEventBody = await responseJson(createEventRes);
  assert.equal(createEventRes.status, 200);
  assert.equal(createEventBody.success, true);
  const eventTypeId = createEventBody.event_type.id;

  const setAvailReq = makeJsonRequest("http://localhost:8888/api/bookings/availability", {
    method: "POST",
    headers: { cookie: authCookie(host) },
    body: {
      windows: [
        {
          day_of_week: "Monday",
          start_time: "09:00",
          end_time: "11:00",
          timezone: "UTC",
        },
      ],
    },
  });
  const setAvailRes = await bookingsHandler(setAvailReq, {});
  const setAvailBody = await responseJson(setAvailRes);
  assert.equal(setAvailRes.status, 200);
  assert.equal(setAvailBody.success, true);

  const pageReq = new Request("http://localhost:8888/api/bookings/page/host", { method: "GET" });
  const pageRes = await bookingsHandler(pageReq, {});
  const pageBody = await responseJson(pageRes);
  assert.equal(pageRes.status, 200);
  assert.equal(pageBody.event_types.length, 1);
  assert.equal(pageBody.event_types[0].id, eventTypeId);

  const slotsReq = new Request(
    `http://localhost:8888/api/bookings/page/host/slots?event_type_id=${encodeURIComponent(eventTypeId)}&date=2026-03-30`,
    { method: "GET" }
  );
  const slotsRes = await bookingsHandler(slotsReq, {});
  const slotsBody = await responseJson(slotsRes);
  assert.equal(slotsRes.status, 200);
  assert.equal(Array.isArray(slotsBody.slots), true);
  assert.equal(slotsBody.slots.includes("09:00"), true);
});

test("authenticated user can book slot and host can view it", async () => {
  const host = { id: "host2", email: "host2@example.com", name: "Host Two" };
  const guest = { id: "guest2", email: "guest2@example.com", name: "Guest Two" };
  await seedUser(host);
  await seedUser(guest);

  const createEventReq = makeJsonRequest("http://localhost:8888/api/bookings/event-types", {
    method: "POST",
    headers: { cookie: authCookie(host) },
    body: {
      title: "Group Office Hours",
      description: "Ask me anything",
      event_type: "group",
      duration_minutes: 30,
      timezone: "UTC",
      group_capacity: 2,
    },
  });
  const createEventBody = await responseJson(await bookingsHandler(createEventReq, {}));
  const eventTypeId = createEventBody.event_type.id;

  await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/availability", {
      method: "POST",
      headers: { cookie: authCookie(host) },
      body: {
        windows: [
          { day_of_week: "Monday", start_time: "09:00", end_time: "11:00", timezone: "UTC" },
        ],
      },
    }),
    {}
  );

  const bookReq = makeJsonRequest("http://localhost:8888/api/bookings/page/host2/book", {
    method: "POST",
    headers: { cookie: authCookie(guest) },
    body: {
      event_type_id: eventTypeId,
      date: "2026-03-30",
      start_time: "09:00",
    },
  });
  const bookRes = await bookingsHandler(bookReq, {});
  const bookBody = await responseJson(bookRes);
  assert.equal(bookRes.status, 200);
  assert.equal(bookBody.success, true);

  const hostListReq = new Request("http://localhost:8888/api/bookings/host", {
    method: "GET",
    headers: { cookie: authCookie(host) },
  });
  const hostListRes = await bookingsHandler(hostListReq, {});
  const hostListBody = await responseJson(hostListRes);
  assert.equal(hostListRes.status, 200);
  assert.equal(hostListBody.bookings.length, 1);
  assert.equal(hostListBody.bookings[0].attendee_email, guest.email);
});

test("host or attendee can cancel booking but unrelated user cannot", async () => {
  const host = { id: "host3", email: "host3@example.com", name: "Host Three" };
  const guest = { id: "guest3", email: "guest3@example.com", name: "Guest Three" };
  const other = { id: "other3", email: "other3@example.com", name: "Other Three" };
  await seedUser(host);
  await seedUser(guest);
  await seedUser(other);

  const createEventReq = makeJsonRequest("http://localhost:8888/api/bookings/event-types", {
    method: "POST",
    headers: { cookie: authCookie(host) },
    body: {
      title: "Demo",
      event_type: "one_on_one",
      duration_minutes: 30,
      timezone: "UTC",
    },
  });
  const createEventBody = await responseJson(await bookingsHandler(createEventReq, {}));
  const eventTypeId = createEventBody.event_type.id;

  await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/availability", {
      method: "POST",
      headers: { cookie: authCookie(host) },
      body: {
        windows: [
          { day_of_week: "Monday", start_time: "09:00", end_time: "10:00", timezone: "UTC" },
        ],
      },
    }),
    {}
  );

  const bookRes = await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/page/host3/book", {
      method: "POST",
      headers: { cookie: authCookie(guest) },
      body: {
        event_type_id: eventTypeId,
        date: "2026-03-30",
        start_time: "09:00",
      },
    }),
    {}
  );
  const bookBody = await responseJson(bookRes);
  const bookingId = bookBody.booking.id;

  const deniedCancelRes = await bookingsHandler(
    makeJsonRequest(`http://localhost:8888/api/bookings/${bookingId}/cancel`, {
      method: "POST",
      headers: { cookie: authCookie(other) },
      body: {},
    }),
    {}
  );
  assert.equal(deniedCancelRes.status, 403);

  const allowedCancelRes = await bookingsHandler(
    makeJsonRequest(`http://localhost:8888/api/bookings/${bookingId}/cancel`, {
      method: "POST",
      headers: { cookie: authCookie(guest) },
      body: {},
    }),
    {}
  );
  const allowedCancelBody = await responseJson(allowedCancelRes);
  assert.equal(allowedCancelRes.status, 200);
  assert.equal(allowedCancelBody.booking.status, "cancelled");

  const hostListReq = new Request("http://localhost:8888/api/bookings/host", {
    method: "GET",
    headers: { cookie: authCookie(host) },
  });
  const hostListBody = await responseJson(await bookingsHandler(hostListReq, {}));
  assert.equal(hostListBody.bookings.length, 1);
  assert.equal(hostListBody.bookings[0].status, "cancelled");
});

test("booking endpoint requires authentication", async () => {
  const host = { id: "host4", email: "host4@example.com", name: "Host Four" };
  await seedUser(host);

  // verify unauthenticated protection at booking endpoint
  const unauthBookReq = makeJsonRequest("http://localhost:8888/api/bookings/page/host4/book", {
    method: "POST",
    body: {
      event_type_id: "x",
      date: "2026-03-30",
      start_time: "09:00",
    },
  });
  const unauthBookRes = await bookingsHandler(unauthBookReq, {});
  assert.equal(unauthBookRes.status, 401);

  // sanity check existing auth route still behaves as expected in this file context
  const meRes = await authHandler(
    new Request("http://localhost:8888/api/auth/me", { method: "GET" }),
    {
      params: { 0: "me" },
    }
  );
  assert.equal(meRes.status, 401);
});

test("booking detail endpoint allows host/attendee and denies unrelated user", async () => {
  const host = { id: "host5", email: "host5@example.com", name: "Host Five" };
  const guest = { id: "guest5", email: "guest5@example.com", name: "Guest Five" };
  const other = { id: "other5", email: "other5@example.com", name: "Other Five" };
  await seedUser(host);
  await seedUser(guest);
  await seedUser(other);

  const createEventReq = makeJsonRequest("http://localhost:8888/api/bookings/event-types", {
    method: "POST",
    headers: { cookie: authCookie(host) },
    body: {
      title: "Detail Demo",
      event_type: "one_on_one",
      duration_minutes: 30,
      timezone: "UTC",
    },
  });
  const createEventBody = await responseJson(await bookingsHandler(createEventReq, {}));
  const eventTypeId = createEventBody.event_type.id;

  await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/availability", {
      method: "POST",
      headers: { cookie: authCookie(host) },
      body: {
        windows: [
          { day_of_week: "Monday", start_time: "09:00", end_time: "10:00", timezone: "UTC" },
        ],
      },
    }),
    {}
  );

  const bookRes = await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/page/host5/book", {
      method: "POST",
      headers: { cookie: authCookie(guest) },
      body: {
        event_type_id: eventTypeId,
        date: "2026-03-30",
        start_time: "09:00",
      },
    }),
    {}
  );
  const bookBody = await responseJson(bookRes);
  assert.equal(bookRes.status, 200);
  const bookingId = bookBody.booking.id;

  const hostDetailRes = await bookingsHandler(
    makeJsonRequest(`http://localhost:8888/api/bookings/${bookingId}`, {
      method: "GET",
      headers: { cookie: authCookie(host) },
    }),
    {}
  );
  assert.equal(hostDetailRes.status, 200);

  const guestDetailRes = await bookingsHandler(
    makeJsonRequest(`http://localhost:8888/api/bookings/${bookingId}`, {
      method: "GET",
      headers: { cookie: authCookie(guest) },
    }),
    {}
  );
  assert.equal(guestDetailRes.status, 200);

  const otherDetailRes = await bookingsHandler(
    makeJsonRequest(`http://localhost:8888/api/bookings/${bookingId}`, {
      method: "GET",
      headers: { cookie: authCookie(other) },
    }),
    {}
  );
  assert.equal(otherDetailRes.status, 403);
});

test("reminder sending is host-only and idempotent", async () => {
  const host = { id: "host6", email: "host6@example.com", name: "Host Six" };
  const guest = { id: "guest6", email: "guest6@example.com", name: "Guest Six" };
  await seedUser(host);
  await seedUser(guest);

  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.AUTH_FROM_EMAIL = "MeetMe <noreply@example.com>";

  const bookingId = "booking-reminder-1";
  const startsAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 75 * 60 * 1000).toISOString();

  await store("bookings").setJSON(`booking:${bookingId}`, {
    id: bookingId,
    status: "confirmed",
    event_type_id: "evt-reminder",
    event_title: "Reminder Event",
    event_kind: "one_on_one",
    host_user_id: host.id,
    host_email: host.email,
    host_name: host.name,
    attendee_user_id: guest.id,
    attendee_email: guest.email,
    attendee_name: guest.name,
    date: "2099-01-01",
    start_time: "09:00",
    end_time: "09:30",
    timezone: "UTC",
    starts_at_utc: startsAt,
    ends_at_utc: endsAt,
    created_at: new Date().toISOString(),
    cancelled_at: null,
    cancelled_by: null,
  });
  await store("bookings").setJSON(`host:${host.id}`, [bookingId]);
  await store("bookings").setJSON(`attendee:${guest.id}`, [bookingId]);

  const unauthorizedRes = await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/reminders/send", {
      method: "POST",
      headers: { cookie: authCookie(guest) },
      body: { within_hours: 2 },
    }),
    {}
  );
  const unauthorizedBody = await responseJson(unauthorizedRes);
  assert.equal(unauthorizedRes.status, 200);
  assert.equal(unauthorizedBody.sent_count, 0);
  assert.equal(unauthorizedBody.failed_count, 0);

  const firstSendRes = await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/reminders/send", {
      method: "POST",
      headers: { cookie: authCookie(host) },
      body: { within_hours: 2 },
    }),
    {}
  );
  const firstSendBody = await responseJson(firstSendRes);
  assert.equal(firstSendRes.status, 200);
  assert.equal(firstSendBody.sent_count, 1);
  assert.equal(firstSendBody.failed_count, 0);

  const secondSendRes = await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/reminders/send", {
      method: "POST",
      headers: { cookie: authCookie(host) },
      body: { within_hours: 2 },
    }),
    {}
  );
  const secondSendBody = await responseJson(secondSendRes);
  assert.equal(secondSendRes.status, 200);
  assert.equal(secondSendBody.sent_count, 0);
  assert.equal(secondSendBody.failed_count, 0);
});

test("admin can run scheduler reminders in allowed environments", async () => {
  const host = { id: "host7", email: "host7@example.com", name: "Host Seven" };
  const guest = { id: "guest7", email: "guest7@example.com", name: "Guest Seven" };
  const admin = { id: "admin7", email: "admin@example.com", name: "Admin Seven" };
  const nonAdmin = { id: "nonadmin7", email: "nonadmin@example.com", name: "Non Admin" };

  await seedUser(host);
  await seedUser(guest);
  await seedUser(admin);
  await seedUser(nonAdmin);

  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.AUTH_FROM_EMAIL = "MeetMe <noreply@example.com>";

  const bookingId = "booking-run-now-1";
  const startsAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 75 * 60 * 1000).toISOString();

  await store("bookings").setJSON(`booking:${bookingId}`, {
    id: bookingId,
    status: "confirmed",
    event_type_id: "evt-run-now",
    event_title: "Run Now Event",
    event_kind: "one_on_one",
    host_user_id: host.id,
    host_email: host.email,
    host_name: host.name,
    attendee_user_id: guest.id,
    attendee_email: guest.email,
    attendee_name: guest.name,
    date: "2099-01-01",
    start_time: "09:00",
    end_time: "09:30",
    timezone: "UTC",
    starts_at_utc: startsAt,
    ends_at_utc: endsAt,
    created_at: new Date().toISOString(),
    cancelled_at: null,
    cancelled_by: null,
  });
  await store("bookings").setJSON(`host:${host.id}`, [bookingId]);

  delete process.env.NETLIFY_DEV;
  delete process.env.ALLOW_BOOKING_REMINDER_RUN_NOW;

  const nonAdminForbidden = await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/reminders/run-now", {
      method: "POST",
      headers: { cookie: authCookie(nonAdmin) },
      body: {},
    }),
    {}
  );
  assert.equal(nonAdminForbidden.status, 403);

  const envForbidden = await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/reminders/run-now", {
      method: "POST",
      headers: { cookie: authCookie(admin) },
      body: {},
    }),
    {}
  );
  assert.equal(envForbidden.status, 403);

  process.env.ALLOW_BOOKING_REMINDER_RUN_NOW = "true";
  const allowedRun = await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/reminders/run-now", {
      method: "POST",
      headers: { cookie: authCookie(admin) },
      body: {},
    }),
    {}
  );
  const allowedBody = await responseJson(allowedRun);
  assert.equal(allowedRun.status, 200);
  assert.equal(allowedBody.host_count, 1);
  assert.equal(allowedBody.sent_count, 1);
});
