const weekdayOptions = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const availabilityGrid = document.getElementById("availability-grid");
const availabilityModeSelect = document.getElementById("availability-mode");
const availabilityStartDateInput = document.getElementById("availability-start-date");
const availabilityEndDateInput = document.getElementById("availability-end-date");
const availabilityTimezoneInput = document.getElementById("availability-timezone");
const availabilityModeHelp = document.getElementById("availability-mode-help");
const availabilityGateMessage = document.getElementById("availability-gate-message");
const availabilitySelectionSummary = document.getElementById("availability-selection-summary");
const saveAvailabilityBtn = document.getElementById("save-availability-btn");

const params = new URLSearchParams(window.location.search);
const requestedEventTypeId = params.get("eventType") || "";
const isNewEventType = params.get("new") === "1";

const TIME_STEP_MINUTES = 15;
const DAY_MINUTES = 24 * 60;

let userProfileTimezone = "UTC";
let hasEventTypes = false;
let allEventTypes = [];
let selectedSlots = new Set();
let gridColumns = [];
let isDragging = false;
let dragAction = null;

function buildTimeOptions() {
  const out = [];
  for (let mins = 0; mins < DAY_MINUTES; mins += TIME_STEP_MINUTES) {
    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    out.push(`${hh}:${mm}`);
  }
  return out;
}

const QUICK_TIME_OPTIONS = buildTimeOptions();

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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysIso(days) {
  const base = new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

function fmtTime(time) {
  const [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function fmtDate(isoDate) {
  const [y, mo, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function currentAvailabilityMode() {
  return availabilityModeSelect.value === "specific_dates" ? "specific_dates" : "weekly";
}

function slotKey(columnKey, time) {
  return `${columnKey}|${time}`;
}

function splitSlotKey(key) {
  const i = key.lastIndexOf("|");
  if (i === -1) return { columnKey: "", time: "" };
  return {
    columnKey: key.slice(0, i),
    time: key.slice(i + 1),
  };
}

function buildDateColumns(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return [];
  const out = [];
  const cursor = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    out.push({ key: iso, label: fmtDate(iso) });
    cursor.setDate(cursor.getDate() + 1);
  }

  return out;
}

function buildColumns() {
  if (currentAvailabilityMode() === "weekly") {
    return weekdayOptions.map((day) => ({ key: day, label: day.slice(0, 3) }));
  }
  return buildDateColumns(availabilityStartDateInput.value, availabilityEndDateInput.value);
}

function updateAvailabilityModeHelp() {
  if (currentAvailabilityMode() === "specific_dates") {
    availabilityModeHelp.textContent = "Specific dates mode uses the date range columns below; click slots on exact dates and times.";
    return;
  }
  availabilityModeHelp.textContent = "Weekly mode repeats selected weekdays within the date range.";
}

function setAvailabilityGate() {
  const controls = [
    availabilityModeSelect,
    availabilityStartDateInput,
    availabilityEndDateInput,
    availabilityTimezoneInput,
    saveAvailabilityBtn,
  ];
  const disabled = !hasEventTypes;

  controls.forEach((el) => {
    el.disabled = disabled;
  });

  if (disabled) {
    availabilityGateMessage.hidden = false;
    availabilityGateMessage.textContent =
      "You need at least one event type before setting availability. Create one on the Event Types page.";
    availabilityGrid.dataset.editing = "false";
  } else {
    availabilityGateMessage.hidden = true;
    availabilityGateMessage.textContent = "";
    availabilityGrid.dataset.editing = "true";
  }
}

function updateSelectionSummary() {
  const total = selectedSlots.size;
  if (!total) {
    availabilitySelectionSummary.textContent = "No slots selected yet.";
    return;
  }
  availabilitySelectionSummary.textContent = `${total} slot${total === 1 ? "" : "s"} selected.`;
}

function paintCell(cell) {
  const selected = selectedSlots.has(cell.dataset.key);
  cell.classList.remove("mine-selected");
  cell.style.background = selected ? "#bbdefb" : "#f5f5f5";
  if (selected) cell.classList.add("mine-selected");
}

function repaintAllCells() {
  availabilityGrid.querySelectorAll(".ag-cell").forEach(paintCell);
}

function buildGrid() {
  gridColumns = buildColumns();
  availabilityGrid.innerHTML = "";
  availabilityGrid.style.setProperty("--cols", String(gridColumns.length));

  const corner = document.createElement("div");
  corner.className = "ag-corner ag-col-header";
  availabilityGrid.appendChild(corner);

  gridColumns.forEach((col) => {
    const header = document.createElement("div");
    header.className = "ag-col-header";
    header.textContent = col.label;
    availabilityGrid.appendChild(header);
  });

  QUICK_TIME_OPTIONS.forEach((time) => {
    const [, minute] = time.split(":").map(Number);
    const isHour = minute === 0;

    const lbl = document.createElement("div");
    lbl.className = `ag-time-label${isHour ? " hour-boundary" : ""}`;
    lbl.textContent = isHour ? fmtTime(time) : "";
    availabilityGrid.appendChild(lbl);

    gridColumns.forEach((col) => {
      const cell = document.createElement("div");
      cell.className = `ag-cell${isHour ? " hour-boundary" : ""}`;
      cell.dataset.column = col.key;
      cell.dataset.time = time;
      cell.dataset.key = slotKey(col.key, time);
      paintCell(cell);
      availabilityGrid.appendChild(cell);
    });
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

function applyWindowsToSelectedSlots(windows, mode) {
  selectedSlots.clear();

  const columnSet = new Set(gridColumns.map((c) => c.key));
  windows.forEach((windowItem) => {
    const columnKey = mode === "specific_dates" ? windowItem.date : windowItem.day_of_week;
    if (!columnKey || !columnSet.has(columnKey)) return;

    const start = Math.max(0, Math.min(DAY_MINUTES, toMinutes(windowItem.start_time || "00:00")));
    const end = Math.max(0, Math.min(DAY_MINUTES, toMinutes(windowItem.end_time || "00:00")));
    if (end <= start) return;

    for (let mins = start; mins < end; mins += TIME_STEP_MINUTES) {
      selectedSlots.add(slotKey(columnKey, fromMinutes(mins)));
    }
  });
}

function collectWindowsFromSelectedSlots(mode) {
  const byColumn = new Map();
  selectedSlots.forEach((key) => {
    const { columnKey, time } = splitSlotKey(key);
    if (!columnKey || !time) return;
    if (!byColumn.has(columnKey)) byColumn.set(columnKey, []);
    byColumn.get(columnKey).push(toMinutes(time));
  });

  const timezone = (availabilityTimezoneInput.value || userProfileTimezone || "UTC").trim() || "UTC";
  const windows = [];

  byColumn.forEach((minuteList, columnKey) => {
    minuteList.sort((a, b) => a - b);
    if (!minuteList.length) return;

    let runStart = minuteList[0];
    let runEnd = runStart + TIME_STEP_MINUTES;

    for (let i = 1; i < minuteList.length; i += 1) {
      const current = minuteList[i];
      if (current === runEnd) {
        runEnd += TIME_STEP_MINUTES;
      } else {
        const windowPayload = {
          start_time: fromMinutes(runStart),
          end_time: fromMinutes(runEnd),
          timezone,
        };
        if (mode === "specific_dates") windowPayload.date = columnKey;
        else windowPayload.day_of_week = columnKey;
        windows.push(windowPayload);

        runStart = current;
        runEnd = current + TIME_STEP_MINUTES;
      }
    }

    const lastWindow = {
      start_time: fromMinutes(runStart),
      end_time: fromMinutes(runEnd),
      timezone,
    };
    if (mode === "specific_dates") lastWindow.date = columnKey;
    else lastWindow.day_of_week = columnKey;
    windows.push(lastWindow);
  });

  return windows;
}

function pruneSlotsOutsideColumns() {
  const validColumns = new Set(gridColumns.map((c) => c.key));
  const next = new Set();
  selectedSlots.forEach((key) => {
    const { columnKey } = splitSlotKey(key);
    if (validColumns.has(columnKey)) next.add(key);
  });
  selectedSlots = next;
}

function redirectToSetupIfNoEventType() {
  if (requestedEventTypeId) return false;
  window.location.href = "/booking-setup.html?error=no-event-type-selected";
  return true;
}

function setupForNewEventType() {
  availabilityModeSelect.value = "weekly";
  availabilityStartDateInput.value = todayIso();
  availabilityEndDateInput.value = plusDaysIso(30);
  availabilityTimezoneInput.value = userProfileTimezone || "UTC";
  selectedSlots.clear();
  updateAvailabilityModeHelp();
  buildGrid();
  updateSelectionSummary();

  const cleanUrl = `${window.location.pathname}?eventType=${encodeURIComponent(requestedEventTypeId)}`;
  window.history.replaceState({}, document.title, cleanUrl);
}

async function loadInitialData() {
  const profile = await apiFetch("/api/auth/profile");
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  userProfileTimezone = profile.ok ? profile.data.timezone || browserTz : browserTz;

  const eventTypesRes = await apiFetch("/api/bookings/event-types");
  if (!eventTypesRes.ok) {
    showFlash(eventTypesRes.data.error || "Could not load event types.", "danger");
    return false;
  }
  allEventTypes = eventTypesRes.data.event_types || [];
  hasEventTypes = allEventTypes.length > 0;
  if (!availabilityTimezoneInput.value) availabilityTimezoneInput.value = userProfileTimezone || "UTC";
  return true;
}

async function loadAndRenderExistingAvailability(eventTypeId) {
  const windowsRes = await apiFetch(`/api/bookings/availability?event_type_id=${encodeURIComponent(eventTypeId)}`);
  if (!windowsRes.ok) {
    showFlash(windowsRes.data.error || "Could not load availability.", "danger");
    return;
  }

  const availability = normalizeAvailabilityResponse(windowsRes.data || {});
  availabilityModeSelect.value = availability.mode;
  availabilityStartDateInput.value = availability.start_date || todayIso();
  availabilityEndDateInput.value = availability.end_date || plusDaysIso(30);

  const firstTz = availability.windows.find((w) => w.timezone)?.timezone;
  availabilityTimezoneInput.value = firstTz || userProfileTimezone || "UTC";

  updateAvailabilityModeHelp();
  buildGrid();
  applyWindowsToSelectedSlots(availability.windows, availability.mode);
  repaintAllCells();
  updateSelectionSummary();
}

async function saveAvailability() {
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
  const windows = collectWindowsFromSelectedSlots(mode);
  if (!windows.length) {
    showFlash("Select at least one available time slot.", "danger");
    return;
  }

  const timezone = (availabilityTimezoneInput.value || userProfileTimezone || "UTC").trim() || "UTC";

  const { ok, data } = await apiFetch(`/api/bookings/availability?event_type_id=${encodeURIComponent(requestedEventTypeId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type_id: requestedEventTypeId,
      mode,
      start_date: startDate,
      end_date: endDate,
      timezone,
      windows,
    }),
  });

  if (!ok) {
    showFlash(data.error || "Could not save availability.", "danger");
    return;
  }
  window.location.href = "/booking-links.html";
}

function startDrag(cell) {
  if (!cell || !cell.classList.contains("ag-cell")) return;
  if (!hasEventTypes) return;
  isDragging = true;
  dragAction = selectedSlots.has(cell.dataset.key) ? "remove" : "add";
  applyDrag(cell);
}

function applyDrag(cell) {
  if (!cell || !cell.classList.contains("ag-cell")) return;
  const key = cell.dataset.key;
  if (dragAction === "add") selectedSlots.add(key);
  if (dragAction === "remove") selectedSlots.delete(key);
  paintCell(cell);
  updateSelectionSummary();
}

function endDrag() {
  if (!isDragging) return;
  isDragging = false;
}

function bindGridDragEvents() {
  let lastTouchTime = 0;

  availabilityGrid.addEventListener("mousedown", (e) => {
    if (Date.now() - lastTouchTime < 500) return;
    const cell = e.target.closest(".ag-cell");
    if (!cell) return;
    startDrag(cell);
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".ag-cell");
    if (cell) applyDrag(cell);
  });

  document.addEventListener("mouseup", endDrag);

  availabilityGrid.addEventListener("touchstart", (e) => {
    lastTouchTime = Date.now();
    const touch = e.touches[0];
    const cell = document.elementFromPoint(touch.clientX, touch.clientY)?.closest?.(".ag-cell");
    if (cell) {
      e.preventDefault();
      startDrag(cell);
    }
  });

  availabilityGrid.addEventListener(
    "touchmove",
    (e) => {
      if (!isDragging) return;
      const touch = e.touches[0];
      const cell = document.elementFromPoint(touch.clientX, touch.clientY)?.closest?.(".ag-cell");
      if (cell) applyDrag(cell);
    },
    { passive: true }
  );

  availabilityGrid.addEventListener("touchend", endDrag);
}

function bindEventListeners() {
  bindGridDragEvents();

  availabilityModeSelect.addEventListener("change", () => {
    selectedSlots.clear();
    updateAvailabilityModeHelp();
    buildGrid();
    updateSelectionSummary();
  });

  const onDateRangeChange = () => {
    buildGrid();
    pruneSlotsOutsideColumns();
    repaintAllCells();
    updateSelectionSummary();
  };

  availabilityStartDateInput.addEventListener("change", onDateRangeChange);
  availabilityEndDateInput.addEventListener("change", onDateRangeChange);

  saveAvailabilityBtn.addEventListener("click", saveAvailability);
}

async function init() {
  const user = await requireAuth();
  if (!user) return;

  if (redirectToSetupIfNoEventType()) return;

  availabilityStartDateInput.value = todayIso();
  availabilityEndDateInput.value = plusDaysIso(30);
  availabilityTimezoneInput.value = "UTC";

  updateAvailabilityModeHelp();
  bindEventListeners();

  await loadInitialData();

  if (requestedEventTypeId) {
    const currentEventType = allEventTypes.find((et) => et.id === requestedEventTypeId);
    if (currentEventType) {
      const heading = document.querySelector("h1");
      if (heading) {
        const sub = document.createElement("div");
        sub.id = "availability-event-type";
        sub.className = "text-muted h3";
        sub.style.marginTop = "-0.5rem";
        sub.style.marginBottom = "1.5rem";
        sub.textContent = currentEventType.title;
        heading.insertAdjacentElement("afterend", sub);
      }
    }
  }

  setAvailabilityGate();

  if (isNewEventType) {
    setupForNewEventType();
  } else if (requestedEventTypeId) {
    await loadAndRenderExistingAvailability(requestedEventTypeId);
  } else {
    buildGrid();
    updateSelectionSummary();
  }
}

init();
