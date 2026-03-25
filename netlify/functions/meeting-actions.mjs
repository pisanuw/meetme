import { getDb, getUserFromRequest, jsonResponse } from "./utils.mjs";

export default async (req, context) => {
  const user = getUserFromRequest(req);
  if (!user) return jsonResponse(401, { error: "Not authenticated" });
  if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  const url = new URL(req.url);
  const path = url.pathname;

  const invites = getDb("invites");
  const availability = getDb("availability");

  // POST /api/meeting/:id/availability
  const availMatch = path.match(/^\/api\/meeting\/([^/]+)\/availability$/);
  if (availMatch) {
    const meetingId = availMatch[1];
    const meetings = getDb("meetings");
    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return jsonResponse(404, { error: "Meeting not found" });

    const meetingInvites = await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []);
    const invite = meetingInvites.find(i => i.email === user.email);
    if (meeting.creator_id !== user.id && !invite) {
      return jsonResponse(403, { error: "Not authorized" });
    }

    const body = await req.json();
    const slots = body.slots || [];

    const allAvail = await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []);
    const otherAvail = allAvail.filter(a => a.user_id !== user.id);

    const validDates = new Set(meeting.dates_or_days);
    const validTimes = new Set();
    const [sh, sm] = meeting.start_time.split(":").map(Number);
    const [eh, em] = meeting.end_time.split(":").map(Number);
    let cur = sh * 60 + sm;
    const end = eh * 60 + em;
    while (cur < end) {
      validTimes.add(`${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`);
      cur += 30;
    }

    const newAvail = [];
    for (const sk of slots) {
      const idx = sk.indexOf("_");
      if (idx === -1) continue;
      const dod = sk.slice(0, idx);
      const ts = sk.slice(idx + 1);
      if (validDates.has(dod) && validTimes.has(ts)) {
        newAvail.push({
          meeting_id: meetingId,
          user_id: user.id,
          date_or_day: dod,
          time_slot: ts,
        });
      }
    }

    const updatedAvail = [...otherAvail, ...newAvail];
    await availability.setJSON(`meeting:${meetingId}`, updatedAvail);

    if (invite) {
      const updatedInvites = meetingInvites.map(i =>
        i.email === user.email ? { ...i, responded: true } : i
      );
      await invites.setJSON(`meeting:${meetingId}`, updatedInvites);
    }

    const slotCounts = {};
    for (const a of updatedAvail) {
      const k = `${a.date_or_day}_${a.time_slot}`;
      slotCounts[k] = (slotCounts[k] || 0) + 1;
    }

    return jsonResponse(200, { success: true, slot_counts: slotCounts });
  }

  // POST /api/meeting/:id/finalize
  const finalizeMatch = path.match(/^\/api\/meeting\/([^/]+)\/finalize$/);
  if (finalizeMatch) {
    const meetingId = finalizeMatch[1];
    const meetings = getDb("meetings");
    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return jsonResponse(404, { error: "Meeting not found" });
    if (meeting.creator_id !== user.id) return jsonResponse(403, { error: "Not authorized" });

    const body = await req.json();
    meeting.finalized_date = body.date_or_day;
    meeting.finalized_slot = body.time_slot;
    meeting.duration_minutes = parseInt(body.duration_minutes || 60);
    meeting.note = body.note || "";
    meeting.is_finalized = true;
    await meetings.setJSON(meetingId, meeting);

    return jsonResponse(200, { success: true });
  }

  // POST /api/meeting/:id/unfinalize
  const unfinalizeMatch = path.match(/^\/api\/meeting\/([^/]+)\/unfinalize$/);
  if (unfinalizeMatch) {
    const meetingId = unfinalizeMatch[1];
    const meetings = getDb("meetings");
    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return jsonResponse(404, { error: "Meeting not found" });
    if (meeting.creator_id !== user.id) return jsonResponse(403, { error: "Not authorized" });

    meeting.is_finalized = false;
    meeting.finalized_date = null;
    meeting.finalized_slot = null;
    await meetings.setJSON(meetingId, meeting);

    return jsonResponse(200, { success: true });
  }

  return jsonResponse(404, { error: "Not found" });
};

export const config = {
  path: "/api/meeting/*",
};
