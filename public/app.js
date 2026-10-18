import { createOffice } from "/office3d.js";
import { initTheme, setTheme, currentTheme } from "/ui/theme.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + (n || 0).toFixed(2);
const tokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n || 0));
const totalTok = (t) => (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
const LABEL = { working: "Working", waiting: "Needs you", idle: "Idle", offline: "Offline" };
const COLORS = { working: "#2E9E6B", waiting: "#D9931C", idle: "#8A97A3", offline: "#C3CBD2" };
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : Math.round(s / 3600) + "h ago";
}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", "X-Requested-With": "agent-office", ...(opts.headers || {}) } });
  if (res.status === 401) { location.href = "/login.html"; throw new Error("Sign in first."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

let state = { agents: [], totals: {} }, settings = {}, selectedId = null;
const prevStates = new Map();

// ---------- office (public/office3d.js) ----------
initTheme();
const office = createOffice($("office"), { onSelect(id) { select(id === selectedId ? null : id); }, onRetry: load });
const themeBtn = $("theme");
const syncThemeBtn = () => { themeBtn.textContent = currentTheme() === "dark" ? "Light theme" : "Dark theme"; };
themeBtn.onclick = () => { setTheme(currentTheme() === "dark" ? "light" : "dark"); syncThemeBtn(); };
syncThemeBtn();
const drawOffice = () => office.update(state.agents, { offlineAfterMin: settings.offlineAfterMin });

// ---------- side list ----------
function select(id) { selectedId = id; renderList(); }

function line(a) {
  if (a.state === "waiting") return a.message || "Waiting for you";
  if (a.state === "working" && a.tool) return `${a.tool} ${a.target || ""}`;
  return a.task || LABEL[a.state];
}

function detail(a) {
  return `<div class="detail" data-detail>
    <div class="row"><label for="rename" style="font-size:13px;color:var(--ink-2)">Name</label>
      <input id="rename" value="${esc(a.name)}" maxlength="40" ${a.folder ? "" : "disabled"}>
      <button class="btn" data-rename="${esc(a.folder || "")}">Save</button></div>
    <dl class="kv">
      <dt>Task</dt><dd>${esc(a.task || "No prompt yet")}</dd>
      <dt>Folder</dt><dd>${esc(a.folder || "-")}</dd>
      <dt>Tokens</dt><dd>in ${tokens(a.tokens.input)} · out ${tokens(a.tokens.output)} · cache ${tokens(a.tokens.cacheRead + a.tokens.cacheWrite)}</dd>
      <dt>Requests</dt><dd>${a.requests} · ${a.toolCount} tools</dd>
      <dt>Session</dt><dd>${esc(a.session)}</dd>
    </dl>
    <div class="hist">${(a.history || []).map((h) => `<div title="${esc(h.target || h.msg || "")}">${new Date(h.t).toLocaleTimeString()} ${esc(h.ev)} ${esc(h.tool || "")} ${esc(h.target || h.msg || "")}</div>`).join("") || "No events yet"}</div>
  </div>`;
}

function card(a) {
  const sel = a.session === selectedId;
  return `<button class="agent ${sel ? "sel" : ""} ${a.state === "offline" ? "off" : ""}" data-id="${esc(a.session)}" aria-expanded="${sel}">
    <div class="top"><i class="dot" style="background:${COLORS[a.state]}"></i>${esc(a.name)}
      <span class="meta">${a.cost ? money(a.cost) + " · " : ""}${ago(a.updated)}</span></div>
    <div class="what">${esc(line(a))}</div>
  </button>${sel ? detail(a) : ""}`;
}

function renderList() {
  const el = $("list");
  // Keep focus and typed text while live updates re-render the list.
  const editing = document.activeElement && document.activeElement.id === "rename";
  if (editing) return;
  if (!state.agents.length) {
    el.innerHTML = `<div class="empty">No agents yet. Run <code>agent-office install</code>, then start <code>claude</code> in any folder. Agents show up here within a few seconds.</div>`;
    return;
  }
  const active = state.agents.filter((a) => a.state !== "offline"), off = state.agents.filter((a) => a.state === "offline");
  el.innerHTML = active.map(card).join("") + (off.length ? `<div class="section-label">Offline in the last 24 hours</div>` + off.map(card).join("") : "");
}

$("list").addEventListener("click", async (e) => {
  const rn = e.target.closest("[data-rename]");
  if (rn) {
    const name = $("rename").value;
    try { settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ alias: { folder: rn.dataset.rename, name } }) }); $("rename").blur(); }
    catch (err) { alert(err.message); }
    return;
  }
  if (e.target.closest("[data-detail]")) return;
  const b = e.target.closest(".agent");
  if (b) select(b.dataset.id === selectedId ? null : b.dataset.id);
});

// ---------- header ----------
function renderHeader() {
  const t = state.totals || {};
  $("c-working").textContent = t.working || 0;
  $("c-waiting").textContent = t.waiting || 0;
  $("c-idle").textContent = t.idle || 0;
  $("c-cost").textContent = money(t.todayCost);
  $("c-cost").className = settings.dailyBudgetUsd && t.todayCost >= settings.dailyBudgetUsd ? "over" : "";
  $("c-tokens").textContent = tokens(t.todayTokens || 0);
  document.title = t.waiting ? `(${t.waiting}) Virtual office` : "Virtual office";
  const b = [];
  if (settings.demo) b.push(`<p class="banner">Demo data. Run <code>agent-office start</code> to see your real sessions.</p>`);
  if (settings.dailyBudgetUsd && t.todayCost >= settings.dailyBudgetUsd) b.push(`<p class="banner bad">Today's spend ${money(t.todayCost)} is over your ${money(settings.dailyBudgetUsd)} budget.</p>`);
  if (!online) b.push(`<p class="banner bad">Lost connection to the server. Retrying…</p>`);
  $("banner").innerHTML = b.join("");
}

// ---------- desktop notifications ----------
function notify() {
  for (const a of state.agents) {
    const before = prevStates.get(a.session);
    if (before && before !== "waiting" && a.state === "waiting" && settings.notifyOnWaiting && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification(`${a.name} needs you`, { body: a.message || "Waiting for your input", tag: a.session });
      n.onclick = () => { window.focus(); select(a.session); };
    }
    prevStates.set(a.session, a.state);
  }
}

// ---------- live data ----------
let online = true;
function apply(snap) {
  state = snap; online = true;
  drawOffice();
  notify(); renderHeader(); renderList();
}
function connect() {
  const es = new EventSource("/api/stream");
  es.onmessage = (m) => apply(JSON.parse(m.data));
  // The office shows "As of <last data>" while the stream is down, and Live again once it reconnects.
  es.onerror = () => { online = false; renderHeader(); if (state.t) office.setStatus("stale", state.t); };
  es.onopen = () => { online = true; renderHeader(); if (state.t) office.setStatus("live"); };
}

// ---------- settings dialog ----------
const dlgS = $("settings"), dlgR = $("report");
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
function desktopHint() {
  const h = $("s-desktop-hint");
  if (!("Notification" in window)) { h.textContent = "This browser doesn't support desktop notifications."; $("s-desktop").hidden = true; return; }
  $("s-desktop").hidden = Notification.permission === "granted";
  h.textContent = Notification.permission === "granted" ? "Desktop notifications are on." : Notification.permission === "denied" ? "Notifications are blocked. Allow them in your browser's site settings." : "";
}
$("open-settings").onclick = () => {
  $("s-budget").value = settings.dailyBudgetUsd || 0;
  $("s-offline").value = settings.offlineAfterMin;
  $("s-webhook").value = settings.webhookUrl || "";
  $("s-notify").checked = !!settings.notifyOnWaiting;
  $("s-err").textContent = ""; desktopHint();
  dlgS.showModal();
};
$("s-desktop").onclick = async () => { await Notification.requestPermission(); desktopHint(); };
["s-budget", "s-offline", "s-webhook"].forEach((id) => $(id).addEventListener("input", () => ($("s-err").textContent = "")));
$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({
      dailyBudgetUsd: $("s-budget").value || 0, offlineAfterMin: $("s-offline").value,
      webhookUrl: $("s-webhook").value, notifyOnWaiting: $("s-notify").checked }) });
    dlgS.close(); renderHeader();
  } catch (err) { $("s-err").textContent = err.message; }
});
$("s-test").onclick = async () => {
  const url = $("s-webhook").value.trim();
  if (!url) { $("s-err").textContent = "Add a webhook URL first."; return; }
  $("s-err").textContent = "Sending…";
  try { await api("/api/settings/test-webhook", { method: "POST", body: JSON.stringify({ webhookUrl: url }) }); $("s-err").textContent = "Test alert sent."; }
  catch (err) { $("s-err").textContent = err.message; }
};

// ---------- report dialog ----------
$("open-report").onclick = async () => {
  $("report-body").innerHTML = "Loading…"; dlgR.showModal();
  try {
    const { days } = await api("/api/report?days=14");
    const max = Math.max(...days.map((d) => d.cost), 0.01);
    const total = days.reduce((s, d) => s + d.cost, 0);
    const proj = {};
    days.forEach((d) => Object.entries(d.byProject).forEach(([k, v]) => (proj[k] = (proj[k] || 0) + v)));
    const rows = Object.entries(proj).sort((a, b) => b[1] - a[1]);
    $("report-body").innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span>Last 14 days</span><span style="font:20px var(--mono)">${money(total)}</span></div>
      <div class="bars">${days.map((d, i) => `<div class="bar ${i === days.length - 1 ? "today" : ""}" style="height:${(d.cost / max) * 100}%" title="${d.date}: ${money(d.cost)}, ${tokens(d.tokens)} tokens"></div>`).join("")}</div>
      <div class="bar-labels">${days.map((d) => `<span>${Number(d.date.slice(8))}</span>`).join("")}</div>
      ${rows.length ? `<table class="proj"><thead><tr><th>Project</th><th style="text-align:right">Cost</th><th style="text-align:right">Share</th></tr></thead><tbody>
        ${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${money(v)}</td><td class="n">${total ? Math.round((v / total) * 100) : 0}%</td></tr>`).join("")}
      </tbody></table>` : `<p class="empty">No cost data yet. Cost tracking starts after <code>agent-office install</code> and a restart of your claude sessions.</p>`}`;
  } catch (err) { $("report-body").textContent = err.message; }
};

// ---------- start ----------
async function load() {
  try { const s = await api("/api/state"); settings = s.settings; apply(s); office.setStatus("live"); }
  catch { if (!state.t) office.setStatus("error"); }
}

(async () => {
  await load();
  connect();
  setInterval(() => { renderList(); drawOffice(); }, 10000);
})();
