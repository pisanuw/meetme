/**
 * meeting.js — Meeting detail page controller
 *
 * External dependencies (from common.js): apiFetch, showFlash, requireAuth, escapeHtml
 *
 * ── Page state ─────────────────────────────────────────────────────────────
 * All mutable page state is declared here so it is easy to identify what
 * constitutes "page state" and avoid hidden coupling between functions.
 */

/** Loaded meeting data and local availability set. */
let M = null;
/** Authenticated user (null if anonymous). */
let currentUser = null;
/** "heatmap" | "person" | "mine" */
let currentView = "heatmap";
/** Index of the person selected in by-person view. */
let currentPerson = 0;
/** Whether the user is currently drag-selecting cells. */
let isDragging = false;
/** "add" | "remove" — action applied while dragging. */
let dragAction = null;
/** Pending debounced-save timer handle. */
let saveTimer = null;
/** Guard against registering persistence listeners more than once. */
let saveLifecycleBound = false;
/** IANA timezone string for the meeting. */
let meetingTz = "UTC";
/** IANA timezone string for the current viewer's local zone. */
let viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
/** Whether to display times in the meeting timezone instead of viewer tz. */
let showMeetingTz = false;

function flushPendingAvailabilitySave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  void saveAvailability({ keepalive: true });
}

function bindAvailabilityPersistenceLifecycle() {
  if (saveLifecycleBound) return;

  window.addEventListener("pagehide", flushPendingAvailabilitySave);
  window.addEventListener("beforeunload", flushPendingAvailabilitySave);

  saveLifecycleBound = true;
}

(async () => {
  const params = new URLSearchParams(window.location.search);
  const meetingId = params.get("id");

  if (!meetingId) {
    window.location.href = "/dashboard.html";
    return;
  }

  const user = await requireAuth();
  if (!user) return;
  currentUser = user;

  bindAvailabilityPersistenceLifecycle();

  const { ok, status, data } = await apiFetch(`/api/meetings/${encodeURIComponent(meetingId)}`);
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
    bar.hidden = false;
    lbl.textContent = viewerTz;
    btn.textContent = meetingTz !== viewerTz ? `Switch to meeting TZ (${meetingTz})` : "";
    btn.hidden = meetingTz === viewerTz;
  }

  document.getElementById("meeting-page").hidden = false;
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

  const tabsContainer = document.getElementById("view-tabs");
  tabsContainer.innerHTML = "";

  const btnHeatmap = document.createElement("button");
  btnHeatmap.className = "view-tab active";
  btnHeatmap.dataset.view = "heatmap";
  btnHeatmap.textContent = "🌡 Group availability";
  tabsContainer.appendChild(btnHeatmap);

  const btnMine = document.createElement("button");
  btnMine.className = "view-tab";
  btnMine.dataset.view = "mine";
  btnMine.textContent = "✏ My availability";
  tabsContainer.appendChild(btnMine);

  if (M.isCreator && M.participants.length) {
    const btnPerson = document.createElement("button");
    btnPerson.className = "view-tab";
    btnPerson.dataset.view = "person";
    btnPerson.textContent = "👤 By person";
    tabsContainer.appendChild(btnPerson);
  }

  tabsContainer.addEventListener("click", (e) => {
    const tab = e.target.closest(".view-tab[data-view]");
    if (!tab) return;
    setView(tab.dataset.view, tab);
  });

  if (M.isCreator && M.participants.length) {
    const sel = document.getElementById("person-select");
    M.participants.forEach((p, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `${p.name} (${p.slot_count} slot${p.slot_count !== 1 ? "s" : ""})${!p.responded ? " – no response" : ""}`;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", (e) => filterPerson(e.target.value));
  }

  if (M.participants.length > 0) {
    document.getElementById("participants-panel").hidden = false;
    document.getElementById("participant-count").textContent = `(${data.invite_count})`;
    const list = document.getElementById("participants-list");
    list.innerHTML = "";
    const fragment = document.createDocumentFragment();
    M.participants.forEach((p, i) => {
      fragment.appendChild(createParticipantRow(p, i));
    });
    list.appendChild(fragment);

    list.addEventListener("click", (e) => {
      if (!M.isCreator) return;
      const row = e.target.closest(".participant-row[data-participant-index]");
      if (!row) return;
      jumpToParticipant(Number(row.dataset.participantIndex));
    });
  }

  document.getElementById("tz-toggle-btn")?.addEventListener("click", toggleTzView);
  document.getElementById("copy-share-url-btn")?.addEventListener("click", copyShareUrl);

  if (M.isCreator) {
    const shareWrap = document.getElementById("share-controls");
    const shareInput = document.getElementById("share-url");
    const meetingUrl = `${window.location.origin}/meeting.html?id=${encodeURIComponent(M.id)}`;
    shareInput.value = meetingUrl;
    shareWrap.hidden = false;
  }

  buildGrid();

  if (M.mySlots.size === 0) {
    const mineTab = document.querySelector('[data-view="mine"]');
    if (mineTab) setView("mine", mineTab);
  }
})();

function createParticipantRow(p, i) {
  const row = document.createElement("div");
  row.className = "participant-row";
  if (M.isCreator) {
    row.dataset.participantIndex = i;
    row.classList.add("participant-row-clickable");
  }

  const avatar = document.createElement("div");
  avatar.className = "participant-avatar";
  avatar.textContent = (p.name || "?")[0].toUpperCase();

  const info = document.createElement("div");
  info.className = "participant-info";
  const nameDiv = document.createElement("div");
  nameDiv.className = "participant-name";
  nameDiv.textContent = p.name;
  info.appendChild(nameDiv);

  if (M.isCreator && p.email) {
    const emailDiv = document.createElement("div");
    emailDiv.className = "participant-email text-muted";
    emailDiv.textContent = p.email;
    info.appendChild(emailDiv);
  }

  const slots = document.createElement("div");
  slots.className = "participant-slots";
  const badge = document.createElement("span");
  badge.className = p.responded ? "badge badge-green" : "badge badge-gray";
  badge.textContent = p.responded
    ? `${p.slot_count} slot${p.slot_count !== 1 ? "s" : ""}`
    : "No response";
  slots.appendChild(badge);

  row.append(avatar, info, slots);
  return row;
}

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
    const inner = document.createElement("div");
    inner.textContent = fmtDate(d);
    hdr.appendChild(inner);
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

  attachGridEvents(grid);

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
  const count = M.slotCounts[key] || 0;
  const isMine = M.mySlots.has(key);

  cell.style.background = "";
  cell.classList.remove("mine-selected", "person-highlighted");
  cell.removeAttribute("data-tip");

  if (currentView === "mine") {
    cell.style.background = isMine ? "#bbdefb" : "#f5f5f5";
    if (isMine) cell.classList.add("mine-selected");
    cell.dataset.tip = isMine ? "You are available" : "Click to mark available";
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
  const TOUCH_DRAG_START_DISTANCE = 12;
  const touchState = {
    active: false,
    startX: 0,
    startY: 0,
    startCell: null,
    isScrolling: false,
  };

  function resetTouchState() {
    touchState.active = false;
    touchState.startX = 0;
    touchState.startY = 0;
    touchState.startCell = null;
    touchState.isScrolling = false;
  }

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
    if (e.touches.length !== 1) {
      resetTouchState();
      return;
    }
    const touch = e.touches[0];
    const cell = document.elementFromPoint(touch.clientX, touch.clientY)?.closest?.(".ag-cell");
    touchState.active = Boolean(cell);
    touchState.startX = touch.clientX;
    touchState.startY = touch.clientY;
    touchState.startCell = cell || null;
    touchState.isScrolling = false;
  });

  grid.addEventListener(
    "touchmove",
    (e) => {
      if (!touchState.active || touchState.isScrolling || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - touchState.startX;
      const deltaY = touch.clientY - touchState.startY;
      const movedFarEnough =
        Math.abs(deltaX) > TOUCH_DRAG_START_DISTANCE ||
        Math.abs(deltaY) > TOUCH_DRAG_START_DISTANCE;
      if (!isDragging) {
        if (!movedFarEnough) return;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          touchState.isScrolling = true;
          return;
        }
        startDrag(touchState.startCell);
      }
      if (isDragging) {
        e.preventDefault();
        const cell = document.elementFromPoint(touch.clientX, touch.clientY)?.closest?.(".ag-cell");
        if (cell) applyDrag(cell);
      }
    },
    { passive: false }
  );

  grid.addEventListener("touchend", () => {
    try {
      if (touchState.active && !touchState.isScrolling && !isDragging && touchState.startCell) {
        startDrag(touchState.startCell);
      }
    } finally {
      endDrag();
      resetTouchState();
    }
  });
  grid.addEventListener("touchcancel", () => {
    endDrag();
    resetTouchState();
  });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveAvailability();
  }, 500);
}

async function saveAvailability({ keepalive = false } = {}) {
  const slots = Array.from(M.mySlots);
  const { ok, data } = await apiFetch(`/api/meetings/${encodeURIComponent(M.id)}/availability`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive,
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
  list.innerHTML = "";
  const fragment = document.createDocumentFragment();
  M.participants.forEach((p, i) => fragment.appendChild(createParticipantRow(p, i)));
  list.appendChild(fragment);
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
