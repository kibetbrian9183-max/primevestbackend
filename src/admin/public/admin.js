const API = ""; // same-origin — the admin panel is served by this backend

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }

async function api(path, options = {}) {
  const res = await fetch(`${API}/api/admin${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  return new Date(d).toLocaleString();
}
function pill(status) {
  return `<span class="pill ${status}">${status}</span>`;
}

// ---------------------------------------------------------------------------
// Auth / view switching
// ---------------------------------------------------------------------------
async function checkSession() {
  try {
    await api("/me");
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $("#loginView").hidden = false;
  $("#appView").hidden = true;
}

function showApp() {
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  loadOverview();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginError").hidden = true;
  const btn = e.target.querySelector("button[type=submit]");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Logging in…";

  // Render's free tier can take 50+ seconds to wake from idle — show
  // that explicitly instead of leaving the button looking frozen.
  const slowNotice = setTimeout(() => {
    btn.textContent = "Still waking up the server… hang tight";
  }, 6000);

  // Don't hang forever if something is actually wrong.
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), 60000);

  try {
    await api("/login", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        email: $("#loginEmail").value,
        password: $("#loginPassword").value,
      }),
    });
    showApp();
  } catch (err) {
    $("#loginError").textContent =
      err.name === "AbortError"
        ? "The server took too long to respond. Wait a few seconds and try again."
        : err.message;
    $("#loginError").hidden = false;
  } finally {
    clearTimeout(slowNotice);
    clearTimeout(hardTimeout);
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/logout", { method: "POST" }); } catch {}
  showLogin();
});

$all(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function switchView(view) {
  $all(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $all(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  if (view === "overview") loadOverview();
  if (view === "users") loadUsers();
  if (view === "withdrawals") loadPayments("withdrawal", "#withdrawalsTable", true);
  if (view === "deposits") loadPayments("deposit", "#depositsTable", false);
  if (view === "notifications") loadNotifications();
  if (view === "settings") loadSettings();
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
async function loadOverview() {
  const s = await api("/stats");
  $("#statCards").innerHTML = `
    <div class="stat-card"><div class="label">TOTAL USERS</div><div class="value">${s.userCount}</div></div>
    <div class="stat-card"><div class="label">TOTAL TRADES</div><div class="value">${s.tradeCount}</div></div>
    <div class="stat-card"><div class="label">TOTAL DEPOSITS</div><div class="value">$${fmtMoney(s.deposits.totalUsd)}</div></div>
    <div class="stat-card"><div class="label">TOTAL WITHDRAWALS PAID</div><div class="value">$${fmtMoney(s.withdrawals.totalUsd)}</div></div>
    <div class="stat-card"><div class="label">PENDING WITHDRAWALS</div><div class="value" style="color:var(--amber)">${s.pendingWithdrawals}</div></div>
  `;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
let usersCache = [];

async function loadUsers() {
  const q = $("#userSearch").value.trim();
  const { users } = await api(`/users${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  usersCache = users;
  const table = $("#usersTable");
  table.querySelector("thead").innerHTML = `<tr><th>Name</th><th>Email</th><th>Demo</th><th>Real</th><th>Status</th><th>Joined</th><th></th></tr>`;
  table.querySelector("tbody").innerHTML = users.length
    ? users
        .map(
          (u) => `<tr>
            <td>${u.name || "—"}</td>
            <td>${u.email}</td>
            <td>$${fmtMoney(u.demoBalance)}</td>
            <td>$${fmtMoney(u.realBalance)}</td>
            <td>${pill(u.status)}</td>
            <td>${fmtDate(u.createdAt)}</td>
            <td><button class="link-btn" onclick="openUser('${u._id}')">View</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty-note">No users yet</td></tr>`;
}

let searchDebounce;
$("#userSearch").addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadUsers, 300);
});

async function openUser(id) {
  const { user, trades, payments } = await api(`/users/${id}`);
  const won = trades.filter((t) => t.status === "won").length;
  const lost = trades.filter((t) => t.status === "lost").length;
  const idt = user.identity || {};

  let docsHtml = "";
  if (user.identityStatus !== "unverified") {
    const { documents } = await api(`/users/${id}/documents`);
    const thumb = (kind, label) => {
      const has = documents.some((d) => d.kind === kind);
      return has
        ? `<a href="/api/admin/users/${id}/documents/${kind}" target="_blank" style="display:block">
             <img src="/api/admin/users/${id}/documents/${kind}" alt="${label}"
                  style="width:100%;border-radius:10px;border:1px solid var(--border);object-fit:cover;height:110px" />
             <div class="meta" style="text-align:center;margin-top:4px">${label}</div>
           </a>`
        : `<div class="empty-note" style="padding:12px">${label} not uploaded</div>`;
    };
    docsHtml = `
      <h3>Identity verification</h3>
      <div class="detail-row"><span>Legal name</span><span>${idt.firstName || ""} ${idt.middleName || ""} ${idt.lastName || ""}</span></div>
      <div class="detail-row"><span>Date of birth</span><span>${idt.dateOfBirth || "—"}</span></div>
      <div class="detail-row"><span>ID type / number</span><span>${idt.idType || "—"} · ${idt.idNumber || "—"}</span></div>
      <div class="detail-row"><span>Issuing country</span><span>${idt.issuingCountry || "—"}</span></div>
      <div class="detail-row"><span>Contact</span><span>${idt.contactEmail || "—"} · ${idt.contactPhone || "—"}</span></div>
      <div class="detail-row"><span>Address</span><span>${[idt.addressLine, idt.city, idt.stateCounty, idt.postalCode, idt.country].filter(Boolean).join(", ") || "—"}</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin:14px 0">
        ${thumb("id_front", "ID Front")}
        ${thumb("id_back", "ID Back")}
        ${thumb("selfie", "Selfie w/ ID")}
      </div>
      ${
        user.identityStatus === "pending"
          ? `<div class="row-actions" style="margin-bottom:20px">
               <button class="btn-sm pay" onclick="decideIdentity('${id}','verified')">Approve identity</button>
               <button class="btn-sm reject" onclick="decideIdentity('${id}','unverified')">Reject</button>
             </div>`
          : ""
      }
    `;
  }

  $("#userModalBody").innerHTML = `
    <h2 style="margin-top:0">${user.name || "Unnamed"}</h2>
    <p class="muted" style="margin-top:-8px">${user.email}</p>
    <div class="detail-row"><span>Status</span><span>${pill(user.status)}</span></div>
    <div class="detail-row"><span>Demo balance</span><span>$${fmtMoney(user.demoBalance)}</span></div>
    <div class="detail-row"><span>Real balance</span><span>$${fmtMoney(user.realBalance)}</span></div>
    <div class="detail-row"><span>Trades</span><span>${trades.length} (${won}W / ${lost}L)</span></div>
    <div class="detail-row"><span>Identity</span><span>${pill(user.identityStatus)}</span></div>
    <div class="detail-row"><span>Joined</span><span>${fmtDate(user.createdAt)}</span></div>

    ${docsHtml}

    <h3>Recent payments</h3>
    ${
      payments.length
        ? payments
            .slice(0, 8)
            .map(
              (p) =>
                `<div class="list-item"><div class="title">${p.type === "deposit" ? "+" : "-"}KES ${fmtMoney(p.amountKes)} (\$${fmtMoney(p.usdAmount)}) ${pill(p.status)}</div><div class="meta">${p.phone} · ${fmtDate(p.createdAt)}</div></div>`
            )
            .join("")
        : `<p class="empty-note">No payments yet</p>`
    }

    <div class="row-actions" style="margin-top:20px">
      <button class="btn-sm ${user.status === "active" ? "reject" : "pay"}" onclick="toggleSuspend('${user._id}', '${user.status}')">
        ${user.status === "active" ? "Suspend user" : "Reactivate user"}
      </button>
      <button class="btn-sm delete" onclick="deleteUser('${user._id}')">Delete user</button>
    </div>
  `;
  $("#userModal").hidden = false;
}

async function decideIdentity(id, decision) {
  await api(`/users/${id}/identity`, { method: "PATCH", body: JSON.stringify({ decision }) });
  openUser(id);
}

$("#closeUserModal").addEventListener("click", () => ($("#userModal").hidden = true));

async function toggleSuspend(id, currentStatus) {
  const status = currentStatus === "active" ? "suspended" : "active";
  await api(`/users/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
  $("#userModal").hidden = true;
  loadUsers();
}

async function deleteUser(id) {
  if (!confirm("Delete this user and all their trades/payments? This can't be undone.")) return;
  await api(`/users/${id}`, { method: "DELETE" });
  $("#userModal").hidden = true;
  loadUsers();
}

// ---------------------------------------------------------------------------
// Payments (withdrawals / deposits)
// ---------------------------------------------------------------------------
async function loadPayments(type, tableSel, withActions) {
  const { payments } = await api(`/payments?type=${type}`);
  const table = $(tableSel);
  table.querySelector("thead").innerHTML = `<tr><th>User</th><th>Phone</th><th>KES</th><th>USD</th><th>Status</th><th>Date</th>${withActions ? "<th></th>" : ""}</tr>`;
  table.querySelector("tbody").innerHTML = payments.length
    ? payments
        .map(
          (p) => `<tr>
            <td>${p.user?.name || p.user?.email || "—"}</td>
            <td>${p.phone}</td>
            <td>KES ${fmtMoney(p.amountKes)}</td>
            <td>$${fmtMoney(p.usdAmount)}</td>
            <td>${pill(p.status)}</td>
            <td>${fmtDate(p.createdAt)}</td>
            ${
              withActions && p.status === "pending"
                ? `<td class="row-actions">
                    <button class="btn-sm pay" onclick="markPaid('${p._id}', '${type}')">Mark paid</button>
                    <button class="btn-sm reject" onclick="rejectPayment('${p._id}', '${type}')">Reject</button>
                   </td>`
                : withActions
                ? "<td></td>"
                : ""
            }
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty-note">Nothing here yet</td></tr>`;
}

async function markPaid(id, type) {
  await api(`/payments/${id}/mark-paid`, { method: "PATCH", body: JSON.stringify({}) });
  loadPayments(type, type === "withdrawal" ? "#withdrawalsTable" : "#depositsTable", type === "withdrawal");
  loadOverview();
}

async function rejectPayment(id, type) {
  const note = prompt("Reason for rejecting (optional):") || "";
  await api(`/payments/${id}/reject`, { method: "PATCH", body: JSON.stringify({ note }) });
  loadPayments(type, type === "withdrawal" ? "#withdrawalsTable" : "#depositsTable", type === "withdrawal");
  loadOverview();
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
async function loadNotifications() {
  const { users } = await api("/users");
  const select = $("#notifyTarget");
  select.innerHTML =
    `<option value="">All users (broadcast)</option>` +
    users.map((u) => `<option value="${u._id}">${u.name || u.email}</option>`).join("");

  const { notifications } = await api("/notifications");
  $("#notifyList").innerHTML = notifications.length
    ? notifications
        .map(
          (n) =>
            `<div class="list-item"><div class="title">${n.title}</div>${n.body}<div class="meta">${n.user ? "Direct" : "Broadcast"} · ${fmtDate(n.createdAt)}</div></div>`
        )
        .join("")
    : `<p class="empty-note">No notifications sent yet</p>`;
}

$("#notifyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/notifications", {
    method: "POST",
    body: JSON.stringify({
      userId: $("#notifyTarget").value || null,
      title: $("#notifyTitle").value,
      body: $("#notifyBody").value,
    }),
  });
  $("#notifyForm").reset();
  loadNotifications();
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function loadSettings() {
  const { settings } = await api("/settings");
  $("#setRate").value = settings.usdKesRate;
  $("#setMinDeposit").value = settings.minDepositKes;
  $("#setMinWithdrawal").value = settings.minWithdrawalUsd;
  $("#setPayoutRate").value = settings.payoutRate;
  $("#setReferralRate").value = settings.referralRate;
  $("#setMaintenance").checked = settings.maintenanceMode;
}

$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/settings", {
    method: "PATCH",
    body: JSON.stringify({
      usdKesRate: Number($("#setRate").value),
      minDepositKes: Number($("#setMinDeposit").value),
      minWithdrawalUsd: Number($("#setMinWithdrawal").value),
      payoutRate: Number($("#setPayoutRate").value),
      referralRate: Number($("#setReferralRate").value),
      maintenanceMode: $("#setMaintenance").checked,
    }),
  });
  alert("Settings saved");
});

checkSession();
