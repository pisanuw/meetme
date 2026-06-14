/**
 * index.js — Landing page: anonymous "create a meeting" flow.
 *
 * If the user is already signed in, they're sent straight to the dashboard.
 * Otherwise, this page hosts the same form widgets as create-meeting.html
 * but submits to /api/public/meetings (no auth, no invite emails). On
 * success we swap the form card for a success card that shows the two
 * shareable URLs — this is the ONLY time the admin URL is displayed.
 */

(async () => {
  // If signed in, the anonymous form is not the right landing page —
  // drop the user at their dashboard.
  const user = await checkAuth();
  if (user) {
    window.location.href = "/dashboard.html";
    return;
  }

  // Populate the timezone dropdown with the browser's guess so the first
  // pick is sensible without forcing the user to scroll.
  const tzSel = document.getElementById("timezone");
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  if (tzSel && browserTz) {
    const already = [...tzSel.options].some((o) => o.value === browserTz);
    if (!already) tzSel.prepend(new Option(browserTz, browserTz));
    tzSel.value = browserTz;
  }
})();

/* ── Time-slot dropdowns ────────────────────────────────────────────────── */

const startSel = document.getElementById("start_time");
const endSel = document.getElementById("end_time");
const startParts = [];
for (let h = 6; h < 24; h++) {
  for (const m of [0, 15, 30, 45]) {
    const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    startParts.push(`<option value="${t}" ${t === "08:00" ? "selected" : ""}>${t}</option>`);
  }
}
startSel.innerHTML = startParts.join("");
const endParts = [];
for (let h = 6; h <= 24; h++) {
  for (const m of [0, 15, 30, 45]) {
    if (h === 24 && m !== 0) continue;
    const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    endParts.push(`<option value="${t}" ${t === "20:00" ? "selected" : ""}>${t}</option>`);
  }
}
endSel.innerHTML = endParts.join("");

/* ── Days-of-week checkboxes ────────────────────────────────────────────── */

const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const defaultDays = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
const dayContainer = document.getElementById("day-checkboxes");
const dayParts = days.map((day) => {
  const checked = defaultDays.has(day) ? " checked" : "";
  return `<label class="day-chip"><input type="checkbox" name="days_of_week" value="${day}"${checked}/>${day.slice(0, 3)}</label>`;
});
dayContainer.innerHTML = dayParts.join("");

document.querySelectorAll('input[name="meeting_type"]').forEach((radio) => {
  radio.addEventListener("change", () => switchType(radio.value));
});
switchType("days_of_week");

function switchType(type) {
  document.getElementById("panel-specific-dates").hidden = type !== "specific_dates";
  document.getElementById("panel-days-of-week").hidden = type !== "days_of_week";
  document.getElementById("tab-dates").classList.toggle("active", type === "specific_dates");
  document.getElementById("tab-days").classList.toggle("active", type === "days_of_week");
}

/* ── Mini calendar for specific dates ──────────────────────────────────── */

const selectedDates = new Set();
let calYear;
let calMonth;

function initCalendar() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  renderCalendar();
}

function renderCalendar() {
  const cal = document.getElementById("mini-calendar");
  const first = new Date(calYear, calMonth, 1);
  const last = new Date(calYear, calMonth + 1, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  let html = `<div class="cal-nav"><button type="button" class="cal-shift" data-delta="-1">&lsaquo;</button><span>${months[calMonth]} ${calYear}</span><button type="button" class="cal-shift" data-delta="1">&rsaquo;</button></div><div class="cal-grid"><div class="cal-dow">Mo</div><div class="cal-dow">Tu</div><div class="cal-dow">We</div><div class="cal-dow">Th</div><div class="cal-dow">Fr</div><div class="cal-dow">Sa</div><div class="cal-dow">Su</div>`;

  const startDow = (first.getDay() + 6) % 7;
  for (let i = 0; i < startDow; i++) html += "<div></div>";
  for (let d = 1; d <= last.getDate(); d++) {
    const dt = new Date(calYear, calMonth, d);
    const key = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const isPast = dt < today;
    const isSel = selectedDates.has(key);
    html += `<div class="cal-day ${isPast ? "past" : ""} ${isSel ? "selected" : ""}" ${isPast ? "" : `data-date="${key}"`}>${d}</div>`;
  }
  html += "</div>";
  cal.innerHTML = html;
}

function shiftMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) {
    calMonth = 11;
    calYear--;
  }
  if (calMonth > 11) {
    calMonth = 0;
    calYear++;
  }
  renderCalendar();
}

function toggleDate(key) {
  if (selectedDates.has(key)) selectedDates.delete(key);
  else selectedDates.add(key);
  renderCalendar();
  updateChips();
}

function updateChips() {
  const container = document.getElementById("selected-dates-chips");
  const sorted = Array.from(selectedDates).sort();
  container.innerHTML = sorted
    .map((d) => {
      const [y, m, day] = d.split("-").map(Number);
      const label = new Date(y, m - 1, day).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      return `<span class="date-chip removable" data-remove-date="${d}">${label} &#x2715;</span>`;
    })
    .join("");
  document.getElementById("date-input").value = sorted.length
    ? `${sorted.length} date${sorted.length > 1 ? "s" : ""} selected`
    : "";
}

const miniCalendar = document.getElementById("mini-calendar");
miniCalendar.addEventListener("click", (e) => {
  const shiftBtn = e.target.closest(".cal-shift");
  if (shiftBtn) {
    shiftMonth(Number(shiftBtn.dataset.delta || "0"));
    return;
  }
  const dayCell = e.target.closest(".cal-day[data-date]");
  if (dayCell) toggleDate(dayCell.dataset.date);
});

document.getElementById("selected-dates-chips").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-remove-date]");
  if (!chip) return;
  toggleDate(chip.dataset.removeDate);
});

document.getElementById("date-input").addEventListener("click", () => {
  miniCalendar.classList.toggle("visible");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".date-picker-wrapper")) miniCalendar.classList.remove("visible");
});

initCalendar();

/* ── Submit ─────────────────────────────────────────────────────────────── */

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const submitBtn = document.getElementById("create-submit");
  submitBtn.disabled = true;

  const title = document.getElementById("title").value.trim();
  const description = document.getElementById("description").value.trim();
  const creatorName = document.getElementById("creator_name").value.trim();
  const meetingType = document.querySelector('input[name="meeting_type"]:checked').value;
  const startTime = document.getElementById("start_time").value;
  const endTime = document.getElementById("end_time").value;

  let datesOrDays;
  if (meetingType === "specific_dates") {
    datesOrDays = Array.from(selectedDates).sort();
    if (datesOrDays.length === 0) {
      showFlash("Select at least one date.", "danger");
      submitBtn.disabled = false;
      return;
    }
  } else {
    datesOrDays = Array.from(document.querySelectorAll('input[name="days_of_week"]:checked')).map(
      (el) => el.value
    );
    datesOrDays.sort((a, b) => days.indexOf(a) - days.indexOf(b));
    if (datesOrDays.length === 0) {
      showFlash("Select at least one day.", "danger");
      submitBtn.disabled = false;
      return;
    }
  }

  const tzSel = document.getElementById("timezone");
  const timezone = tzSel.value || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const { ok, status, data } = await apiFetch("/api/public/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      description,
      creator_name: creatorName,
      meeting_type: meetingType,
      dates_or_days: datesOrDays,
      start_time: startTime,
      end_time: endTime,
      timezone,
    }),
  });

  if (!(ok && data.success)) {
    showFlash(data.error || `Server error (${status}).`, "danger");
    submitBtn.disabled = false;
    return;
  }

  // Swap form card for success card with the two URLs.
  document.getElementById("create-card").hidden = true;
  const successCard = document.getElementById("success-card");
  successCard.hidden = false;

  document.getElementById("participation-url").value = data.participation_url;
  document.getElementById("admin-url").value = data.admin_url;
  document.getElementById("open-admin-link").href = data.admin_url;

  // Store the admin URL in sessionStorage as a fallback recovery aid —
  // survives accidental tab reloads while the page is still open but does
  // not persist across sessions, in keeping with "shown only on this page".
  try {
    sessionStorage.setItem(`meetme:admin-url:${data.meeting_id}`, data.admin_url);
  } catch {
    /* sessionStorage may be unavailable (private mode); that's fine. */
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
});

/* ── Copy buttons on the success card ───────────────────────────────────── */

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy-target]");
  if (!btn) return;
  const target = document.getElementById(btn.dataset.copyTarget);
  if (!target) return;
  target.select();
  target.setSelectionRange(0, target.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(target.value).then(
      () => {
        /* no-op */
      },
      () => {
        /* ignore */
      }
    );
    copied = true;
  }
  const originalText = btn.textContent;
  btn.textContent = copied ? "Copied!" : "Copy failed";
  setTimeout(() => {
    btn.textContent = originalText;
  }, 1500);
});
