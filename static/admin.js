let allUsers = [];
let allEvents = [];
let editingEmail = null;
let usersPage = 1;
let meetingsPage = 1;
let usersPagination = null;
let meetingsPagination = null;
const ADMIN_PAGE_SIZE = 25;

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const { ok, status, data } = await apiFetch("/api/admin/stats");
  if (!ok) {
    if (status === 403) {
      document.querySelector("main").innerHTML =
        '<div class="admin-access-denied">' +
        "<h2>Access Denied</h2>" +
        '<p class="text-muted">You do not have admin privileges.</p>' +
        '<a href="/dashboard.html" class="btn btn-primary admin-access-denied-link">Back to Dashboard</a>' +
        "</div>";
    } else {
      showFlash(data.error || "Failed to load admin panel.", "danger");
    }
    return;
  }

  document.getElementById("admin-page").hidden = false;
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
  document.getElementById("users-pagination").addEventListener("click", onUsersPaginationClick);
  document.getElementById("meetings-pagination").addEventListener("click", onMeetingsPaginationClick);
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
    p.hidden = true;
  });
  document.querySelectorAll(".admin-tab").forEach((b) => {
    b.classList.remove("active");
  });
  document.getElementById(`tab-${name}`).hidden = false;
  btn.classList.add("active");
  if (name === "events" && allEvents.length === 0) loadEvents();
  if (name === "meetings") loadMeetings();
}

async function loadUsers() {
  const query = document.getElementById("user-search").value.trim();
  const params = new URLSearchParams({
    page: String(usersPage),
    page_size: String(ADMIN_PAGE_SIZE),
  });
  if (query) params.set("q", query);

  const { ok, data } = await apiFetch(`/api/admin/users?${params.toString()}`);
  if (!ok) {
    showFlash(data.error || "Failed to load users.", "danger");
    return;
  }
  allUsers = data.users || [];
  usersPagination = data.pagination || null;
  renderUsers(allUsers);
  renderPagination("users-pagination", usersPagination, "users");
}

function renderUsers(users) {
  const tbody = document.getElementById("users-tbody");
  tbody.innerHTML = ""; // Clear existing content
  const fragment = document.createDocumentFragment();

  users.forEach((u) => {
    const tr = document.createElement("tr");

    let td = document.createElement("td");
    td.textContent = u.email;
    tr.appendChild(td);

    td = document.createElement("td");
    td.textContent = `${u.first_name || ""} ${u.last_name || ""}`.trim();
    tr.appendChild(td);

    td = document.createElement("td");
    const badge = document.createElement("span");
    if (u.is_super_admin) {
      badge.className = "badge badge-green";
      badge.textContent = "super admin";
    } else if (u.is_admin) {
      badge.className = "badge badge-gray";
      badge.textContent = "admin";
    } else {
      badge.className = "text-muted";
      badge.textContent = "member";
    }
    td.appendChild(badge);
    tr.appendChild(td);

    td = document.createElement("td");
    td.className = "admin-cell-small";
    td.textContent = u.timezone || "—";
    tr.appendChild(td);

    td = document.createElement("td");
    td.className = "admin-cell-small";
    td.textContent = u.created_at ? new Date(u.created_at).toLocaleDateString() : "—";
    tr.appendChild(td);

    td = document.createElement("td");
    td.className = "admin-cell-center";
    td.textContent = u.calendar_connected ? "✅" : "—";
    tr.appendChild(td);

    td = document.createElement("td");
    td.className = "admin-cell-nowrap";

    const createButton = (action, text) => {
      const btn = document.createElement("button");
      btn.className = "btn btn-xs btn-ghost";
      btn.dataset.action = action;
      btn.dataset.email = u.email;
      btn.textContent = text;
      return btn;
    };

    td.appendChild(createButton("view", "View"));
    td.appendChild(createButton("edit", "Edit"));
    td.appendChild(createButton("act", "Act as"));

    if (!u.is_super_admin) {
      const toggleAdminBtn = createButton("admin-toggle", u.is_admin ? "Revoke Admin" : "Make Admin");
      toggleAdminBtn.dataset.nextAdmin = u.is_admin ? "false" : "true";
      td.appendChild(toggleAdminBtn);
    }
    tr.appendChild(td);

    fragment.appendChild(tr);
  });

  tbody.appendChild(fragment);
}

function renderPagination(containerId, pagination, kind) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  if (!pagination || pagination.total <= pagination.page_size) {
    return;
  }

  const summary = document.createElement("div");
  summary.className = "admin-pagination-summary";
  summary.textContent = `Page ${pagination.page} of ${pagination.total_pages} · ${pagination.total} total`;

  const controls = document.createElement("div");
  controls.className = "admin-pagination-controls";

  const prevBtn = document.createElement("button");
  prevBtn.className = "btn btn-ghost btn-sm";
  prevBtn.type = "button";
  prevBtn.dataset.kind = kind;
  prevBtn.dataset.page = pagination.page - 1;
  prevBtn.disabled = !pagination.has_prev;
  prevBtn.textContent = "Previous";

  const nextBtn = document.createElement("button");
  nextBtn.className = "btn btn-ghost btn-sm";
  nextBtn.type = "button";
  nextBtn.dataset.kind = kind;
  nextBtn.dataset.page = pagination.page + 1;
  nextBtn.disabled = !pagination.has_next;
  nextBtn.textContent = "Next";

  controls.append(prevBtn, nextBtn);
  container.append(summary, controls);
}

function onUsersPaginationClick(e) {
  const button = e.target.closest("button[data-kind='users'][data-page]");
  if (!button) return;
  usersPage = Math.max(1, Number.parseInt(button.dataset.page || "1", 10) || 1);
  loadUsers();
}

function onMeetingsPaginationClick(e) {
  const button = e.target.closest("button[data-kind='meetings'][data-page]");
  if (!button) return;
  meetingsPage = Math.max(1, Number.parseInt(button.dataset.page || "1", 10) || 1);
  loadMeetings();
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
  usersPage = 1;
  loadUsers();
}

function openUserModal(email) {
  editingEmail = email;
  const u = email ? allUsers.find((user) => user.email === email) : null;
  document.getElementById("modal-title").textContent = email ? "Edit User" : "Create User";
  document.getElementById("modal-first").value = u?.first_name || "";
  document.getElementById("modal-last").value = u?.last_name || "";
  document.getElementById("modal-email").value = email || "";
  document.getElementById("modal-email").readOnly = !!email;
  document.getElementById("modal-delete-zone").hidden = !email;
  document.getElementById("user-modal").hidden = false;
}

function closeUserModal() {
  document.getElementById("user-modal").hidden = true;
}

async function saveUser(e) {
  e.preventDefault();
  const body = {
    email: document.getElementById("modal-email").value.trim(),
    first_name: document.getElementById("modal-first").value.trim(),
    last_name: document.getElementById("modal-last").value.trim(),
  };
  const { ok, status, data } = await apiFetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (ok) {
    showFlash(status === 201 ? "User created." : "User updated.", "success");
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
  document.getElementById("user-detail-modal").hidden = false;

  const { ok, data } = await apiFetch(`/api/admin/users/${encodeURIComponent(email)}`);
  if (!ok) {
    document.getElementById("detail-body").innerHTML =
      `<p class="text-muted">${escapeHtml(data.error || "Failed to load.")}</p>`;
    return;
  }

  const u = data.user;
  const detailBody = document.getElementById("detail-body");
  detailBody.innerHTML = "";

  const table = document.createElement("table");
  table.className = "admin-detail-table";
  const addRow = (lbl, val) => {
    const tr = document.createElement("tr");
    const th = document.createElement("td"); th.className = "admin-detail-label"; th.textContent = lbl;
    const td = document.createElement("td"); td.className = "admin-detail-value"; td.textContent = val;
    tr.append(th, td);
    table.appendChild(tr);
  };

  addRow("Email", u.email);
  addRow("Name", `${u.first_name || ""} ${u.last_name || ""}`.trim());
  addRow("Timezone", u.timezone || "—");
  addRow("Joined", u.created_at ? new Date(u.created_at).toLocaleString() : "—");
  addRow("Calendar", u.calendar_connected ? "✅ Connected" : "—");
  addRow("Meetings created", data.created_meetings?.length ?? 0);
  addRow("Meetings invited", data.invited_meetings?.length ?? 0);

  detailBody.appendChild(table);

  if (data.created_meetings?.length) {
    const meetingsDiv = document.createElement("div");
    meetingsDiv.className = "admin-detail-meetings";

    const strong = document.createElement("strong");
    strong.className = "admin-detail-heading";
    strong.textContent = "CREATED MEETINGS";
    meetingsDiv.appendChild(strong);

    const ul = document.createElement("ul");
    ul.className = "admin-detail-list";
    data.created_meetings.forEach(m => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `/meeting.html?id=${encodeURIComponent(m.id)}`;
      a.target = "_blank";
      a.textContent = m.title;
      li.appendChild(a);
      if (m.is_finalized) li.appendChild(document.createTextNode(" ✅"));
      ul.appendChild(li);
    });
    meetingsDiv.appendChild(ul);
    detailBody.appendChild(meetingsDiv);
  }
}

function closeDetailModal() {
  document.getElementById("user-detail-modal").hidden = true;
}

async function loadMeetings() {
  const tbody = document.getElementById("meetings-tbody");
  tbody.innerHTML = '<tr><td colspan="7" class="text-muted admin-table-placeholder">Loading…</td></tr>';
  const params = new URLSearchParams({
    page: String(meetingsPage),
    page_size: String(ADMIN_PAGE_SIZE),
  });
  const { ok, data } = await apiFetch(`/api/admin/meetings?${params.toString()}`);
  if (!ok) {
    tbody.innerHTML = `<tr><td colspan="7">${escapeHtml(data.error || "Failed")}</td></tr>`;
    return;
  }
  const meetings = data.meetings || [];
  meetingsPagination = data.pagination || null;

  tbody.innerHTML = "";
  if (meetings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted admin-table-placeholder">No meetings found.</td></tr>';
  } else {
    const fragment = document.createDocumentFragment();
    meetings.forEach(m => {
      const tr = document.createElement("tr");

      let td = document.createElement("td");
      const a = document.createElement("a");
      a.href = `/meeting.html?id=${encodeURIComponent(m.id)}`;
      a.target = "_blank";
      a.textContent = m.title;
      td.appendChild(a);
      tr.appendChild(td);

      td = document.createElement("td");
      td.className = "admin-cell-small";
      td.textContent = m.creator_name || "—";
      tr.appendChild(td);

      td = document.createElement("td");
      td.className = "admin-cell-small";
      td.textContent = (m.meeting_type || "").replace("_", " ");
      tr.appendChild(td);

      td = document.createElement("td");
      td.className = "admin-cell-tiny";
      td.textContent = m.timezone || "UTC";
      tr.appendChild(td);

      td = document.createElement("td");
      td.className = "admin-cell-small";
      td.textContent = (m.invitees || []).length;
      tr.appendChild(td);

      td = document.createElement("td");
      td.className = "admin-cell-center";
      td.textContent = m.is_finalized ? "✅" : "—";
      tr.appendChild(td);

      td = document.createElement("td");
      td.className = "admin-cell-tiny";
      td.textContent = m.created_at ? new Date(m.created_at).toLocaleDateString() : "—";
      tr.appendChild(td);

      fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
  }
  renderPagination("meetings-pagination", meetingsPagination, "meetings");
}

async function loadEvents() {
  const tbody = document.getElementById("events-tbody");
  tbody.innerHTML = '<tr><td colspan="5" class="text-muted admin-table-placeholder">Loading…</td></tr>';
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

  tbody.innerHTML = "";
  if (events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted admin-table-placeholder">No events found.</td></tr>';
  } else {
    const fragment = document.createDocumentFragment();
    events.forEach(ev => {
      const tr = document.createElement("tr");
      const extra = extractDetails(ev);

      let td = document.createElement("td");
      td.className = "admin-cell-tiny admin-cell-nowrap";
      td.textContent = formatEventTime(ev.ts || ev.timestamp || "");
      tr.appendChild(td);

      td = document.createElement("td");
      const span = document.createElement("span");
      span.className = `log-level log-level-${ev.level || "info"}`;
      span.textContent = ev.level || "info";
      td.appendChild(span);
      tr.appendChild(td);

      td = document.createElement("td");
      td.className = "admin-cell-small";
      td.textContent = ev.fn || "";
      tr.appendChild(td);

      td = document.createElement("td");
      td.className = "admin-cell-message";
      td.textContent = ev.message || "";
      tr.appendChild(td);

      td = document.createElement("td");
      td.className = "admin-cell-detail";
      td.title = extra;
      td.textContent = extra;
      tr.appendChild(td);

      fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
  }
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
