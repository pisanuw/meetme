const weekdayOptions = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const availabilityRows = document.getElementById("availability-rows");
const availabilityModeSelect = document.getElementById("availability-mode");
const availabilityStartDateInput = document.getElementById("availability-start-date");
const availabilityEndDateInput = document.getElementById("availability-end-date");
const availabilityModeHelp = document.getElementById("availability-mode-help");
const availabilityGateMessage = document.getElementById("availability-gate-message");
const addWindowBtn = document.getElementById("add-window-btn");
const saveAvailabilityBtn = document.getElementById("save-availability-btn");

const params = new URLSearchParams(window.location.search);
const requestedEventTypeId = params.get("eventType") || "";

let userProfileTimezone = "UTC";
let hasEventTypes = false;
let eventTypes = [];

function redirectToSetupIfNoEventType() {
  if (!requestedEventTypeId) {
    showFlash("No event type selected. Please create or select an event type first.", "danger");
    setTimeout(() => {
      window.location.href = "/booking-setup.html";
    }, 1200);
    throw new Error("No event type selected");
  }
}
const TIME_STEP_MINUTES = 15;
const DAY_MINUTES = 24 * 60;
const QUICK_TIME_OPTIONS = buildTimeOptions();

function buildTimeOptions() {
  const out = [];
  for (let mins = 0; mins < DAY_MINUTES; mins += TIME_STEP_MINUTES) {
    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    out.push(`${hh}:${mm}`);
  }
  return out;
}

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
  return QUICK_TIME_OPTIONS.map(
    (time) =>
      `<button type="button" class="date-chip removable js-time-chip" data-kind="${kind}" data-time="${time}">${time}</button>`
  ).join("");
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
  const dateRow = document.getElementById("availability-date-row");
  if (currentAvailabilityMode() === "specific_dates") {
    availabilityModeHelp.textContent = "Specific dates mode applies only to the exact dates and times listed below.";
    addWindowBtn.textContent = "+ Add Date Window";
    if (dateRow) dateRow.style.display = "none";
    return;
  }
  availabilityModeHelp.textContent = "Weekly mode repeats selected weekdays within the date range.";
  addWindowBtn.textContent = "+ Add Weekly Window";
  if (dateRow) dateRow.style.display = "";
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
    availabilityGateMessage.textContent =
      "You need at least one event type before setting availability. Create one on the Event Types page.";
  } else {
    availabilityGateMessage.hidden = true;
    availabilityGateMessage.textContent = "";
  }
}

function renderAvailabilityRow(window = {}, mode = currentAvailabilityMode()) {
  const row = document.createElement("div");
  row.className = "form-row availability-row availability-row-spaced";

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
    windows.forEach((w) => renderAvailabilityRow(w, mode));
  }
  setAvailabilityGate();
}

function collectAvailabilityWindows(mode = currentAvailabilityMode()) {
  return [...availabilityRows.children].map((row) => {
    const base = {
      start_time: row.querySelector(".js-start")?.value || "",
      end_time: row.querySelector(".js-end")?.value || "",
      timezone: row.querySelector(".js-timezone")?.value.trim() || "UTC",
    };
    if (mode === "specific_dates") {
      return { ...base, date: row.querySelector(".js-date")?.value || "" };
    }
    return { ...base, day_of_week: row.querySelector(".js-day")?.value || "" };
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

async function loadAvailability() {
  const profile = await apiFetch("/api/auth/profile");
  userProfileTimezone = profile.ok ? profile.data.timezone || "UTC" : "UTC";

  const eventTypesRes = await apiFetch("/api/bookings/event-types");
  if (!eventTypesRes.ok) {
    showFlash(eventTypesRes.data.error || "Could not load event types.", "danger");
    return;
  }
  hasEventTypes = (eventTypesRes.data.event_types || []).length > 0;

  redirectToSetupIfNoEventType();
  const eventTypeId = requestedEventTypeId;
  const windowsRes = await apiFetch(`/api/bookings/availability?event_type_id=${encodeURIComponent(eventTypeId)}`);
  if (!windowsRes.ok) {
    showFlash(windowsRes.data.error || "Could not load availability.", "danger");
    return;
  }

  const availability = normalizeAvailabilityResponse(windowsRes.data || {});
  availabilityModeSelect.value = availability.mode;
  availabilityStartDateInput.value = availability.start_date || todayIso();
  availabilityEndDateInput.value = availability.end_date || plusDaysIso(30);
  updateAvailabilityModeHelp();
  renderAvailabilityRows(availability.windows, availability.mode);
}

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
    showFlash("Create at least one event type before setting availability.", "danger");
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

  const { ok, data } = await apiFetch(`/api/bookings/availability?event_type_id=${encodeURIComponent(requestedEventTypeId)}`, {
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
});

(async () => {
  const user = await requireAuth();
  if (!user) return;
  redirectToSetupIfNoEventType();
  updateAvailabilityModeHelp();
  await loadAvailability();
})();
