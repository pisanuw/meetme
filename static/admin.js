let allUsers = [];
let allEvents = [];
let editingEmail = null;

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const { ok, status, data } = await apiFetch("/api/admin/stats");
  if (!ok) {
    if (status === 403) {
      document.querySelector("main").innerHTML =
        '<div style="text-align:center;padding:60px 20px;">' +
        "<h2>Access Denied</h2>" +
        '<p class="text-muted">You do not have admin privileges.</p>' +
        '<a href="/dashboard.html" class="btn btn-primary" style="margin-top:16px;">Back to Dashboard</a>' +
        "</div>";
    } else {
      showFlash(data.error || "Failed to load admin panel.", "danger");
    }
    return;
  }

  document.getElementById("admin-page").style.display = "";
  renderStats(data);
  bindUi();
  await loadUsers();
})();

function bindUi() {
  document.getElementById("admin-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".admin-tab[data-tab]");
    if (!btn) return;
    showTab(btn.dataset.tab, btn);
  });

  document.getElementById("user-search").addEventListener("input", filterUsers);
  document.getElementById("event-search").addEventListener("input", filterEvents);
  document.getElementById("create-user-btn").addEventListener("click", () => openUserModal(null));
  document.getElementById("refresh-events-btn").addEventListener("click", loadEvents);

  const userModal = document.getElementById("user-modal");
  userModal.addEventListener("click", (e) => {
    if (e.target === userModal) closeUserModal();
  });
  document.getElementById("user-modal-close-btn").addEventListener("click", closeUserModal);
  document.getElementById("cancel-user-btn").addEventListener("click", closeUserModal);
  document.getElementById("user-form").addEventListener("submit", saveUser);
  document.getElementById("delete-user-btn").addEventListener("click", deleteUser);

  const detailModal = document.getElementById("user-detail-modal");
  detailModal.addEventListener("click", (e) => {
    if (e.target === detailModal) closeDetailModal();
  });
  document.getElementById("detail-modal-close-btn").addEventListener("click", closeDetailModal);

  document.getElementById("users-tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action][data-email]");
    if (!btn) return;
    const email = btn.dataset.email;
    const action = btn.dataset.action;
    if (action === "view") viewUserDetail(email);
    if (action === "edit") openUserModal(email);
    if (action === "act") impersonateUser(email);
    if (action === "admin-toggle") toggleAdminRole(email, btn.dataset.nextAdmin === "true");
  });
}

function renderStats(data) {
  document.getElementById("stat-users").textContent = data.total_users ?? "—";
  document.getElementById("stat-meetings").textContent = data.total_meetings ?? "—";
  document.getElementById("stat-events").textContent = data.total_events ?? "—";
}

function showTab(name, btn) {
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.style.display = "none";
  });
  document.querySelectorAll(".admin-tab").forEach((b) => {
    b.classList.remove("active");
  });
  document.getElementById(`tab-${name}`).style.display = "";
  btn.classList.add("active");
  if (name === "events" && allEvents.length === 0) loadEvents();
  if (name === "meetings") loadMeetings();
}

async function loadUsers() {
  const { ok, data } = await apiFetch("/api/admin/users");
  if (!ok) {
    showFlash(data.error || "Failed to load users.", "danger");
    return;
  }
  allUsers = data.users || [];
  renderUsers(allUsers);
}

function renderUsers(users) {
  const tbody = document.getElementById("users-tbody");
  tbody.innerHTML = users
    .map(
      (u) => `
    <tr>
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.first_name || "")} ${escapeHtml(u.last_name || "")}</td>
      <td>
        ${u.is_super_admin ? '<span class="badge badge-green">super admin</span>' : u.is_admin ? '<span class="badge badge-gray">admin</span>' : '<span class="text-muted">member</span>'}
      </td>
      <td style="font-size:0.8rem;">${escapeHtml(u.timezone || "—")}</td>
      <td style="font-size:0.8rem;">${u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}</td>
      <td style="text-align:center;">${u.calendar_connected ? "✅" : "—"}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-xs btn-ghost" data-action="view" data-email="${escapeHtml(u.email)}">View</button>
        <button class="btn btn-xs btn-ghost" data-action="edit" data-email="${escapeHtml(u.email)}">Edit</button>
        <button class="btn btn-xs btn-ghost" data-action="act" data-email="${escapeHtml(u.email)}">Act as</button>
        ${u.is_super_admin ? "" : `<button class="btn btn-xs btn-ghost" data-action="admin-toggle" data-next-admin="${u.is_admin ? "false" : "true"}" data-email="${escapeHtml(u.email)}">${u.is_admin ? "Revoke Admin" : "Make Admin"}</button>`}
      </td>
    </tr>`
    )
    .join("");
}

async function toggleAdminRole(email, makeAdmin) {
  const actionLabel = makeAdmin ? "grant admin" : "revoke admin";
  if (!confirm(`Are you sure you want to ${actionLabel} for ${email}?`)) return;

  const { ok, data } = await apiFetch("/api/admin/users/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, is_admin: makeAdmin }),
  });

  if (!ok) {
    showFlash(data.error || "Failed to update admin role.", "danger");
    return;
  }

  showFlash(makeAdmin ? "Admin role granted." : "Admin role revoked.", "success");
  await loadUsers();
}

async function impersonateUser(email) {
  if (!confirm(`Act as ${email}? You can return to your admin account from the top navigation.`))
    return;
  const { ok, data } = await apiFetch("/api/admin/impersonate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!ok) {
    showFlash(data.error || "Failed to start impersonation.", "danger");
    return;
  }
  window.location.href = "/dashboard.html";
}

function filterUsers() {
  const q = document.getElementById("user-search").value.toLowerCase();
  renderUsers(
    allUsers.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        (u.first_name || "").toLowerCase().includes(q) ||
        (u.last_name || "").toLowerCase().includes(q)
    )
  );
}

function openUserModal(email) {
  editingEmail = email;
  const u = email ? allUsers.find((user) => user.email === email) : null;
  document.getElementById("modal-title").textContent = email ? "Edit User" : "Create User";
  document.getElementById("modal-first").value = u?.first_name || "";
  document.getElementById("modal-last").value = u?.last_name || "";
  document.getElementById("modal-email").value = email || "";
  document.getElementById("modal-email").readOnly = !!email;
  document.getElementById("modal-delete-zone").style.display = email ? "" : "none";
  document.getElementById("user-modal").style.display = "";
}

function closeUserModal() {
  document.getElementById("user-modal").style.display = "none";
}

async function saveUser(e) {
  e.preventDefault();
  const body = {
    email: document.getElementById("modal-email").value.trim(),
    first_name: document.getElementById("modal-first").value.trim(),
    last_name: document.getElementById("modal-last").value.trim(),
  };
  const { ok, data } = await apiFetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (ok) {
    showFlash(data.created ? "User created." : "User updated.", "success");
    closeUserModal();
    await loadUsers();
  } else {
    showFlash(data.error || "Failed to save user.", "danger");
  }
}

async function deleteUser() {
  if (!editingEmail || !confirm(`Permanently delete ${editingEmail}? This cannot be undone.`))
    return;
  const { ok, data } = await apiFetch("/api/admin/users/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: editingEmail }),
  });
  if (ok) {
    showFlash("User deleted.", "success");
    closeUserModal();
    await loadUsers();
  } else {
    showFlash(data.error || "Failed to delete user.", "danger");
  }
}

async function viewUserDetail(email) {
  document.getElementById("detail-title").textContent = email;
  document.getElementById("detail-body").innerHTML = '<p class="text-muted">Loading…</p>';
  document.getElementById("user-detail-modal").style.display = "";

  const { ok, data } = await apiFetch(`/api/admin/users/${encodeURIComponent(email)}`);
  if (!ok) {
    document.getElementById("detail-body").innerHTML =
      `<p class="text-muted">${escapeHtml(data.error || "Failed to load.")}</p>`;
    return;
  }

  const u = data.user;
  document.getElementById("detail-body").innerHTML = `
    <table style="width:100%;font-size:0.875rem;border-collapse:collapse;">
      <tr><td style="padding:4px 8px;color:var(--text-muted)">Email</td><td style="padding:4px 8px;">${escapeHtml(u.email)}</td></tr>
      <tr><td style="padding:4px 8px;color:var(--text-muted)">Name</td><td style="padding:4px 8px;">${escapeHtml((u.first_name || "") + " " + (u.last_name || ""))}</td></tr>
      <tr><td style="padding:4px 8px;color:var(--text-muted)">Timezone</td><td style="padding:4px 8px;">${escapeHtml(u.timezone || "—")}</td></tr>
      <tr><td style="padding:4px 8px;color:var(--text-muted)">Joined</td><td style="padding:4px 8px;">${u.created_at ? new Date(u.created_at).toLocaleString() : "—"}</td></tr>
      <tr><td style="padding:4px 8px;color:var(--text-muted)">Calendar</td><td style="padding:4px 8px;">${u.calendar_connected ? "✅ Connected" : "—"}</td></tr>
      <tr><td style="padding:4px 8px;color:var(--text-muted)">Meetings created</td><td style="padding:4px 8px;">${data.created_meetings?.length ?? 0}</td></tr>
      <tr><td style="padding:4px 8px;color:var(--text-muted)">Meetings invited</td><td style="padding:4px 8px;">${data.invited_meetings?.length ?? 0}</td></tr>
    </table>
    ${
      data.created_meetings?.length
        ? `
    <div style="margin-top:14px;">
      <strong style="font-size:0.8rem;color:var(--text-muted);">CREATED MEETINGS</strong>
      <ul style="margin:6px 0;padding-left:18px;font-size:0.85rem;">
        ${data.created_meetings.map((m) => `<li><a href="/meeting.html?id=${escapeHtml(m.id)}" target="_blank">${escapeHtml(m.title)}</a>${m.is_finalized ? " ✅" : ""}</li>`).join("")}
      </ul>
    </div>`
        : ""
    }`;
}

function closeDetailModal() {
  document.getElementById("user-detail-modal").style.display = "none";
}

async function loadMeetings() {
  const tbody = document.getElementById("meetings-tbody");
  tbody.innerHTML =
    '<tr><td colspan="7" class="text-muted" style="padding:16px;text-align:center;">Loading…</td></tr>';
  const { ok, data } = await apiFetch("/api/admin/meetings");
  if (!ok) {
    tbody.innerHTML = `<tr><td colspan="7">${escapeHtml(data.error || "Failed")}</td></tr>`;
    return;
  }
  const meetings = data.meetings || [];
  tbody.innerHTML =
    meetings
      .map(
        (m) => `
    <tr>
      <td><a href="/meeting.html?id=${escapeHtml(m.id)}" target="_blank">${escapeHtml(m.title)}</a></td>
      <td style="font-size:0.8rem;">${escapeHtml(m.creator_name || "—")}</td>
      <td style="font-size:0.8rem;">${(m.meeting_type || "").replace("_", " ")}</td>
      <td style="font-size:0.78rem;">${escapeHtml(m.timezone || "UTC")}</td>
      <td style="font-size:0.8rem;">${(m.invitees || []).length}</td>
      <td style="text-align:center;">${m.is_finalized ? "✅" : "—"}</td>
      <td style="font-size:0.78rem;">${m.created_at ? new Date(m.created_at).toLocaleDateString() : "—"}</td>
    </tr>`
      )
      .join("") ||
    '<tr><td colspan="7" class="text-muted" style="padding:16px;text-align:center;">No meetings found.</td></tr>';
}

async function loadEvents() {
  const tbody = document.getElementById("events-tbody");
  tbody.innerHTML =
    '<tr><td colspan="5" class="text-muted" style="padding:16px;text-align:center;">Loading…</td></tr>';
  const { ok, data } = await apiFetch("/api/admin/events");
  if (!ok) {
    tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(data.error || "Failed")}</td></tr>`;
    return;
  }
  allEvents = data.events || [];
  renderEvents(allEvents);
}

function renderEvents(events) {
  const tbody = document.getElementById("events-tbody");
  const formatEventTime = (isoTs) => {
    if (!isoTs) return "—";
    const d = new Date(isoTs);
    if (Number.isNaN(d.getTime())) return isoTs;
    return `${d.toLocaleString()} (${d.toISOString().replace("T", " ").slice(0, 19)} UTC)`;
  };

  const extractDetails = (ev) => {
    const reserved = new Set(["ts", "level", "fn", "message"]);
    const detailObj = {};
    for (const [key, value] of Object.entries(ev || {})) {
      if (!reserved.has(key)) detailObj[key] = value;
    }
    const keys = Object.keys(detailObj);
    if (keys.length === 0) return "";
    return JSON.stringify(detailObj);
  };

  tbody.innerHTML =
    events
      .map((ev) => {
        const extra = extractDetails(ev);
        return `<tr>
      <td style="font-size:0.78rem;white-space:nowrap;">${escapeHtml(formatEventTime(ev.ts || ev.timestamp || ""))}</td>
      <td><span class="log-level log-level-${ev.level || "info"}">${escapeHtml(ev.level || "info")}</span></td>
      <td style="font-size:0.8rem;">${escapeHtml(ev.fn || "")}</td>
      <td style="font-size:0.85rem;">${escapeHtml(ev.message || "")}</td>
      <td style="font-size:0.75rem;color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          title="${escapeHtml(extra)}">${escapeHtml(extra)}</td>
    </tr>`;
      })
      .join("") ||
    '<tr><td colspan="5" class="text-muted" style="padding:16px;text-align:center;">No events found.</td></tr>';
}

function filterEvents() {
  const q = document.getElementById("event-search").value.toLowerCase();
  renderEvents(
    allEvents.filter(
      (ev) =>
        (ev.message || "").toLowerCase().includes(q) ||
        (ev.fn || "").toLowerCase().includes(q) ||
        (ev.level || "").toLowerCase().includes(q)
    )
  );
}
