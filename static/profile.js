(async () => {
  const user = await requireAuth();
  if (!user) return;

  const params = new URLSearchParams(window.location.search);
  const isSetup = params.get("setup") === "1";

  if (params.get("calendar") === "connected")
    showFlash("Google Calendar connected successfully!", "success");
  const errMap = {
    "calendar-denied": "Google Calendar connection was cancelled.",
    "calendar-auth-failed": "Google Calendar connection failed. Please try again.",
    "calendar-state-mismatch": "Connection failed (state mismatch). Please try again.",
    "calendar-state-expired": "Connection session expired. Please try again.",
    "calendar-rate-limited": "Too many calendar connection attempts. Please wait a few minutes.",
    "google-not-configured": "Google OAuth is not configured on this server.",
  };
  const errCode = params.get("error");
  if (errCode && errMap[errCode]) showFlash(errMap[errCode], "danger");

  if (isSetup) {
    document.getElementById("page-title").textContent = "Welcome to MeetMe!";
    document.getElementById("page-subtitle").textContent =
      "Enter your name and time zone so others can schedule with you.";
    document.getElementById("skip-btn").hidden = false;
  } else {
    document.getElementById("back-link").hidden = false;
  }

  const { ok, data } = await apiFetch("/api/auth/profile");
  if (ok) {
    document.getElementById("first-name").value = data.first_name || "";
    document.getElementById("last-name").value = data.last_name || "";
    if (!data.first_name && data.name) {
      const parts = data.name.trim().split(/\s+/);
      document.getElementById("first-name").value = parts[0] || "";
      document.getElementById("last-name").value = parts.slice(1).join(" ") || "";
    }

    const tzSel = document.getElementById("timezone");
    const storedTz = data.timezone || "";
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const tzToSet = storedTz || browserTz;
    if (tzToSet) {
      const already = [...tzSel.options].some((o) => o.value === tzToSet);
      if (!already) tzSel.prepend(new Option(tzToSet, tzToSet));
      tzSel.value = tzToSet;
    }

    renderCalendarStatus(data.calendar_connected);
  }

  await loadEmailPreferences();

  document.getElementById("profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const saveBtn = document.getElementById("save-btn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    const tzSel = document.getElementById("timezone");
    const timezone = tzSel.value || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    const { ok: saveOk, data: saveData } = await apiFetch("/api/auth/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        first_name: document.getElementById("first-name").value.trim(),
        last_name: document.getElementById("last-name").value.trim(),
        timezone,
      }),
    });

    if (saveOk) {
      showFlash("Profile saved!", "success");
      setTimeout(() => {
        window.location.href = "/dashboard.html";
      }, 800);
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save profile";
      showFlash(saveData.error || "Could not save profile. Please try again.", "danger");
    }
  });

  document.getElementById("save-email-prefs-btn")?.addEventListener("click", saveEmailPreferences);
})();

function parseBlockedOrganizerInput(value) {
  return [...new Set(
    String(value || "")
      .split(/[\n,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )];
}

function isSimpleEmail(value) {
  const v = String(value || "").trim().toLowerCase();
  return v.includes("@") && v.includes(".");
}

function formatUpdatedAt(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleString();
}

async function loadEmailPreferences() {
  const { ok, data } = await apiFetch("/api/auth/email-preferences");
  if (!ok) {
    showFlash(data.error || "Could not load email preferences.", "danger");
    return;
  }

  const globalOptOutInput = document.getElementById("pref-global-opt-out");
  const blockedInput = document.getElementById("pref-blocked-organizers");
  const meta = document.getElementById("email-prefs-meta");

  globalOptOutInput.checked = data.global_opt_out === true;
  blockedInput.value = Array.isArray(data.blocked_organizers)
    ? data.blocked_organizers.join("\n")
    : "";
  meta.textContent = data.updated_at ? `Last updated: ${formatUpdatedAt(data.updated_at)}` : "";
}

async function saveEmailPreferences() {
  const saveBtn = document.getElementById("save-email-prefs-btn");
  const globalOptOutInput = document.getElementById("pref-global-opt-out");
  const blockedInput = document.getElementById("pref-blocked-organizers");

  const blockedOrganizers = parseBlockedOrganizerInput(blockedInput.value);
  const invalid = blockedOrganizers.find((email) => !isSimpleEmail(email));
  if (invalid) {
    showFlash(`Invalid organizer email: ${invalid}`, "danger");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  const { ok, data } = await apiFetch("/api/auth/email-preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      global_opt_out: globalOptOutInput.checked,
      blocked_organizers: blockedOrganizers,
    }),
  });

  saveBtn.disabled = false;
  saveBtn.textContent = "Save email preferences";

  if (!ok) {
    showFlash(data.error || "Could not save email preferences.", "danger");
    return;
  }

  showFlash("Email preferences saved.", "success");
  await loadEmailPreferences();
}

function renderCalendarStatus(connected) {
  const el = document.getElementById("calendar-status");
  if (connected) {
    el.innerHTML = `
      <div class="profile-calendar-status">
        <span class="profile-calendar-icon">✅</span>
        <div class="profile-calendar-copy">
          <strong class="profile-calendar-title">Google Calendar connected</strong>
          <p class="profile-calendar-note">MeetMe can load your busy times on meeting pages.</p>
        </div>
        <div class="profile-calendar-actions">
          <a href="/api/auth/google/calendar-start" class="btn btn-sm btn-ghost">Reconnect</a>
          <button type="button" class="btn btn-sm btn-danger" id="disconnect-calendar-btn">Disconnect</button>
        </div>
      </div>`;

    const disconnectBtn = document.getElementById("disconnect-calendar-btn");
    if (disconnectBtn) disconnectBtn.addEventListener("click", disconnectCalendar);
  } else {
    el.innerHTML = `
      <a href="/api/auth/google/calendar-start" class="btn btn-ghost btn-full profile-calendar-connect">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Connect Google Calendar
      </a>
      <p class="profile-calendar-readonly">Read-only. MeetMe never modifies your calendar.</p>`;
  }
}

async function disconnectCalendar() {
  if (!confirm("Disconnect Google Calendar from MeetMe?")) return;
  const { ok, data } = await apiFetch("/api/auth/google/calendar-disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (ok) {
    renderCalendarStatus(false);
    showFlash("Google Calendar disconnected.", "success");
  } else {
    showFlash(data.error || "Could not disconnect calendar. Please try again.", "danger");
  }
}
