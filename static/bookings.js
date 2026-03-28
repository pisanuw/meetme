const gridEl = document.getElementById("bookings-grid");
const tabHost = document.getElementById("tab-host");
const tabMine = document.getElementById("tab-mine");
const reminderWindowLabel = document.getElementById("reminder-window-label");
const reminderWindow = document.getElementById("reminder-window");
const sendRemindersBtn = document.getElementById("send-reminders-btn");
const runSchedulerNowBtn = document.getElementById("run-scheduler-now-btn");

let hostBookings = [];
let myBookings = [];
let activeTab = "host";
let currentUser = null;

function bookingCard(booking) {
  const cancelled = booking.status === "cancelled";
  return `
    <article class="meeting-card">
      <h3>${escapeHtml(booking.event_title || "Booking")}</h3>
      <p class="text-muted" style="margin-top: 6px;">
        ${escapeHtml(booking.date || "")}
        ${booking.start_time ? `at ${escapeHtml(booking.start_time)}` : ""}
        ${booking.timezone ? `(${escapeHtml(booking.timezone)})` : ""}
      </p>
      <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
        <span class="badge ${cancelled ? "badge-gray" : "badge-green"}">${escapeHtml(booking.status || "confirmed")}</span>
        <span class="badge badge-gray">${escapeHtml(booking.event_kind || "")}</span>
      </div>
      <div class="form-group" style="margin-top: 12px;">
        <label>Host</label>
        <div class="text-muted">${escapeHtml(booking.host_name || booking.host_email || "")}</div>
      </div>
      <div class="form-group" style="margin-top: 8px;">
        <label>Attendee</label>
        <div class="text-muted">${escapeHtml(booking.attendee_name || booking.attendee_email || "")}</div>
      </div>
      <div class="form-actions" style="margin-top: 12px;">
        <a class="btn btn-ghost" href="/booking-confirmation.html?id=${encodeURIComponent(booking.id || "")}">View</a>
        <button type="button" class="btn btn-danger js-cancel" data-id="${booking.id}" ${cancelled ? "disabled" : ""}>Cancel</button>
      </div>
    </article>
  `;
}

function renderBookings() {
  const list = activeTab === "host" ? hostBookings : myBookings;
  tabHost.classList.toggle("active", activeTab === "host");
  tabMine.classList.toggle("active", activeTab === "mine");
  reminderWindowLabel.style.display = activeTab === "host" ? "inline-flex" : "none";
  sendRemindersBtn.style.display = activeTab === "host" ? "inline-flex" : "none";
  reminderWindow.style.display = activeTab === "host" ? "inline-flex" : "none";
  runSchedulerNowBtn.style.display =
    activeTab === "host" && currentUser?.is_admin ? "inline-flex" : "none";

  if (!list.length) {
    gridEl.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <p>No bookings found in this view.</p>
      </div>
    `;
    return;
  }

  gridEl.innerHTML = list.map(bookingCard).join("");

  gridEl.querySelectorAll(".js-cancel").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Cancel this booking?")) return;
      const id = button.dataset.id;
      const { ok, data } = await apiFetch(`/api/bookings/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!ok) {
        showFlash(data.error || "Could not cancel booking.", "danger");
        return;
      }
      showFlash("Booking cancelled.", "success");
      await loadBookings();
    });
  });
}

async function loadBookings() {
  const [hostRes, mineRes] = await Promise.all([
    apiFetch("/api/bookings/host"),
    apiFetch("/api/bookings/mine"),
  ]);

  if (!hostRes.ok) {
    showFlash(hostRes.data.error || "Could not load host bookings.", "danger");
    return;
  }
  if (!mineRes.ok) {
    showFlash(mineRes.data.error || "Could not load attendee bookings.", "danger");
    return;
  }

  hostBookings = hostRes.data.bookings || [];
  myBookings = mineRes.data.bookings || [];
  renderBookings();
}

tabHost.addEventListener("click", () => {
  activeTab = "host";
  renderBookings();
});

tabMine.addEventListener("click", () => {
  activeTab = "mine";
  renderBookings();
});

sendRemindersBtn.addEventListener("click", async () => {
  sendRemindersBtn.disabled = true;
  const originalLabel = sendRemindersBtn.textContent;
  sendRemindersBtn.textContent = "Sending...";

  const { ok, data } = await apiFetch("/api/bookings/reminders/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      within_hours: Number.parseInt(reminderWindow.value || "24", 10),
    }),
  });

  sendRemindersBtn.disabled = false;
  sendRemindersBtn.textContent = originalLabel;

  if (!ok) {
    showFlash(data.error || "Could not send reminders.", "danger");
    return;
  }

  showFlash(
    `Reminder run complete: sent ${data.sent_count || 0}, skipped ${data.skipped_count || 0}, failed ${data.failed_count || 0}.`,
    "success"
  );
});

runSchedulerNowBtn.addEventListener("click", async () => {
  if (!confirm("Run scheduler reminders for all hosts now?")) return;

  runSchedulerNowBtn.disabled = true;
  const originalLabel = runSchedulerNowBtn.textContent;
  runSchedulerNowBtn.textContent = "Running...";

  const { ok, data } = await apiFetch("/api/bookings/reminders/run-now", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  runSchedulerNowBtn.disabled = false;
  runSchedulerNowBtn.textContent = originalLabel;

  if (!ok) {
    showFlash(data.error || "Could not run scheduler reminders.", "danger");
    return;
  }

  showFlash(
    `Scheduler run complete: hosts ${data.host_count || 0}, sent ${data.sent_count || 0}, skipped ${data.skipped_count || 0}, failed ${data.failed_count || 0}.`,
    "success"
  );
});

(async () => {
  const user = await requireAuth();
  if (!user) return;
  currentUser = user;
  await loadBookings();
})();
