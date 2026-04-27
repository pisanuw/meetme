/**
 * bookings-store.mjs — Blob-store operations for event types, bookings, and user slugs.
 */
import { asArray, saveUserRecord } from "../utils.mjs";
import { eventTypePublicView, getAvailabilityKey } from "./bookings-helpers.mjs";
import { loadAvailabilityConfig } from "./bookings-availability.mjs";

export async function ensureUserPublicSlug(usersDb, user) {
  const dbUser = await usersDb.get(user.email, { type: "json" }).catch(() => null);
  if (!dbUser) return null;
  return saveUserRecord(usersDb, dbUser);
}

export async function listEventTypesForOwner(eventTypesDb, ownerId) {
  const ids = asArray(await eventTypesDb.get(`owner:${ownerId}`, { type: "json" }).catch(() => []));
  const results = [];
  for (const id of ids) {
    const eventType = await eventTypesDb.get(`event_type:${id}`, { type: "json" }).catch(() => null);
    if (eventType) results.push(eventType);
  }
  return results;
}

export async function buildPublicEventTypes(eventTypes, availabilityDb, ownerId) {
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

export async function listBookingHostIds(bookingsDb) {
  const listing = await bookingsDb.list().catch(() => ({ blobs: [] }));
  return [...new Set(
    asArray(listing.blobs)
      .map((entry) => String(entry?.key || ""))
      .filter((key) => key.startsWith("host:"))
      .map((key) => key.slice("host:".length))
      .filter(Boolean)
  )];
}

export async function listStoreKeys(store, prefix = "") {
  const listing = await store.list({ prefix }).catch(() => ({ blobs: [] }));
  return asArray(listing.blobs)
    .map((entry) => String(entry?.key || ""))
    .filter(Boolean);
}

export async function removeBookingReferences(bookingsDb, booking) {
  const bookingId = String(booking?.id || "").trim();
  if (!bookingId) return;

  const hostUserId = String(booking.host_user_id || "").trim();
  const attendeeUserId = String(booking.attendee_user_id || "").trim();
  const eventTypeId = String(booking.event_type_id || "").trim();
  const date = String(booking.date || "").trim();
  const startTime = String(booking.start_time || "").trim();

  if (hostUserId) {
    const hostIds = asArray(await bookingsDb.get(`host:${hostUserId}`, { type: "json" }).catch(() => []));
    await bookingsDb.setJSON(`host:${hostUserId}`, hostIds.filter((id) => id !== bookingId)).catch(() => null);
  }

  if (attendeeUserId) {
    const attendeeIds = asArray(
      await bookingsDb.get(`attendee:${attendeeUserId}`, { type: "json" }).catch(() => [])
    );
    await bookingsDb
      .setJSON(`attendee:${attendeeUserId}`, attendeeIds.filter((id) => id !== bookingId))
      .catch(() => null);
  }

  if (eventTypeId && date && startTime) {
    const slotKey = `slot:${eventTypeId}:${date}:${startTime}`;
    const slotIds = asArray(await bookingsDb.get(slotKey, { type: "json" }).catch(() => []));
    const filteredSlotIds = slotIds.filter((id) => id !== bookingId);
    if (filteredSlotIds.length > 0) {
      await bookingsDb.setJSON(slotKey, filteredSlotIds).catch(() => null);
    } else {
      await bookingsDb.delete(slotKey).catch(() => null);
    }
  }

  await bookingsDb.delete(`reminder:${bookingId}`).catch(() => null);
  await bookingsDb.delete(`booking:${bookingId}`).catch(() => null);
}

export async function deleteBookingsForEventType(bookingsDb, eventTypeId) {
  const bookingKeys = await listStoreKeys(bookingsDb, "booking:");
  let deletedCount = 0;

  for (const bookingKey of bookingKeys) {
    const booking = await bookingsDb.get(bookingKey, { type: "json" }).catch(() => null);
    if (!booking || booking.event_type_id !== eventTypeId) continue;
    await removeBookingReferences(bookingsDb, booking);
    deletedCount += 1;
  }

  const slotKeys = await listStoreKeys(bookingsDb, `slot:${eventTypeId}:`);
  for (const slotKey of slotKeys) {
    await bookingsDb.delete(slotKey).catch(() => null);
  }

  return deletedCount;
}
