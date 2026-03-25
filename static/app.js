/* ================================================================
   app.js — MeetSync availability grid
================================================================ */

const RAW = JSON.parse(document.getElementById('meeting-data').textContent);
const M   = {
  id:            RAW.id,
  dates:         RAW.dates,
  timeSlots:     RAW.timeSlots,
  mySlots:       new Set(RAW.mySlots),
  slotCounts:    RAW.slotCounts,       // { "key": count }
  totalInvited:  RAW.totalInvited,
  isCreator:     RAW.isCreator,
  isFinalized:   RAW.isFinalized,
  finalizedDate: RAW.finalizedDate,
  finalizedSlot: RAW.finalizedSlot,
  meetingType:   RAW.meetingType,
  participants:  RAW.participants || [],
};

// State
let currentView     = 'heatmap';   // 'heatmap' | 'mine' | 'person'
let currentPerson   = 0;
let isDragging      = false;
let dragAction      = null;        // 'add' | 'remove'
let saveTimer       = null;
let pendingFinalize = null;        // { date, time }

// ────────────────────────────────────────────
// COLOUR HELPERS
// ────────────────────────────────────────────

function heatColor(count) {
  if (!count || count === 0) return '#f5f5f5';
  const ratio = Math.min(count / Math.max(M.totalInvited, 1), 1);
  // 5-stop green gradient
  if (ratio <= 0)    return '#f5f5f5';
  if (ratio <= 0.20) return '#e8f5e9';
  if (ratio <= 0.40) return '#c8e6c9';
  if (ratio <= 0.65) return '#81c784';
  if (ratio <= 0.85) return '#4caf50';
  return '#2e7d32';
}

function mineColor(isMine) {
  return isMine ? '#bbdefb' : '#f5f5f5';
}

function personColor(isHighlighted) {
  return isHighlighted ? '#fff3e0' : '#f5f5f5';
}

// ────────────────────────────────────────────
// SLOT KEY
// ────────────────────────────────────────────

function slotKey(date, time) { return `${date}_${time}`; }

// ────────────────────────────────────────────
// FORMAT HELPERS
// ────────────────────────────────────────────

function fmtDate(d) {
  // d = "YYYY-MM-DD" or "Monday" etc.
  if (!d.includes('-')) return d;                 // days of week pass-through
  const [y, mo, day] = d.split('-').map(Number);
  const dt = new Date(y, mo - 1, day);
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(t) {
  // "14:00" → "2:00 PM"
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ────────────────────────────────────────────
// BUILD GRID
// ────────────────────────────────────────────

function buildGrid() {
  const grid = document.getElementById('av-grid');
  grid.innerHTML = '';

  const numCols = M.dates.length;
  grid.style.setProperty('--cols', numCols);

  // ── Header row ─────────────────────────────
  // Corner
  const corner = el('div', 'ag-corner ag-col-header');
  corner.textContent = '';
  grid.appendChild(corner);

  M.dates.forEach(d => {
    const hdr = el('div', 'ag-col-header');
    if (M.isFinalized && d === M.finalizedDate) hdr.classList.add('is-finalized');
    hdr.innerHTML = `<div>${fmtDate(d)}</div>`;
    grid.appendChild(hdr);
  });

  // ── Time rows ──────────────────────────────
  M.timeSlots.forEach(time => {
    const [h, m] = time.split(':').map(Number);
    const isHour = m === 0;

    // Time label
    const lbl = el('div', `ag-time-label${isHour ? ' hour-boundary' : ''}`);
    lbl.textContent = isHour ? fmtTime(time) : '';
    grid.appendChild(lbl);

    // Cells
    M.dates.forEach(date => {
      const key  = slotKey(date, time);
      const cell = el('div', `ag-cell${isHour ? ' hour-boundary' : ''}`);
      cell.dataset.date = date;
      cell.dataset.time = time;
      cell.dataset.key  = key;
      paintCell(cell);
      grid.appendChild(cell);
    });
  });

  // ── Interaction ────────────────────────────
  if (!M.isFinalized) {
    attachGridEvents(grid);
  }

  // If creator and not finalized: click selects finalize time in heatmap view
  if (M.isCreator && !M.isFinalized) {
    grid.addEventListener('click', e => {
      if (currentView !== 'heatmap') return;
      const cell = e.target.closest('.ag-cell');
      if (!cell) return;
      showFinalizePanel(cell.dataset.date, cell.dataset.time);
    });
  }
}

function el(tag, cls) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  return d;
}

// ────────────────────────────────────────────
// PAINT CELL
// ────────────────────────────────────────────

function paintCell(cell) {
  const key    = cell.dataset.key;
  const date   = cell.dataset.date;
  const time   = cell.dataset.time;
  const count  = M.slotCounts[key] || 0;
  const isMine = M.mySlots.has(key);

  // Reset
  cell.style.background = '';
  cell.classList.remove('mine-selected', 'finalized-cell', 'person-highlighted');
  cell.removeAttribute('data-tip');

  if (M.isFinalized && date === M.finalizedDate && time === M.finalizedSlot) {
    cell.classList.add('finalized-cell');
  }

  if (currentView === 'heatmap') {
    cell.style.background = heatColor(count);
    if (isMine) cell.classList.add('mine-selected');
    const tip = count > 0 ? `${count}/${M.totalInvited} available` : 'No one available';
    cell.dataset.tip = tip;

  } else if (currentView === 'mine') {
    cell.style.background = mineColor(isMine);
    if (isMine) cell.classList.add('mine-selected');
    cell.dataset.tip = isMine ? 'You are available' : 'Click to mark available';

  } else if (currentView === 'person') {
    const p      = M.participants[currentPerson];
    const pSlots = new Set(p ? p.slots : []);
    const isp    = pSlots.has(key);
    cell.style.background = isp ? '#fff3e0' : (count > 0 ? heatColor(count * 0.3) : '#f5f5f5');
    if (isp) cell.classList.add('person-highlighted');
    cell.dataset.tip = isp ? `${p.name} is available` : '';
  }
}

function repaintAll() {
  document.querySelectorAll('.ag-cell').forEach(paintCell);
}

// ────────────────────────────────────────────
// DRAG SELECTION (edit mode)
// ────────────────────────────────────────────

function attachGridEvents(grid) {
  function startDrag(cell) {
    if (currentView !== 'mine') return;
    if (!cell || !cell.classList.contains('ag-cell')) return;
    const key  = cell.dataset.key;
    isDragging = true;
    dragAction = M.mySlots.has(key) ? 'remove' : 'add';
    applyDrag(cell);
  }

  function applyDrag(cell) {
    if (!cell || !cell.classList.contains('ag-cell')) return;
    const key = cell.dataset.key;
    if (dragAction === 'add')    M.mySlots.add(key);
    if (dragAction === 'remove') M.mySlots.delete(key);
    paintCell(cell);
  }

  function endDrag() {
    if (isDragging) {
      isDragging = false;
      scheduleSave();
    }
  }

  // Mouse
  grid.addEventListener('mousedown', e => {
    const cell = e.target.closest('.ag-cell');
    if (cell) { startDrag(cell); e.preventDefault(); }
  });
  document.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.ag-cell');
    if (cell) applyDrag(cell);
  });
  document.addEventListener('mouseup', endDrag);

  // Touch
  grid.addEventListener('touchstart', e => {
    const touch = e.touches[0];
    const cell  = document.elementFromPoint(touch.clientX, touch.clientY)?.closest?.('.ag-cell');
    if (cell) { startDrag(cell); }
  }, { passive: true });
  grid.addEventListener('touchmove', e => {
    if (!isDragging) return;
    const touch = e.touches[0];
    const cell  = document.elementFromPoint(touch.clientX, touch.clientY)?.closest?.('.ag-cell');
    if (cell) applyDrag(cell);
  }, { passive: true });
  grid.addEventListener('touchend', endDrag);
}

// ────────────────────────────────────────────
// SAVE AVAILABILITY
// ────────────────────────────────────────────

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAvailability, 500);
}

async function saveAvailability() {
  const slots = Array.from(M.mySlots);
  try {
    const res  = await fetch(`/api/meeting/${M.id}/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots }),
    });
    const data = await res.json();
    if (data.success) {
      M.slotCounts = data.slot_counts;
      showSavedIndicator();
    }
  } catch (e) {
    console.error('Save failed', e);
  }
}

function showSavedIndicator() {
  let ind = document.getElementById('save-indicator');
  if (!ind) {
    ind = document.createElement('div');
    ind.id = 'save-indicator';
    ind.style.cssText = `position:fixed;bottom:24px;right:24px;background:#2e7d32;color:white;
      padding:10px 18px;border-radius:8px;font-size:0.85rem;font-weight:600;
      box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:999;transition:opacity 0.3s;`;
    document.body.appendChild(ind);
  }
  ind.textContent = '✓ Saved';
  ind.style.opacity = '1';
  clearTimeout(ind._timer);
  ind._timer = setTimeout(() => { ind.style.opacity = '0'; }, 2000);
}

// ────────────────────────────────────────────
// VIEW MODES
// ────────────────────────────────────────────

window.setView = function(view, btn) {
  currentView = view;
  document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  const editMode = view === 'mine';
  document.getElementById('av-grid').dataset.editing = editMode;

  // Instructions
  const editInst  = document.getElementById('edit-instructions');
  const heatInst  = document.getElementById('heatmap-instructions');
  if (editInst)  editInst.style.display  = editMode ? '' : 'none';
  if (heatInst)  heatInst.style.display  = editMode ? 'none' : '';

  // Person selector
  const ps = document.getElementById('person-selector');
  if (ps) ps.style.display = view === 'person' ? '' : 'none';

  repaintAll();
};

window.filterPerson = function(idx) {
  currentPerson = parseInt(idx);
  repaintAll();
};

window.jumpToParticipant = function(idx) {
  currentPerson = idx;
  const tab = document.querySelector('[data-view="person"]');
  if (tab) setView('person', tab);
  const sel = document.getElementById('person-select');
  if (sel) sel.value = idx;
};

// ────────────────────────────────────────────
// FINALIZE
// ────────────────────────────────────────────

window.showFinalizePanel = function(date, time) {
  if (!M.isCreator || M.isFinalized) return;
  pendingFinalize = { date, time };
  const panel = document.getElementById('finalize-panel');
  if (!panel) return;
  panel.style.display = '';
  const lbl = document.getElementById('finalize-slot-label');
  if (lbl) lbl.textContent = `${fmtDate(date)} at ${fmtTime(time)}`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window.cancelFinalize = function() {
  pendingFinalize = null;
  const panel = document.getElementById('finalize-panel');
  if (panel) panel.style.display = 'none';
};

window.confirmFinalize = async function() {
  if (!pendingFinalize) return;
  const duration = document.getElementById('finalize-duration').value;
  const note     = document.getElementById('finalize-note').value;
  try {
    const res  = await fetch(`/api/meeting/${M.id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date_or_day:      pendingFinalize.date,
        time_slot:        pendingFinalize.time,
        duration_minutes: parseInt(duration),
        note,
      }),
    });
    const data = await res.json();
    if (data.success) window.location.reload();
  } catch (e) {
    alert('Failed to finalize. Please try again.');
  }
};

// Unfinalize
const btnUnfinalize = document.getElementById('btn-unfinalize');
if (btnUnfinalize) {
  btnUnfinalize.addEventListener('click', async () => {
    if (!confirm('Remove finalization and reopen for editing?')) return;
    const res  = await fetch(`/api/meeting/${M.id}/unfinalize`, { method: 'POST' });
    const data = await res.json();
    if (data.success) window.location.reload();
  });
}

// ────────────────────────────────────────────
// INIT
// ────────────────────────────────────────────

buildGrid();

// Default to edit/mine mode if user hasn't responded yet and meeting isn't finalized
if (!M.isFinalized && M.mySlots.size === 0) {
  const mineTab = document.querySelector('[data-view="mine"]');
  if (mineTab) setView('mine', mineTab);
}
