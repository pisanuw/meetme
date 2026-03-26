(async () => {
  const user = await requireAuth();
  if (!user) return;

  document.getElementById("greeting").textContent = `Hello, ${user.name}`;

  const { ok, status, data } = await apiFetch("/api/meetings");
  if (!ok) {
    showFlash(data.error || `Failed to load meetings (HTTP ${status}).`, "danger");
    return;
  }

  renderMeetings("my-meetings", data.my_meetings, true);
  renderMeetings("invited-meetings", data.invited_meetings, false);
})();

function renderMeetings(containerId, meetings, isOwner) {
  const container = document.getElementById(containerId);

  if (!meetings || meetings.length === 0) {
    if (isOwner) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📅</div>
          <p>You haven't created any meetings yet.</p>
          <a href="/create-meeting.html" class="btn btn-primary">Create your first meeting</a>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✉️</div>
          <p>You haven't been invited to any meetings yet.</p>
        </div>`;
    }
    return;
  }

  let html = '<div class="meeting-grid">';
  for (const m of meetings) {
    const dates = m.dates_or_days || [];
    const datesHtml = dates
      .slice(0, 4)
      .map((d) => `<span class="date-chip">${escapeHtml(d)}</span>`)
      .join("");
    const moreHtml =
      dates.length > 4 ? `<span class="date-chip muted">+${dates.length - 4} more</span>` : "";

    html += `
    <div class="meeting-card ${m.is_finalized ? "finalized" : ""}">
      <div class="meeting-card-top">
        <div>
          <h3 class="meeting-title">
            <a href="/meeting.html?id=${m.id}">${escapeHtml(m.title)}</a>
          </h3>
          <span class="meeting-meta">
            ${escapeHtml((m.meeting_type || "").replace("_", " "))} &middot;
            ${m.respond_count || 0}/${m.invite_count || 0} responded
            ${!isOwner && m.creator_name ? "&middot; Organized by " + escapeHtml(m.creator_name) : ""}
          </span>
        </div>
        ${
          m.is_finalized
            ? '<span class="badge badge-green">Finalized</span>'
            : isOwner
              ? '<span class="badge badge-blue">Open</span>'
              : '<span class="badge badge-orange">Needs your input</span>'
        }
      </div>
      ${m.description ? `<p class="meeting-desc">${escapeHtml(m.description)}</p>` : ""}
      <div class="meeting-dates">${datesHtml}${moreHtml}</div>
      ${m.is_finalized ? `<div class="finalized-info">📅 <strong>${escapeHtml(m.finalized_date || "")}</strong> at <strong>${escapeHtml(m.finalized_slot || "")}</strong> (${m.duration_minutes} min)</div>` : ""}
      <div class="meeting-actions">
        <a href="/meeting.html?id=${m.id}" class="btn btn-sm btn-primary">${m.is_finalized ? "View" : isOwner ? "View" : "Add Availability"}</a>
        <button class="btn btn-sm btn-danger" data-action="${isOwner ? "delete" : "leave"}" data-meeting-id="${m.id}">${isOwner ? "Delete" : "Remove"}</button>
      </div>
    </div>`;
  }
  html += "</div>";
  container.innerHTML = html;
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
