/**
 * scheduling.js — Shared meeting-form widgets for the "create a meeting" pages.
 *
 * index.html (anonymous flow) and create-meeting.html (signed-in flow) share the
 * exact same form markup: the start/end time dropdowns, the day-of-week chips,
 * the specific-dates mini-calendar, and the dates-vs-days tab toggle. This module
 * owns all of that behavior so each page script only carries its own submit logic.
 *
 * No bundler — exposes a single global, `window.MeetingForm`.
 */
(function () {
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const DEFAULT_DAYS = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
  const MONTHS = [
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

  const selectedDates = new Set();
  let calYear;
  let calMonth;

  /* ── Time-slot dropdowns ──────────────────────────────────────────────── */

  function populateTimeOptions() {
    const startSel = document.getElementById("start_time");
    const endSel = document.getElementById("end_time");
    if (startSel) {
      const startParts = [];
      for (let h = 6; h < 24; h++) {
        for (const m of [0, 15, 30, 45]) {
          const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          startParts.push(`<option value="${t}" ${t === "08:00" ? "selected" : ""}>${t}</option>`);
        }
      }
      startSel.innerHTML = startParts.join("");
    }
    if (endSel) {
      const endParts = [];
      for (let h = 6; h <= 24; h++) {
        for (const m of [0, 15, 30, 45]) {
          if (h === 24 && m !== 0) continue;
          const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          endParts.push(`<option value="${t}" ${t === "20:00" ? "selected" : ""}>${t}</option>`);
        }
      }
      endSel.innerHTML = endParts.join("");
    }
  }

  /* ── Days-of-week checkboxes ──────────────────────────────────────────── */

  function populateDayCheckboxes() {
    const dayContainer = document.getElementById("day-checkboxes");
    if (!dayContainer) return;
    dayContainer.innerHTML = DAYS.map((day) => {
      const checked = DEFAULT_DAYS.has(day) ? " checked" : "";
      return `<label class="day-chip"><input type="checkbox" name="days_of_week" value="${day}"${checked}/>${day.slice(0, 3)}</label>`;
    }).join("");
  }

  /* ── Dates-vs-days tab toggle ─────────────────────────────────────────── */

  function switchType(type) {
    document.getElementById("panel-specific-dates").hidden = type !== "specific_dates";
    document.getElementById("panel-days-of-week").hidden = type !== "days_of_week";
    document.getElementById("tab-dates").classList.toggle("active", type === "specific_dates");
    document.getElementById("tab-days").classList.toggle("active", type === "days_of_week");
  }

  function initTypeToggle() {
    document.querySelectorAll('input[name="meeting_type"]').forEach((radio) => {
      radio.addEventListener("change", () => switchType(radio.value));
    });
    switchType("days_of_week");
  }

  /* ── Mini calendar for specific dates ─────────────────────────────────── */

  function renderCalendar() {
    const cal = document.getElementById("mini-calendar");
    if (!cal) return;
    const first = new Date(calYear, calMonth, 1);
    const last = new Date(calYear, calMonth + 1, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let html = `<div class="cal-nav"><button type="button" class="cal-shift" data-delta="-1">&lsaquo;</button><span>${MONTHS[calMonth]} ${calYear}</span><button type="button" class="cal-shift" data-delta="1">&rsaquo;</button></div><div class="cal-grid"><div class="cal-dow">Mo</div><div class="cal-dow">Tu</div><div class="cal-dow">We</div><div class="cal-dow">Th</div><div class="cal-dow">Fr</div><div class="cal-dow">Sa</div><div class="cal-dow">Su</div>`;

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

  function initDatePicker() {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    renderCalendar();

    const miniCalendar = document.getElementById("mini-calendar");
    if (!miniCalendar) return;
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
  }

  /**
   * Read the user's date/day selection for submission.
   * Returns a sorted array of "YYYY-MM-DD" dates (specific_dates) or weekday
   * names in calendar order (days_of_week). Empty array means nothing selected.
   *
   * @param {"specific_dates"|"days_of_week"} meetingType
   * @returns {string[]}
   */
  function collectDatesOrDays(meetingType) {
    if (meetingType === "specific_dates") {
      return Array.from(selectedDates).sort();
    }
    const picked = Array.from(document.querySelectorAll('input[name="days_of_week"]:checked')).map(
      (el) => el.value
    );
    picked.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
    return picked;
  }

  /** Build and wire all meeting-form widgets. Call once after the DOM is ready. */
  function init() {
    populateTimeOptions();
    populateDayCheckboxes();
    initTypeToggle();
    initDatePicker();
  }

  window.MeetingForm = { init, selectedDates, collectDatesOrDays };
})();
