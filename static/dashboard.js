function sortBookingsByDate(bookings) {
  return [...bookings].sort((a, b) => {
    const aKey = `${a.date || "9999-12-31"}T${a.start_time || "23:59"}`;
    const bKey = `${b.date || "9999-12-31"}T${b.start_time || "23:59"}`;
    return aKey.localeCompare(bKey);
  });
}

function renderBookingLinks(eventTypes, hostSlug) {
  const container = document.getElementById("dashboard-booking-links");
  container.innerHTML = "";

  if (!eventTypes || eventTypes.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔗</div>
        <p>You haven't created any booking links yet.</p>
        <a href="/booking-setup.html" class="btn btn-primary">Create booking link</a>
      </div>
    `;
    return;
  }

  const grid = document.createElement("div");
  grid.className = "meeting-grid";

  eventTypes.forEach((item) => {
    const card = document.createElement("article");
    card.className = "meeting-card";

    const url = `${window.location.origin}/book.html?host=${encodeURIComponent(hostSlug)}&event=${encodeURIComponent(item.id)}`;

    card.innerHTML = `
      <div class="meeting-card-top">
        <div>
          <h3 class="meeting-title">${escapeHtml(item.title)}</h3>
          <span class="meeting-meta">${escapeHtml(item.duration_minutes)} min · ${escapeHtml(item.timezone || "UTC")}</span>
        </div>
        <span class="badge ${item.event_type === "group" ? "badge-orange" : "badge-blue"}">${escapeHtml(item.event_type || "one_on_one")}</span>
      </div>
      <p class="meeting-desc">${escapeHtml(item.description || "No description")}</p>
      <div class="booking-card-badges">
        <span class="badge badge-gray">${escapeHtml(item.day_start_time || "08:00")} - ${escapeHtml(item.day_end_time || "20:00")}</span>
        <span class="badge badge-gray">${item.availability?.window_count || 0} windows</span>
      </div>
      <div class="meeting-actions">
        <a class="btn btn-sm btn-ghost" href="/booking-setup.html?edit=${encodeURIComponent(item.id)}">Edit</a>
        <a class="btn btn-sm btn-ghost" href="/booking-availability.html?eventType=${encodeURIComponent(item.id)}">Availability</a>
        <a class="btn btn-sm btn-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open</a>
      </div>
    `;

    grid.appendChild(card);
  });

  container.appendChild(grid);
}

function renderDashboardBookings(hostBookings, attendeeBookings) {
  const container = document.getElementById("dashboard-my-bookings");
  container.innerHTML = "";

  const merged = [
    ...hostBookings.map((booking) => ({ ...booking, dashboard_role: "Host" })),
    ...attendeeBookings.map((booking) => ({ ...booking, dashboard_role: "Attendee" })),
  ];

  const deduped = Array.from(new Map(merged.map((booking) => [booking.id, booking])).values());
  const bookings = sortBookingsByDate(deduped);

  if (!bookings.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗓️</div>
        <p>You don't have any bookings yet.</p>
        <a href="/bookings.html" class="btn btn-primary">Open bookings</a>
      </div>
    `;
    return;
  }

  const grid = document.createElement("div");
  grid.className = "meeting-grid";

  bookings.forEach((booking) => {
    const cancelled = booking.status === "cancelled";
    const card = document.createElement("article");
    card.className = "meeting-card";

    const counterpart = booking.dashboard_role === "Host"
      ? booking.attendee_name || booking.attendee_email || "Attendee"
      : booking.host_name || booking.host_email || "Host";
    const counterpartLabel = booking.dashboard_role === "Host" ? "Attendee" : "Host";

    card.innerHTML = `
      <div class="meeting-card-top">
        <div>
          <h3 class="meeting-title">${escapeHtml(booking.event_title || "Booking")}</h3>
          <span class="meeting-meta">${escapeHtml(booking.date || "")} ${booking.start_time ? `· ${escapeHtml(booking.start_time)}` : ""} ${booking.timezone ? `· ${escapeHtml(booking.timezone)}` : ""}</span>
        </div>
        <span class="badge ${booking.dashboard_role === "Host" ? "badge-blue" : "badge-orange"}">${booking.dashboard_role}</span>
      </div>
      <div class="booking-card-badges">
        <span class="badge ${cancelled ? "badge-gray" : "badge-green"}">${escapeHtml(booking.status || "confirmed")}</span>
        <span class="badge badge-gray">${escapeHtml(booking.event_kind || "")}</span>
      </div>
      <p class="meeting-desc">${counterpartLabel}: ${escapeHtml(counterpart)}</p>
      <div class="meeting-actions">
        <a class="btn btn-sm btn-primary" href="/booking-confirmation.html?id=${encodeURIComponent(booking.id || "")}">View</a>
      </div>
    `;

    grid.appendChild(card);
  });

  container.appendChild(grid);
}

(async () => {
  const user = await requireAuth();
  if (!user) return;

  document.getElementById("greeting").textContent = `Hello, ${user.name}`;

  const [meetingsRes, eventTypesRes, hostBookingsRes, myBookingsRes] = await Promise.all([
    apiFetch("/api/meetings"),
    apiFetch("/api/bookings/event-types"),
    apiFetch("/api/bookings/host"),
    apiFetch("/api/bookings/mine"),
  ]);

  if (meetingsRes.ok) {
    renderMeetings("my-meetings", meetingsRes.data.my_meetings, true);
    renderMeetings("invited-meetings", meetingsRes.data.invited_meetings, false);
  } else {
    showFlash(meetingsRes.data.error || `Failed to load meetings (HTTP ${meetingsRes.status}).`, "danger");
    renderMeetings("my-meetings", [], true);
    renderMeetings("invited-meetings", [], false);
  }

  if (eventTypesRes.ok) {
    renderBookingLinks(eventTypesRes.data.event_types || [], eventTypesRes.data.public_page_slug || "");
  } else {
    showFlash(eventTypesRes.data.error || "Failed to load booking links.", "danger");
    renderBookingLinks([], "");
  }

  if (hostBookingsRes.ok && myBookingsRes.ok) {
    renderDashboardBookings(hostBookingsRes.data.bookings || [], myBookingsRes.data.bookings || []);
  } else {
    showFlash(
      hostBookingsRes.data?.error || myBookingsRes.data?.error || "Failed to load bookings.",
      "danger"
    );
    renderDashboardBookings([], []);
  }
})();

function renderMeetings(containerId, meetings, isOwner) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  if (!meetings || meetings.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";

    if (isOwner) {
      emptyState.innerHTML = `
        <div class="empty-icon">📅</div>
        <p>You haven't created any meetings yet.</p>
        <a href="/create-meeting.html" class="btn btn-primary">Create your first meeting</a>
      `;
    } else {
      emptyState.innerHTML = `
        <div class="empty-icon">✉️</div>
        <p>You haven't been invited to any meetings yet.</p>
      `;
    }
    container.appendChild(emptyState);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "meeting-grid";

  for (const m of meetings) {
    const card = document.createElement("div");
    card.className = `meeting-card ${m.is_finalized ? "finalized" : ""}`;

    const top = document.createElement("div");
    top.className = "meeting-card-top";

    const titleDiv = document.createElement("div");
    const h3 = document.createElement("h3");
    h3.className = "meeting-title";
    const a = document.createElement("a");
    a.href = `/meeting.html?id=${encodeURIComponent(m.id)}`;
    a.textContent = m.title;
    h3.appendChild(a);

    const meta = document.createElement("span");
    meta.className = "meeting-meta";
    let metaText = `${(m.meeting_type || "").replace("_", " ")} · ${m.respond_count || 0}/${m.invite_count || 0} responded`;
    if (!isOwner && m.creator_name) metaText += ` · Organized by ${m.creator_name}`;
    meta.textContent = metaText;
    titleDiv.append(h3, meta);

    const badge = document.createElement("span");
    if (m.is_finalized) {
      badge.className = "badge badge-green";
      badge.textContent = "Finalized";
    } else if (isOwner) {
      badge.className = "badge badge-blue";
      badge.textContent = "Open";
    } else {
      badge.className = "badge badge-orange";
      badge.textContent = "Needs your input";
    }
    top.append(titleDiv, badge);
    card.appendChild(top);

    if (m.description) {
      const desc = document.createElement("p");
      desc.className = "meeting-desc";
      desc.textContent = m.description;
      card.appendChild(desc);
    }

    const datesDiv = document.createElement("div");
    datesDiv.className = "meeting-dates";
    const dates = m.dates_or_days || [];
    dates.slice(0, 4).forEach(d => {
      const s = document.createElement("span");
      s.className = "date-chip";
      s.textContent = d;
      datesDiv.appendChild(s);
    });
    if (dates.length > 4) {
      const s = document.createElement("span");
      s.className = "date-chip muted";
      s.textContent = `+${dates.length - 4} more`;
      datesDiv.appendChild(s);
    }
    card.appendChild(datesDiv);

    if (m.is_finalized) {
      const finInfo = document.createElement("div");
      finInfo.className = "finalized-info";
      finInfo.innerHTML = `📅 <strong>${escapeHtml(m.finalized_date || "")}</strong> at <strong>${escapeHtml(m.finalized_slot || "")}</strong> (${m.duration_minutes} min)`;
      card.appendChild(finInfo);
    }

    const actions = document.createElement("div");
    actions.className = "meeting-actions";
    const btnView = document.createElement("a");
    btnView.href = `/meeting.html?id=${encodeURIComponent(m.id)}`;
    btnView.className = "btn btn-sm btn-primary";
    btnView.textContent = m.is_finalized ? "View" : isOwner ? "View" : "Add Availability";

    const btnAction = document.createElement("button");
    btnAction.className = "btn btn-sm btn-danger";
    btnAction.dataset.action = isOwner ? "delete" : "leave";
    btnAction.dataset.meetingId = m.id;
    btnAction.textContent = isOwner ? "Delete" : "Remove";

    actions.append(btnView, btnAction);
    card.appendChild(actions);
    grid.appendChild(card);
  }
  container.appendChild(grid);
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action][data-meeting-id]");
  if (!btn) return;
  const id = btn.dataset.meetingId;
  const action = btn.dataset.action;

  if (action === "delete") {
    if (!confirm("Delete this meeting?")) return;
    const { ok, status, data } = await apiFetch(`/api/meetings/${id}/delete`, { method: "POST" });
    if (ok) window.location.reload();
    else showFlash(data.error || `Failed to delete meeting (HTTP ${status}).`, "danger");
    return;
  }

  if (action === "leave") {
    if (!confirm("Remove this meeting from your dashboard?")) return;
    const { ok, status, data } = await apiFetch(`/api/meetings/${id}/leave`, { method: "POST" });
    if (ok) window.location.reload();
    else showFlash(data.error || `Failed to remove meeting (HTTP ${status}).`, "danger");
  }
});
