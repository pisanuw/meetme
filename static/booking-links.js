function copyText(text) {
  return navigator.clipboard.writeText(text);
}

function linkCard(item, hostSlug) {
  const url = `${window.location.origin}/book.html?host=${encodeURIComponent(hostSlug)}&event=${encodeURIComponent(item.id)}`;
  return `
    <article class="meeting-card" data-event-id="${escapeHtml(item.id)}">
      <h3>${escapeHtml(item.title)}</h3>
      <p class="text-muted booking-card-copy">${escapeHtml(item.description || "No description")}</p>
      <div class="booking-card-badges">
        <span class="badge ${item.event_type === "group" ? "badge-orange" : "badge-blue"}">${item.event_type}</span>
        <span class="badge badge-gray">${item.duration_minutes} min</span>
        <span class="badge badge-gray">cap ${item.group_capacity}</span>
      </div>
      <div class="form-group booking-card-share-group">
        <label>Share URL</label>
        <input class="form-control" readonly value="${escapeHtml(url)}" />
      </div>
      <div class="form-actions">
        <a class="btn btn-ghost" href="/booking-setup.html?edit=${encodeURIComponent(item.id)}">Edit</a>
        <a class="btn btn-ghost" href="/booking-availability.html?eventType=${encodeURIComponent(item.id)}">Set Availability</a>
        <a class="btn btn-ghost" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open</a>
        <button type="button" class="btn btn-primary js-copy-link" data-link="${escapeHtml(url)}">Copy Link</button>
        <button type="button" class="btn btn-danger js-delete-link" data-event-id="${escapeHtml(item.id)}">Delete</button>
      </div>
    </article>
  `;
}

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const hostResp = await apiFetch("/api/bookings/event-types");
  if (!hostResp.ok) {
    showFlash(hostResp.data.error || "Could not load booking links.", "danger");
    return;
  }

  const hostSlug = hostResp.data.public_page_slug;
  const items = hostResp.data.event_types || [];
  const grid = document.getElementById("links-grid");

  if (!items.length) {
    grid.innerHTML = `
      <div class="empty-state empty-state-full">
        <p>No event types yet.</p>
        <a class="btn btn-primary" href="/booking-setup.html">Create Event Type</a>
      </div>
    `;
    return;
  }

  grid.innerHTML = items.map((item) => linkCard(item, hostSlug)).join("");

  grid.querySelectorAll(".js-copy-link").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await copyText(btn.dataset.link);
        showFlash("Booking link copied.", "success");
      } catch {
        showFlash("Could not copy link.", "warning");
      }
    });
  });

  grid.querySelectorAll(".js-delete-link").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Are you sure you want to delete this booking link? This cannot be undone.")) return;
      const eventId = btn.dataset.eventId;
      btn.disabled = true;
      btn.textContent = "Deleting...";
      const resp = await apiFetch(`/api/bookings/event-types/${encodeURIComponent(eventId)}/delete`, { method: "POST" });
      if (resp.ok) {
        showFlash("Booking link deleted.", "success");
        // Remove the card from the DOM
        const card = btn.closest(".meeting-card");
        if (card) card.remove();
      } else {
        showFlash(resp.data.error || "Could not delete booking link.", "danger");
        btn.disabled = false;
        btn.textContent = "Delete";
      }
    });
  });
})();
