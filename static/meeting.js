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
/** Whether the user is currently drag-selecting cells. */
let isDragging = false;
/** "add" | "remove" — action applied while dragging. */
let dragAction = null;

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
  }

  document.getElementById("copy-share-url-btn")?.addEventListener("click", copyShareUrl);
  document.getElementById("save-btn")?.addEventListener("click", () => void saveAvailability());

  if (M.isCreator) {
    const shareWrap = document.getElementById("share-controls");
    const shareInput = document.getElementById("share-url");
    const meetingUrl = `${window.location.origin}/meeting.html?id=${encodeURIComponent(M.id)}`;
    shareInput.value = meetingUrl;
    shareWrap.hidden = false;
  }

  buildGrid();
})();

function createParticipantRow(p, i) {
  const row = document.createElement("div");
  row.className = "participant-row";

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

function slotKey(date, time) {
  return `${date}_${time}`;
}

function fmtDate(d) {
  if (!d.includes("-")) return d;
  const [y, mo, day] = d.split("-").map(Number);
  const dt = new Date(y, mo - 1, day);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
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
    lbl.textContent = isHour ? fmtTime(time) : "";
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
}

function paintCell(cell) {
  const key = cell.dataset.key;
  const isMine = M.mySlots.has(key);

  cell.style.background = "";
  cell.classList.remove("mine-selected");
  cell.removeAttribute("data-tip");

  cell.style.background = isMine ? "#bbdefb" : "#f5f5f5";
  if (isMine) cell.classList.add("mine-selected");
  cell.dataset.tip = isMine ? "You are available" : "Click to mark available";
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

async function saveAvailability() {
  const slots = Array.from(M.mySlots);
  const { ok, data } = await apiFetch(`/api/meetings/${encodeURIComponent(M.id)}/availability`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slots }),
  });
  if (ok && data.success) {
    M.slotCounts = data.slot_counts;
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
