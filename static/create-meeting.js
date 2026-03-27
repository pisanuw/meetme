(async () => {
  const user = await requireAuth();
  if (!user) return;

  const tzSel = document.getElementById("timezone");
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const { ok, data } = await apiFetch("/api/auth/profile");
  const profileTz = ok && data.timezone ? data.timezone : "";
  const tzToSet = profileTz || browserTz;
  if (tzToSet) {
    const already = [...tzSel.options].some((o) => o.value === tzToSet);
    if (!already) tzSel.prepend(new Option(tzToSet, tzToSet));
    tzSel.value = tzToSet;
  }
})();

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
  document.getElementById("panel-specific-dates").style.display =
    type === "specific_dates" ? "" : "none";
  document.getElementById("panel-days-of-week").style.display =
    type === "days_of_week" ? "" : "none";
  document.getElementById("tab-dates").classList.toggle("active", type === "specific_dates");
  document.getElementById("tab-days").classList.toggle("active", type === "days_of_week");
}

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
  if (dayCell) {
    toggleDate(dayCell.dataset.date);
  }
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

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = document.getElementById("title").value.trim();
  const description = document.getElementById("description").value.trim();
  const meetingType = document.querySelector('input[name="meeting_type"]:checked').value;
  const startTime = document.getElementById("start_time").value;
  const endTime = document.getElementById("end_time").value;
  const inviteEmails = document.getElementById("invite_emails").value;

  let datesOrDays;
  if (meetingType === "specific_dates") {
    datesOrDays = Array.from(selectedDates).sort();
    if (datesOrDays.length === 0) {
      showFlash("Select at least one date.", "danger");
      return;
    }
  } else {
    datesOrDays = Array.from(document.querySelectorAll('input[name="days_of_week"]:checked')).map(
      (el) => el.value
    );
    const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    datesOrDays.sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b));
    if (datesOrDays.length === 0) {
      showFlash("Select at least one day.", "danger");
      return;
    }
  }

  const tzSel = document.getElementById("timezone");
  const timezone = tzSel.value || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const { ok, status, data } = await apiFetch("/api/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      description,
      meeting_type: meetingType,
      dates_or_days: datesOrDays,
      start_time: startTime,
      end_time: endTime,
      invite_emails: inviteEmails,
      timezone,
    }),
  });
  if (ok && data.success) {
    const failures = data.email_failures || [];
    if (failures.length) {
      showFlash(
        `Meeting created! However, invitation emails could not be sent to: ${failures.join(", ")}. These participants can still join via the sharing link.`,
        "warning"
      );
      setTimeout(() => {
        window.location.href = `/meeting.html?id=${data.meeting_id}`;
      }, 3500);
    } else {
      window.location.href = `/meeting.html?id=${data.meeting_id}`;
    }
  } else {
    showFlash(data.error || `Server error (${status}) — check Netlify function logs.`, "danger");
  }
});
