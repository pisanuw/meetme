/**
 * index.js — Landing page: anonymous "create a meeting" flow.
 *
 * If the user is already signed in, they're sent straight to the dashboard.
 * Otherwise, this page hosts the same form widgets as create-meeting.html
 * (provided by the shared window.MeetingForm module) but submits to
 * /api/public/meetings (no auth, no invite emails). On success we swap the form
 * card for a success card that shows the two shareable URLs — this is the ONLY
 * time the admin URL is displayed.
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
  applyTimezoneToSelect(tzSel, browserTz);
})();

// Time dropdowns, day-of-week chips, dates-vs-days toggle, mini calendar.
MeetingForm.init();

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

  const datesOrDays = MeetingForm.collectDatesOrDays(meetingType);
  if (datesOrDays.length === 0) {
    showFlash(
      meetingType === "specific_dates" ? "Select at least one date." : "Select at least one day.",
      "danger"
    );
    submitBtn.disabled = false;
    return;
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
