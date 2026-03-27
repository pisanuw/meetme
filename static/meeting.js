// Meeting data - loaded from API
let M = null;
let currentUser = null;
let currentView = "heatmap";
let currentPerson = 0;
let isDragging = false;
let dragAction = null;
let saveTimer = null;
let pendingFinalize = null;
let meetingTz = "UTC";
let viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
let showMeetingTz = false;
let busySlots = new Set();

(async () => {
  const user = await requireAuth();
  if (!user) return;
  currentUser = user;

  const params = new URLSearchParams(window.location.search);
  const meetingId = params.get("id");
  if (!meetingId) {
    window.location.href = "/dashboard.html";
    return;
  }

  const { ok, status, data } = await apiFetch(`/api/meetings/${meetingId}`);
  if (!ok) {
    showFlash(data.error || `Could not load meeting (HTTP ${status}).`, "danger");
    setTimeout(() => {
      window.location.href = "/dashboard.html";
    }, 2000);
    return;
  }

  M = {
    id: data.meeting.id,
    dates: data.meeting.dates_or_days,
    timeSlots: data.time_slots,
    mySlots: new Set(data.my_slots),
    slotCounts: data.slot_counts,
    totalInvited: data.total_invited,
    isCreator: data.is_creator,
    isFinalized: data.meeting.is_finalized,
    finalizedDate: data.meeting.finalized_date,
    finalizedSlot: data.meeting.finalized_slot,
    meetingType: data.meeting.meeting_type,
    participants: data.participants || [],
    meeting: data.meeting,
  };

  M.myParticipantIndex = -1;
  if (currentUser && Array.isArray(M.participants)) {
    let idx = currentUser.email
      ? M.participants.findIndex(
          (p) => (p.email || "").toLowerCase() === currentUser.email.toLowerCase()
        )
      : -1;
    if (idx === -1)
      idx = M.participants.findIndex(
        (p) => (p.name || "").toLowerCase() === (currentUser.name || "").toLowerCase()
      );
    M.myParticipantIndex = idx;
  }

  meetingTz = data.meeting.timezone || "UTC";

  const { ok: pOk, data: pData } = await apiFetch("/api/auth/profile");
  if (pOk && pData.timezone) viewerTz = pData.timezone;

  if (meetingTz && M.meetingType === "specific_dates") {
    const bar = document.getElementById("tz-bar");
    const lbl = document.getElementById("tz-label");
    const btn = document.getElementById("tz-toggle-btn");
    bar.style.display = "flex";
    lbl.textContent = viewerTz;
    btn.textContent = meetingTz !== viewerTz ? `Switch to meeting TZ (${meetingTz})` : "";
    btn.style.display = meetingTz !== viewerTz ? "" : "none";
  }

  if (pOk && pData.calendar_connected && M.meetingType === "specific_dates") {
    document.getElementById("gcal-area").style.display = "";
  }

  document.getElementById("meeting-page").style.display = "";
  document.title = `${M.meeting.title} – MeetMe`;

  document.getElementById("meeting-title").textContent = M.meeting.title;
  if (M.meeting.description) {
    document.getElementById("meeting-desc").textContent = M.meeting.description;
  }
  document.getElementById("meeting-type-badge").textContent = (M.meeting.meeting_type || "")
    .replace("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  document.getElementById("meeting-time-range").textContent =
    `${M.meeting.start_time} – ${M.meeting.end_time}`;
  document.getElementById("meeting-respond-count").textContent =
    `${data.respond_count}/${data.invite_count} responded`;

  document.getElementById("heatmap-instructions").textContent =
    `Showing combined availability for all ${data.invite_count} participant${data.invite_count !== 1 ? "s" : ""}.`;

  if (M.isFinalized) {
    document.getElementById("finalized-badge").style.display = "";
    const banner = document.getElementById("finalized-banner");
    banner.style.display = "";
    document.getElementById("finalized-time").innerHTML =
      `&#x1F4C5; ${escapeHtml(M.finalizedDate)} at ${fmtTime(M.finalizedSlot, M.finalizedDate)} (${M.meeting.duration_minutes} min)`;
    if (meetingTz && meetingTz !== "UTC") {
      document.getElementById("finalized-time").innerHTML +=
        ` <span style="font-size:0.75rem;color:var(--text-muted);">(${meetingTz})</span>`;
    }
    if (M.meeting.note) {
      document.getElementById("finalized-note").textContent = M.meeting.note;
    }
    if (M.isCreator) {
      document.getElementById("btn-unfinalize").style.display = "";
    }
  }

  const tabsContainer = document.getElementById("view-tabs");
  tabsContainer.innerHTML = `
    <button class="view-tab active" data-view="heatmap">&#x1F321; Group availability</button>
    ${!M.isFinalized ? '<button class="view-tab" data-view="mine">&#x270F; My availability</button>' : ""}
    ${M.isCreator && M.participants.length ? '<button class="view-tab" data-view="person">&#x1F464; By person</button>' : ""}
  `;
  tabsContainer.addEventListener("click", (e) => {
    const tab = e.target.closest(".view-tab[data-view]");
    if (!tab) return;
    setView(tab.dataset.view, tab);
  });

  if (M.isCreator && M.participants.length) {
    const sel = document.getElementById("person-select");
    const optParts = M.participants.map((p, i) =>
      `<option value="${i}">${escapeHtml(p.name)} (${p.slot_count} slot${p.slot_count !== 1 ? "s" : ""})${!p.responded ? " \u2013 no response" : ""}</option>`
    );
    sel.innerHTML += optParts.join("");
    sel.addEventListener("change", (e) => filterPerson(e.target.value));
  }

  if (M.participants.length > 0) {
    document.getElementById("participants-panel").style.display = "";
    document.getElementById("participant-count").textContent = `(${data.invite_count})`;
    const list = document.getElementById("participants-list");
    const rowParts = M.participants.map((p, i) => {
      const clickableAttrs = M.isCreator
        ? `data-participant-index="${i}" style="cursor:pointer;"`
        : "";
      return `
        <div class="participant-row" ${clickableAttrs}>
          <div class="participant-avatar">${escapeHtml((p.name || "?")[0].toUpperCase())}</div>
          <div class="participant-info">
            <div class="participant-name">${escapeHtml(p.name)}</div>
            ${M.isCreator && p.email ? `<div class="participant-email text-muted">${escapeHtml(p.email)}</div>` : ""}
          </div>
          <div class="participant-slots">
            ${
              p.responded
                ? `<span class="badge badge-green">${p.slot_count} slot${p.slot_count !== 1 ? "s" : ""}</span>`
                : '<span class="badge badge-gray">No response</span>'
            }
          </div>
        </div>`;
    });
    list.innerHTML += rowParts.join("");
    list.addEventListener("click", (e) => {
      if (!M.isCreator) return;
      const row = e.target.closest(".participant-row[data-participant-index]");
      if (!row) return;
      jumpToParticipant(Number(row.dataset.participantIndex));
    });
  }

  document.getElementById("tz-toggle-btn")?.addEventListener("click", toggleTzView);
  document.getElementById("copy-share-url-btn")?.addEventListener("click", copyShareUrl);
  document.getElementById("remind-pending-btn")?.addEventListener("click", sendPendingReminders);
  document.getElementById("gcal-btn")?.addEventListener("click", loadBusyTimes);
  document.getElementById("btn-confirm-finalize")?.addEventListener("click", confirmFinalize);
  document.getElementById("btn-cancel-finalize")?.addEventListener("click", cancelFinalize);

  if (M.isCreator) {
    const shareWrap = document.getElementById("share-controls");
    const shareInput = document.getElementById("share-url");
    const meetingUrl = `${window.location.origin}/meeting.html?id=${encodeURIComponent(M.id)}`;
    shareInput.value = meetingUrl;
    shareWrap.style.display = "";
  }

  const btnUnfinalize = document.getElementById("btn-unfinalize");
  if (btnUnfinalize) {
    btnUnfinalize.addEventListener("click", async () => {
      if (!confirm("Remove finalization and reopen for editing?")) return;
      const { ok, data: d } = await apiFetch(`/api/meetings/${M.id}/unfinalize`, {
        method: "POST",
      });
      if (ok && d.success) window.location.reload();
      else showFlash(d.error || "Failed to unfinalize. Please try again.", "danger");
    });
  }

  buildGrid();

  if (!M.isFinalized && M.mySlots.size === 0) {
    const mineTab = document.querySelector('[data-view="mine"]');
    if (mineTab) setView("mine", mineTab);
  }
})();

function heatColor(count) {
  if (!count || count === 0) return "#f5f5f5";
  const ratio = Math.min(count / Math.max(M.totalInvited, 1), 1);
  if (ratio <= 0) return "#f5f5f5";
  if (ratio <= 0.2) return "#e8f5e9";
  if (ratio <= 0.4) return "#c8e6c9";
  if (ratio <= 0.65) return "#81c784";
  if (ratio <= 0.85) return "#4caf50";
  return "#2e7d32";
}

function slotKey(date, time) {
  return `${date}_${time}`;
}

function fmtDate(d) {
  if (!d.includes("-")) return d;
  const [y, mo, day] = d.split("-").map(Number);
  const dt = new Date(y, mo - 1, day);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function fmtTime(t, date) {
  const displayTz = showMeetingTz ? meetingTz : viewerTz;
  if (date && date.includes("-") && meetingTz && displayTz !== meetingTz) {
    const converted = convertSlotTime(date, t, meetingTz, displayTz);
    if (converted) t = converted;
  }
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function convertSlotTime(date, time, fromTz, toTz) {
  try {
    if (!date.includes("-") || fromTz === toTz) return null;
    const [y, mo, d] = date.split("-").map(Number);
    const [h, m] = time.split(":").map(Number);
    const utcRef = Date.UTC(y, mo - 1, d, h, m);
    const refDate = new Date(utcRef);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: fromTz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(refDate);
    const get = (partType) => parseInt(parts.find((p) => p.type === partType)?.value || "0");
    const offsetMins = get("hour") * 60 + get("minute") - (h * 60 + m);
    const trueUtc = utcRef - offsetMins * 60000;
    return new Intl.DateTimeFormat("en-US", {
      timeZone: toTz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(trueUtc));
  } catch {
    return null;
  }
}

function toggleTzView() {
  showMeetingTz = !showMeetingTz;
  const lbl = document.getElementById("tz-label");
  const btn = document.getElementById("tz-toggle-btn");
  lbl.textContent = showMeetingTz ? meetingTz : viewerTz;
  btn.textContent = showMeetingTz
    ? `Switch to your TZ (${viewerTz})`
    : `Switch to meeting TZ (${meetingTz})`;
  buildGrid();
}

async function loadBusyTimes() {
  const btn = document.getElementById("gcal-btn");
  btn.disabled = true;
  btn.textContent = "Loading…";
  const { ok, data } = await apiFetch(`/api/calendar/busy?meeting_id=${M.id}`);
  if (ok && data.busy_slots) {
    busySlots = new Set(data.busy_slots);
    repaintAll();
    showFlash(
      `Loaded busy times (${busySlots.size} slot${busySlots.size !== 1 ? "s" : ""} marked busy). You can still override manually.`,
      "info"
    );
    btn.textContent = "Reload busy times";
  } else {
    showFlash(
      data?.error === "calendar_not_connected"
        ? "Google Calendar is not connected. Go to Profile to connect it."
        : data?.error || "Could not load calendar data.",
      "danger"
    );
    btn.textContent = "Load busy times";
  }
  btn.disabled = false;
}

async function sendPendingReminders() {
  if (!M?.isCreator) return;
  const btn = document.getElementById("remind-pending-btn");
  if (!btn) return;

  if (!confirm("Send reminder emails to participants who have not responded yet?")) return;

  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Sending…";

  const { ok, data } = await apiFetch(`/api/meetings/${M.id}/remind-pending`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  if (ok && data.success) {
    const failed = Number(data.failed_count || 0);
    const sent = Number(data.sent_count || 0);
    const msg =
      failed > 0
        ? `Sent ${sent} reminder${sent === 1 ? "" : "s"} (${failed} failed).`
        : data.message || `Sent ${sent} reminder${sent === 1 ? "" : "s"}.`;
    showFlash(msg, failed > 0 ? "warning" : "success");
  } else {
    showFlash(data?.error || "Could not send reminders. Please try again.", "danger");
  }

  btn.disabled = false;
  btn.textContent = prev;
}

async function copyShareUrl() {
  const input = document.getElementById("share-url");
  if (!input || !input.value) return;

  try {
    await navigator.clipboard.writeText(input.value);
    showFlash("Meeting URL copied.", "success");
  } catch {
    input.select();
    input.setSelectionRange(0, input.value.length);
    const ok = document.execCommand("copy");
    showFlash(
      ok ? "Meeting URL copied." : "Could not copy URL automatically.",
      ok ? "success" : "warning"
    );
  }
}

function mkEl(tag, cls) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  return d;
}

function buildGrid() {
  const grid = document.getElementById("av-grid");
  grid.innerHTML = "";
  const numCols = M.dates.length;
  grid.style.setProperty("--cols", numCols);

  const corner = mkEl("div", "ag-corner ag-col-header");
  grid.appendChild(corner);

  M.dates.forEach((d) => {
    const hdr = mkEl("div", "ag-col-header");
    if (M.isFinalized && d === M.finalizedDate) hdr.classList.add("is-finalized");
    hdr.innerHTML = `<div>${fmtDate(d)}</div>`;
    grid.appendChild(hdr);
  });

  M.timeSlots.forEach((time) => {
    const [, m] = time.split(":").map(Number);
    const isHour = m === 0;
    const lbl = mkEl("div", `ag-time-label${isHour ? " hour-boundary" : ""}`);
    lbl.textContent = isHour ? fmtTime(time, M.dates[0]) : "";
    grid.appendChild(lbl);

    M.dates.forEach((date) => {
      const key = slotKey(date, time);
      const cell = mkEl("div", `ag-cell${isHour ? " hour-boundary" : ""}`);
      cell.dataset.date = date;
      cell.dataset.time = time;
      cell.dataset.key = key;
      paintCell(cell);
      grid.appendChild(cell);
    });
  });

  if (!M.isFinalized) attachGridEvents(grid);
  if (M.isCreator && !M.isFinalized) {
    grid.addEventListener("click", (e) => {
      if (currentView !== "heatmap") return;
      const cell = e.target.closest(".ag-cell");
      if (!cell) return;
      showFinalizePanel(cell.dataset.date, cell.dataset.time);
    });
  }

  grid.addEventListener("mouseover", (e) => {
    if (currentView !== "heatmap") return;
    const cell = e.target.closest(".ag-cell");
    if (!cell) return;
    updateSlotDetail(cell.dataset.key, cell.dataset.date, cell.dataset.time);
  });
  grid.addEventListener("mouseleave", () => clearSlotDetail());
}

function updateSlotDetail(key, date, time) {
  const panel = document.getElementById("slot-detail");
  const heading = document.getElementById("slot-detail-heading");
  const availList = document.getElementById("slot-detail-available");
  const unavailList = document.getElementById("slot-detail-unavailable");
  const body = document.getElementById("slot-detail-body");
  const noParticipants = document.getElementById("slot-detail-no-participants");
  if (!panel) return;

  const count = M.slotCounts[key] || 0;
  const label = `${fmtDate(date)} at ${fmtTime(time, date)}`;
  heading.textContent = `${label} — ${count}/${M.totalInvited} available`;

  if (!M.participants || M.participants.length === 0) {
    body.style.display = "none";
    noParticipants.style.display = "";
    noParticipants.textContent = `${count} of ${M.totalInvited} participant${M.totalInvited !== 1 ? "s" : ""} available at this time.`;
    panel.style.display = "";
    return;
  }

  body.style.display = "grid";
  noParticipants.style.display = "none";
  availList.innerHTML = "";
  unavailList.innerHTML = "";

  const available = [];
  const unavailable = [];
  const noResponse = [];

  for (const p of M.participants) {
    if (p.slots.includes(key)) {
      available.push(p.name);
    } else if (p.responded) {
      unavailable.push(p.name);
    } else {
      noResponse.push(p.name);
    }
  }

  const mkLi = (text, color) => {
    const li = document.createElement("li");
    li.style.cssText = `padding:2px 0; color:${color};`;
    li.textContent = text;
    return li;
  };

  if (available.length === 0) {
    availList.appendChild(mkLi("—", "var(--text-muted)"));
  } else {
    available.forEach((n) => availList.appendChild(mkLi(n, "var(--text)")));
  }

  if (unavailable.length === 0 && noResponse.length === 0) {
    unavailList.appendChild(mkLi("—", "var(--text-muted)"));
  } else {
    unavailable.forEach((n) => unavailList.appendChild(mkLi(n, "var(--text)")));
    noResponse.forEach((n) =>
      unavailList.appendChild(mkLi(`${n} (no response)`, "var(--text-muted)"))
    );
  }

  panel.style.display = "";
}

function clearSlotDetail() {
  const panel = document.getElementById("slot-detail");
  if (panel) panel.style.display = "none";
}

function paintCell(cell) {
  const key = cell.dataset.key;
  const date = cell.dataset.date;
  const time = cell.dataset.time;
  const count = M.slotCounts[key] || 0;
  const isMine = M.mySlots.has(key);

  cell.style.background = "";
  cell.classList.remove("mine-selected", "finalized-cell", "person-highlighted");
  cell.removeAttribute("data-tip");

  if (M.isFinalized && date === M.finalizedDate && time === M.finalizedSlot) {
    cell.classList.add("finalized-cell");
  }

  if (currentView === "mine") {
    const isBusy = busySlots.has(key);
    cell.style.background = isBusy
      ? isMine
        ? "#90caf9"
        : "#ffcdd2"
      : isMine
        ? "#bbdefb"
        : "#f5f5f5";
    if (isMine) cell.classList.add("mine-selected");
    cell.dataset.tip = isBusy
      ? isMine
        ? "Busy on calendar (marked available anyway)"
        : "Busy on your Google Calendar"
      : isMine
        ? "You are available"
        : "Click to mark available";
  } else if (currentView === "heatmap") {
    cell.style.background = heatColor(count);
    if (isMine) cell.classList.add("mine-selected");
    cell.dataset.tip = count > 0 ? `${count}/${M.totalInvited} available` : "No one available";
  } else if (currentView === "person") {
    const p = M.participants[currentPerson];
    const pSlots = new Set(p ? p.slots : []);
    const isp = pSlots.has(key);
    cell.style.background = isp ? "#fff3e0" : count > 0 ? heatColor(count * 0.3) : "#f5f5f5";
    if (isp) cell.classList.add("person-highlighted");
    cell.dataset.tip = isp ? `${p.name} is available` : "";
  }
}

function repaintAll() {
  document.querySelectorAll(".ag-cell").forEach(paintCell);
}

function attachGridEvents(grid) {
  let lastTouchTime = 0;

  function startDrag(cell) {
    if (currentView !== "mine") return;
    if (!cell || !cell.classList.contains("ag-cell")) return;
    isDragging = true;
    dragAction = M.mySlots.has(cell.dataset.key) ? "remove" : "add";
    applyDrag(cell);
  }

  function applyDrag(cell) {
    if (!cell || !cell.classList.contains("ag-cell")) return;
    const key = cell.dataset.key;
    if (dragAction === "add") M.mySlots.add(key);
    if (dragAction === "remove") M.mySlots.delete(key);
    paintCell(cell);
  }

  function endDrag() {
    if (isDragging) {
      isDragging = false;
      scheduleSave();
    }
  }

  grid.addEventListener("mousedown", (e) => {
    if (Date.now() - lastTouchTime < 500) return;
    const cell = e.target.closest(".ag-cell");
    if (cell) {
      startDrag(cell);
      e.preventDefault();
    }
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".ag-cell");
    if (cell) applyDrag(cell);
  });

  document.addEventListener("mouseup", endDrag);

  grid.addEventListener("touchstart", (e) => {
    lastTouchTime = Date.now();
    e.preventDefault();
    const touch = e.touches[0];
    const cell = document.elementFromPoint(touch.clientX, touch.clientY)?.closest?.(".ag-cell");
    if (cell) startDrag(cell);
  });

  grid.addEventListener(
    "touchmove",
    (e) => {
      if (!isDragging) return;
      const touch = e.touches[0];
      const cell = document.elementFromPoint(touch.clientX, touch.clientY)?.closest?.(".ag-cell");
      if (cell) applyDrag(cell);
    },
    { passive: true }
  );

  grid.addEventListener("touchend", endDrag);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAvailability, 500);
}

async function saveAvailability() {
  const slots = Array.from(M.mySlots);
  const { ok, data } = await apiFetch(`/api/meetings/${M.id}/availability`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slots }),
  });
  if (ok && data.success) {
    M.slotCounts = data.slot_counts;
    if (M.myParticipantIndex >= 0) {
      const myEntry = M.participants[M.myParticipantIndex];
      if (myEntry) {
        myEntry.slots = Array.from(M.mySlots);
        myEntry.slot_count = myEntry.slots.length;
        myEntry.responded = myEntry.slot_count > 0;
      }
    }
    refreshParticipantsPanel();
    showSavedIndicator();
  } else if (!ok) {
    showFlash(data.error || "Failed to save availability. Please try again.", "danger");
  }
}

function showSavedIndicator() {
  let ind = document.getElementById("save-indicator");
  if (!ind) {
    ind = document.createElement("div");
    ind.id = "save-indicator";
    ind.style.cssText =
      "position:fixed;bottom:24px;right:24px;background:#2e7d32;color:white;padding:10px 18px;border-radius:8px;font-size:0.85rem;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:999;transition:opacity 0.3s;";
    document.body.appendChild(ind);
  }
  ind.textContent = "✓ Saved";
  ind.style.opacity = "1";
  clearTimeout(ind._timer);
  ind._timer = setTimeout(() => {
    ind.style.opacity = "0";
  }, 2000);
}

function refreshParticipantsPanel() {
  const list = document.getElementById("participants-list");
  if (!list || !M.participants || M.participants.length === 0) return;
  let html = "";
  M.participants.forEach((p, i) => {
    const clickableAttrs = M.isCreator
      ? `data-participant-index="${i}" style="cursor:pointer;"`
      : "";
    html += `
      <div class="participant-row" ${clickableAttrs}>
        <div class="participant-avatar">${escapeHtml((p.name || "?")[0].toUpperCase())}</div>
        <div class="participant-info">
          <div class="participant-name">${escapeHtml(p.name)}</div>
          ${M.isCreator && p.email ? `<div class="participant-email text-muted">${escapeHtml(p.email)}</div>` : ""}
        </div>
        <div class="participant-slots">
          ${
            p.responded
              ? `<span class="badge badge-green">${p.slot_count} slot${p.slot_count !== 1 ? "s" : ""}</span>`
              : '<span class="badge badge-gray">No response</span>'
          }
        </div>
      </div>`;
  });
  list.innerHTML = html;
}

function setView(view, btn) {
  currentView = view;
  document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  if (view !== "heatmap") clearSlotDetail();
  const editMode = view === "mine";
  document.getElementById("av-grid").dataset.editing = editMode;
  const editInst = document.getElementById("edit-instructions");
  const heatInst = document.getElementById("heatmap-instructions");
  if (editInst) editInst.style.display = editMode ? "" : "none";
  if (heatInst) heatInst.style.display = editMode ? "none" : "";
  const ps = document.getElementById("person-selector");
  if (ps) ps.style.display = view === "person" ? "" : "none";
  repaintAll();
}

function filterPerson(idx) {
  currentPerson = parseInt(idx, 10);
  repaintAll();
}

function jumpToParticipant(idx) {
  currentPerson = idx;
  const tab = document.querySelector('[data-view="person"]');
  if (tab) setView("person", tab);
  const sel = document.getElementById("person-select");
  if (sel) sel.value = idx;
}

function showFinalizePanel(date, time) {
  if (!M.isCreator || M.isFinalized) return;
  pendingFinalize = { date, time };
  const panel = document.getElementById("finalize-panel");
  if (!panel) return;
  panel.style.display = "";
  const lbl = document.getElementById("finalize-slot-label");
  if (lbl) lbl.textContent = `${fmtDate(date)} at ${fmtTime(time, date)}`;
  if (meetingTz && meetingTz !== viewerTz && meetingTz !== "UTC") {
    lbl.title = `In meeting timezone: ${meetingTz}`;
  }
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function cancelFinalize() {
  pendingFinalize = null;
  const panel = document.getElementById("finalize-panel");
  if (panel) panel.style.display = "none";
}

async function confirmFinalize() {
  if (!pendingFinalize) return;
  const duration = document.getElementById("finalize-duration").value;
  const note = document.getElementById("finalize-note").value;
  const { ok, data } = await apiFetch(`/api/meetings/${M.id}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date_or_day: pendingFinalize.date,
      time_slot: pendingFinalize.time,
      duration_minutes: parseInt(duration, 10),
      note,
    }),
  });
  if (ok && data.success) {
    const sent = Number(data.sent_count || 0);
    const failed = Number(data.failed_count || 0);
    const msg =
      failed > 0
        ? `Meeting finalized. Sent ${sent} email${sent === 1 ? "" : "s"} (${failed} failed).`
        : `Meeting finalized. Sent ${sent} email${sent === 1 ? "" : "s"}.`;
    showFlash(msg, failed > 0 ? "warning" : "success");
    setTimeout(() => {
      window.location.reload();
    }, 1400);
  } else {
    showFlash(data.error || "Failed to finalize. Please try again.", "danger");
  }
}
