import { getDb, getUserFromRequest, jsonResponse, generateId } from "./utils.mjs";

export default async (req, context) => {
  const user = getUserFromRequest(req);
  if (!user) return jsonResponse(401, { error: "Not authenticated" });

  const url = new URL(req.url);
  const pathParts = url.pathname.replace("/api/meetings", "").split("/").filter(Boolean);

  const meetings = getDb("meetings");
  const invites = getDb("invites");
  const availability = getDb("availability");

  // GET /api/meetings - list dashboard data
  if (req.method === "GET" && pathParts.length === 0) {
    const indexData = await meetings.get("index", { type: "json" }).catch(() => []);

    const myMeetings = [];
    const invitedMeetings = [];

    for (const meetingId of indexData) {
      const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
      if (!meeting) continue;

      const meetingInvites = await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []);
      const respondCount = meetingInvites.filter(i => i.responded).length;
      const inviteCount = meetingInvites.length;

      const summary = {
        ...meeting,
        respond_count: respondCount,
        invite_count: inviteCount,
      };

      if (meeting.creator_id === user.id) {
        myMeetings.push(summary);
      } else if (meetingInvites.some(i => i.email === user.email)) {
        invitedMeetings.push(summary);
      }
    }

    myMeetings.sort((a, b) => b.created_at.localeCompare(a.created_at));
    invitedMeetings.sort((a, b) => b.created_at.localeCompare(a.created_at));

    return jsonResponse(200, { my_meetings: myMeetings, invited_meetings: invitedMeetings });
  }

  // POST /api/meetings - create meeting
  if (req.method === "POST" && pathParts.length === 0) {
    const body = await req.json();
    const { title, description, meeting_type, dates_or_days, start_time, end_time, invite_emails } = body;

    if (!title) return jsonResponse(400, { error: "Meeting title is required." });
    if (!dates_or_days || dates_or_days.length === 0) return jsonResponse(400, { error: "Select at least one date or day." });

    const meetingId = generateId();
    const meeting = {
      id: meetingId,
      title,
      description: description || "",
      creator_id: user.id,
      creator_name: user.name,
      meeting_type: meeting_type || "specific_dates",
      dates_or_days,
      start_time: start_time || "08:00",
      end_time: end_time || "20:00",
      duration_minutes: 60,
      finalized_date: null,
      finalized_slot: null,
      note: "",
      is_finalized: false,
      created_at: new Date().toISOString(),
    };

    await meetings.setJSON(meetingId, meeting);

    const indexData = await meetings.get("index", { type: "json" }).catch(() => []);
    indexData.push(meetingId);
    await meetings.setJSON("index", indexData);

    const meetingInvites = [{
      id: generateId(),
      meeting_id: meetingId,
      user_id: user.id,
      email: user.email,
      name: user.name,
      responded: false,
    }];

    if (invite_emails) {
      const emails = invite_emails.split("\n").map(e => e.trim().toLowerCase()).filter(e => e && e.includes("@") && e !== user.email);
      const users = getDb("users");
      for (const email of emails) {
        const existingUser = await users.get(email, { type: "json" }).catch(() => null);
        meetingInvites.push({
          id: generateId(),
          meeting_id: meetingId,
          user_id: existingUser ? existingUser.id : null,
          email,
          name: existingUser ? existingUser.name : "",
          responded: false,
        });

        if (!existingUser) {
          const pending = await invites.get(`pending:${email}`, { type: "json" }).catch(() => []);
          pending.push(meetingId);
          await invites.setJSON(`pending:${email}`, pending);
        }
      }
    }

    await invites.setJSON(`meeting:${meetingId}`, meetingInvites);

    return jsonResponse(200, { success: true, meeting_id: meetingId });
  }

  // GET /api/meetings/:id - get meeting detail
  if (req.method === "GET" && pathParts.length === 1) {
    const meetingId = pathParts[0];
    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return jsonResponse(404, { error: "Meeting not found" });

    const meetingInvites = await invites.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []);
    const isCreator = meeting.creator_id === user.id;
    const invite = meetingInvites.find(i => i.email === user.email);

    if (!isCreator && !invite) {
      return jsonResponse(403, { error: "You are not invited to this meeting." });
    }

    const allAvail = await availability.get(`meeting:${meetingId}`, { type: "json" }).catch(() => []);
    const myAvail = allAvail.filter(a => a.user_id === user.id);
    const mySlots = myAvail.map(a => `${a.date_or_day}_${a.time_slot}`);

    const slotCounts = {};
    for (const a of allAvail) {
      const k = `${a.date_or_day}_${a.time_slot}`;
      slotCounts[k] = (slotCounts[k] || 0) + 1;
    }

    const timeSlots = [];
    const [sh, sm] = meeting.start_time.split(":").map(Number);
    const [eh, em] = meeting.end_time.split(":").map(Number);
    let cur = sh * 60 + sm;
    const end = eh * 60 + em;
    while (cur < end) {
      timeSlots.push(`${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`);
      cur += 30;
    }

    let participants = [];
    if (isCreator) {
      const usersDb = getDb("users");
      for (const inv of meetingInvites) {
        const ua = allAvail.filter(a => a.user_id === inv.user_id);
        let pName = inv.name || inv.email;
        if (inv.user_id) {
          const u = await usersDb.get(inv.email, { type: "json" }).catch(() => null);
          if (u) pName = u.name;
        }
        participants.push({
          email: inv.email,
          name: pName,
          slot_count: ua.length,
          responded: inv.responded,
          slots: ua.map(a => `${a.date_or_day}_${a.time_slot}`),
        });
      }
    }

    return jsonResponse(200, {
      meeting,
      is_creator: isCreator,
      my_slots: mySlots,
      slot_counts: slotCounts,
      total_invited: meetingInvites.length,
      participants,
      time_slots: timeSlots,
      all_invites: meetingInvites,
      respond_count: meetingInvites.filter(i => i.responded).length,
      invite_count: meetingInvites.length,
    });
  }

  // POST /api/meetings/:id/delete
  if (req.method === "POST" && pathParts.length === 2 && pathParts[1] === "delete") {
    const meetingId = pathParts[0];
    const meeting = await meetings.get(meetingId, { type: "json" }).catch(() => null);
    if (!meeting) return jsonResponse(404, { error: "Meeting not found" });
    if (meeting.creator_id !== user.id) return jsonResponse(403, { error: "Not authorized" });

    await meetings.delete(meetingId);
    await invites.delete(`meeting:${meetingId}`);
    await availability.delete(`meeting:${meetingId}`);

    const indexData = await meetings.get("index", { type: "json" }).catch(() => []);
    const newIndex = indexData.filter(id => id !== meetingId);
    await meetings.setJSON("index", newIndex);

    return jsonResponse(200, { success: true });
  }

  return jsonResponse(404, { error: "Not found" });
};

export const config = {
  path: ["/api/meetings", "/api/meetings/*"],
};
