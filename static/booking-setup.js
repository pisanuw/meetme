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
  newEventTypeBtn.hidden = true;
  eventTypePanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideEventForm() {
  eventTypePanel.hidden = true;
  newEventTypeBtn.hidden = false;
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
  if (!items.length) {
    eventTypesList.innerHTML = `
      <div class="empty-state empty-state-full">
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
          <p class="text-muted booking-card-copy">${escapeHtml(item.description || "No description")}</p>
          <p class="text-muted booking-card-summary">${escapeHtml(formatAvailabilitySummary(item))}</p>
          <div class="booking-card-badges">
            <span class="badge ${item.event_type === "group" ? "badge-orange" : "badge-blue"}">${item.event_type}</span>
            <span class="badge badge-gray">${item.duration_minutes} min</span>
            <span class="badge badge-gray">cap ${item.group_capacity}</span>
            <span class="badge badge-gray">${escapeHtml(item.timezone || "UTC")}</span>
          </div>
          <div class="form-actions booking-card-actions">
            <button type="button" class="btn btn-ghost js-edit" data-id="${item.id}">Edit</button>
            <a href="/booking-availability.html?eventType=${encodeURIComponent(item.id)}" class="btn btn-ghost">${item.availability?.window_count ? "Edit Availability" : "Set Availability"}</a>
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
    eventTypesSection.scrollIntoView({ behavior: "smooth", block: "start" });
    showFlash("Event type created. Use \u201cSet Availability\u201d to open time slots for booking.", "success");
  } else {
    showFlash("Event type updated.", "success");
  }
});

eventCancelBtn.addEventListener("click", () => {
  resetEventForm();
  hideEventForm();
});

newEventTypeBtn.addEventListener("click", () => {
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


function toMinutes(timeStr) {
  const [h, m] = String(timeStr || "00:00").split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(mins) {
  const safe = Math.max(0, Math.min(DAY_MINUTES - TIME_STEP_MINUTES, mins));
  const hh = String(Math.floor(safe / 60)).padStart(2, "0");
  const mm = String(safe % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function buildTimeChipsHtml(kind) {
  return QUICK_TIME_OPTIONS.map((time) => `<button type="button" class="date-chip removable js-time-chip" data-kind="${kind}" data-time="${time}">${time}</button>`).join("");
}

function syncActiveTimeChips(row) {
  const startValue = row.querySelector(".js-start")?.value || "";
  const endValue = row.querySelector(".js-end")?.value || "";
  row.querySelectorAll('.js-time-chip[data-kind="start"]').forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.time === startValue);
  });
  row.querySelectorAll('.js-time-chip[data-kind="end"]').forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.time === endValue);
  });
}

function clampTimeRange(row, changedKind) {
  const startInput = row.querySelector(".js-start");
  const endInput = row.querySelector(".js-end");
  if (!startInput || !endInput) return;

  const startMins = toMinutes(startInput.value);
  const endMins = toMinutes(endInput.value);
  if (startMins < endMins) return;

  if (changedKind === "start") {
    endInput.value = fromMinutes(startMins + TIME_STEP_MINUTES);
  } else {
    startInput.value = fromMinutes(endMins - TIME_STEP_MINUTES);
  }
}

function bindTimePickerRow(row) {
  const startInput = row.querySelector(".js-start");
  const endInput = row.querySelector(".js-end");
  if (!startInput || !endInput) return;

  row.querySelectorAll(".js-time-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const { kind, time } = chip.dataset;
      if (kind === "start") {
        startInput.value = time;
        clampTimeRange(row, "start");
      } else {
        endInput.value = time;
        clampTimeRange(row, "end");
      }
      syncActiveTimeChips(row);
    });
  });

  startInput.addEventListener("change", () => {
    clampTimeRange(row, "start");
    syncActiveTimeChips(row);
  });

  endInput.addEventListener("change", () => {
    clampTimeRange(row, "end");
    syncActiveTimeChips(row);
  });

  syncActiveTimeChips(row);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysIso(days) {
  const base = new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

function currentAvailabilityMode() {
  return availabilityModeSelect.value === "specific_dates" ? "specific_dates" : "weekly";
}

function updateAvailabilityModeHelp() {
  if (currentAvailabilityMode() === "specific_dates") {
    availabilityModeHelp.textContent = "Specific dates mode applies only to the exact dates and times listed below.";
    addWindowBtn.textContent = "+ Add Date Window";
    return;
  }
  availabilityModeHelp.textContent = "Weekly mode repeats selected weekdays within the date range.";
  addWindowBtn.textContent = "+ Add Weekly Window";
}

function setAvailabilityGate() {
  const controls = [availabilityModeSelect, availabilityStartDateInput, availabilityEndDateInput, addWindowBtn, saveAvailabilityBtn];
  const disabled = !hasEventTypes;

  controls.forEach((el) => {
    el.disabled = disabled;
  });

  availabilityRows.querySelectorAll("input, select, button").forEach((el) => {
    el.disabled = disabled;
  });

  if (disabled) {
    availabilityGateMessage.hidden = false;
    availabilityGateMessage.textContent = "Create at least one Event Type before setting availability.";
  } else {
    availabilityGateMessage.hidden = true;
    availabilityGateMessage.textContent = "";
  }
}

function renderAvailabilityRow(window = {}, mode = currentAvailabilityMode()) {
  const row = document.createElement("div");
  row.className = "form-row availability-row";
  row.classList.add("availability-row-spaced");

  const firstField =
    mode === "specific_dates"
      ? `<input class="form-control js-date" type="date" value="${window.date || ""}" />`
      : `<select class="form-control js-day">${weekdayOptions
          .map((d) => `<option value="${d}" ${window.day_of_week === d ? "selected" : ""}>${d}</option>`)
          .join("")}</select>`;

  row.innerHTML = `
    ${firstField}
    <input class="form-control js-start" type="time" value="${window.start_time || "09:00"}" />
    <input class="form-control js-end" type="time" value="${window.end_time || "17:00"}" />
    <input class="form-control js-timezone" value="${window.timezone || userProfileTimezone || "UTC"}" placeholder="Timezone" />
    <button type="button" class="btn btn-ghost js-remove">Remove</button>
    <details class="availability-quick-picker availability-quick-picker-wide">
      <summary class="text-muted availability-quick-picker-summary">Quick pick in 15-minute slots</summary>
      <div class="availability-quick-picker-group">
        <label class="text-muted availability-quick-picker-label">Start</label>
        <div class="chips-row availability-time-chips js-start-chips">
          ${buildTimeChipsHtml("start")}
        </div>
      </div>
      <div class="availability-quick-picker-group">
        <label class="text-muted availability-quick-picker-label">End</label>
        <div class="chips-row availability-time-chips js-end-chips">
          ${buildTimeChipsHtml("end")}
        </div>
      </div>
    </details>
  `;

  row.querySelector(".js-remove").addEventListener("click", () => {
    row.remove();
    setAvailabilityGate();
  });

  bindTimePickerRow(row);

  availabilityRows.appendChild(row);
}

function renderAvailabilityRows(windows = [], mode = currentAvailabilityMode()) {
  availabilityRows.innerHTML = "";
  if (!windows.length) {
    renderAvailabilityRow({}, mode);
  } else {
    windows.forEach((window) => renderAvailabilityRow(window, mode));
  }
  setAvailabilityGate();
}

function collectAvailabilityWindows(mode = currentAvailabilityMode()) {
  const rows = [...availabilityRows.children];
  return rows.map((row) => {
    const base = {
      start_time: row.querySelector(".js-start")?.value || "",
      end_time: row.querySelector(".js-end")?.value || "",
      timezone: row.querySelector(".js-timezone")?.value.trim() || "UTC",
    };

    if (mode === "specific_dates") {
      return {
        ...base,
        date: row.querySelector(".js-date")?.value || "",
      };
    }

    return {
      ...base,
      day_of_week: row.querySelector(".js-day")?.value || "",
    };
  });
}

function normalizeAvailabilityResponse(data = {}) {
  return {
    mode: data.mode === "specific_dates" ? "specific_dates" : "weekly",
    start_date: data.start_date || "",
    end_date: data.end_date || "",
    windows: Array.isArray(data.windows) ? data.windows : [],
  };
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
      <div class="empty-state empty-state-full">
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
          <p class="text-muted booking-card-copy">${escapeHtml(item.description || "No description")}</p>
          <div class="booking-card-badges">
            <span class="badge ${item.event_type === "group" ? "badge-orange" : "badge-blue"}">${item.event_type}</span>
            <span class="badge badge-gray">${item.duration_minutes} min</span>
            <span class="badge badge-gray">cap ${item.group_capacity}</span>
            <span class="badge badge-gray">${escapeHtml(item.timezone || "UTC")}</span>
          </div>
          <div class="form-actions booking-card-actions">
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
      document.getElementById("event-timezone").value = item.timezone || userProfileTimezone || "UTC";
      window.scrollTo({ top: 0, behavior: "smooth" });
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
  const eventTypes = eventTypesResponse.data.event_types || [];
  hasEventTypes = eventTypes.length > 0;
  renderEventTypes(eventTypes);

  const windowsResponse = await apiFetch("/api/bookings/availability");
  if (!windowsResponse.ok) {
    showFlash(windowsResponse.data.error || "Could not load availability.", "danger");
    return;
  }

  const availability = normalizeAvailabilityResponse(windowsResponse.data || {});
  availabilityModeSelect.value = availability.mode;
  availabilityStartDateInput.value = availability.start_date || todayIso();
  availabilityEndDateInput.value = availability.end_date || plusDaysIso(30);
  updateAvailabilityModeHelp();
  renderAvailabilityRows(availability.windows, availability.mode);
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

addWindowBtn.addEventListener("click", () => {
  renderAvailabilityRow({}, currentAvailabilityMode());
  setAvailabilityGate();
});

availabilityModeSelect.addEventListener("change", () => {
  updateAvailabilityModeHelp();
  renderAvailabilityRows([], currentAvailabilityMode());
});

saveAvailabilityBtn.addEventListener("click", async () => {
  if (!hasEventTypes) {
    showFlash("Create at least one Event Type before setting availability.", "danger");
    return;
  }

  const startDate = availabilityStartDateInput.value;
  const endDate = availabilityEndDateInput.value;
  if (!startDate || !endDate) {
    showFlash("Please set both start and end dates.", "danger");
    return;
  }
  if (startDate > endDate) {
    showFlash("Start date must be on or before end date.", "danger");
    return;
  }

  const mode = currentAvailabilityMode();
  const windows = collectAvailabilityWindows(mode);

  const { ok, data } = await apiFetch("/api/bookings/availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode,
      start_date: startDate,
      end_date: endDate,
      timezone: userProfileTimezone || "UTC",
      windows,
    }),
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
  updateAvailabilityModeHelp();
  await loadBookingSetup();
})();
