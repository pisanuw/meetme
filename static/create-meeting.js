/**
 * create-meeting.js — Signed-in "create a meeting" flow.
 *
 * Shares the form widgets (time dropdowns, day chips, mini calendar, dates-vs-days
 * toggle) with the anonymous landing page via the shared window.MeetingForm module.
 * This script only adds the signed-in specifics: profile-timezone prefill and the
 * authenticated POST to /api/meetings (with invite emails).
 */

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const tzSel = document.getElementById("timezone");
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const { ok, data } = await apiFetch("/api/auth/profile");
  const profileTz = ok && data.timezone ? data.timezone : "";
  const tzToSet = profileTz || browserTz;
  applyTimezoneToSelect(tzSel, tzToSet);
})();

// Time dropdowns, day-of-week chips, dates-vs-days toggle, mini calendar.
MeetingForm.init();

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const submitBtn = e.target.querySelector('button[type="submit"]');

  const title = document.getElementById("title").value.trim();
  const description = document.getElementById("description").value.trim();
  const meetingType = document.querySelector('input[name="meeting_type"]:checked').value;
  const startTime = document.getElementById("start_time").value;
  const endTime = document.getElementById("end_time").value;
  const inviteEmails = document.getElementById("invite_emails").value;

  const datesOrDays = MeetingForm.collectDatesOrDays(meetingType);
  if (datesOrDays.length === 0) {
    showFlash(
      meetingType === "specific_dates" ? "Select at least one date." : "Select at least one day.",
      "danger"
    );
    return;
  }

  const tzSel = document.getElementById("timezone");
  const timezone = tzSel.value || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  // Guard against a double-submit creating duplicate meetings / invite emails.
  if (submitBtn) submitBtn.disabled = true;

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
    // Success navigates away — keep the button disabled so it can't fire again.
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
    return;
  }

  showFlash(data.error || `Server error (${status}) — check Netlify function logs.`, "danger");
  if (submitBtn) submitBtn.disabled = false;
});
