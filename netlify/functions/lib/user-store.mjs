/**
 * lib/user-store.mjs — User record CRUD with booking-public-slug management
 */
import { getDb } from "./db.mjs";
import { validateEmail } from "./http.mjs";

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeSlug(value) {
  const base = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "user";
}

async function resolveUniqueBookingPublicSlug(usersDb, desiredSlug, email) {
  const baseSlug = normalizeSlug(desiredSlug || String(email || "").split("@")[0]);
  let candidate = baseSlug;
  let suffix = 2;

  while (true) {
    const mapped = await usersDb
      .get(`booking_public_slug:${candidate}`, { type: "json" })
      .catch(() => null);
    const mappedEmail = normalizeEmail(mapped?.email || mapped);
    if (!mappedEmail || mappedEmail === email) return candidate;
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

export async function saveUserRecord(usersDb, userRecord) {
  const email = validateEmail(userRecord?.email || "") || normalizeEmail(userRecord?.email || "");
  if (!email) throw new Error("User record must include a valid email.");

  const existing = await usersDb.get(email, { type: "json" }).catch(() => null);
  const previousSlug = String(existing?.booking_public_slug || "")
    .trim()
    .toLowerCase();
  const bookingPublicSlug = await resolveUniqueBookingPublicSlug(
    usersDb,
    userRecord?.booking_public_slug || existing?.booking_public_slug || email.split("@")[0],
    email
  );

  const next = {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...(userRecord && typeof userRecord === "object" ? userRecord : {}),
    email,
    booking_public_slug: bookingPublicSlug,
  };

  await usersDb.setJSON(email, next);
  await usersDb.setJSON(`booking_public_slug:${bookingPublicSlug}`, { email });

  if (previousSlug && previousSlug !== bookingPublicSlug) {
    const mapped = await usersDb
      .get(`booking_public_slug:${previousSlug}`, { type: "json" })
      .catch(() => null);
    const mappedEmail = normalizeEmail(mapped?.email || mapped);
    if (!mappedEmail || mappedEmail === email) {
      await usersDb.delete(`booking_public_slug:${previousSlug}`).catch(() => null);
    }
  }

  return next;
}

export async function deleteUserRecord(usersDb, email) {
  const normalizedEmail = validateEmail(email || "") || normalizeEmail(email || "");
  if (!normalizedEmail) return;

  const existing = await usersDb.get(normalizedEmail, { type: "json" }).catch(() => null);
  const slug = String(existing?.booking_public_slug || "")
    .trim()
    .toLowerCase();

  await usersDb.delete(normalizedEmail).catch(() => null);

  if (slug) {
    const mapped = await usersDb
      .get(`booking_public_slug:${slug}`, { type: "json" })
      .catch(() => null);
    const mappedEmail = normalizeEmail(mapped?.email || mapped);
    if (!mappedEmail || mappedEmail === normalizedEmail) {
      await usersDb.delete(`booking_public_slug:${slug}`).catch(() => null);
    }
  }
}

export async function findUserByBookingPublicSlug(usersDb, ownerSlug) {
  const slug = normalizeSlug(ownerSlug);
  if (!slug) return null;

  const mapped = await usersDb
    .get(`booking_public_slug:${slug}`, { type: "json" })
    .catch(() => null);
  const mappedEmail = normalizeEmail(mapped?.email || mapped);
  if (mappedEmail) {
    const user = await usersDb.get(mappedEmail, { type: "json" }).catch(() => null);
    if (
      user &&
      String(user.booking_public_slug || "")
        .trim()
        .toLowerCase() === slug
    )
      return user;
    await usersDb.delete(`booking_public_slug:${slug}`).catch(() => null);
  }

  const listing = await usersDb.list().catch(() => ({ blobs: [] }));
  for (const entry of (Array.isArray(listing?.blobs) ? listing.blobs : [])) {
    const key = entry?.key;
    if (!key || key.includes(":")) continue;
    const user = await usersDb.get(key, { type: "json" }).catch(() => null);
    if (!user) continue;
    const saved = await saveUserRecord(usersDb, user).catch(() => null);
    if (saved && saved.booking_public_slug === slug) return saved;
  }

  return null;
}
