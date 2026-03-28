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
      event_type_id: eventTypeId,
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
  assert.equal(pageBody.event_types[0].availability.start_date, "");

  const slugIndex = await store("users").get("booking_public_slug:host", { type: "json" });
  assert.equal(slugIndex.email, "host@example.com");

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

test("legacy booking slug lookup backfills slug index on first access", async () => {
  await store("users").setJSON("legacy@example.com", {
    id: "legacy-user",
    email: "legacy@example.com",
    name: "Legacy User",
    first_name: "Legacy",
    last_name: "User",
    profile_complete: true,
    timezone: "UTC",
    calendar_connected: false,
    created_at: new Date().toISOString(),
  });

  const pageReq = new Request("http://localhost:8888/api/bookings/page/legacy", { method: "GET" });
  const pageRes = await bookingsHandler(pageReq, {});
  const pageBody = await responseJson(pageRes);
  assert.equal(pageRes.status, 200);
  assert.equal(pageBody.owner.email, "legacy@example.com");

  const slugIndex = await store("users").get("booking_public_slug:legacy", { type: "json" });
  assert.equal(slugIndex.email, "legacy@example.com");
});

test("availability cannot be saved before creating an event type", async () => {
  const host = { id: "host-no-event", email: "host-no-event@example.com", name: "Host No Event" };
  await seedUser(host);

  const setAvailReq = makeJsonRequest("http://localhost:8888/api/bookings/availability", {
    method: "POST",
    headers: { cookie: authCookie(host) },
    body: {
      event_type_id: "missing-event-type",
      mode: "weekly",
      start_date: "2026-03-01",
      end_date: "2026-03-31",
      windows: [{ day_of_week: "Monday", start_time: "09:00", end_time: "10:00", timezone: "UTC" }],
    },
  });

  const setAvailRes = await bookingsHandler(setAvailReq, {});
  const setAvailBody = await responseJson(setAvailRes);
  assert.equal(setAvailRes.status, 400);
  assert.match(setAvailBody.error, /Create at least one event type/i);
});

test("specific-dates availability mode only returns slots on configured dates", async () => {
  const host = { id: "host-specific", email: "host-specific@example.com", name: "Host Specific" };
  await seedUser(host);

  const createEventReq = makeJsonRequest("http://localhost:8888/api/bookings/event-types", {
    method: "POST",
    headers: { cookie: authCookie(host) },
    body: {
      title: "Specific Date Consult",
      description: "Only some dates",
      event_type: "one_on_one",
      duration_minutes: 30,
      timezone: "UTC",
    },
  });
  const createEventRes = await bookingsHandler(createEventReq, {});
  const createEventBody = await responseJson(createEventRes);
  assert.equal(createEventRes.status, 200);
  const eventTypeId = createEventBody.event_type.id;

  const setAvailReq = makeJsonRequest("http://localhost:8888/api/bookings/availability", {
    method: "POST",
    headers: { cookie: authCookie(host) },
    body: {
      event_type_id: eventTypeId,
      mode: "specific_dates",
      start_date: "2026-03-01",
      end_date: "2026-03-31",
      windows: [
        { date: "2026-03-18", start_time: "09:00", end_time: "10:00", timezone: "UTC" },
      ],
    },
  });
  const setAvailRes = await bookingsHandler(setAvailReq, {});
  assert.equal(setAvailRes.status, 200);

  const matchingDateReq = new Request(
    `http://localhost:8888/api/bookings/page/host-specific/slots?event_type_id=${encodeURIComponent(eventTypeId)}&date=2026-03-18`,
    { method: "GET" }
  );
  const matchingDateRes = await bookingsHandler(matchingDateReq, {});
  const matchingDateBody = await responseJson(matchingDateRes);
  assert.equal(matchingDateRes.status, 200);
  assert.equal(matchingDateBody.slots.includes("09:00"), true);

  const otherDateReq = new Request(
    `http://localhost:8888/api/bookings/page/host-specific/slots?event_type_id=${encodeURIComponent(eventTypeId)}&date=2026-03-19`,
    { method: "GET" }
  );
  const otherDateRes = await bookingsHandler(otherDateReq, {});
  const otherDateBody = await responseJson(otherDateRes);
  assert.equal(otherDateRes.status, 200);
  assert.equal(otherDateBody.slots.length, 0);
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
        event_type_id: eventTypeId,
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
        event_type_id: eventTypeId,
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
  const meRes = await authHandler(new Request("http://localhost:8888/api/auth/me", { method: "GET" }), {
    params: { 0: "me" },
  });
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
        event_type_id: eventTypeId,
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

test("different event types can expose different availability schedules", async () => {
  const host = { id: "host-per-event", email: "host-per-event@example.com", name: "Host Per Event" };
  await seedUser(host);

  const officeHoursBody = await responseJson(
    await bookingsHandler(
      makeJsonRequest("http://localhost:8888/api/bookings/event-types", {
        method: "POST",
        headers: { cookie: authCookie(host) },
        body: {
          title: "Office Hours",
          event_type: "one_on_one",
          duration_minutes: 30,
          timezone: "UTC",
        },
      }),
      {}
    )
  );
  const socializingBody = await responseJson(
    await bookingsHandler(
      makeJsonRequest("http://localhost:8888/api/bookings/event-types", {
        method: "POST",
        headers: { cookie: authCookie(host) },
        body: {
          title: "Socializing",
          event_type: "one_on_one",
          duration_minutes: 30,
          timezone: "UTC",
        },
      }),
      {}
    )
  );

  const officeHoursId = officeHoursBody.event_type.id;
  const socializingId = socializingBody.event_type.id;

  const officeAvailRes = await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/availability", {
      method: "POST",
      headers: { cookie: authCookie(host) },
      body: {
        event_type_id: officeHoursId,
        mode: "weekly",
        start_date: "2026-03-01",
        end_date: "2026-03-31",
        windows: [{ day_of_week: "Monday", start_time: "09:00", end_time: "11:00", timezone: "UTC" }],
      },
    }),
    {}
  );
  assert.equal(officeAvailRes.status, 200);

  const socialAvailRes = await bookingsHandler(
    makeJsonRequest("http://localhost:8888/api/bookings/availability", {
      method: "POST",
      headers: { cookie: authCookie(host) },
      body: {
        event_type_id: socializingId,
        mode: "weekly",
        start_date: "2026-03-01",
        end_date: "2026-03-31",
        windows: [{ day_of_week: "Monday", start_time: "14:00", end_time: "17:00", timezone: "UTC" }],
      },
    }),
    {}
  );
  assert.equal(socialAvailRes.status, 200);

  const officeSlotsRes = await bookingsHandler(
    new Request(
      `http://localhost:8888/api/bookings/page/host-per-event/slots?event_type_id=${encodeURIComponent(officeHoursId)}&date=2026-03-30`,
      { method: "GET" }
    ),
    {}
  );
  const officeSlotsBody = await responseJson(officeSlotsRes);
  assert.equal(officeSlotsRes.status, 200);
  assert.equal(officeSlotsBody.slots.includes("09:00"), true);
  assert.equal(officeSlotsBody.slots.includes("14:00"), false);

  const socialSlotsRes = await bookingsHandler(
    new Request(
      `http://localhost:8888/api/bookings/page/host-per-event/slots?event_type_id=${encodeURIComponent(socializingId)}&date=2026-03-30`,
      { method: "GET" }
    ),
    {}
  );
  const socialSlotsBody = await responseJson(socialSlotsRes);
  assert.equal(socialSlotsRes.status, 200);
  assert.equal(socialSlotsBody.slots.includes("14:00"), true);
  assert.equal(socialSlotsBody.slots.includes("09:00"), false);

  const pageBody = await responseJson(
    await bookingsHandler(new Request("http://localhost:8888/api/bookings/page/host-per-event", { method: "GET" }), {})
  );
  const officePublic = pageBody.event_types.find((item) => item.id === officeHoursId);
  const socialPublic = pageBody.event_types.find((item) => item.id === socializingId);
  assert.equal(officePublic.availability.start_date, "2026-03-01");
  assert.equal(socialPublic.availability.end_date, "2026-03-31");
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
