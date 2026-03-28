const params = new URLSearchParams(window.location.search);
const bookingId = params.get("id") || "";

const subtitleEl = document.getElementById("confirmation-subtitle");
const detailsEl = document.getElementById("confirmation-details");
const actionsEl = document.getElementById("confirmation-actions");
const cancelBtn = document.getElementById("cancel-booking-btn");

let currentBooking = null;

function renderDetail(label, value) {
  return `
    <div class="form-group" style="margin-bottom: 10px;">
      <label>${escapeHtml(label)}</label>
      <div class="text-muted">${escapeHtml(value || "-")}</div>
    </div>
  `;
}

(async () => {
  const user = await requireAuth();
  if (!user) return;

  if (!bookingId) {
    subtitleEl.textContent = "Missing booking id in URL.";
    showFlash("Missing booking id in URL.", "danger");
    return;
  }

  async function loadBookingDetails() {
    const { ok, data } = await apiFetch(`/api/bookings/${encodeURIComponent(bookingId)}`);
    if (!ok) {
      subtitleEl.textContent = "Could not load booking details.";
      showFlash(data.error || "Could not load booking details.", "danger");
      actionsEl.style.display = "none";
      return;
    }

    const booking = data.booking || {};
    currentBooking = booking;
    subtitleEl.textContent = `Booking ${booking.status || "confirmed"}.`;

    detailsEl.innerHTML = [
      renderDetail("Event", booking.event_title),
      renderDetail("Date", booking.date),
      renderDetail("Time", `${booking.start_time || ""} ${booking.timezone ? `(${booking.timezone})` : ""}`.trim()),
      renderDetail("Host", booking.host_name || booking.host_email),
      renderDetail("Attendee", booking.attendee_name || booking.attendee_email),
      renderDetail("Status", booking.status),
    ].join("");
    detailsEl.style.display = "block";

    const canCancel = booking.status !== "cancelled";
    actionsEl.style.display = canCancel ? "flex" : "none";
  }

  cancelBtn.addEventListener("click", async () => {
    if (!currentBooking || currentBooking.status === "cancelled") return;
    if (!confirm("Cancel this booking?")) return;

    cancelBtn.disabled = true;
    const original = cancelBtn.textContent;
    cancelBtn.textContent = "Cancelling...";

    const { ok, data } = await apiFetch(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    cancelBtn.disabled = false;
    cancelBtn.textContent = original;

    if (!ok) {
      showFlash(data.error || "Could not cancel booking.", "danger");
      return;
    }

    showFlash("Booking cancelled.", "success");
    await loadBookingDetails();
  });

  await loadBookingDetails();
})();
