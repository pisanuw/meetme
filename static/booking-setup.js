const params = new URLSearchParams(window.location.search);
const editEventTypeId = params.get("edit") || "";

if (params.get("error") === "no-event-type-selected") {
  showFlash("No event type selected. Please create or select an event type first.", "danger");
  const cleanUrl = window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);
}

let userProfileTimezone = "UTC";

async function loadProfile() {
  const profile = await apiFetch("/api/auth/profile");
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  userProfileTimezone = profile.ok ? profile.data.timezone || browserTz : browserTz;
  document.getElementById("event-timezone").value = userProfileTimezone;
}

async function loadEventTypeForEdit(id) {
  const res = await apiFetch("/api/bookings/event-types");
  if (!res.ok) {
    showFlash(res.data.error || "Could not load event type.", "danger");
    return;
  }
  const item = (res.data.event_types || []).find((et) => et.id === id);
  if (!item) {
    showFlash("Event type not found.", "danger");
    return;
  }
  document.getElementById("event-type-id").value = item.id;
  document.getElementById("event-title").value = item.title || "";
  document.getElementById("event-description").value = item.description || "";
  document.getElementById("event-kind").value = item.event_type || "one_on_one";
  document.getElementById("event-duration").value = String(item.duration_minutes || 30);
  document.getElementById("event-capacity").value = String(item.group_capacity || 1);
  document.getElementById("event-timezone").value = item.timezone || userProfileTimezone || "UTC";
  document.getElementById("page-heading").textContent = "Edit Booking";
  document.title = "Edit Booking \u2013 MeetMe";
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
  if (isNew) {
    window.location.href = `/booking-availability.html?eventType=${encodeURIComponent(data.event_type.id)}&new=1`;
  } else {
    window.location.href = "/booking-links.html";
  }
});

(async () => {
  const user = await requireAuth();
  if (!user) return;
  await loadProfile();
  if (editEventTypeId) {
    await loadEventTypeForEdit(editEventTypeId);
  }
})();
