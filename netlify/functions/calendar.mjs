import {
  getDb, getEnv, getUserFromRequest, jsonResponse, errorResponse,
  log, logRequest, decryptSecret, encryptSecret,
} from "./utils.mjs";

const FN = "calendar";

export default async (req, context) => {
  try {
    return await handleCalendar(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, `Internal server error: ${err.message}`);
  }
};

// ─── Timezone helpers ─────────────────────────────────────────────────────────
// Converts a local date+time in a given timezone to a UTC Date object.
// Technique: parse as UTC, measure offset via Intl, then correct.
function localToUTC(dateStr, timeStr, timezone) {
  const localStr = `${dateStr}T${timeStr}:00`;
  const utcCandidate = new Date(localStr + "Z");

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = {};
  fmt.formatToParts(utcCandidate).forEach(({ type, value }) => { parts[type] = value; });

  const hour = parts.hour === "24" ? "00" : parts.hour;
  const tzStr = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}Z`;
  const tzAsIfUtc = new Date(tzStr);
  const offsetMs = tzAsIfUtc - utcCandidate;

  return new Date(utcCandidate.getTime() - offsetMs);
}

// ─── Google token refresh ─────────────────────────────────────────────────────
async function refreshAccessToken(dbUser) {
  const refreshToken = decryptSecret(dbUser.google_refresh_token);
  if (!refreshToken) return null;

  const clientId     = getEnv("GOOGLE_CLIENT_ID");
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

  const asArray = (value) => Array.isArray(value) ? value : [];

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
    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return errorResponse(404, `Meeting '${meetingId}' not found.`);

    if (meeting.meeting_type === "day_of_week" || meeting.meeting_type === "days_of_week") {
      return errorResponse(400, "Calendar busy check is only available for meetings with specific dates.");
    }

    // Load user's Google tokens
    const usersDb = getDb("users");
    const dbUser = await usersDb.get(user.email, { type: "json" }).catch(() => null);
    if (!dbUser) return errorResponse(404, "User record not found.");
    let accessToken = decryptSecret(dbUser.google_access_token);
    if (!dbUser.calendar_connected || !accessToken) {
      return errorResponse(403, "Google Calendar is not connected. Connect it from your profile page.");
    }

    // Refresh token if expired (with 60s buffer)
    if ((dbUser.google_token_expiry || 0) < Date.now() + 60_000) {
      log("info", FN, "refreshing google access token", { email: user.email });
      const refreshed = await refreshAccessToken(dbUser);
      if (refreshed) {
        accessToken = refreshed.access_token;
        dbUser.google_access_token = encryptSecret(accessToken);
        dbUser.google_token_expiry = refreshed.expiry;
        await usersDb.setJSON(user.email, dbUser);
      } else {
        // Clear stale connection so user can reconnect
        dbUser.calendar_connected = false;
        dbUser.google_access_token = "";
        dbUser.google_refresh_token = "";
        dbUser.google_token_expiry = 0;
        await usersDb.setJSON(user.email, dbUser);
        return errorResponse(403, "Google Calendar session expired. Please reconnect from your profile page.");
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
    const endUTC   = localToUTC(lastDate, meeting.end_time || "24:00", meetingTz);
    // Clamp "24:00" edge case
    if (isNaN(endUTC.getTime())) {
      // end_time "20:00" on last date + 1 day
      const fallback = localToUTC(lastDate, "20:00", meetingTz);
      fallback.setDate(fallback.getDate() + 1);
    }

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
        await usersDb.setJSON(user.email, dbUser);
        return errorResponse(403, "Google Calendar access was revoked. Please reconnect from your profile page.");
      }
      return errorResponse(502, `Google Calendar API error (HTTP ${freeBusyRes.status}).`);
    }

    const freeBusyData = await freeBusyRes.json().catch(() => ({}));
    const busyPeriods  = (freeBusyData.calendars?.primary?.busy || []).map(p => ({
      start: new Date(p.start),
      end:   new Date(p.end),
    }));

    // Build time slots from the meeting definition (same logic as meetings.mjs)
    const [sh, sm] = (meeting.start_time || "08:00").split(":").map(Number);
    const [eh, em] = (meeting.end_time   || "20:00").split(":").map(Number);

    const busySlots = [];

    for (const dateStr of dates) {
      let cur = sh * 60 + sm;
      const end = eh * 60 + em;

      while (cur < end) {
        const hh = String(Math.floor(cur / 60)).padStart(2, "0");
        const mm = String(cur % 60).padStart(2, "0");
        const slotKey = `${dateStr}_${hh}:${mm}`;

        // Convert slot start and end to UTC
        const slotStartUTC = localToUTC(dateStr, `${hh}:${mm}`, meetingTz);
        const slotEndMs = slotStartUTC.getTime() + 15 * 60 * 1000;

        // Check overlap with any busy period
        const isBusy = busyPeriods.some(p =>
          slotStartUTC.getTime() < p.end.getTime() && slotEndMs > p.start.getTime()
        );

        if (isBusy) busySlots.push(slotKey);
        cur += 15;
      }
    }

    log("info", FN, "freeBusy result", { email: user.email, meetingId, busyCount: busySlots.length });
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
