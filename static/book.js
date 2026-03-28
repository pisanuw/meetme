const params = new URLSearchParams(window.location.search);
const hostSlug = params.get("host") || "";
const preselectedEvent = params.get("event") || "";

const eventSelect = document.getElementById("event-select");
const dateInput = document.getElementById("book-date");
const slotsGrid = document.getElementById("slots-grid");
const bookBtn = document.getElementById("book-btn");

let selectedSlot = "";

function renderSlots(slots) {
  slotsGrid.innerHTML = "";
  selectedSlot = "";
  bookBtn.disabled = true;

  if (!slots.length) {
    slotsGrid.innerHTML = `<span class="text-muted">No slots available for this day.</span>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  slots.forEach((slot) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "date-chip removable";
    btn.textContent = slot;
    btn.addEventListener("click", () => {
      selectedSlot = slot;
      [...slotsGrid.querySelectorAll("button")].forEach((x) => x.classList.remove("active"));
      btn.classList.add("active");
      bookBtn.disabled = false;
    });
    fragment.appendChild(btn);
  });
  slotsGrid.appendChild(fragment);
}

async function loadSlots() {
  const eventTypeId = eventSelect.value;
  const date = dateInput.value;
  if (!eventTypeId || !date) {
    renderSlots([]);
    return;
  }

  const { ok, data } = await apiFetch(
    `/api/bookings/page/${encodeURIComponent(hostSlug)}/slots?event_type_id=${encodeURIComponent(eventTypeId)}&date=${encodeURIComponent(date)}`
  );
  if (!ok) {
    showFlash(data.error || "Could not load available slots.", "danger");
    renderSlots([]);
    return;
  }
  renderSlots(data.slots || []);
}

bookBtn.addEventListener("click", async () => {
  if (!selectedSlot) return;
  const payload = {
    event_type_id: eventSelect.value,
    date: dateInput.value,
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

  document.getElementById("book-title").textContent =
    `Book Time with ${data.owner?.name || data.owner?.email || hostSlug}`;
  document.getElementById("book-host").textContent =
    `Host: ${data.owner?.name || data.owner?.email || hostSlug}`;

  const eventTypes = data.event_types || [];
  eventSelect.innerHTML = eventTypes
    .map((eventType) => {
      const selected = eventType.id === preselectedEvent ? "selected" : "";
      return `<option value="${eventType.id}" ${selected}>${escapeHtml(eventType.title)} (${eventType.duration_minutes}m)</option>`;
    })
    .join("");

  const today = new Date().toISOString().slice(0, 10);
  dateInput.value = today;

  eventSelect.addEventListener("change", loadSlots);
  dateInput.addEventListener("change", loadSlots);
  await loadSlots();
})();
