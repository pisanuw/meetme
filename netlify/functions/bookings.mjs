/**
 * bookings.mjs — One-on-one and group booking endpoints
 *
 * Routes handled:
 *   GET  /api/bookings/event-types                    — list my event types
 *   POST /api/bookings/event-types                    — create/update an event type
 *   POST /api/bookings/event-types/:id/delete         — delete an event type
 *   GET  /api/bookings/availability                   — list my weekly availability windows
 *   POST /api/bookings/availability                   — replace my weekly availability windows
 *   GET  /api/bookings/page/:ownerSlug               — public page metadata (event type list)
 *   GET  /api/bookings/page/:ownerSlug/slots         — public slots for one event type and date
 *   POST /api/bookings/page/:ownerSlug/book          — create booking (authenticated user)
 *   GET  /api/bookings/host                           — list bookings where I am host
 *   GET  /api/bookings/mine                           — list bookings where I am attendee
 *   GET  /api/bookings/:id                            — fetch one booking if caller is host/attendee
 *   POST /api/bookings/:id/cancel                     — cancel as host or attendee
 *   POST /api/bookings/reminders/send                 — send upcoming booking reminders (host-owned)
 */
import {
  getDb,
  getEnv,
  getUserFromRequest,
  isAdmin,
  jsonResponse,
  errorResponse,
  log,
  logRequest,
  safeJson,
  generateId,
  asArray,
  validateEmail,
  sanitizeUser,
  decryptSecret,
  encryptSecret,
  sendEmail,
  persistEvent,
  escapeHtml,
  localToUTC,
  saveUserRecord,
  findUserByBookingPublicSlug,
  LIMITS,
} from "./utils.mjs";

const FN = "bookings";
const SLOT_STEP_MINUTES = 15;
const DEFAULT_REMINDER_WINDOW_HOURS = 24;
const ALLOWED_AVAILABILITY_MODES = new Set(["weekly", "specific_dates"]);

const ALLOWED_WEEKDAYS = new Set([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

const ALLOWED_EVENT_TYPES = new Set(["one_on_one", "group"]);

export default async (req, context) => {
  try {
    return await handleBookings(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, "Internal server error.");
  }
};

function toMinutes(timeStr) {
  const [h, m] = String(timeStr || "").split(":").map(Number);
  return h * 60 + m;
}

function isValidTime(timeStr) {
  return /^\d{2}:\d{2}$/.test(String(timeStr || ""));
}

function isValidDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""));
}

function isDateInRange(dateStr, startDate, endDate) {
  if (!startDate || !endDate) return true;
  return dateStr >= startDate && dateStr <= endDate;
}

function slugify(value) {
  const base = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "user";
}

function getWeekdayForDate(dateStr, timezone) {
  const utcNoon = new Date(`${dateStr}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: timezone || "UTC",
  }).format(utcNoon);
}

function eventTypePublicView(eventType) {
  return {
    id: eventType.id,
    title: eventType.title,
    description: eventType.description,
    event_type: eventType.event_type,
    duration_minutes: eventType.duration_minutes,
    day_start_time: eventType.day_start_time || "08:00",
    day_end_time: eventType.day_end_time || "20:00",
    group_capacity: eventType.group_capacity,
    timezone: eventType.timezone,
  };
}

function getAvailabilityKey(ownerId, eventTypeId) {
  return `owner:${ownerId}:event_type:${eventTypeId}`;
}

async function ensureUserPublicSlug(usersDb, user) {
  const dbUser = await usersDb.get(user.email, { type: "json" }).catch(() => null);
  if (!dbUser) return null;
  return saveUserRecord(usersDb, dbUser);
}

async function refreshGoogleAccessToken(dbUser) {
  const refreshToken = decryptSecret(dbUser.google_refresh_token);
  if (!refreshToken) return null;

  const clientId = getEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getEnv("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      access_token: data.access_token,
      expiry: Date.now() + (data.expires_in || 3600) * 1000,
    };
  } catch {
    return null;
  }
}

async function fetchBusyPeriodsForDate(usersDb, hostUser, timezone, dateStr, startTime, endTime) {
  const dbUser = await usersDb.get(hostUser.email, { type: "json" }).catch(() => null);
  if (!dbUser || !dbUser.calendar_connected) return [];

  let accessToken = decryptSecret(dbUser.google_access_token);
  if (!accessToken) return [];

  if ((dbUser.google_token_expiry || 0) < Date.now() + 60_000) {
    const refreshed = await refreshGoogleAccessToken(dbUser);
    if (!refreshed) return [];
    accessToken = refreshed.access_token;
    dbUser.google_access_token = encryptSecret(accessToken);
    dbUser.google_token_expiry = refreshed.expiry;
    await saveUserRecord(usersDb, dbUser);
  }

  const timeMin = localToUTC(dateStr, startTime, timezone).toISOString();
  const timeMax = localToUTC(dateStr, endTime, timezone).toISOString();

  try {
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        timeMin,
        timeMax,
        items: [{ id: "primary" }],
      }),
    });
    if (!res.ok) return [];
    const payload = await res.json().catch(() => ({}));
    return asArray(payload?.calendars?.primary?.busy)
      .map((item) => ({
        start: new Date(item.start).getTime(),
        end: new Date(item.end).getTime(),
      }))
      .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end));
  } catch {
    return [];
  }
}

function normalizeAvailabilityConfig(raw, fallbackTimezone = "UTC") {
  if (Array.isArray(raw)) {
    return {
      mode: "weekly",
      start_date: "",
      end_date: "",
      timezone: fallbackTimezone,
      windows: raw,
    };
  }

  const mode = String(raw?.mode || "weekly").trim();
  const normalizedMode = ALLOWED_AVAILABILITY_MODES.has(mode) ? mode : "weekly";

  return {
    mode: normalizedMode,
    start_date: String(raw?.start_date || "").trim(),
    end_date: String(raw?.end_date || "").trim(),
    timezone: String(raw?.timezone || fallbackTimezone).trim() || fallbackTimezone,
    windows: asArray(raw?.windows),
  };
}

async function loadAvailabilityConfig(availabilityDb, ownerId, eventTypeId, fallbackTimezone = "UTC") {
  if (!eventTypeId) {
    return normalizeAvailabilityConfig([], fallbackTimezone);
  }

  const specific = await availabilityDb
    .get(getAvailabilityKey(ownerId, eventTypeId), { type: "json" })
    .catch(() => null);
  if (specific) return normalizeAvailabilityConfig(specific, fallbackTimezone);

  const legacy = await availabilityDb.get(`owner:${ownerId}`, { type: "json" }).catch(() => null);
  return normalizeAvailabilityConfig(legacy || [], fallbackTimezone);
}

function buildSlotCandidates(eventType, availabilityConfig, dateStr) {
  const config = normalizeAvailabilityConfig(availabilityConfig, eventType.timezone || "UTC");
  if (!isDateInRange(dateStr, config.start_date, config.end_date)) return [];

  const eventTz = eventType.timezone || "UTC";
  let dayWindows = [];

  if (config.mode === "specific_dates") {
    dayWindows = config.windows.filter((w) => String(w.date || "").trim() === dateStr);
  } else {
    const dayName = getWeekdayForDate(dateStr, eventTz);
    dayWindows = config.windows.filter((w) => w.day_of_week === dayName);
  }

  const slots = [];
  for (const window of dayWindows) {
    const startMinutes = toMinutes(window.start_time);
    const endMinutes = toMinutes(window.end_time);
    for (
      let cur = startMinutes;
      cur + eventType.duration_minutes <= endMinutes;
      cur += SLOT_STEP_MINUTES
    ) {
      const hh = String(Math.floor(cur / 60)).padStart(2, "0");
      const mm = String(cur % 60).padStart(2, "0");
      slots.push(`${hh}:${mm}`);
    }
  }

  return [...new Set(slots)].sort();
}

async function listEventTypesForOwner(eventTypesDb, ownerId) {
  const ids = asArray(await eventTypesDb.get(`owner:${ownerId}`, { type: "json" }).catch(() => []));
  const results = [];
  for (const id of ids) {
    const eventType = await eventTypesDb.get(`event_type:${id}`, { type: "json" }).catch(() => null);
    if (eventType) results.push(eventType);
  }
  return results;
}

async function buildSlotsResponse({ eventType, dateStr, availabilityConfig, bookingsDb, usersDb, hostUser }) {
  const candidates = buildSlotCandidates(eventType, availabilityConfig, dateStr);
  if (candidates.length === 0) return { slots: [], blocked_by_calendar: [] };

  const firstStart = candidates[0];
  const lastStart = candidates[candidates.length - 1];
  const endMin = toMinutes(lastStart) + eventType.duration_minutes;
  const lastEnd = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;

  const busyPeriods = await fetchBusyPeriodsForDate(
    usersDb,
    hostUser,
    eventType.timezone || "UTC",
    dateStr,
    firstStart,
    lastEnd
  );

  const available = [];
  const blockedByCalendar = [];

  for (const slot of candidates) {
    const slotKey = `slot:${eventType.id}:${dateStr}:${slot}`;
    const slotBookingIds = asArray(await bookingsDb.get(slotKey, { type: "json" }).catch(() => []));

    let confirmedCount = 0;
    for (const bookingId of slotBookingIds) {
      const booking = await bookingsDb.get(`booking:${bookingId}`, { type: "json" }).catch(() => null);
      if (booking?.status === "confirmed") confirmedCount += 1;
    }
    if (confirmedCount >= (eventType.group_capacity || 1)) continue;

    const slotStartMs = localToUTC(dateStr, slot, eventType.timezone || "UTC").getTime();
    const slotEndMs = slotStartMs + eventType.duration_minutes * 60 * 1000;
    const overlapsBusy = busyPeriods.some((p) => slotStartMs < p.end && slotEndMs > p.start);

    if (overlapsBusy) {
      blockedByCalendar.push(slot);
      continue;
    }
    available.push(slot);
  }

  return { slots: available, blocked_by_calendar: blockedByCalendar };
}

async function buildPublicEventTypes(eventTypes, availabilityDb, ownerId) {
  const items = [];
  for (const eventType of eventTypes) {
    const availability = await loadAvailabilityConfig(
      availabilityDb,
      ownerId,
      eventType.id,
      eventType.timezone || "UTC"
    );
    items.push({
      ...eventTypePublicView(eventType),
      availability: {
        mode: availability.mode,
        start_date: availability.start_date,
        end_date: availability.end_date,
        window_count: availability.windows.length,
      },
    });
  }
  return items;
}

async function listBookingHostIds(bookingsDb) {
  const listing = await bookingsDb.list().catch(() => ({ blobs: [] }));
  return [...new Set(
    asArray(listing.blobs)
      .map((entry) => String(entry?.key || ""))
      .filter((key) => key.startsWith("host:"))
      .map((key) => key.slice("host:".length))
      .filter(Boolean)
  )];
}

function normalizeReminderWindowHours(input) {
  const requested = Number.parseInt(String(input || DEFAULT_REMINDER_WINDOW_HOURS), 10);
  if (!Number.isFinite(requested)) return DEFAULT_REMINDER_WINDOW_HOURS;
  return Math.max(1, Math.min(requested, LIMITS.BOOKING_REMINDER_WINDOW_HOURS_MAX));
}

async function sendBookingReminderEmails(booking, bookingId) {
  const hostHtml = `
    <p>Hello ${escapeHtml(booking.host_name || booking.host_email)},</p>
    <p>Reminder: <strong>${escapeHtml(booking.event_title)}</strong> starts soon.</p>
    <p><strong>When:</strong> ${escapeHtml(booking.date)} at ${escapeHtml(booking.start_time)} (${escapeHtml(booking.timezone || "UTC")})</p>
    <p><strong>Attendee:</strong> ${escapeHtml(booking.attendee_name || booking.attendee_email)}</p>
  `;

  const attendeeHtml = `
    <p>Hello ${escapeHtml(booking.attendee_name || booking.attendee_email)},</p>
    <p>Reminder: your booking starts soon.</p>
    <p><strong>Event:</strong> ${escapeHtml(booking.event_title)}</p>
    <p><strong>When:</strong> ${escapeHtml(booking.date)} at ${escapeHtml(booking.start_time)} (${escapeHtml(booking.timezone || "UTC")})</p>
    <p><strong>Host:</strong> ${escapeHtml(booking.host_name || booking.host_email)}</p>
  `;

  const [hostResult, attendeeResult] = await Promise.all([
    sendEmail({
      to: booking.host_email,
      subject: `Reminder: ${booking.event_title}`,
      html: hostHtml,
      text: `Reminder: ${booking.event_title} at ${booking.date} ${booking.start_time}.`,
      tags: [
        { name: "type", value: "booking_reminder" },
        { name: "booking_id", value: bookingId },
      ],
    }),
    sendEmail({
      to: booking.attendee_email,
      subject: `Reminder: ${booking.event_title}`,
      html: attendeeHtml,
      text: `Reminder: ${booking.event_title} at ${booking.date} ${booking.start_time}.`,
      tags: [
        { name: "type", value: "booking_reminder" },
        { name: "booking_id", value: bookingId },
      ],
    }),
  ]);

  return {
    ok: Boolean(hostResult?.ok) && Boolean(attendeeResult?.ok),
    host_result: hostResult,
    attendee_result: attendeeResult,
  };
}

export async function sendUpcomingRemindersForHost({
  bookingsDb,
  hostUserId,
  actorEmail = "system",
  withinHours = DEFAULT_REMINDER_WINDOW_HOURS,
}) {
  const windowHours = normalizeReminderWindowHours(withinHours);
  const now = Date.now();
  const cutoff = now + windowHours * 3600 * 1000;
  const hostIds = asArray(await bookingsDb.get(`host:${hostUserId}`, { type: "json" }).catch(() => []));

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const reminderIds = [];

  for (const bookingId of hostIds) {
    const booking = await bookingsDb.get(`booking:${bookingId}`, { type: "json" }).catch(() => null);
    if (!booking || booking.status !== "confirmed") {
      skippedCount += 1;
      continue;
    }

    const startTs = new Date(booking.starts_at_utc || "").getTime();
    if (!Number.isFinite(startTs) || startTs <= now || startTs > cutoff) {
      skippedCount += 1;
      continue;
    }

    const reminderKey = `reminder:${bookingId}`;
    const reminderState = await bookingsDb.get(reminderKey, { type: "json" }).catch(() => null);
    if (reminderState?.sent_at) {
      skippedCount += 1;
      continue;
    }

    const delivery = await sendBookingReminderEmails(booking, bookingId);
    if (!delivery.ok) {
      failedCount += 1;
      continue;
    }

    await bookingsDb.setJSON(reminderKey, {
      sent_at: new Date().toISOString(),
      sent_by: actorEmail,
      booking_id: bookingId,
    });

    reminderIds.push(bookingId);
    sentCount += 1;
  }

  return {
    sent_count: sentCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    reminder_booking_ids: reminderIds,
    within_hours: windowHours,
  };
}

async function handleBookings(req, _context) {
  logRequest(FN, req);

  const url = new URL(req.url);
  const pathname = url.pathname;
  const authUser = getUserFromRequest(req);

  const eventTypesDb = getDb("booking_event_types");
  const availabilityDb = getDb("booking_availability");
  const bookingsDb = getDb("bookings");
  const usersDb = getDb("users");

  // GET /api/bookings/event-types
  if (req.method === "GET" && pathname === "/api/bookings/event-types") {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");
    const currentUser = await ensureUserPublicSlug(usersDb, authUser);
    if (!currentUser) return errorResponse(404, "User record not found.");

    const eventTypes = await listEventTypesForOwner(eventTypesDb, authUser.id);
    const publicEventTypes = await buildPublicEventTypes(eventTypes, availabilityDb, authUser.id);
    return jsonResponse(200, {
      event_types: publicEventTypes,
      public_page_slug: currentUser.booking_public_slug,
    });
  }

  // POST /api/bookings/event-types
  if (req.method === "POST" && pathname === "/api/bookings/event-types") {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");
    const currentUser = await ensureUserPublicSlug(usersDb, authUser);
    if (!currentUser) return errorResponse(404, "User record not found.");

    const body = await safeJson(req);
    if (body === null) return errorResponse(400, "Request body must be valid JSON.");

    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    const eventKind = String(body.event_type || "one_on_one").trim();
    const durationMinutes = Number.parseInt(body.duration_minutes || "30", 10);
    const dayStartTime = String(body.day_start_time || "08:00").trim();
    const dayEndTime = String(body.day_end_time || "20:00").trim();
    const timezone = String(body.timezone || currentUser.timezone || "UTC").trim();
    const groupCapacity = Number.parseInt(
      body.group_capacity || (eventKind === "group" ? "5" : "1"),
      10
    );
    const enabled = body.enabled !== false;
    const eventTypeId = String(body.id || "").trim();

    if (!title) return errorResponse(400, "Event title is required.");
    if (title.length > LIMITS.BOOKING_EVENT_TITLE_MAX) {
      return errorResponse(
        400,
        `Event title must be ${LIMITS.BOOKING_EVENT_TITLE_MAX} characters or fewer.`
      );
    }
    if (description.length > LIMITS.BOOKING_EVENT_DESCRIPTION_MAX) {
      return errorResponse(
        400,
        `Description must be ${LIMITS.BOOKING_EVENT_DESCRIPTION_MAX} characters or fewer.`
      );
    }
    if (!ALLOWED_EVENT_TYPES.has(eventKind)) {
      return errorResponse(400, "event_type must be one_on_one or group.");
    }
    if (
      !Number.isFinite(durationMinutes) ||
      durationMinutes < LIMITS.DURATION_MIN ||
      durationMinutes > LIMITS.BOOKING_DURATION_MAX
    ) {
      return errorResponse(
        400,
        `duration_minutes must be between ${LIMITS.DURATION_MIN} and ${LIMITS.BOOKING_DURATION_MAX}.`
      );
    }

    if (
      !Number.isFinite(groupCapacity) ||
      groupCapacity < 1 ||
      groupCapacity > LIMITS.BOOKING_GROUP_CAPACITY_MAX
    ) {
      return errorResponse(
        400,
        `group_capacity must be between 1 and ${LIMITS.BOOKING_GROUP_CAPACITY_MAX}.`
      );
    }

    const ownerIds = asArray(
      await eventTypesDb.get(`owner:${authUser.id}`, { type: "json" }).catch(() => [])
    );

    let id = eventTypeId;
    if (!id) {
      if (ownerIds.length >= LIMITS.BOOKING_EVENT_TYPES_MAX) {
        return errorResponse(
          400,
          `You can create at most ${LIMITS.BOOKING_EVENT_TYPES_MAX} event types.`
        );
      }
      id = generateId();
      ownerIds.push(id);
    }

    const existing = await eventTypesDb.get(`event_type:${id}`, { type: "json" }).catch(() => null);
    if (existing && existing.owner_user_id !== authUser.id) {
      return errorResponse(403, "You cannot modify another user's event type.");
    }

    const eventType = {
      id,
      owner_user_id: authUser.id,
      owner_email: authUser.email,
      owner_name: authUser.name,
      owner_public_slug: currentUser.booking_public_slug,
      slug: slugify(title),
      title,
      description,
      event_type: eventKind,
      duration_minutes: durationMinutes,
      day_start_time: isValidTime(dayStartTime) ? dayStartTime : "08:00",
      day_end_time: isValidTime(dayEndTime) ? dayEndTime : "20:00",
      group_capacity: eventKind === "one_on_one" ? 1 : groupCapacity,
      timezone,
      enabled,
      updated_at: new Date().toISOString(),
      created_at: existing?.created_at || new Date().toISOString(),
    };

    await eventTypesDb.setJSON(`event_type:${id}`, eventType);
    await eventTypesDb.setJSON(`owner:${authUser.id}`, [...new Set(ownerIds)]);

    return jsonResponse(200, { success: true, event_type: eventType });
  }

  // POST /api/bookings/event-types/:id/delete
  const deleteEventMatch = pathname.match(/^\/api\/bookings\/event-types\/([^/]+)\/delete$/);
  if (req.method === "POST" && deleteEventMatch) {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");
    const eventTypeId = deleteEventMatch[1];

    const eventType = await eventTypesDb
      .get(`event_type:${eventTypeId}`, { type: "json" })
      .catch(() => null);
    if (!eventType) return errorResponse(404, "Event type not found.");
    if (eventType.owner_user_id !== authUser.id) {
      return errorResponse(403, "Only the owner can delete this event type.");
    }

    const ownerIds = asArray(
      await eventTypesDb.get(`owner:${authUser.id}`, { type: "json" }).catch(() => [])
    ).filter((id) => id !== eventTypeId);

    // Delete the event type
    await eventTypesDb.delete(`event_type:${eventTypeId}`);
    await availabilityDb.delete(getAvailabilityKey(authUser.id, eventTypeId)).catch(() => null);
    await eventTypesDb.setJSON(`owner:${authUser.id}`, ownerIds);

    // Clean up all bookings and slot keys for this event type
    try {
      const bookingsDb = getDb("bookings");
      // Find all slot keys and booking keys for this event type
      const allKeys = await bookingsDb.list({ prefix: "" });
      const slotKeys = allKeys.keys.filter((k) => k.startsWith(`slot:${eventTypeId}:`));
      const bookingKeys = allKeys.keys.filter((k) => {
        // Booking keys are booking:<id>, need to check event_type_id
        return k.startsWith("booking:");
      });
      // For each booking, check if it matches this event type
      for (const bookingKey of bookingKeys) {
        const booking = await bookingsDb.get(bookingKey, { type: "json" }).catch(() => null);
        if (booking && booking.event_type_id === eventTypeId) {
          await bookingsDb.delete(bookingKey).catch(() => null);
        }
      }
      // Delete all slot keys for this event type
      for (const slotKey of slotKeys) {
        await bookingsDb.delete(slotKey).catch(() => null);
      }
    } catch (cleanupErr) {
      log("warn", FN, "cleanup failed after event type delete", { eventTypeId, error: cleanupErr.message });
    }
    return jsonResponse(200, { success: true });
  }

  // GET /api/bookings/availability
  if (req.method === "GET" && pathname === "/api/bookings/availability") {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");
    const ownerEventTypes = await listEventTypesForOwner(eventTypesDb, authUser.id);
    if (!ownerEventTypes.length) {
      return jsonResponse(200, {
        event_type_id: "",
        mode: "weekly",
        start_date: "",
        end_date: "",
        timezone: "UTC",
        windows: [],
      });
    }

    const eventTypeId = String(url.searchParams.get("event_type_id") || "").trim();
    if (!eventTypeId) {
      return errorResponse(400, "event_type_id query param is required.");
    }

    const eventType = ownerEventTypes.find((item) => item.id === eventTypeId);
    if (!eventType) return errorResponse(404, "Event type not found.");

    const config = await loadAvailabilityConfig(
      availabilityDb,
      authUser.id,
      eventTypeId,
      eventType.timezone || "UTC"
    );
    return jsonResponse(200, {
      event_type_id: eventTypeId,
      mode: config.mode,
      start_date: config.start_date,
      end_date: config.end_date,
      timezone: config.timezone,
      windows: config.windows,
    });
  }

  // POST /api/bookings/availability
  if (req.method === "POST" && pathname === "/api/bookings/availability") {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const ownerEventTypes = await listEventTypesForOwner(eventTypesDb, authUser.id);
    if (!ownerEventTypes.length) {
      return errorResponse(400, "Create at least one event type before setting availability.");
    }

    const body = await safeJson(req);
    if (body === null) return errorResponse(400, "Request body must be valid JSON.");

    const eventTypeId = String(body.event_type_id || "").trim();
    if (!eventTypeId) {
      return errorResponse(400, "event_type_id is required.");
    }

    const eventType = ownerEventTypes.find((item) => item.id === eventTypeId);
    if (!eventType) {
      return errorResponse(404, "Event type not found.");
    }

    const mode = String(body.mode || "weekly").trim();
    if (!ALLOWED_AVAILABILITY_MODES.has(mode)) {
      return errorResponse(400, "mode must be weekly or specific_dates.");
    }

    const startDate = String(body.start_date || "").trim();
    const endDate = String(body.end_date || "").trim();
    if ((startDate && !endDate) || (!startDate && endDate)) {
      return errorResponse(400, "start_date and end_date must both be provided when using a date range.");
    }
    if (startDate && (!isValidDate(startDate) || !isValidDate(endDate))) {
      return errorResponse(400, "start_date and end_date must be in YYYY-MM-DD format.");
    }
    if (startDate && startDate > endDate) {
      return errorResponse(400, "start_date must be on or before end_date.");
    }

    const defaultTimezone = String(body.timezone || eventType.timezone || "UTC").trim() || "UTC";
    const windows = asArray(body.windows);
    if (windows.length > LIMITS.BOOKING_AVAIL_WINDOWS_MAX) {
      return errorResponse(
        400,
        `You can set at most ${LIMITS.BOOKING_AVAIL_WINDOWS_MAX} availability windows.`
      );
    }

    const normalized = [];
    for (const row of windows) {
      const startTime = String(row?.start_time || "").trim();
      const endTime = String(row?.end_time || "").trim();
      const timezone = String(row?.timezone || defaultTimezone).trim() || defaultTimezone;

      if (!isValidTime(startTime) || !isValidTime(endTime)) {
        return errorResponse(400, "start_time and end_time must use HH:MM format.");
      }
      if (toMinutes(startTime) >= toMinutes(endTime)) {
        return errorResponse(400, "end_time must be after start_time.");
      }

      if (mode === "specific_dates") {
        const date = String(row?.date || "").trim();
        if (!isValidDate(date)) {
          return errorResponse(400, "Each availability row must include a valid date in YYYY-MM-DD format.");
        }
        if (!isDateInRange(date, startDate, endDate)) {
          return errorResponse(400, "Availability date must be within the selected date range.");
        }

        normalized.push({
          id: generateId(),
          date,
          start_time: startTime,
          end_time: endTime,
          timezone,
        });
      } else {
        const dayOfWeek = String(row?.day_of_week || "").trim();
        if (!ALLOWED_WEEKDAYS.has(dayOfWeek)) {
          return errorResponse(400, `Invalid day_of_week '${dayOfWeek}'.`);
        }

        normalized.push({
          id: generateId(),
          day_of_week: dayOfWeek,
          start_time: startTime,
          end_time: endTime,
          timezone,
        });
      }
    }

    const payload = {
      event_type_id: eventTypeId,
      mode,
      start_date: startDate,
      end_date: endDate,
      timezone: defaultTimezone,
      windows: normalized,
      updated_at: new Date().toISOString(),
    };

    await availabilityDb.setJSON(getAvailabilityKey(authUser.id, eventTypeId), payload);
    return jsonResponse(200, { success: true, ...payload });
  }

  // GET /api/bookings/page/:ownerSlug
  const pageMatch = pathname.match(/^\/api\/bookings\/page\/([^/]+)$/);
  if (req.method === "GET" && pageMatch) {
    const ownerSlug = pageMatch[1];
    const owner = await findUserByBookingPublicSlug(usersDb, ownerSlug);
    if (!owner) return errorResponse(404, "Booking page not found.");

    const ownerEventTypes = (await listEventTypesForOwner(eventTypesDb, owner.id)).filter(
      (eventType) => eventType.enabled !== false
    );
    const publicEventTypes = await buildPublicEventTypes(ownerEventTypes, availabilityDb, owner.id);

    return jsonResponse(200, {
      owner: sanitizeUser(owner),
      event_types: publicEventTypes,
    });
  }

  // GET /api/bookings/page/:ownerSlug/slots?event_type_id=...&date=YYYY-MM-DD
  const slotsMatch = pathname.match(/^\/api\/bookings\/page\/([^/]+)\/slots$/);
  if (req.method === "GET" && slotsMatch) {
    const ownerSlug = slotsMatch[1];
    const owner = await findUserByBookingPublicSlug(usersDb, ownerSlug);
    if (!owner) return errorResponse(404, "Booking page not found.");

    const eventTypeId = String(url.searchParams.get("event_type_id") || "").trim();
    const dateStr = String(url.searchParams.get("date") || "").trim();
    if (!eventTypeId || !dateStr) {
      return errorResponse(400, "event_type_id and date query params are required.");
    }
    if (!isValidDate(dateStr)) {
      return errorResponse(400, "date must be in YYYY-MM-DD format.");
    }

    const eventType = await eventTypesDb
      .get(`event_type:${eventTypeId}`, { type: "json" })
      .catch(() => null);
    if (!eventType || eventType.owner_user_id !== owner.id || eventType.enabled === false) {
      return errorResponse(404, "Event type not found.");
    }

    const availabilityConfig = await loadAvailabilityConfig(
      availabilityDb,
      owner.id,
      eventType.id,
      eventType.timezone || "UTC"
    );

    const { slots, blocked_by_calendar: blockedByCalendar } = await buildSlotsResponse({
      eventType,
      dateStr,
      availabilityConfig,
      bookingsDb,
      usersDb,
      hostUser: owner,
    });

    return jsonResponse(200, {
      event_type: eventTypePublicView(eventType),
      date: dateStr,
      slots,
      blocked_by_calendar: blockedByCalendar,
    });
  }

  // POST /api/bookings/page/:ownerSlug/book
  const bookMatch = pathname.match(/^\/api\/bookings\/page\/([^/]+)\/book$/);
  if (req.method === "POST" && bookMatch) {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const ownerSlug = bookMatch[1];
    const owner = await findUserByBookingPublicSlug(usersDb, ownerSlug);
    if (!owner) return errorResponse(404, "Booking page not found.");

    const body = await safeJson(req);
    if (body === null) return errorResponse(400, "Request body must be valid JSON.");

    const eventTypeId = String(body.event_type_id || "").trim();
    const dateStr = String(body.date || "").trim();
    const startTime = String(body.start_time || "").trim();

    if (!eventTypeId || !dateStr || !startTime) {
      return errorResponse(400, "event_type_id, date, and start_time are required.");
    }
    if (!isValidDate(dateStr) || !isValidTime(startTime)) {
      return errorResponse(400, "Invalid date or start_time format.");
    }

    const eventType = await eventTypesDb
      .get(`event_type:${eventTypeId}`, { type: "json" })
      .catch(() => null);
    if (!eventType || eventType.owner_user_id !== owner.id || eventType.enabled === false) {
      return errorResponse(404, "Event type not found.");
    }

    const availabilityConfig = await loadAvailabilityConfig(
      availabilityDb,
      owner.id,
      eventType.id,
      eventType.timezone || "UTC"
    );
    const { slots } = await buildSlotsResponse({
      eventType,
      dateStr,
      availabilityConfig,
      bookingsDb,
      usersDb,
      hostUser: owner,
    });

    if (!slots.includes(startTime)) {
      return errorResponse(409, "Selected slot is no longer available.");
    }

    const slotKey = `slot:${eventType.id}:${dateStr}:${startTime}`;
    const slotBookingIds = asArray(await bookingsDb.get(slotKey, { type: "json" }).catch(() => []));
    let confirmedCount = 0;
    for (const bookingId of slotBookingIds) {
      const booking = await bookingsDb.get(`booking:${bookingId}`, { type: "json" }).catch(() => null);
      if (booking?.status === "confirmed") confirmedCount += 1;
    }
    if (confirmedCount >= (eventType.group_capacity || 1)) {
      return errorResponse(409, "This slot is already full.");
    }

    const startUtc = localToUTC(dateStr, startTime, eventType.timezone || "UTC");
    const endUtc = new Date(startUtc.getTime() + eventType.duration_minutes * 60 * 1000);
    const bookingId = generateId();

    const booking = {
      id: bookingId,
      status: "confirmed",
      event_type_id: eventType.id,
      event_title: eventType.title,
      event_kind: eventType.event_type,
      host_user_id: owner.id,
      host_email: owner.email,
      host_name: owner.name,
      attendee_user_id: authUser.id,
      attendee_email: validateEmail(authUser.email) || authUser.email,
      attendee_name: authUser.name,
      date: dateStr,
      start_time: startTime,
      end_time: `${String(Math.floor((toMinutes(startTime) + eventType.duration_minutes) / 60)).padStart(2, "0")}:${String((toMinutes(startTime) + eventType.duration_minutes) % 60).padStart(2, "0")}`,
      timezone: eventType.timezone || "UTC",
      starts_at_utc: startUtc.toISOString(),
      ends_at_utc: endUtc.toISOString(),
      created_at: new Date().toISOString(),
      cancelled_at: null,
      cancelled_by: null,
    };

    await bookingsDb.setJSON(`booking:${bookingId}`, booking);
    await bookingsDb.setJSON(slotKey, [...slotBookingIds, bookingId]);

    // Best-effort post-write reconciliation: if concurrent writers overfill a slot,
    // roll this booking back and return a conflict.
    const postWriteSlotIds = asArray(await bookingsDb.get(slotKey, { type: "json" }).catch(() => []));
    let postWriteConfirmedCount = 0;
    for (const candidateId of postWriteSlotIds) {
      const candidate = await bookingsDb.get(`booking:${candidateId}`, { type: "json" }).catch(() => null);
      if (candidate?.status === "confirmed") postWriteConfirmedCount += 1;
    }

    if (postWriteConfirmedCount > (eventType.group_capacity || 1)) {
      await bookingsDb.delete(`booking:${bookingId}`).catch(() => null);
      const rollbackSlotIds = postWriteSlotIds.filter((id) => id !== bookingId);
      await bookingsDb.setJSON(slotKey, rollbackSlotIds).catch(() => null);
      return errorResponse(409, "Selected slot is no longer available.");
    }

    const hostIds = asArray(
      await bookingsDb.get(`host:${owner.id}`, { type: "json" }).catch(() => [])
    );
    const attendeeIds = asArray(
      await bookingsDb.get(`attendee:${authUser.id}`, { type: "json" }).catch(() => [])
    );
    await bookingsDb.setJSON(`host:${owner.id}`, [...new Set([...hostIds, bookingId])]);
    await bookingsDb.setJSON(`attendee:${authUser.id}`, [...new Set([...attendeeIds, bookingId])]);

    const hostBody = `
      <p>Hello ${escapeHtml(owner.name || owner.email)},</p>
      <p>You have a new booking for <strong>${escapeHtml(eventType.title)}</strong>.</p>
      <p><strong>When:</strong> ${escapeHtml(dateStr)} at ${escapeHtml(startTime)} (${escapeHtml(eventType.timezone || "UTC")})</p>
      <p><strong>Attendee:</strong> ${escapeHtml(authUser.name || authUser.email)} (${escapeHtml(authUser.email || "")})</p>
    `;

    const attendeeBody = `
      <p>Hello ${escapeHtml(authUser.name || authUser.email)},</p>
      <p>Your booking is confirmed.</p>
      <p><strong>Event:</strong> ${escapeHtml(eventType.title)}</p>
      <p><strong>When:</strong> ${escapeHtml(dateStr)} at ${escapeHtml(startTime)} (${escapeHtml(eventType.timezone || "UTC")})</p>
      <p><strong>Host:</strong> ${escapeHtml(owner.name || owner.email)}</p>
    `;

    await Promise.all([
      sendEmail({
        to: owner.email,
        subject: `New booking: ${eventType.title}`,
        html: hostBody,
        text: `New booking for ${eventType.title} on ${dateStr} at ${startTime}.`,
        tags: [
          { name: "type", value: "booking_created" },
          { name: "booking_id", value: bookingId },
        ],
      }),
      sendEmail({
        to: authUser.email,
        subject: `Booking confirmed: ${eventType.title}`,
        html: attendeeBody,
        text: `Your booking for ${eventType.title} is confirmed on ${dateStr} at ${startTime}.`,
        tags: [
          { name: "type", value: "booking_confirmed" },
          { name: "booking_id", value: bookingId },
        ],
      }),
    ]);

    await persistEvent("info", FN, "booking created", {
      booking_id: bookingId,
      host_email: owner.email,
      attendee_email: authUser.email,
      event_type_id: eventType.id,
    });

    return jsonResponse(200, { success: true, booking });
  }

  // GET /api/bookings/host
  if (req.method === "GET" && pathname === "/api/bookings/host") {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const ids = asArray(await bookingsDb.get(`host:${authUser.id}`, { type: "json" }).catch(() => []));
    const bookings = [];
    for (const id of ids) {
      const booking = await bookingsDb.get(`booking:${id}`, { type: "json" }).catch(() => null);
      if (booking) bookings.push(booking);
    }
    bookings.sort((a, b) => String(a.starts_at_utc || "").localeCompare(String(b.starts_at_utc || "")));
    return jsonResponse(200, { bookings });
  }

  // GET /api/bookings/mine
  if (req.method === "GET" && pathname === "/api/bookings/mine") {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const ids = asArray(
      await bookingsDb.get(`attendee:${authUser.id}`, { type: "json" }).catch(() => [])
    );
    const bookings = [];
    for (const id of ids) {
      const booking = await bookingsDb.get(`booking:${id}`, { type: "json" }).catch(() => null);
      if (booking) bookings.push(booking);
    }
    bookings.sort((a, b) => String(a.starts_at_utc || "").localeCompare(String(b.starts_at_utc || "")));
    return jsonResponse(200, { bookings });
  }

  // GET /api/bookings/:id
  const bookingDetailMatch = pathname.match(/^\/api\/bookings\/([^/]+)$/);
  if (req.method === "GET" && bookingDetailMatch) {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const bookingId = bookingDetailMatch[1];
    const booking = await bookingsDb.get(`booking:${bookingId}`, { type: "json" }).catch(() => null);
    if (!booking) return errorResponse(404, "Booking not found.");

    const canView = booking.host_user_id === authUser.id || booking.attendee_user_id === authUser.id;
    if (!canView) return errorResponse(403, "You cannot view this booking.");

    return jsonResponse(200, { booking });
  }

  // POST /api/bookings/reminders/send
  if (req.method === "POST" && pathname === "/api/bookings/reminders/send") {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const body = await safeJson(req);
    if (body === null) return errorResponse(400, "Request body must be valid JSON.");

    const result = await sendUpcomingRemindersForHost({
      bookingsDb,
      hostUserId: authUser.id,
      actorEmail: authUser.email,
      withinHours: body.within_hours,
    });

    await persistEvent("info", FN, "booking reminders sent", {
      host_email: authUser.email,
      sent_count: result.sent_count,
      skipped_count: result.skipped_count,
      failed_count: result.failed_count,
      within_hours: result.within_hours,
    });

    return jsonResponse(200, {
      success: true,
      sent_count: result.sent_count,
      skipped_count: result.skipped_count,
      failed_count: result.failed_count,
      reminder_booking_ids: result.reminder_booking_ids,
      within_hours: result.within_hours,
    });
  }

  // POST /api/bookings/reminders/run-now (admin, non-production by default)
  if (req.method === "POST" && pathname === "/api/bookings/reminders/run-now") {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");
    if (!isAdmin(authUser)) return errorResponse(403, "Only admins can run scheduler reminders manually.");

    const allowManualRunNow =
      getEnv("NETLIFY_DEV", "") === "true" ||
      getEnv("ALLOW_BOOKING_REMINDER_RUN_NOW", "") === "true";

    if (!allowManualRunNow) {
      return errorResponse(403, "Manual scheduler run is disabled outside approved environments.");
    }

    const hostIds = await listBookingHostIds(bookingsDb);
    let totalSent = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (const hostUserId of hostIds) {
      const result = await sendUpcomingRemindersForHost({
        bookingsDb,
        hostUserId,
        actorEmail: authUser.email,
      });
      totalSent += result.sent_count;
      totalSkipped += result.skipped_count;
      totalFailed += result.failed_count;
    }

    await persistEvent("warn", FN, "booking reminder scheduler run-now triggered", {
      actor_email: authUser.email,
      host_count: hostIds.length,
      sent_count: totalSent,
      skipped_count: totalSkipped,
      failed_count: totalFailed,
      allow_manual_run_now: allowManualRunNow,
    });

    return jsonResponse(200, {
      success: true,
      host_count: hostIds.length,
      sent_count: totalSent,
      skipped_count: totalSkipped,
      failed_count: totalFailed,
    });
  }

  // POST /api/bookings/:id/cancel
  const cancelMatch = pathname.match(/^\/api\/bookings\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    if (!authUser) return errorResponse(401, "Not authenticated. Please sign in.");

    const bookingId = cancelMatch[1];
    const booking = await bookingsDb.get(`booking:${bookingId}`, { type: "json" }).catch(() => null);
    if (!booking) return errorResponse(404, "Booking not found.");
    const canCancel = booking.host_user_id === authUser.id || booking.attendee_user_id === authUser.id;
    if (!canCancel) return errorResponse(403, "You cannot cancel this booking.");
    if (booking.status === "cancelled") return jsonResponse(200, { success: true, booking });

    booking.status = "cancelled";
    booking.cancelled_at = new Date().toISOString();
    booking.cancelled_by = authUser.email;
    await bookingsDb.setJSON(`booking:${bookingId}`, booking);

    await Promise.all([
      sendEmail({
        to: booking.host_email,
        subject: `Booking cancelled: ${booking.event_title}`,
        html: `<p>A booking was cancelled for <strong>${escapeHtml(booking.event_title)}</strong>.</p>`,
        text: `A booking was cancelled for ${booking.event_title}.`,
        tags: [
          { name: "type", value: "booking_cancelled" },
          { name: "booking_id", value: bookingId },
        ],
      }),
      sendEmail({
        to: booking.attendee_email,
        subject: `Booking cancelled: ${booking.event_title}`,
        html: `<p>Your booking for <strong>${escapeHtml(booking.event_title)}</strong> was cancelled.</p>`,
        text: `Your booking for ${booking.event_title} was cancelled.`,
        tags: [
          { name: "type", value: "booking_cancelled" },
          { name: "booking_id", value: bookingId },
        ],
      }),
    ]);

    await persistEvent("info", FN, "booking cancelled", {
      booking_id: bookingId,
      cancelled_by: authUser.email,
    });

    return jsonResponse(200, { success: true, booking });
  }

  return errorResponse(404, `Booking route '${pathname}' not found.`);
}

export const config = {
  path: ["/api/bookings", "/api/bookings/*"],
};
