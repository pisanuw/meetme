/**
 * bookings-calendar.mjs — Google Calendar free/busy integration.
 */
import { getEnv, asArray, localToUTC, decryptSecret, encryptSecret, saveUserRecord } from "../utils.mjs";

export async function refreshGoogleAccessToken(dbUser) {
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

export async function fetchBusyPeriodsForDate(usersDb, hostUser, timezone, dateStr, startTime, endTime) {
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
