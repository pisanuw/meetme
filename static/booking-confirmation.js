const params = new URLSearchParams(window.location.search);
const bookingId = params.get("id") || "";

const subtitleEl = document.getElementById("confirmation-subtitle");
const detailsEl = document.getElementById("confirmation-details");

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

  const { ok, data } = await apiFetch(`/api/bookings/${encodeURIComponent(bookingId)}`);
  if (!ok) {
    subtitleEl.textContent = "Could not load booking details.";
    showFlash(data.error || "Could not load booking details.", "danger");
    return;
  }

  const booking = data.booking || {};
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
})();
