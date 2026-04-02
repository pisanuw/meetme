const params = new URLSearchParams(window.location.search);
const hostSlug = params.get("host") || "";
const preselectedEvent = params.get("event") || "";

const eventSelect = document.getElementById("event-select");
const dateInput = document.getElementById("book-date");
const slotsGrid = document.getElementById("slots-grid");
const bookBtn = document.getElementById("book-btn");
const prevWeekBtn = document.getElementById("prev-week-btn");
const nextWeekBtn = document.getElementById("next-week-btn");
const weekLabel = document.getElementById("week-label");

const DAYS_PER_PAGE = 7;

let selectedSlot = "";
let selectedDate = "";
let eventTypes = [];
let weekStartDate = "";
let expandedDate = "";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtDate(isoDate) {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtShortDate(isoDate) {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getSelectedEventType() {
  return eventTypes.find((et) => et.id === eventSelect.value) || null;
}

function getFirstAvailableDateForSelectedEvent() {
  const eventType = getSelectedEventType();
  const availability = eventType?.availability || {};
  const minDate = availability.start_date || "";

  if (minDate) return minDate;
  return todayIso();
}

function getWeekDates() {
  const start = weekStartDate || getFirstAvailableDateForSelectedEvent();
  return Array.from({ length: DAYS_PER_PAGE }, (_, i) => addDays(start, i));
}

function updateWeekLabel() {
  const dates = getWeekDates();
  weekLabel.textContent = `${fmtShortDate(dates[0])} – ${fmtShortDate(dates[dates.length - 1])}`;
  const firstAllowedDate = getFirstAvailableDateForSelectedEvent();
  prevWeekBtn.disabled = !weekStartDate || weekStartDate <= firstAllowedDate;
  dateInput.value = dates[0] || "";
}

function clearSelection() {
  selectedSlot = "";
  selectedDate = "";
  bookBtn.disabled = true;
}

function renderWeekSlots(dayResults) {
  clearSelection();
  slotsGrid.innerHTML = "";

  let anySlots = false;
  const firstAvailableDate = dayResults.find(({ slots }) => slots.length)?.date || dayResults[0]?.date || "";
  if (!expandedDate || !dayResults.some(({ date }) => date === expandedDate)) {
    expandedDate = firstAvailableDate;
  }

  dayResults.forEach(({ date, slots }) => {
    if (slots.length) anySlots = true;

    const dayDiv = document.createElement("div");
    dayDiv.className = "slots-day";

    const label = document.createElement("button");
    label.type = "button";
    label.className = `slots-day-label${date === expandedDate ? " active" : ""}`;
    label.textContent = `${fmtDate(date)}${slots.length ? ` · ${slots.length} slot${slots.length === 1 ? "" : "s"}` : " · No availability"}`;
    label.addEventListener("click", () => {
      expandedDate = date;
      renderWeekSlots(dayResults);
    });
    dayDiv.appendChild(label);

    if (date === expandedDate && !slots.length) {
      const empty = document.createElement("span");
      empty.className = "text-muted slots-day-empty";
      empty.textContent = "No availability";
      dayDiv.appendChild(empty);
    } else if (date === expandedDate) {
      const row = document.createElement("div");
      row.className = "chips-row";
      slots.forEach((slot) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "date-chip removable";
        btn.textContent = slot;
        btn.dataset.date = date;
        btn.dataset.slot = slot;
        btn.addEventListener("click", () => {
          selectedSlot = slot;
          selectedDate = date;
          slotsGrid.querySelectorAll("button.active").forEach((x) => x.classList.remove("active"));
          btn.classList.add("active");
          bookBtn.disabled = false;
        });
        row.appendChild(btn);
      });
      dayDiv.appendChild(row);
    }

    slotsGrid.appendChild(dayDiv);
  });

  if (!anySlots) {
    const msg = document.createElement("p");
    msg.className = "text-muted";
    msg.textContent = "No available slots in this period.";
    slotsGrid.prepend(msg);
  }
}

async function loadWeekSlots() {
  const eventTypeId = eventSelect.value;
  if (!eventTypeId) return;

  slotsGrid.innerHTML = `<span class="text-muted">Loading...</span>`;
  clearSelection();

  const eventType = getSelectedEventType();
  const availability = eventType?.availability || {};
  const minDate = availability.start_date || "";
  const maxDate = availability.end_date || "";

  const dates = getWeekDates().filter((d) => {
    if (minDate && d < minDate) return false;
    if (maxDate && d > maxDate) return false;
    return true;
  });

  const results = await Promise.all(
    dates.map(async (date) => {
      const { ok, data } = await apiFetch(
        `/api/bookings/page/${encodeURIComponent(hostSlug)}/slots?event_type_id=${encodeURIComponent(eventTypeId)}&date=${encodeURIComponent(date)}`
      );
      return { date, slots: ok ? (data.slots || []) : [] };
    })
  );

  renderWeekSlots(results);
}

bookBtn.addEventListener("click", async () => {
  if (!selectedSlot || !selectedDate) return;
  const payload = {
    event_type_id: eventSelect.value,
    date: selectedDate,
    start_time: selectedSlot,
  };

  const { ok, data } = await apiFetch(`/api/bookings/page/${encodeURIComponent(hostSlug)}/book`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!ok) {
    showFlash(data.error || "Could not create booking.", "danger");
    return;
  }

  const booking = data.booking || {};
  window.location.href = `/booking-confirmation.html?id=${encodeURIComponent(booking.id || "")}`;
});

prevWeekBtn.addEventListener("click", () => {
  const firstAllowedDate = getFirstAvailableDateForSelectedEvent();
  if (!weekStartDate || weekStartDate <= firstAllowedDate) return;
  const nextStart = addDays(weekStartDate, -DAYS_PER_PAGE);
  weekStartDate = nextStart < firstAllowedDate ? firstAllowedDate : nextStart;
  expandedDate = "";
  updateWeekLabel();
  loadWeekSlots();
});

nextWeekBtn.addEventListener("click", () => {
  weekStartDate = addDays(weekStartDate || getFirstAvailableDateForSelectedEvent(), DAYS_PER_PAGE);
  expandedDate = "";
  updateWeekLabel();
  loadWeekSlots();
});

(async () => {
  const user = await requireAuth();
  if (!user) return;

  if (!hostSlug) {
    showFlash("Missing host in URL. Use ?host=<slug>", "danger");
    return;
  }

  const { ok, data } = await apiFetch(`/api/bookings/page/${encodeURIComponent(hostSlug)}`);
  if (!ok) {
    showFlash(data.error || "Could not load booking page.", "danger");
    return;
  }

  document.getElementById("book-title").textContent = `Book Time with ${data.owner?.name || data.owner?.email || hostSlug}`;
  document.getElementById("book-host").textContent = `Host: ${data.owner?.name || data.owner?.email || hostSlug}`;

  eventTypes = data.event_types || [];
  eventSelect.innerHTML = eventTypes
    .map((et) => {
      const selected = et.id === preselectedEvent ? "selected" : "";
      return `<option value="${et.id}" ${selected}>${escapeHtml(et.title)} (${et.duration_minutes}m)</option>`;
    })
    .join("");

  weekStartDate = getFirstAvailableDateForSelectedEvent();
  updateWeekLabel();

  eventSelect.addEventListener("change", async () => {
    weekStartDate = getFirstAvailableDateForSelectedEvent();
    expandedDate = "";
    updateWeekLabel();
    await loadWeekSlots();
  });

  await loadWeekSlots();
})();
