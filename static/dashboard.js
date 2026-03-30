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
