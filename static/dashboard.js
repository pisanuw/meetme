/**
 * dashboard.js — Dashboard page controller
 *
 * All page state is scoped inside the init IIFE. Functions close over state
 * instead of reading/writing module-level globals, eliminating hidden coupling
 * between sections.
 *
 * External dependencies (from common.js): apiFetch, showFlash, requireAuth, escapeHtml
 */

(async () => {
  // ── Page state ─────────────────────────────────────────────────────────────
  let currentUser = null;
  let currentHostBookings = [];
  let currentMyBookings = [];
  let currentEventTypes = [];

  // ── Pure helpers ───────────────────────────────────────────────────────────
  function sortBookingsByDate(bookings) {
    return [...bookings].sort((a, b) => {
      const aKey = `${a.date || "9999-12-31"}T${a.start_time || "23:59"}`;
      const bKey = `${b.date || "9999-12-31"}T${b.start_time || "23:59"}`;
      return aKey.localeCompare(bKey);
    });
  }

  function copyText(text) {
    return navigator.clipboard.writeText(text);
  }

  function buildReminderRunMessage(result = {}) {
    const sent = Number(result.sent_count || 0);
    const skipped = Number(result.skipped_count || 0);
    const failed = Number(result.failed_count || 0);

    if (sent === 0 && failed === 0 && skipped > 0) {
      return "No reminders were sent for upcoming bookings in the selected window (already reminded or not eligible).";
    }
    if (sent === 0 && failed === 0 && skipped === 0) {
      return "No reminders were needed for upcoming bookings in the selected window.";
    }
    if (sent === 0 && failed > 0) {
      return `No reminders were sent. ${failed} failed and ${skipped} ${skipped === 1 ? "was" : "were"} skipped.`;
    }
    let message = `Sent ${sent} reminder${sent === 1 ? "" : "s"}.`;
    if (skipped > 0) message += " Some other bookings were not eligible in this window.";
    if (failed > 0) message += ` ${failed} failed.`;
    return message;
  }

  function getReminderTargetDetails(result = {}) {
    const reminderBookingIds = Array.isArray(result.reminder_booking_ids)
      ? result.reminder_booking_ids.filter(Boolean)
      : [];
    if (!reminderBookingIds.length || !currentHostBookings.length) return [];

    const bookingById = new Map(currentHostBookings.map((b) => [b.id, b]));
    return reminderBookingIds
      .map((bookingId) => bookingById.get(bookingId))
      .filter(Boolean)
      .map((b) => {
        const recipient = b.attendee_name || b.attendee_email || "attendee";
        const eventTitle = b.event_title || "booking";
        const when = [b.date, b.start_time, b.timezone].filter(Boolean).join(" ");
        return `${recipient} · ${eventTitle}${when ? ` · ${when}` : ""}`;
      });
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function setBookingsToolbarFeedback(message, type = "info") {
    const feedbackEl = document.getElementById("bookings-toolbar-feedback");
    if (!feedbackEl) return;
    feedbackEl.hidden = !message;
    feedbackEl.textContent = message || "";
    feedbackEl.classList.remove("success", "error");
    if (type === "success") feedbackEl.classList.add("success");
    if (type === "error") feedbackEl.classList.add("error");
    if (message) feedbackEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function setBookingsToolbarReminderDetails(items = []) {
    const listEl = document.getElementById("bookings-toolbar-reminder-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!Array.isArray(items) || items.length === 0) {
      listEl.hidden = true;
      return;
    }
    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      listEl.appendChild(li);
    });
    listEl.hidden = false;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function renderMeetings(containerId, meetings, isOwner) {
    const container = document.getElementById(containerId);
    container.innerHTML = "";

    if (!meetings || meetings.length === 0) {
      const emptyState = document.createElement("div");
      emptyState.className = "empty-state";
      if (isOwner) {
        emptyState.innerHTML = `
          <div class="empty-icon">📅</div>
          <p>You haven't created any meetings yet.</p>
          <a href="/create-meeting.html" class="btn btn-primary">Create your first meeting</a>
        `;
      } else {
        emptyState.innerHTML = `
          <div class="empty-icon">✉️</div>
          <p>You haven't been invited to any meetings yet.</p>
        `;
      }
      container.appendChild(emptyState);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "meeting-grid";

    for (const m of meetings) {
      const card = document.createElement("div");
      card.className = `meeting-card ${m.is_finalized ? "finalized" : ""}`;

      const top = document.createElement("div");
      top.className = "meeting-card-top";

      const titleDiv = document.createElement("div");
      const h3 = document.createElement("h3");
      h3.className = "meeting-title";
      const a = document.createElement("a");
      a.href = `/meeting.html?id=${encodeURIComponent(m.id)}`;
      a.textContent = m.title;
      h3.appendChild(a);

      const meta = document.createElement("span");
      meta.className = "meeting-meta";
      let metaText = `${(m.meeting_type || "").replace("_", " ")} · ${m.respond_count || 0}/${m.invite_count || 0} responded`;
      if (!isOwner && m.creator_name) metaText += ` · Organized by ${m.creator_name}`;
      meta.textContent = metaText;
      titleDiv.append(h3, meta);

      const badge = document.createElement("span");
      if (m.is_finalized) {
        badge.className = "badge badge-green";
        badge.textContent = "Finalized";
      } else if (isOwner) {
        badge.className = "badge badge-blue";
        badge.textContent = "Open";
      } else if (m.user_has_responded) {
        badge.className = "badge badge-blue";
        badge.textContent = "Waiting for organizer";
      } else {
        badge.className = "badge badge-orange";
        badge.textContent = "Needs your input";
      }
      top.append(titleDiv, badge);
      card.appendChild(top);

      if (m.description) {
        const desc = document.createElement("p");
        desc.className = "meeting-desc";
        desc.textContent = m.description;
        card.appendChild(desc);
      }

      const datesDiv = document.createElement("div");
      datesDiv.className = "meeting-dates";
      const dates = m.dates_or_days || [];
      dates.slice(0, 4).forEach((d) => {
        const s = document.createElement("span");
        s.className = "date-chip";
        s.textContent = d;
        datesDiv.appendChild(s);
      });
      if (dates.length > 4) {
        const s = document.createElement("span");
        s.className = "date-chip muted";
        s.textContent = `+${dates.length - 4} more`;
        datesDiv.appendChild(s);
      }
      card.appendChild(datesDiv);

      if (m.is_finalized) {
        const finInfo = document.createElement("div");
        finInfo.className = "finalized-info";
        finInfo.innerHTML = `📅 <strong>${escapeHtml(m.finalized_date || "")}</strong> at <strong>${escapeHtml(m.finalized_slot || "")}</strong> (${m.duration_minutes} min)`;
        card.appendChild(finInfo);
      }

      const actions = document.createElement("div");
      actions.className = "meeting-actions";
      const btnView = document.createElement("a");
      btnView.href = `/meeting.html?id=${encodeURIComponent(m.id)}`;
      btnView.className = "btn btn-sm btn-primary";
      btnView.textContent = m.is_finalized ? "View" : isOwner ? "View" : m.user_has_responded ? "Update Availability" : "Add Availability";

      const btnAction = document.createElement("button");
      btnAction.className = "btn btn-sm btn-danger";
      btnAction.dataset.action = isOwner ? "delete" : "leave";
      btnAction.dataset.meetingId = m.id;
      btnAction.textContent = isOwner ? "Delete" : "Remove";

      actions.append(btnView, btnAction);
      card.appendChild(actions);
      grid.appendChild(card);
    }
    container.appendChild(grid);
  }

  function renderBookingLinks(eventTypes, hostSlug) {
    const container = document.getElementById("dashboard-booking-links");
    container.innerHTML = "";

    if (!eventTypes || eventTypes.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔗</div>
          <p>You haven't created any booking links yet.</p>
          <a href="/booking-setup.html" class="btn btn-primary">Create booking link</a>
        </div>
      `;
      return;
    }

    const grid = document.createElement("div");
    grid.className = "meeting-grid";

    eventTypes.forEach((item) => {
      const card = document.createElement("article");
      card.className = "meeting-card";
      const url = `${window.location.origin}/book.html?host=${encodeURIComponent(hostSlug)}&event=${encodeURIComponent(item.id)}`;

      card.innerHTML = `
        <div class="meeting-card-top">
          <div>
            <h3 class="meeting-title">${escapeHtml(item.title)}</h3>
            <span class="meeting-meta">${escapeHtml(item.duration_minutes)} min · ${escapeHtml(item.timezone || "UTC")}</span>
          </div>
          <span class="badge ${item.event_type === "group" ? "badge-orange" : "badge-blue"}">${escapeHtml(item.event_type || "one_on_one")}</span>
        </div>
        <p class="meeting-desc">${escapeHtml(item.description || "No description")}</p>
        <div class="booking-card-badges">
          <span class="badge badge-gray">${escapeHtml(item.day_start_time || "08:00")} - ${escapeHtml(item.day_end_time || "20:00")}</span>
          <span class="badge badge-gray">${item.availability?.window_count || 0} windows</span>
        </div>
        <div class="form-group booking-card-share-group">
          <label>Share URL</label>
          <input class="form-control" readonly value="${escapeHtml(url)}" />
        </div>
        <div class="meeting-actions">
          <a class="btn btn-sm btn-ghost" href="/booking-setup.html?edit=${encodeURIComponent(item.id)}">Edit</a>
          <a class="btn btn-sm btn-ghost" href="/booking-availability.html?eventType=${encodeURIComponent(item.id)}">Availability</a>
          <a class="btn btn-sm btn-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open</a>
          <button type="button" class="btn btn-sm btn-primary js-copy-link" data-link="${escapeHtml(url)}">Copy Link</button>
          <button type="button" class="btn btn-sm btn-danger js-delete-link" data-event-id="${escapeHtml(item.id)}">Delete</button>
        </div>
      `;

      grid.appendChild(card);
    });

    container.appendChild(grid);

    grid.querySelectorAll(".js-copy-link").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await copyText(btn.dataset.link);
          showFlash("Booking link copied.", "success");
        } catch {
          showFlash("Could not copy link.", "warning");
        }
      });
    });

    grid.querySelectorAll(".js-delete-link").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to delete this booking link? This cannot be undone.")) return;
        const eventId = btn.dataset.eventId;
        btn.disabled = true;
        btn.textContent = "Deleting...";
        const resp = await apiFetch(`/api/bookings/event-types/${encodeURIComponent(eventId)}/delete`, { method: "POST" });
        if (resp.ok) {
          const deletedBookings = Number(resp.data?.deleted_bookings || 0);
          const suffix = deletedBookings > 0
            ? ` (${deletedBookings} related booking${deletedBookings === 1 ? "" : "s"} removed)`
            : "";
          showFlash(`Booking link deleted${suffix}.`, "success");

          currentEventTypes = currentEventTypes.filter((et) => et.id !== eventId);
          currentHostBookings = currentHostBookings.filter((b) => b.event_type_id !== eventId);
          currentMyBookings = currentMyBookings.filter((b) => b.event_type_id !== eventId);
          renderDashboardBookings(currentHostBookings, currentMyBookings);
          configureBookingsToolbar(currentHostBookings, currentEventTypes.length > 0);

          const card = btn.closest(".meeting-card");
          if (card) card.remove();
          if (currentEventTypes.length === 0 || !grid.querySelector(".meeting-card")) {
            renderBookingLinks([], hostSlug);
          }
        } else {
          showFlash(resp.data.error || "Could not delete booking link.", "danger");
          btn.disabled = false;
          btn.textContent = "Delete";
        }
      });
    });
  }

  function renderDashboardBookings(hostBookings, attendeeBookings) {
    const container = document.getElementById("dashboard-my-bookings");
    container.innerHTML = "";

    const merged = [
      ...hostBookings.map((b) => ({ ...b, dashboard_role: "Host" })),
      ...attendeeBookings.map((b) => ({ ...b, dashboard_role: "Attendee" })),
    ];
    const deduped = Array.from(new Map(merged.map((b) => [b.id, b])).values());
    const activeBookings = deduped.filter((b) => b.status !== "cancelled");
    const bookings = sortBookingsByDate(activeBookings);

    if (!bookings.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🗓️</div>
          <p>You don't have any bookings yet.</p>
        </div>
      `;
      return;
    }

    const grid = document.createElement("div");
    grid.className = "meeting-grid";

    bookings.forEach((booking) => {
      const card = document.createElement("article");
      card.className = "meeting-card";

      const counterpart = booking.dashboard_role === "Host"
        ? booking.attendee_name || booking.attendee_email || "Attendee"
        : booking.host_name || booking.host_email || "Host";
      const counterpartLabel = booking.dashboard_role === "Host" ? "Attendee" : "Host";

      card.innerHTML = `
        <div class="meeting-card-top">
          <div>
            <h3 class="meeting-title">${escapeHtml(booking.event_title || "Booking")}</h3>
            <span class="meeting-meta">${escapeHtml(booking.date || "")} ${booking.start_time ? `· ${escapeHtml(booking.start_time)}` : ""} ${booking.timezone ? `· ${escapeHtml(booking.timezone)}` : ""}</span>
          </div>
          <span class="badge ${booking.dashboard_role === "Host" ? "badge-blue" : "badge-orange"}">${booking.dashboard_role}</span>
        </div>
        <div class="booking-card-badges">
          <span class="badge ${booking.status === "cancelled" ? "badge-gray" : "badge-green"}">${escapeHtml(booking.status || "confirmed")}</span>
          <span class="badge badge-gray">${escapeHtml(booking.event_kind || "")}</span>
        </div>
        <p class="meeting-desc">${counterpartLabel}: ${escapeHtml(counterpart)}</p>
        <div class="meeting-actions">
          <a class="btn btn-sm btn-primary" href="/booking-confirmation.html?id=${encodeURIComponent(booking.id || "")}">View</a>
          <button type="button" class="btn btn-sm btn-danger" data-booking-action="cancel" data-booking-id="${escapeHtml(booking.id || "")}" ${booking.status === "cancelled" ? "disabled" : ""}>Cancel</button>
        </div>
      `;

      grid.appendChild(card);
    });

    container.appendChild(grid);
  }

  function configureBookingsToolbar(hostBookings, hasBookingLinks) {
    const toolbar = document.getElementById("bookings-toolbar");
    const reminderWindowLabel = document.getElementById("reminder-window-label");
    const reminderWindow = document.getElementById("reminder-window");
    const sendRemindersBtn = document.getElementById("send-reminders-btn");
    const runSchedulerNowBtn = document.getElementById("run-scheduler-now-btn");
    if (!toolbar || !reminderWindowLabel || !reminderWindow || !sendRemindersBtn || !runSchedulerNowBtn) return;

    const activeHostBookings = hostBookings.filter((b) => b.status !== "cancelled");
    toolbar.hidden = !hasBookingLinks || !activeHostBookings.length;
    if (toolbar.hidden) {
      setBookingsToolbarFeedback("");
      return;
    }

    reminderWindowLabel.style.display = "inline-flex";
    reminderWindow.style.display = "inline-flex";
    sendRemindersBtn.style.display = "inline-flex";
    runSchedulerNowBtn.style.display = currentUser?.is_admin ? "inline-flex" : "none";
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function sendReminders() {
    const reminderWindow = document.getElementById("reminder-window");
    const sendRemindersBtn = document.getElementById("send-reminders-btn");
    if (!reminderWindow || !sendRemindersBtn) return;

    sendRemindersBtn.disabled = true;
    const originalLabel = sendRemindersBtn.textContent;
    sendRemindersBtn.textContent = "Sending...";

    const { ok, data } = await apiFetch("/api/bookings/reminders/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ within_hours: Number.parseInt(reminderWindow.value || "24", 10) }),
    });

    sendRemindersBtn.disabled = false;
    sendRemindersBtn.textContent = originalLabel;

    if (!ok) {
      showFlash(data.error || "Could not send reminders.", "danger");
      setBookingsToolbarFeedback(data.error || "Could not send reminders.", "error");
      setBookingsToolbarReminderDetails([]);
      return;
    }

    const message = buildReminderRunMessage(data);
    const details = getReminderTargetDetails(data);
    const visibleDetails = details.slice(0, 5);
    if (details.length > visibleDetails.length) {
      visibleDetails.push(`+${details.length - visibleDetails.length} more reminder${details.length - visibleDetails.length === 1 ? "" : "s"}`);
    }
    showFlash(message, "success");
    setBookingsToolbarFeedback(message, "success");
    setBookingsToolbarReminderDetails(visibleDetails);
  }

  async function runSchedulerNow() {
    const runSchedulerNowBtn = document.getElementById("run-scheduler-now-btn");
    if (!runSchedulerNowBtn) return;
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
      setBookingsToolbarFeedback(data.error || "Could not run scheduler reminders.", "error");
      setBookingsToolbarReminderDetails([]);
      return;
    }

    const message = `Scheduler run complete: hosts ${data.host_count || 0}, sent ${data.sent_count || 0}, skipped ${data.skipped_count || 0}, failed ${data.failed_count || 0}.`;
    showFlash(message, "success");
    setBookingsToolbarFeedback(message, "success");
    setBookingsToolbarReminderDetails([]);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  const user = await requireAuth();
  if (!user) return;
  currentUser = user;

  document.getElementById("greeting").textContent = `Hello, ${user.name}`;

  const [meetingsRes, eventTypesRes, hostBookingsRes, myBookingsRes] = await Promise.all([
    apiFetch("/api/meetings"),
    apiFetch("/api/bookings/event-types"),
    apiFetch("/api/bookings/host"),
    apiFetch("/api/bookings/mine"),
  ]);

  if (meetingsRes.ok) {
    renderMeetings("my-meetings", meetingsRes.data.my_meetings, true);
    renderMeetings("invited-meetings", meetingsRes.data.invited_meetings, false);
  } else {
    showFlash(meetingsRes.data.error || `Failed to load meetings (HTTP ${meetingsRes.status}).`, "danger");
    renderMeetings("my-meetings", [], true);
    renderMeetings("invited-meetings", [], false);
  }

  if (eventTypesRes.ok) {
    currentEventTypes = eventTypesRes.data.event_types || [];
    renderBookingLinks(currentEventTypes, eventTypesRes.data.public_page_slug || "");
  } else {
    currentEventTypes = [];
    showFlash(eventTypesRes.data.error || "Failed to load booking links.", "danger");
    renderBookingLinks([], "");
  }

  if (hostBookingsRes.ok && myBookingsRes.ok) {
    currentHostBookings = hostBookingsRes.data.bookings || [];
    currentMyBookings = myBookingsRes.data.bookings || [];
    renderDashboardBookings(currentHostBookings, currentMyBookings);
    configureBookingsToolbar(currentHostBookings, currentEventTypes.length > 0);
  } else {
    currentHostBookings = [];
    currentMyBookings = [];
    showFlash(
      hostBookingsRes.data?.error || myBookingsRes.data?.error || "Failed to load bookings.",
      "danger"
    );
    renderDashboardBookings([], []);
    configureBookingsToolbar([], false);
    setBookingsToolbarReminderDetails([]);
  }

  const sendRemindersBtn = document.getElementById("send-reminders-btn");
  if (sendRemindersBtn) sendRemindersBtn.addEventListener("click", sendReminders);

  const runSchedulerNowBtn = document.getElementById("run-scheduler-now-btn");
  if (runSchedulerNowBtn) runSchedulerNowBtn.addEventListener("click", runSchedulerNow);

  // ── Delegated click handler (meeting delete/leave + booking cancel) ────────
  document.addEventListener("click", async (e) => {
    const bookingBtn = e.target.closest("button[data-booking-action][data-booking-id]");
    if (bookingBtn && bookingBtn.dataset.bookingAction === "cancel") {
      if (!window.confirm("Cancel this booking?")) return;
      const bookingId = bookingBtn.dataset.bookingId;
      const { ok, data } = await apiFetch(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!ok) {
        showFlash(data.error || "Could not cancel booking.", "danger");
        return;
      }
      const cancelledBooking = data.booking || {};
      const mergeCancelled = (list) =>
        list.map((b) => b.id === bookingId ? { ...b, ...cancelledBooking, status: "cancelled" } : b);
      currentHostBookings = mergeCancelled(currentHostBookings);
      currentMyBookings = mergeCancelled(currentMyBookings);
      renderDashboardBookings(currentHostBookings, currentMyBookings);
      configureBookingsToolbar(currentHostBookings, currentEventTypes.length > 0);
      showFlash("Booking cancelled.", "success");
      return;
    }

    const btn = e.target.closest("button[data-action][data-meeting-id]");
    if (!btn) return;
    const id = btn.dataset.meetingId;
    const action = btn.dataset.action;

    if (action === "delete") {
      if (!confirm("Delete this meeting?")) return;
      const { ok, status, data } = await apiFetch(`/api/meetings/${id}/delete`, { method: "POST" });
      if (ok) window.location.reload();
      else showFlash(data.error || `Failed to delete meeting (HTTP ${status}).`, "danger");
      return;
    }

    if (action === "leave") {
      if (!confirm("Remove this meeting from your dashboard?")) return;
      const { ok, status, data } = await apiFetch(`/api/meetings/${id}/leave`, { method: "POST" });
      if (ok) window.location.reload();
      else showFlash(data.error || `Failed to remove meeting (HTTP ${status}).`, "danger");
    }
  });
})();
