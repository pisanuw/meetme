const eventTypePanel = document.getElementById("event-type-panel");
const eventTypesList = document.getElementById("event-types-list");
const eventFormHeading = document.getElementById("event-form-heading");
const eventCancelBtn = document.getElementById("event-cancel-btn");
const newEventTypeBtn = document.getElementById("new-event-type-btn");
const eventTypesSection = document.getElementById("event-types-section");

let userProfileTimezone = "UTC";
let hasEventTypes = false;

function showEventForm(isEditing = false) {
  eventFormHeading.textContent = isEditing ? "Edit Event Type" : "New Event Type";
  eventCancelBtn.hidden = !hasEventTypes;
  eventTypePanel.hidden = false;
  // Always hide and disable the '+ New Event Type' button when form is open
  if (newEventTypeBtn) {
    newEventTypeBtn.hidden = true;
    newEventTypeBtn.disabled = true;
  }
  eventTypePanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideEventForm() {
  eventTypePanel.hidden = true;
  // Only show and enable the '+ New Event Type' button if there are event types
  if (newEventTypeBtn) {
    newEventTypeBtn.hidden = !hasEventTypes;
    newEventTypeBtn.disabled = false;
  }
}

function resetEventForm() {
  document.getElementById("event-type-id").value = "";
  document.getElementById("event-title").value = "";
  document.getElementById("event-description").value = "";
  document.getElementById("event-kind").value = "one_on_one";
  document.getElementById("event-duration").value = "30";
  document.getElementById("event-capacity").value = "1";
  document.getElementById("event-timezone").value = userProfileTimezone || "UTC";
}



function formatAvailabilitySummary(item) {
  const availability = item.availability || {};
  const windowCount = Number(availability.window_count || 0);
  if (windowCount === 0) {
    return "No availability set yet.";
  }

  const modeLabel = availability.mode === "specific_dates" ? "Specific dates" : "Weekly";
  const rangeLabel = availability.start_date && availability.end_date
    ? `${availability.start_date} to ${availability.end_date}`
    : "No date range";
  return `${modeLabel} schedule · ${windowCount} window${windowCount === 1 ? "" : "s"} · ${rangeLabel}`;
}

function renderEventTypes(items = []) {
  const fragment = document.createDocumentFragment();
  const section = document.getElementById("event-types-section");
  eventTypesList.innerHTML = ""; // Clear the list

  if (!items.length) {
    if (section) section.classList.add("no-event-types");
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state empty-state-full";
    emptyState.innerHTML = `
      <div class="empty-state empty-state-full">
        <p>No event types yet. Create your first one above.</p>
      </div>
    `;
    eventTypesList.appendChild(emptyState);
    return;
  }

  if (section) section.classList.remove("no-event-types");

  const header = document.createElement("div");
  header.className = "setup-section-header";
  header.id = "event-types-header";
  header.innerHTML = `
    <div class="setup-section-header" id="event-types-header">
      <h2 class="setup-section-title">Your Event Types</h2>
      <div class="setup-section-header-actions"></div>
    </div>
  `;
  fragment.appendChild(header);

  items
    .slice()
    .reverse()
    .forEach((item) => {
      const article = document.createElement("article");
      article.className = "meeting-card";

      const h3 = document.createElement("h3");
      h3.textContent = item.title;
      article.appendChild(h3);

      const description = document.createElement("p");
      description.className = "text-muted booking-card-copy";
      description.textContent = item.description || "No description";
      article.appendChild(description);

      const summary = document.createElement("p");
      summary.className = "text-muted booking-card-summary";
      summary.textContent = formatAvailabilitySummary(item);
      article.appendChild(summary);

      const badges = document.createElement("div");
      badges.className = "booking-card-badges";
      badges.innerHTML = `
        <span class="badge ${item.event_type === "group" ? "badge-orange" : "badge-blue"}">${item.event_type}</span>
        <span class="badge badge-gray">${item.duration_minutes} min</span>
        <span class="badge badge-gray">cap ${item.group_capacity}</span>
        <span class="badge badge-gray">${escapeHtml(item.timezone || "UTC")}</span>
      `;
      article.appendChild(badges);

      const actions = document.createElement("div");
      actions.className = "form-actions booking-card-actions";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn-ghost js-edit";
      editBtn.dataset.id = item.id;
      editBtn.textContent = "Edit";
      actions.appendChild(editBtn);

      const availabilityLink = document.createElement("a");
      availabilityLink.href = `/booking-availability.html?eventType=${encodeURIComponent(item.id)}`;
      availabilityLink.className = "btn btn-ghost";
      availabilityLink.textContent = "Set Availability";
      actions.appendChild(availabilityLink);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-danger js-delete";
      deleteBtn.dataset.id = item.id;
      deleteBtn.textContent = "Delete";
      actions.appendChild(deleteBtn);

      article.appendChild(actions);
      fragment.appendChild(article);
    });

  eventTypesList.appendChild(fragment);

  eventTypesList.querySelectorAll(".js-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = items.find((x) => x.id === btn.dataset.id);
      if (!item) return;
      document.getElementById("event-type-id").value = item.id;
      document.getElementById("event-title").value = item.title || "";
      document.getElementById("event-description").value = item.description || "";
      document.getElementById("event-kind").value = item.event_type || "one_on_one";
      document.getElementById("event-duration").value = String(item.duration_minutes || 30);
      document.getElementById("event-capacity").value = String(item.group_capacity || 1);
      document.getElementById("event-timezone").value = item.timezone || userProfileTimezone || "UTC";
      showEventForm(true);
    });
  });

  eventTypesList.querySelectorAll(".js-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this event type?")) return;
      const { ok, data } = await apiFetch(`/api/bookings/event-types/${encodeURIComponent(btn.dataset.id)}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!ok) {
        showFlash(data.error || "Could not delete event type.", "danger");
        return;
      }
      await loadEventTypes();
      showFlash("Event type deleted.", "success");
    });
  });
}

async function loadEventTypes() {
  const profile = await apiFetch("/api/auth/profile");
  userProfileTimezone = profile.ok ? profile.data.timezone || "UTC" : "UTC";
  document.getElementById("event-timezone").value = userProfileTimezone;

  const eventTypesResponse = await apiFetch("/api/bookings/event-types");
  if (!eventTypesResponse.ok) {
    showFlash(eventTypesResponse.data.error || "Could not load event types.", "danger");
    return;
  }
  const eventTypes = eventTypesResponse.data.event_types || [];
  hasEventTypes = eventTypes.length > 0;
  renderEventTypes(eventTypes);
}

document.getElementById("event-type-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("event-type-id").value.trim();
  const payload = {
    id: id || undefined,
    title: document.getElementById("event-title").value.trim(),
    description: document.getElementById("event-description").value.trim(),
    event_type: document.getElementById("event-kind").value,
    duration_minutes: Number(document.getElementById("event-duration").value),
    group_capacity: Number(document.getElementById("event-capacity").value),
    timezone: document.getElementById("event-timezone").value.trim() || "UTC",
    enabled: true,
  };

  const { ok, data } = await apiFetch("/api/bookings/event-types", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!ok) {
    showFlash(data.error || "Could not save event type.", "danger");
    return;
  }

  const isNew = !id;
  resetEventForm();
  await loadEventTypes();
  hideEventForm();

  if (isNew) {
    // Redirect to the availability page for the new event type
    window.location.href = `/booking-availability.html?eventType=${encodeURIComponent(data.event_type.id)}`;
  } else {
    showFlash("Event type updated.", "success");
  }
});

eventCancelBtn.addEventListener("click", () => {
  resetEventForm();
  hideEventForm();
});

newEventTypeBtn.addEventListener("click", () => {
  // Prevent opening the form if already open
  if (!eventTypePanel.hidden) return;
  resetEventForm();
  showEventForm(false);
});

(async () => {
  const user = await requireAuth();
  if (!user) return;
  resetEventForm();
  await loadEventTypes();
  if (hasEventTypes) {
    hideEventForm();
  }
})();
