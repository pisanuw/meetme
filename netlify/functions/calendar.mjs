/**
 * calendar.mjs — Google Calendar free/busy integration
 *
 * Routes handled:
 *   GET /api/calendar/busy?meeting_id=X
 *       Returns the caller's busy intervals (from Google Calendar) that overlap
 *       with the meeting's dates/days and time range so the front-end can
 *       pre-highlight conflict slots in the availability grid.
 *
 * Requires the user to have completed the Google Calendar OAuth flow
 * (google/calendar-start → google/calendar-callback in auth.mjs).
 * Access tokens are stored AES-256-GCM encrypted in Netlify Blobs and are
 * refreshed automatically when they expire.
 */
import {
  getDb,
  getEnv,
  getUserFromRequest,
  jsonResponse,
  errorResponse,
  log,
  logRequest,
  decryptSecret,
  encryptSecret,
  asArray,
  buildTimeSlots,
  localToUTC,
  saveUserRecord,
  getMeetingRecord,
} from "./utils.mjs";

const FN = "calendar";

export default async (req, context) => {
  try {
    return await handleCalendar(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, "Internal server error.");
  }
};

/**
 * Convert a local date + time string to UTC, handling the "24:00" edge case
 * by mapping it to midnight (00:00) of the following day before conversion.
 * This avoids `Invalid Date` from `Date("YYYY-MM-DDT24:00:00Z")`.
 *
 * @param {string} dateStr  - "YYYY-MM-DD"
 * @param {string} timeStr  - "HH:MM", may be "24:00"
 * @param {string} timezone - IANA timezone
 * @returns {Date}
 */
function normalisedEndUTC(dateStr, timeStr, timezone) {
  if (timeStr === "24:00") {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return localToUTC(d.toISOString().slice(0, 10), "00:00", timezone);
  }
  return localToUTC(dateStr, timeStr, timezone);
}

// ─── Google token refresh ─────────────────────────────────────────────────────

/**
 * Use the stored refresh token to obtain a new Google access token.
 * Returns `{ access_token, expiry }` on success, or `null` on failure.
 * The caller is responsible for persisting the new access token to the database.
 *
 * @param {{ google_refresh_token: string }} dbUser - User record from Netlify Blobs
 * @returns {Promise<{ access_token: string, expiry: number }|null>}
 */
async function refreshAccessToken(dbUser) {
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
    if (!res.ok) {
      log("warn", FN, "token refresh failed", { status: res.status });
      return null;
    }
    const data = await res.json();
    return {
      access_token: data.access_token,
      expiry: Date.now() + (data.expires_in || 3600) * 1000,
    };
  } catch (err) {
    log("error", FN, "token refresh threw", { error: err.message });
    return null;
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handleCalendar(req, context) {
  logRequest(FN, req);

  const user = getUserFromRequest(req);
  if (!user) return errorResponse(401, "Not authenticated. Please sign in.");
  if (req.method !== "GET") return errorResponse(405, `Method ${req.method} not allowed.`);

  const url = new URL(req.url);
  const path = (context.params["0"] || "").replace(/^\/+/, "");

  // ─── GET /api/calendar/busy?meeting_id=X ─────────────────────────────────
  if (path === "busy") {
    const meetingId = url.searchParams.get("meeting_id") || "";
    if (!meetingId) return errorResponse(400, "meeting_id query param required.");

    // Load meeting
    const meetings = getDb("meetings");
    const meeting = await getMeetingRecord(meetings, meetingId);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);

    if (meeting.meeting_type === "day_of_week" || meeting.meeting_type === "days_of_week") {
      return errorResponse(
        400,
        "Calendar busy check is only available for meetings with specific dates."
      );
    }

    // Load user's Google tokens
    const usersDb = getDb("users");
    const dbUser = await usersDb.get(user.email, { type: "json" }).catch(() => null);
    if (!dbUser) return errorResponse(404, "User record not found.");
    let accessToken = decryptSecret(dbUser.google_access_token);
    if (!dbUser.calendar_connected || !accessToken) {
      return errorResponse(
        403,
        "Google Calendar is not connected. Connect it from your profile page."
      );
    }

    // Refresh token if expired (with 60s buffer)
    if ((dbUser.google_token_expiry || 0) < Date.now() + 60_000) {
      log("info", FN, "refreshing google access token", { email: user.email });
      const refreshed = await refreshAccessToken(dbUser);
      if (refreshed) {
        accessToken = refreshed.access_token;
        dbUser.google_access_token = encryptSecret(accessToken);
        dbUser.google_token_expiry = refreshed.expiry;
        await saveUserRecord(usersDb, dbUser);
      } else {
        // Clear stale connection so user can reconnect
        dbUser.calendar_connected = false;
        dbUser.google_access_token = "";
        dbUser.google_refresh_token = "";
        dbUser.google_token_expiry = 0;
        await saveUserRecord(usersDb, dbUser);
        return errorResponse(
          403,
          "Google Calendar session expired. Please reconnect from your profile page."
        );
      }
    }

    const meetingTz = meeting.timezone || "UTC";
    const dates = [...asArray(meeting.dates_or_days)].sort();
    if (dates.length === 0) {
      return errorResponse(400, "Meeting has no dates configured for calendar lookup.");
    }

    // Determine UTC range for the FreeBusy query
    const startUTC = localToUTC(dates[0], meeting.start_time || "00:00", meetingTz);
    const lastDate = dates[dates.length - 1];
    // Normalise "24:00" (midnight end of day) to "00:00" on the following day
    // before calling localToUTC, which cannot parse "T24:00" natively.
    const endUTC = normalisedEndUTC(lastDate, meeting.end_time || "24:00", meetingTz);

    log("info", FN, "querying freeBusy", {
      email: user.email,
      meetingId,
      timeMin: startUTC.toISOString(),
      timeMax: endUTC.toISOString(),
    });

    let freeBusyRes;
    try {
      freeBusyRes = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          timeMin: startUTC.toISOString(),
          timeMax: endUTC.toISOString(),
          items: [{ id: "primary" }],
        }),
      });
    } catch (err) {
      log("error", FN, "freeBusy fetch threw", { error: err.message });
      return errorResponse(502, `Could not reach Google Calendar: ${err.message}`);
    }

    if (!freeBusyRes.ok) {
      const errText = await freeBusyRes.text().catch(() => "");
      log("error", FN, "freeBusy API error", { status: freeBusyRes.status, body: errText });
      if (freeBusyRes.status === 401) {
        dbUser.calendar_connected = false;
        dbUser.google_access_token = "";
        dbUser.google_refresh_token = "";
        dbUser.google_token_expiry = 0;
        await saveUserRecord(usersDb, dbUser);
        return errorResponse(
          403,
          "Google Calendar access was revoked. Please reconnect from your profile page."
        );
      }
      return errorResponse(502, `Google Calendar API error (HTTP ${freeBusyRes.status}).`);
    }

    const freeBusyData = await freeBusyRes.json().catch(() => ({}));
    const busyPeriods = (freeBusyData.calendars?.primary?.busy || []).map((p) => ({
      start: new Date(p.start),
      end: new Date(p.end),
    }));

    const busySlots = [];
    const timeSlots = buildTimeSlots(meeting.start_time, meeting.end_time);

    for (const dateStr of dates) {
      for (const timeStr of timeSlots) {
        const slotKey = `${dateStr}_${timeStr}`;

        // Convert slot start and end to UTC
        const slotStartUTC = localToUTC(dateStr, timeStr, meetingTz);
        const slotEndMs = slotStartUTC.getTime() + 15 * 60 * 1000;

        // Check overlap with any busy period
        const isBusy = busyPeriods.some(
          (p) => slotStartUTC.getTime() < p.end.getTime() && slotEndMs > p.start.getTime()
        );

        if (isBusy) busySlots.push(slotKey);
      }
    }

    log("info", FN, "freeBusy result", {
      email: user.email,
      meetingId,
      busyCount: busySlots.length,
    });
    return jsonResponse(200, {
      busy_slots: busySlots,
      meeting_timezone: meetingTz,
      queried_at: new Date().toISOString(),
    });
  }

  // ─── GET /api/calendar/status ─────────────────────────────────────────────
  if (path === "status") {
    const usersDb = getDb("users");
    const dbUser = await usersDb.get(user.email, { type: "json" }).catch(() => null);
    return jsonResponse(200, {
      connected: !!(dbUser?.calendar_connected && decryptSecret(dbUser?.google_access_token)),
    });
  }

  return errorResponse(404, `Calendar route '${path}' not found.`);
}

export const config = {
  path: "/api/calendar/*",
};
