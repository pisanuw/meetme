const weekdayOptions = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const availabilityRows = document.getElementById("availability-rows");
const eventTypesList = document.getElementById("event-types-list");
let userProfileTimezone = "UTC";

function renderAvailabilityRow(window = {}) {
  const row = document.createElement("div");
  row.className = "form-row";
  row.style.marginBottom = "8px";
  row.innerHTML = `
    <select class="form-control js-day">
      ${weekdayOptions
        .map(
          (d) => `<option value="${d}" ${window.day_of_week === d ? "selected" : ""}>${d}</option>`
        )
        .join("")}
    </select>
    <input class="form-control js-start" type="time" value="${window.start_time || "09:00"}" />
    <input class="form-control js-end" type="time" value="${window.end_time || "17:00"}" />
    <input class="form-control js-timezone" value="${window.timezone || userProfileTimezone || "UTC"}" placeholder="Timezone" />
    <button type="button" class="btn btn-ghost js-remove">Remove</button>
  `;

  row.querySelector(".js-remove").addEventListener("click", () => row.remove());
  availabilityRows.appendChild(row);
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

function renderEventTypes(items = []) {
  if (!items.length) {
    eventTypesList.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <p>No event types yet. Create your first one above.</p>
      </div>
    `;
    return;
  }

  eventTypesList.innerHTML = items
    .map(
      (item) => `
        <article class="meeting-card">
          <h3>${escapeHtml(item.title)}</h3>
          <p class="text-muted" style="margin-top: 6px;">${escapeHtml(item.description || "No description")}</p>
          <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
            <span class="badge ${item.event_type === "group" ? "badge-orange" : "badge-blue"}">${item.event_type}</span>
            <span class="badge badge-gray">${item.duration_minutes} min</span>
            <span class="badge badge-gray">cap ${item.group_capacity}</span>
            <span class="badge badge-gray">${escapeHtml(item.timezone || "UTC")}</span>
          </div>
          <div class="form-actions" style="margin-top: 12px;">
            <button type="button" class="btn btn-ghost js-edit" data-id="${item.id}">Edit</button>
            <button type="button" class="btn btn-danger js-delete" data-id="${item.id}">Delete</button>
          </div>
        </article>
      `
    )
    .join("");

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
      document.getElementById("event-timezone").value =
        item.timezone || userProfileTimezone || "UTC";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  eventTypesList.querySelectorAll(".js-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this event type?")) return;
      const { ok, data } = await apiFetch(
        `/api/bookings/event-types/${encodeURIComponent(btn.dataset.id)}/delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }
      );
      if (!ok) {
        showFlash(data.error || "Could not delete event type.", "danger");
        return;
      }
      await loadBookingSetup();
      showFlash("Event type deleted.", "success");
    });
  });
}

async function loadBookingSetup() {
  const profile = await apiFetch("/api/auth/profile");
  userProfileTimezone = profile.ok ? profile.data.timezone || "UTC" : "UTC";
  document.getElementById("event-timezone").value = userProfileTimezone;

  const eventTypesResponse = await apiFetch("/api/bookings/event-types");
  if (!eventTypesResponse.ok) {
    showFlash(eventTypesResponse.data.error || "Could not load booking event types.", "danger");
    return;
  }
  renderEventTypes(eventTypesResponse.data.event_types || []);

  const windowsResponse = await apiFetch("/api/bookings/availability");
  if (!windowsResponse.ok) {
    showFlash(windowsResponse.data.error || "Could not load availability.", "danger");
    return;
  }

  availabilityRows.innerHTML = "";
  const windows = windowsResponse.data.windows || [];
  if (!windows.length) {
    renderAvailabilityRow();
  } else {
    windows.forEach((window) => renderAvailabilityRow(window));
  }
}

document.getElementById("event-type-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    id: document.getElementById("event-type-id").value.trim() || undefined,
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

  resetEventForm();
  await loadBookingSetup();
  showFlash("Event type saved.", "success");
});

document.getElementById("event-reset").addEventListener("click", resetEventForm);

document.getElementById("add-window-btn").addEventListener("click", () => {
  renderAvailabilityRow();
});

document.getElementById("save-availability-btn").addEventListener("click", async () => {
  const rows = [...availabilityRows.children];
  const windows = rows.map((row) => ({
    day_of_week: row.querySelector(".js-day").value,
    start_time: row.querySelector(".js-start").value,
    end_time: row.querySelector(".js-end").value,
    timezone: row.querySelector(".js-timezone").value.trim() || "UTC",
  }));

  const { ok, data } = await apiFetch("/api/bookings/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ windows }),
  });

  if (!ok) {
    showFlash(data.error || "Could not save availability.", "danger");
    return;
  }
  showFlash("Availability saved.", "success");
  await loadBookingSetup();
});

(async () => {
  const user = await requireAuth();
  if (!user) return;
  resetEventForm();
  await loadBookingSetup();
})();
