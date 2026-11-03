// Settings (M11) at #/settings, one section at a time from its left nav (#/settings?section=<id>): Machines (each one's
// hook health as its hooks report it: failed sends in the last hour and the spool backlog; Ping; Add machine; the
// offline timeout), Token (Reveal, Copy, Rotate with an inline confirm), Budgets (daily, monthly and the per-session
// alert, each with what it used), Projects (a display name and room colour per git folder), Appearance (theme, reduce
// motion, name tags: this browser) and Notifications (Slack and Discord as the Alerts Center sees them, desktop
// notifications, quiet hours). Changes save as you make them.
// Data: the shell's settings and live data; while the screen shows, GET /api/machines (again as events arrive, at most
// every 5 s, and every 30 s), /api/projects (again when a project's name or colour changes), /api/setup (the token; again
// whenever the screen, its Token section or Add machine opens) and /api/alerts (again when the live data's alertsRev
// changes). Writes: PUT /api/settings, PUT /api/alerts (the session rule's limit, which the Alerts Center shares),
// POST /api/token/rotate.
//
//   const settings = createSettings({ root, doc?, win?, api, context: () => ({ snap, status, settings, loaded, colors }), onSettings(s) })
//   settings.show(on) · settings.go(hash, { focus }) · settings.render() · settings.destroy()
import { createPatch, byKey } from "./ui/patch.js";
import { getPrefs, setPref, systemReduced } from "./ui/prefs.js";
import * as M from "./settings-model.js";
import * as V from "./settings-view.js";

const SOURCES = { machines: ["/api/machines", 5000], projects: ["/api/projects", 3000], setup: ["/api/setup", 0], alerts: ["/api/alerts", 3000] };
const LABELS = { offlineAfterMin: "Offline after", dailyBudgetUsd: "Daily budget", monthlyBudgetUsd: "Monthly budget", session: "Session alert",
  notifyOnWaiting: "Desktop notifications", quiet: "Quiet hours" };
const BUDGET = { daily: "dailyBudgetUsd", monthly: "monthlyBudgetUsd" };
// The first panel of each section: where focus goes when you switch to it.
const FIRST = { machines: "st-machines", token: "st-token", budgets: "st-budgets", projects: "st-projects", appearance: "st-appearance", notifications: "st-channels" };
const TOAST_MS = 6000, MACHINES_EVERY = 30000;

export function createSettings({ root, doc = document, win = window, api, context, onSettings = () => {} }) {
  const patch = createPatch(doc);
  let shown = false, dead = false, section = "machines", toastTimer = 0, adding = false, keys = [];
  // Each source: its path, data, status (loading, live, stale, error), key (what it was fetched for) and throttle.
  const src = Object.fromEntries(Object.entries(SOURCES).map(([k, [path, gap]]) => [k, { path, gap, data: null, status: "loading", key: null, last: 0, busy: false, again: false, timer: 0 }]));
  // This tab's own: each field's note ({ text, error }), what you typed while it saves or after it was refused (drafts),
  // saves on their way (field → the next change, if you made one meanwhile), Ping results and hosts being pinged, the token's state.
  const notes = new Map(), drafts = new Map(), saving = new Map(), pings = new Map(), pinging = new Set();
  const tok = { revealed: false, confirming: false, rotating: false, rotated: false, error: "" };
  root.classList.add("st-root");
  root.innerHTML = V.frame();
  const slot = (k) => root.querySelector(`[data-st="${k}"]`);

  // ---------- data ----------
  function want(s, key) {
    if (key === s.key) return;
    s.key = key;
    clearTimeout(s.timer);
    const wait = s.last + s.gap - Date.now();
    if (wait <= 0) load(s); else s.timer = setTimeout(() => load(s), wait);
  }

  async function load(s) {
    if (s.busy) { s.again = true; return; }
    Object.assign(s, { busy: true, again: false, last: Date.now() });
    try {
      const v = await api(s.path);
      if (dead) return;
      Object.assign(s, { data: v, status: "live" });
    } catch {
      if (dead) return;
      s.status = s.data ? "stale" : "error";
    } finally { s.busy = false; }
    render();
    if (s.again) load(s);
  }

  /** What each source is fetched for: machines change with every event (and with time), projects with a name or colour. */
  function wants(c) {
    const snap = c.snap;
    want(src.machines, `${snap ? snap.lastEvent : "-"}|${Math.floor(Date.now() / MACHINES_EVERY)}`);
    want(src.projects, snap ? [...new Set(snap.agents.map((a) => `${a.project}\u0001${a.projectColor ?? ""}`))].sort().join("\u0002") : "-");
    want(src.setup, "once");
    want(src.alerts, `${snap && snap.alertsRev != null ? snap.alertsRev : "-"}`);
  }

  /** loading, error, stale (its last load failed, or for live data the stream stopped) or live. */
  const ownStatus = (s) => (!s.data ? (s.status === "error" ? "error" : "loading") : s.status === "stale" ? "stale" : "live");
  const statusOf = (s, c) => (ownStatus(s) === "live" && c.status === "stale" ? "stale" : ownStatus(s));
  const settingsStatus = (c) => (!c.loaded ? (c.status === "error" ? "error" : "loading") : "live");

  // ---------- rendering ----------
  /** Redraws the nav and the section on screen, keeping focus and scroll (patch.js). Inputs sit in slots drawn only
   *  from what's saved, so live updates leave what you're typing alone. */
  function render() {
    if (!shown || dead) return;
    const c = context();
    wants(c);
    setHidden(slot("demo"), !(c.settings || {}).demo);
    patch(slot("nav"), V.nav(section, M.navNotes({ machines: src.machines.data, alerts: src.alerts.data })));
    for (const pane of root.querySelectorAll("[data-st-pane]")) setHidden(pane, pane.getAttribute("data-st-pane") !== section);
    ({ machines: renderMachines, token: renderToken, budgets: renderBudgets, projects: renderProjects, appearance: renderAppearance, notifications: renderNotifications })[section](c);
  }
  const setHidden = (el, h) => { if (el.hasAttribute("hidden") !== h) { if (h) el.setAttribute("hidden", ""); else el.removeAttribute("hidden"); } };
  const field = (f) => ({ note: notes.get(f) || null, draft: drafts.has(f) ? drafts.get(f) : null });

  function renderMachines(c) {
    const s = src.machines, status = statusOf(s, c), r = s.data;
    const add = V.addMachine(src.setup.data, { failed: src.setup.status === "error" });
    patch(slot("machines"), V.machinesPanel({ rows: r ? M.machineRows(r, { pings }) : null, status, asOf: r && r.t, pinging, adding, add }));
    patch(slot("offline"), V.offlinePanel({ value: (c.settings || {}).offlineAfterMin || 30, ...field("offlineAfterMin"), status: settingsStatus(c) }));
  }

  function renderToken(c) {
    const s = src.setup, m = src.machines.data;
    const v = s.data ? M.tokenView(s.data, { machines: m }) : null;
    patch(slot("token"), V.tokenPanel({ v, setup: s.data, status: statusOf(s, c), asOf: s.data && s.data.t, t: tok }));
  }

  function renderBudgets(c) {
    const status = settingsStatus(c), a = src.alerts.data;
    const rows = M.budgetRows(c.settings || {}, { snap: c.snap, rule: a ? a.rules.session : null });
    patch(slot("budgets"), V.budgetsPanel({ rows, status: status === "live" && c.status === "stale" ? "stale" : status, asOf: c.asOf }));
    if (status !== "live") return;
    for (const r of rows) {
      const f = BUDGET[r.key] || r.key, form = root.querySelector(`[data-st-bf="${r.key}"]`), use = root.querySelector(`[data-st-bu="${r.key}"]`);
      patch(form, V.budgetForm(r, { ...field(f), failed: r.key === "session" && src.alerts.status === "error" }));
      patch(use, V.budgetUse(r));
    }
  }

  function renderProjects(c) {
    const s = src.projects, status = statusOf(s, c), rows = s.data ? M.projectRows(s.data, { colors: c.colors }) : [];
    keys = rows.map((r) => r.key);
    patch(slot("projects"), V.projectsPanel({ count: s.data ? rows.length : null, status, asOf: s.data && s.data.t }));
    rows.forEach((r, i) => {
      const form = root.querySelector(`[data-st-pf="${i}"]`), info = root.querySelector(`[data-st-pi="${i}"]`);
      if (!form) return;
      patch(form, V.projectForm(r, i, field(`project:${r.key}`)));
      patch(info, V.projectInfo(r));
    });
  }

  function renderAppearance() {
    patch(slot("appearance"), V.appearancePanel({ prefs: getPrefs(), system: systemReduced() }));
  }

  function renderNotifications(c) {
    const a = src.alerts, set = c.settings || {}, status = settingsStatus(c);
    patch(slot("channels"), V.channelsPanel({ rows: a.data ? M.channelRows(a.data) : null, status: statusOf(a, c), asOf: a.data && a.data.t }));
    const N = win.Notification, hint = !N ? "This browser doesn't support desktop notifications." : N.permission === "granted" ? "This browser allows them."
      : N.permission === "denied" ? "This browser blocks them. Allow notifications in its site settings." : "This browser hasn't been asked yet.";
    patch(slot("desktop"), V.desktopPanel({ on: !!set.notifyOnWaiting, ...field("notifyOnWaiting"), hint, ask: !!N && N.permission === "default", status }));
    const q = drafts.get("quiet") || set.quietHours || {};
    patch(slot("quiet"), V.quietPanel({ v: M.quietView(q, { serverOffset: set.tzOffsetMin ?? -new Date().getTimezoneOffset() }), notes: { quiet: notes.get("quiet") }, status }));
  }

  function say(text) {
    const el = slot("said");
    el.textContent = "";
    setTimeout(() => { if (!dead) el.textContent = text; }, 30);
  }

  function showToast(html) {
    const box = slot("toasts");
    box.innerHTML = html;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.innerHTML = ""; }, TOAST_MS);
  }

  // ---------- saving ----------
  /** Saves a change: "Saving…", then "Saved" or what went wrong (what you typed stays, to fix). One save per field at a
   *  time; a change made during one is saved right after, and what you typed for it stays until then. body may be a
   *  function that makes it as it's sent. done(reply, body) uses the server's answer. */
  async function save(f, body, { path = "/api/settings", draft = null, done = onSettings } = {}) {
    if (draft != null) drafts.set(f, draft);
    if (saving.has(f)) { saving.set(f, { body, path, draft, done }); return; }
    saving.set(f, null);
    notes.set(f, { text: "Saving…" });
    render();
    try {
      const sent = typeof body === "function" ? body() : body;
      const r = await api(path, { method: "PUT", body: JSON.stringify(sent) });
      if (dead) return;
      if (!saving.get(f)) drafts.delete(f);
      notes.set(f, { text: "Saved" });
      done(r, sent);
      say(`${LABELS[f] || "Project"}: saved`);
    } catch (e) {
      if (dead) return;
      notes.set(f, { text: `Not saved. ${e.message}`, error: true });
      say(`${LABELS[f] || "Project"}: not saved. ${e.message}`);
    } finally {
      const next = saving.get(f);
      saving.delete(f);
      if (!dead) { render(); if (next) save(f, next.body, next); }
    }
  }

  /** A budget or the offline timeout from its input. Empty means none for a budget; the same number again saves nothing. */
  function saveNumber(input) {
    const raw = input.value.trim(), key = input.getAttribute("data-st-budget"), f = key ? BUDGET[key] || key : "offlineAfterMin";
    if (input.validity && input.validity.badInput) return refuse(f, "That isn't a number.", raw);
    if (key === "session") {
      const rule = src.alerts.data && src.alerts.data.rules.session;
      if (!raw) return refuse(f, "Type an amount first.", raw);
      if (rule && Number(raw) === rule.usd && !drafts.has(f)) return;
      return save(f, { rules: { session: { usd: Number(raw) } } }, { path: "/api/alerts", draft: raw, done: (v) => { Object.assign(src.alerts, { data: v, status: "live" }); } });
    }
    if (!raw && !key) return refuse(f, "Type a number of minutes first.", raw);
    if (Number(raw || 0) === Number((context().settings || {})[f] || 0) && !drafts.has(f)) return;
    save(f, { [f]: raw || 0 }, { draft: raw });
  }
  function refuse(f, text, draft) {
    drafts.set(f, draft);
    notes.set(f, { text, error: true });
    render();
  }

  // A project's form is one field: its draft is { name?, color? }, what you typed and picked that isn't saved yet.
  const projectRow = (key) => (src.projects.data ? M.projectRows(src.projects.data, { colors: context().colors }).find((r) => r.key === key) : null);
  /** What a project's form saves, made as it's sent so it carries every change made while an earlier save was out: the
   *  name you typed, if you did, and the colour you picked, else its current one (so a rename never changes it). */
  function projectBody(key) {
    const d = drafts.get(`project:${key}`) || {};
    return { project: { key, ...(d.name != null && { name: d.name.trim() }), color: d.color ?? projectRow(key)?.color } };
  }
  function saveName(input) {
    const key = keys[Number(input.getAttribute("data-st-name"))], p = key != null && projectRow(key), f = `project:${key}`;
    if (!p) return;
    const d = drafts.get(f) || {};
    if (input.value.trim() === p.name && d.name == null) return;
    save(f, () => projectBody(key), { draft: { ...d, name: input.value }, done: afterProject });
  }
  function saveColor(input) {
    const key = keys[Number(input.getAttribute("data-st-color"))], f = `project:${key}`;
    if (key != null) save(f, () => projectBody(key), { draft: { ...drafts.get(f), color: Number(input.value) }, done: afterProject });
  }
  /** Saved: the list shows it at once, and loads again for the server's word on it. */
  function afterProject(s, sent) {
    onSettings(s);
    src.projects.data = M.withProject(src.projects.data, sent.project);
    src.projects.key = null;
    load(src.projects);
  }

  /** Quiet hours: the switch, or a time. */
  function saveQuiet(input) {
    const set = context().settings || {}, q = { ...(set.quietHours || {}), ...(drafts.get("quiet") || {}) }, k = input.getAttribute("data-st-quiet");
    if (k === "on") q.on = input.checked; else if (input.value) q[k] = input.value; else return refuse("quiet", "Pick a time first.", q);
    save("quiet", { quietHours: q }, { draft: q });
  }

  // ---------- machines and token ----------
  /** Ping: the server can't reach a machine, so it checks when it last heard from it, and says so. */
  async function ping(host) {
    if (pinging.has(host)) return;
    pinging.add(host);
    render();
    try {
      const r = await api("/api/machines");
      if (dead) return;
      Object.assign(src.machines, { data: r, status: "live", last: Date.now() });
      pings.set(host, M.pingText(r.machines.find((m) => m.host === host), Date.now()));
    } catch (e) {
      if (dead) return;
      pings.set(host, `Couldn't check. ${e.message}`);
    } finally { pinging.delete(host); }
    render();
    say(`${host}: ${pings.get(host)}`);
  }

  async function rotate() {
    if (tok.rotating) return;
    Object.assign(tok, { rotating: true, error: "" });
    render();
    try {
      const s = await api("/api/token/rotate", { method: "POST", body: "{}" });
      if (dead) return;
      Object.assign(src.setup, { data: s, status: "live" });
      Object.assign(tok, { confirming: false, rotated: true, revealed: false });
      showToast(V.noteToast("New token in use", s.teamMode ? "Update every machine with it." : "Hooks here use it already."));
      render();
      byKey(root, "st-rotate")?.focus();
    } catch (e) {
      if (dead) return;
      tok.error = `Couldn't rotate it. ${e.message}`;
    } finally { tok.rotating = false; }
    render();
  }

  function confirmRotate(open) {
    tok.confirming = open;
    tok.error = "";
    render();
    byKey(root, open ? "st-rotate-no" : "st-rotate")?.focus();
  }

  // ---------- input ----------
  const CLICKS = "[data-st-ping], [data-st-add], [data-st-reveal], [data-st-rotate], [data-st-rotate-yes], [data-st-rotate-no], [data-st-retry], [data-st-desktop]";
  const onClick = (e) => {
    const t = e.target.closest?.(CLICKS);
    if (!t) return;
    const v = (k) => t.getAttribute(k);
    if (t.matches("[data-st-ping]")) ping(v("data-st-ping"));
    else if (t.matches("[data-st-add]")) { adding = !adding; if (adding) src.setup.key = null; render(); }
    else if (t.matches("[data-st-reveal]")) { tok.revealed = !tok.revealed; render(); }
    else if (t.matches("[data-st-rotate]")) confirmRotate(!tok.confirming);
    else if (t.matches("[data-st-rotate-yes]")) rotate();
    else if (t.matches("[data-st-rotate-no]")) confirmRotate(false);
    else if (t.matches("[data-st-desktop]")) { if (win.Notification) Promise.resolve(win.Notification.requestPermission()).then(() => render()); }
    else { const s = src[v("data-st-retry")]; if (s) { s.status = "loading"; s.data = null; render(); load(s); } }
  };
  const onChange = (e) => {
    const t = e.target;
    if (!t.matches) return;
    if (t.matches('[data-st-budget], [data-st-field="offlineAfterMin"]')) saveNumber(t);
    else if (t.matches('[data-st-field="notifyOnWaiting"]')) save("notifyOnWaiting", { notifyOnWaiting: t.checked });
    else if (t.matches("[data-st-name]")) saveName(t);
    else if (t.matches("[data-st-color]")) saveColor(t);
    else if (t.matches("[data-st-quiet]")) saveQuiet(t);
    else if (t.matches("[data-st-pref]")) { setPref(t.getAttribute("data-st-pref"), t.checked); say(`${t.getAttribute("data-st-pref") === "nameTags" ? "Name tags" : "Reduce motion"}: ${t.checked ? "on" : "off"}`); render(); }
  };
  // Enter saves a name or number at once; Esc closes the rotate confirm.
  const onKey = (e) => {
    const t = e.target;
    if (e.key === "Enter" && t.matches?.('[data-st-name], [data-st-budget], [data-st-field="offlineAfterMin"]')) { e.preventDefault(); if (t.matches("[data-st-name]")) saveName(t); else saveNumber(t); }
    else if (e.key === "Escape" && tok.confirming && t.closest?.("[data-st-confirm]")) { e.preventDefault(); confirmRotate(false); }
  };
  const handlers = [["click", onClick], ["change", onChange], ["keydown", onKey]];
  for (const [type, fn] of handlers) root.addEventListener(type, fn);

  // ---------- api ----------
  /** The screen is on (true) or not. Coming back refreshes the machines and the token and retries what failed. */
  function show(on) {
    shown = !!on;
    if (!shown) return;
    src.machines.key = src.setup.key = null;
    for (const s of Object.values(src)) if (s.status === "error") s.key = null;
    render();
  }

  /** The address names a section: show it. focus = move focus to it (you switched sections here). */
  function go(hash, { focus = false } = {}) {
    const next = M.sectionOf(hash);
    if (!next || next === section) return;
    section = next;
    if (section === "token") src.setup.key = null; // another tab may have rotated it, and hooks have used it since
    render();
    if (!focus) return;
    const h = root.querySelector(`#${FIRST[section]}-title`);
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }

  function destroy() {
    dead = true;
    clearTimeout(toastTimer);
    for (const s of Object.values(src)) clearTimeout(s.timer);
    for (const [type, fn] of handlers) root.removeEventListener(type, fn);
  }

  return { show, go, render, destroy };
}
