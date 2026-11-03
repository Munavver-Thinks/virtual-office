// Settings, markup: small functions that return HTML strings. Text is escaped; no DOM.
// Colour rules: teal for healthy, picked and primary actions; red only for errors (failed sends, events a full spool
// dropped, a failing webhook, a save that didn't go through) and over budget. Offline is gray and dashed. Nothing here is amber: nobody waits on you
// here. Every state also has an icon and words.
import { panel, emptyState, loadingState, errorState, button, themeSwitch, pathChip, toast } from "./ui/components.js";
import { esc } from "./ui/format.js";
import { icon } from "./ui/icons.js";
import { copyBtn } from "./shell-view.js";
import { SECTIONS, COLOR_NAMES, sectionHref, maskToken } from "./settings-model.js";

const cx = (...n) => n.filter(Boolean).join(" ");
const stateOf = (status, asOf) => (status === "stale" ? asOf : null);
const retry = (what) => ({ label: "Retry", attrs: what === "settings" ? { "data-retry": true } : { "data-st-retry": what } });
/** Loading or error for a panel whose data isn't in yet; null once it is. */
function pending(base, status, { label, text, what, rows = 3 }) {
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows, avatar: false, label }) });
  if (status === "error") return panel({ ...base, body: errorState({ text, action: retry(what) }) });
  return null;
}
/** A field's "Saving…", "Saved" or what went wrong (red). */
const saved = (n, field) => `<span class="${cx("st-saved", n && n.error && "is-error")}" data-st-saved="${esc(field)}">${n ? esc(n.text) : ""}</span>`;
const pill = (p) => `<span class="${cx("st-pill", `st-pill--${p.tone}`)}">${icon(p.icon, { size: 13 })}<span>${esc(p.label)}</span></span>`;
/** A switch: a real checkbox with role="switch", its label and a note. */
const toggle = ({ id, attrs = "", label, on, hint, disabled = false, note = "" }) => `<div class="st-switch"><input type="checkbox" role="switch" class="ao-switch" id="${id}" data-key="${id}" ${attrs}${on ? " checked" : ""}${disabled ? " disabled" : ""} aria-describedby="${id}-hint">` +
  `<label for="${id}">${esc(label)}</label>${note}<p class="ao-meta" id="${id}-hint">${esc(hint)}</p></div>`;

// ---------- frame and nav ----------
const PANES = {
  machines: '<div data-st="machines"></div><div data-st="offline"></div>',
  token: '<div data-st="token"></div>',
  budgets: '<div data-st="budgets"></div>',
  projects: '<div data-st="projects"></div>',
  appearance: '<div data-st="appearance"></div>',
  notifications: '<div data-st="channels"></div><div data-st="desktop"></div><div data-st="quiet"></div>',
};

/** The screen's fixed parts; settings.js fills each slot. One section shows at a time. "said" tells screen readers what
 *  a change did; the toasts are a polite live region. */
export function frame() {
  return `<div class="st-head"><p class="st-auto">${icon("check", { size: 15 })}<span>Changes save automatically</span></p></div>
    <p class="cc-note st-demo" data-st="demo" hidden>${icon("alert", { size: 15 })}Demo mode: changes last until the demo stops and are never saved.</p>
    <div class="st-layout"><nav class="st-nav" aria-label="Settings sections" data-st="nav"></nav>
      <div class="st-panes">${SECTIONS.map((s) => `<div class="st-pane" data-st-pane="${s.id}" hidden>${PANES[s.id]}</div>`).join("")}</div></div>
    <p class="ao-sr" role="status" data-st="said"></p>
    <div class="st-toasts" data-st="toasts" role="status" aria-live="polite"></div>`;
}

/** The left nav: a link per section (the current one marked), with notes like "1 offline" or "1 failing". */
export function nav(current, notes = {}) {
  const note = (n) => `<span class="${cx("st-nav-note", `is-${n.tone}`)}">${icon(n.icon, { size: 13 })}${esc(n.text)}</span>`;
  return `<ul class="st-nav-list">${SECTIONS.map((s) => `<li><a class="st-nav-link" href="${sectionHref(s.id)}" data-key="st-nav:${s.id}"${s.id === current ? ' aria-current="page"' : ""}>` +
    `${icon(s.icon)}<span class="st-nav-text">${esc(s.label)}</span>${(notes[s.id] || []).map(note).join("")}</a></li>`).join("")}</ul>`;
}

// ---------- machines ----------
function machineRow(r, busy) {
  const line = `<span class="${cx("st-line", r.line.error && "is-error")}">${r.line.error ? icon("alert", { size: 13 }) : ""}${esc(r.line.text)}</span>`;
  const bar = r.backlog.n ? `<span class="st-bar" aria-hidden="true"><span style="width:${(r.backlog.w * 100).toFixed(1)}%"></span></span>` : "";
  const dropped = r.dropped ? `<span class="st-line is-error">${icon("alert", { size: 13 })}${esc(r.dropped.text)}</span>` : "";
  const ping = button({ label: busy ? "Pinging…" : "Ping", size: "sm", attrs: { "data-st-ping": r.host, "data-key": `st-ping:${r.host}`, "aria-busy": busy ? "true" : null, "aria-label": `Ping ${r.host}` } });
  return `<tr><th scope="row" class="st-host"><code>${esc(r.host)}</code>${r.self ? '<span class="ao-label">This computer</span>' : ""}<span class="ao-meta">${esc(r.about)}</span></th>` +
    `<td><div class="st-health">${pill(r.health)}${line}</div></td><td><div class="st-backlog">${bar}<span class="ao-meta">${esc(r.backlog.text)}</span>${dropped}</div></td>` +
    `<td class="st-nowrap"><time datetime="${esc(r.lastAt)}">${esc(r.last)}</time></td><td class="st-nowrap">${esc(r.today)}</td>` +
    `<td class="st-acts">${ping}${r.ping ? `<p class="ao-meta st-ping-out">${esc(r.ping)}</p>` : ""}</td></tr>`;
}

/**
 * The machines table: each machine's name, OS and live sessions, hook health (Healthy / Retrying with its failed sends
 * in red / Offline with its last contact), what waits in its spool (and in red, what it dropped when full), last event,
 * sessions today and Ping. Add machine shows how to connect one (add = addMachine()). Empty, loading, error and stale
 * states.
 */
export function machinesPanel({ rows = null, status = "live", asOf = null, pinging = new Set(), adding = false, add = "" } = {}) {
  const base = { id: "st-machines", title: "Machines", icon: "machine", meta: "Reported in the last 7 days" };
  const wait = pending(base, status, { label: "Loading the machines", text: "Couldn't load the machines. The server didn't answer.", what: "machines" });
  if (wait) return wait;
  const tools = button({ label: adding ? "Hide setup" : "Add machine", icon: adding ? null : "plus", size: "sm", attrs: { "data-st-add": true, "data-key": "st-add", "aria-expanded": String(adding), "aria-controls": "st-add" } });
  const region = `<div class="st-add" id="st-add"${adding ? "" : " hidden"}>${add}</div>`;
  const stale = stateOf(status, asOf);
  if (!rows.length) return panel({ ...base, stale, tools, body: emptyState({ icon: "machine", text: "No machine has reported yet. Each one shows up here with its first hook event." }) + region });
  const cols = ["Machine", "Hook health", "Spool", "Last event", "Today"].map((h) => `<th scope="col">${h}</th>`).join("") + '<th scope="col"><span class="ao-sr">Ping</span></th>';
  return panel({ ...base, stale, tools, body: `<div class="st-table-wrap" role="region" aria-labelledby="st-machines-title" tabindex="0"><table class="st-table">` +
    `<caption class="ao-sr">Machines, with their hooks' health as each one's newest event reported it</caption><thead><tr>${cols}</tr></thead>` +
    `<tbody>${rows.map((r) => machineRow(r, pinging.has(r.host))).join("")}</tbody></table></div>` +
    `<p class="ao-meta st-foot">Hooks send to this server; it can't reach a machine. Ping checks when it last heard from one.</p>${region}` });
}

/** How to connect a machine: the install command (team mode) and the settings.json snippet, the token masked on screen
 *  (Copy carries it whole). On a local dashboard other machines can't reach it, so it says how to change that. */
export function addMachine(setup, { failed = false } = {}) {
  if (!setup) return failed ? `<p class="st-err" role="alert">${icon("alert", { size: 14 })}Couldn't load the token. Run <code>agent-office token</code> on the server instead.</p>`
    : loadingState({ rows: 2, avatar: false, label: "Loading the setup" });
  const hide = (s) => String(s).split(setup.token).join(maskToken(setup.token)), install = `agent-office install --url ${setup.url} --token ${setup.token}`;
  const snippet = (where) => `<p>Or add this to ${where} <code>~/.claude/settings.json</code> yourself:</p><pre class="cc-snippet" tabindex="0" aria-label="settings.json snippet, token hidden"><code>${esc(hide(setup.snippet))}</code></pre>${copyBtn(setup.snippet, "Copy snippet")}`;
  if (!setup.teamMode) return `<p>This dashboard listens only on this computer, so other machines can't reach it. To add one, run the server in team mode (<code>HOST=0.0.0.0</code>, behind HTTPS), then run <code>agent-office install --url &lt;its address&gt; --token &lt;the token&gt;</code> on the machine.</p>` +
    `<p>On this computer, <code>agent-office install</code> sets it up.</p>${snippet("this computer's")}`;
  return `<p>On the new machine, run:</p><div class="cc-token"><code class="cc-cmd">${esc(hide(install))}</code>${copyBtn(install, "Copy command")}</div>${snippet("its")}`;
}

/** Offline after N minutes: for agents, and for machines with no live session. */
export function offlinePanel({ value = 30, note = null, draft = null, status = "live" } = {}) {
  const base = { id: "st-offline", title: "Offline after", icon: "power" };
  const wait = pending(base, status, { label: "Loading your settings", text: "Couldn't load your settings. The server didn't answer.", what: "settings", rows: 1 });
  if (wait) return wait;
  return panel({ ...base, body: `<div class="st-field"><label for="st-offline-min">Mark agents and machines offline after</label><span class="st-num"><input type="number" id="st-offline-min" inputmode="numeric" min="1" max="1440" step="1" value="${esc(draft ?? value)}" data-st-field="offlineAfterMin" data-key="st-offline-min" aria-describedby="st-offline-hint"> minutes</span>${saved(note, "offlineAfterMin")}</div>` +
    `<p class="ao-meta" id="st-offline-hint">With no events for this long, an agent goes offline (one waiting on you stays up to 8 hours), and so does a machine with no live session.</p>` });
}

// ---------- token ----------
/** The workspace token: masked (Reveal shows it), Copy, Rotate with an inline confirm that says what rotating stops,
 *  when it was made and last used, and after a rotation how to update each machine. */
export function tokenPanel({ v = null, setup = null, status = "live", asOf = null, t = {} } = {}) {
  const base = { id: "st-token", title: "Workspace token", icon: "key" };
  const wait = pending(base, status, { label: "Loading the token", text: "Couldn't load the token. Run agent-office token on the server to see it.", what: "setup", rows: 2 });
  if (wait) return wait;
  const value = t.revealed ? `<code class="st-token-value">${esc(setup.token)}</code>` : `<code class="st-token-value"><span class="ao-sr">Workspace token, hidden: </span>${esc(v.masked)}</code>`;
  const acts = button({ label: t.revealed ? "Hide" : "Reveal", icon: "eye", size: "sm", attrs: { "data-st-reveal": true, "data-key": "st-reveal", "aria-pressed": String(!!t.revealed) } }) +
    copyBtn(setup.token, "Copy") + button({ label: "Rotate", icon: "retry", size: "sm", attrs: { "data-st-rotate": true, "data-key": "st-rotate", "aria-expanded": String(!!t.confirming), "aria-controls": t.confirming ? "st-rotate-box" : null } });
  const confirm = !t.confirming ? "" : `<div class="st-confirm" id="st-rotate-box" role="group" aria-labelledby="st-rotate-h" data-st-confirm>
    <p id="st-rotate-h"><b>Rotate the token?</b> ${esc(v.confirm.lead)}</p><p class="ao-meta">${esc(v.confirm.more)}</p>
    <div class="st-confirm-acts">${button({ label: t.rotating ? "Rotating…" : "Rotate token", variant: "primary", size: "sm", attrs: { "data-st-rotate-yes": true, "data-key": "st-rotate-yes", disabled: !!t.rotating, "aria-busy": t.rotating ? "true" : null } })}` +
    `${button({ label: "Keep this one", variant: "ghost", size: "sm", attrs: { "data-st-rotate-no": true, "data-key": "st-rotate-no" } })}</div>${t.error ? `<p class="st-err" role="alert">${icon("alert", { size: 14 })}${esc(t.error)}</p>` : ""}</div>`;
  const after = !t.rotated ? "" : `<div class="st-rotated">${icon("check", { size: 16 })}<div><p><b>New token in use.</b> ${v.install ? "Run this on every machine to update it:" : "Run agent-office install on this computer to keep cost tracking."}</p>` +
    `${v.install ? `<div class="cc-token"><code class="cc-cmd">${esc(v.install.split(setup.token).join(v.masked))}</code>${copyBtn(v.install, "Copy command")}</div>` : ""}</div></div>`;
  return panel({ ...base, stale: stateOf(status, asOf), body: `<div class="st-token">${value}<div class="st-token-acts">${acts}</div></div>` +
    `<p class="ao-meta">${esc(v.created)} · ${esc(v.used)}</p><p class="ao-meta">Machines send their events with it. Anyone who can open this dashboard can see it.</p>${confirm}${after}` });
}

// ---------- budgets ----------
/** The budgets' frame: a row per budget, each with its own slot for the input (data-st-bf, drawn from the settings) and
 *  for what it used (data-st-bu, live), so live updates never touch what you're typing. */
export function budgetsPanel({ rows = null, status = "live", asOf = null } = {}) {
  const base = { id: "st-budgets", title: "Budgets", icon: "chart" };
  const wait = pending(base, status, { label: "Loading your budgets", text: "Couldn't load your settings. The server didn't answer.", what: "settings" });
  if (wait) return wait;
  return panel({ ...base, stale: stateOf(status, asOf), body: `<ul class="st-budgets">${rows.map((r) => `<li class="st-budget"><div data-st-bf="${r.key}"></div><div class="st-use" data-st-bu="${r.key}" id="st-bu-${r.key}"></div></li>`).join("")}</ul>` });
}

/** A budget's label, $ input, its saved note and hint. The session alert's number is the Alerts Center's rule. */
export function budgetForm(r, { note = null, draft = null, failed = false } = {}) {
  const id = `st-b-${r.key}`, field = r.key;
  if (r.value == null) {
    const text = failed ? "Couldn't load the alert rules." : "Loading the alert rule…";
    return `<div class="st-budget-head"><span class="st-budget-label">${esc(r.label)}</span></div><p class="${cx("ao-meta", failed && "st-err")}">${esc(text)}${failed ? ` ${button({ label: "Retry", size: "sm", attrs: { "data-st-retry": "alerts" } })}` : ""}</p>`;
  }
  const link = r.rule ? ` <a class="cc-link" href="#/alerts">Alert rules</a>` : "";
  return `<div class="st-budget-head"><label for="${id}">${esc(r.label)}</label>${saved(note, field)}</div>` +
    `<span class="st-money"><span aria-hidden="true">$</span><input type="number" id="${id}" inputmode="decimal" min="${r.min || 0}" step="${r.step}" value="${esc(draft ?? (r.key === "session" ? Number(r.value).toFixed(2) : r.value))}" data-st-budget="${r.key}" data-key="${id}" aria-describedby="st-bu-${r.key} ${id}-hint"></span>` +
    `<p class="ao-meta" id="${id}-hint">${esc(r.hint)}${link}</p>`;
}

/** What a budget used: a bar (teal, red past the limit) and its words, which say "over budget" too. */
export function budgetUse(r) {
  const u = r.use;
  return `<span class="${cx("st-meter", u.over && "is-over")}" aria-hidden="true"><span style="width:${(u.w * 100).toFixed(1)}%"></span></span>` +
    `<p class="${cx("st-use-text", u.over && "is-over")}">${u.over ? icon("alert", { size: 13 }) : ""}${esc(u.text)}</p>`;
}

// ---------- projects ----------
/** The projects' frame: a row per project with its own slots for the form (data-st-pf, drawn from what you set) and its
 *  facts (data-st-pi), by position in keys. */
export function projectsPanel({ count = null, status = "live", asOf = null } = {}) {
  const base = { id: "st-projects", title: "Projects", icon: "office", meta: "One per git folder" };
  const wait = pending(base, status, { label: "Loading the projects", text: "Couldn't load the projects. The server didn't answer.", what: "projects" });
  if (wait) return wait;
  const stale = stateOf(status, asOf);
  if (!count) return panel({ ...base, stale, body: emptyState({ icon: "office", text: "No projects yet. Each git folder an agent works in becomes a project, with a room in the office." }) });
  return panel({ ...base, stale, body: `<p class="ao-meta st-lead">The name and room colour every screen uses. Renaming keeps its colour.</p>` +
    `<ul class="st-projects">${Array.from({ length: count }, (_, i) => `<li class="st-proj"><div class="st-proj-form" data-st-pf="${i}"></div><div class="st-proj-info" data-st-pi="${i}"></div></li>`).join("")}</ul>` });
}

/** A project's display name (empty = its folder's) and its colour: a radio group of the 6 room colours, each named.
 *  draft = what you typed and picked that isn't saved yet: { name?, color? }. */
export function projectForm(r, i, { note = null, draft = null } = {}) {
  const color = draft?.color ?? r.color, picked = r.picked || draft?.color != null;
  const swatch = (name, c) => `<label class="st-swatch" title="${name}"><input type="radio" name="st-c-${i}" value="${c}" data-st-color="${i}" data-key="st-c:${esc(r.key)}:${c}"${c === color ? " checked" : ""}>` +
    `<span class="st-dot" style="--av:var(--proj-${c + 1})" aria-hidden="true">${icon("check", { size: 13 })}</span><span class="ao-sr">${name}</span></label>`;
  return `<div class="st-proj-name"><label for="st-p-${i}">Display name <span class="ao-sr">for ${esc(r.folder)}</span></label>${saved(note, `project:${r.key}`)}` +
    `<input type="text" id="st-p-${i}" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(draft?.name ?? r.name)}" placeholder="${esc(r.folder)}" data-st-name="${i}" data-key="st-p:${esc(r.key)}" aria-describedby="st-ph-${i}">` +
    `<p class="ao-meta" id="st-ph-${i}">Empty = the folder's name, <code>${esc(r.folder)}</code>.</p></div>` +
    `<fieldset class="st-colors"><legend>Room colour<span class="ao-sr"> for ${esc(r.folder)}</span>${picked ? "" : ' <span class="ao-meta">(automatic)</span>'}</legend><div class="st-swatches">${COLOR_NAMES.map(swatch).join("")}</div></fieldset>`;
}

/** Where a project lives (its root, middle-truncated, copy on click; how many other roots) and its agents today. */
export function projectInfo(r) {
  const more = r.more ? `<span class="ao-meta" title="${esc(r.others.join("\n"))}">+${r.more} more ${r.more === 1 ? "root" : "roots"}</span>` : "";
  return `${r.root ? pathChip(r.root, { max: 44 }) : '<span class="ao-meta">No git root</span>'}${more}<span class="ao-meta st-proj-today">${esc(r.today)}</span>`;
}

// ---------- appearance ----------
/** Theme, Reduce motion and Show name tags, for this browser. system = the system asks for less motion. */
export function appearancePanel({ prefs = {}, system = false } = {}) {
  return panel({ id: "st-appearance", title: "Appearance", icon: "sun", meta: "Saved in this browser", body: `<div class="st-field"><span class="st-field-label">Theme</span>${themeSwitch()}</div>` +
    toggle({ id: "st-motion", attrs: 'data-st-pref="reduceMotion"', label: "Reduce motion", on: prefs.reduceMotion || system, disabled: system,
      hint: system ? "Your system asks for less motion, so it stays on." : "No walking, pulsing or typing animations." }) +
    toggle({ id: "st-tags", attrs: 'data-st-pref="nameTags"', label: "Show name tags", on: prefs.nameTags !== false, hint: "Each person's name above them in the office." }) });
}

// ---------- notifications ----------
function channelRow(c) {
  return `<li class="${cx("st-channel", c.failing && "is-failing")}"><div class="st-ch-head"><b>${esc(c.title)}</b>${pill(c.pill)}</div>` +
    `<p class="${cx("st-ch-line", c.failing && "is-error")}">${c.failing ? icon("alert", { size: 14 }) : ""}<span>${esc(c.line)}</span></p>` +
    `${c.url ? `<p class="ao-meta"><span class="ao-sr">Webhook: </span><code>${esc(c.url)}</code>${c.env ? ` · set on the server with <code>${esc(c.env)}</code>` : ""}</p>` : ""}</li>`;
}

/** Slack and Discord as the Alerts Center sees them (healthy, failing in red with what it may mean, not set up); the
 *  webhooks and the alert rules are changed there. */
export function channelsPanel({ rows = null, status = "live", asOf = null } = {}) {
  const base = { id: "st-channels", title: "Slack and Discord", icon: "chat", tools: `<a class="cc-link" href="#/alerts">Alerts Center</a>` };
  const wait = pending(base, status, { label: "Loading the channels", text: "Couldn't load the alert channels. The server didn't answer.", what: "alerts", rows: 2 });
  if (wait) return wait;
  return panel({ ...base, stale: stateOf(status, asOf), body: `<ul class="st-channels">${rows.map(channelRow).join("")}</ul>` +
    `<p class="ao-meta">Webhooks and the alert rules are changed in the <a class="cc-link" href="#/alerts">Alerts Center</a>.</p>` });
}

/** Desktop notifications when an agent needs you, and the button that asks the browser for permission. */
export function desktopPanel({ on = false, note = null, hint = "", ask = false, status = "live" } = {}) {
  const base = { id: "st-desktop", title: "Desktop notifications", icon: "bell" };
  const wait = pending(base, status, { label: "Loading your settings", text: "Couldn't load your settings. The server didn't answer.", what: "settings", rows: 1 });
  if (wait) return wait;
  return panel({ ...base, body: `<div class="cc-check st-check"><input type="checkbox" id="st-notify" data-st-field="notifyOnWaiting" data-key="st-notify"${on ? " checked" : ""}><label for="st-notify">Show a desktop notification when an agent needs me</label>${saved(note, "notifyOnWaiting")}</div>` +
    `${ask ? button({ label: "Turn on desktop notifications", size: "sm", attrs: { "data-st-desktop": true, "data-key": "st-desktop" } }) : ""}${hint ? `<p class="ao-meta">${esc(hint)}</p>` : ""}` });
}

/** Quiet hours: on or off, from and to (the server's clock), what they hold, and a note when that clock isn't yours. */
export function quietPanel({ v = null, notes = {}, status = "live" } = {}) {
  const base = { id: "st-quiet", title: "Quiet hours", icon: "moon" };
  const wait = pending(base, status, { label: "Loading your settings", text: "Couldn't load your settings. The server didn't answer.", what: "settings", rows: 1 });
  if (wait) return wait;
  const time = (k, label) => `<label for="st-q-${k}">${label}</label><input type="time" id="st-q-${k}" step="60" value="${esc(v[k])}" data-st-quiet="${k}" data-key="st-q-${k}">`;
  return panel({ ...base, body: toggle({ id: "st-quiet-on", attrs: 'data-st-quiet="on"', label: `Quiet hours ${v.from}–${v.to}`, on: v.on, hint: v.text, note: saved(notes.quiet, "quiet") }) +
    `<div class="st-times" role="group" aria-label="Quiet hours times">${time("from", "From")}${time("to", "To")}</div>` +
    `${v.tz ? `<p class="ao-meta st-tz">${icon("clock", { size: 13 })}${esc(v.tz)}</p>` : ""}` });
}

/** After something saved or failed. */
export const noteToast = (title, text = "", ok = true) => toast({ icon: ok ? "check" : "alert", title, text });
