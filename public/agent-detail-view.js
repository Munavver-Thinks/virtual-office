// The Agent Detail slide-over, markup: small functions that return HTML strings. Text is escaped; no DOM.
// Colour rules: amber only for a question waiting on you (its bubble and wait rows); red only for failed steps and errors.
import { statePill, avatar, pathChip, codeBox, progressBar, segmented, filterChip, button, emptyState, loadingState, errorState, STATES, stateKey } from "./ui/components.js";
import { esc, clock, money, compact, tokensLine, middleTruncate } from "./ui/format.js";
import { icon } from "./ui/icons.js";
import { projectKey, rootOf } from "./office3d-model.js";
import { copyBtn } from "./shell-view.js";
import { FILTERS, costFact, durationText, durText, durWidth, dayClock } from "./agent-detail-model.js";

const SECTIONS = [["mission", "Mission"], ["convo", "Conversation"], ["plan", "Plan"], ["trace", "Trace"], ["files", "Files & usage"]];
const cx = (...n) => n.filter(Boolean).join(" ");
/** An element id from a row key ("b" + a tool-use id may hold anything). */
const idOf = (key) => `ad-x-${String(key).replace(/[^\w-]/g, "_")}`;
const LONG = 160; // characters before a prompt or reply gets "Show all"

// ---------- frame ----------
/** The slide-over's fixed parts; the controller fills each [data-ad] slot. The name form has its own slot so a name
 *  you're typing survives live updates. */
export function frame({ back = "Back to office" } = {}) {
  const sec = ([k, label], body) => `<section class="ad-sec" id="ad-sec-${k}" aria-labelledby="ad-${k}-h"><h3 class="ad-h" id="ad-${k}-h" tabindex="-1">${esc(label)}</h3>${body}</section>`;
  const [mission, convo, plan, trace, files] = SECTIONS;
  return `<div class="ad-bar">
      <button type="button" class="ao-btn ao-btn--ghost ad-back" data-close data-key="ad-back">${icon("back")}<span>${esc(back)}</span></button>
      <nav class="ad-nav" aria-label="Sections">${SECTIONS.map(([k, label]) => `<a href="#ad-sec-${k}" data-ad-section="${k}">${esc(label)}</a>`).join("")}</nav>
      <span class="ad-asof" data-ad="asof"></span>
    </div>
    <header class="ad-head">
      <span class="ad-avatar" data-ad="avatar"></span>
      <div class="ad-id">
        <h2 class="ao-sr" id="ad-title" tabindex="-1" data-ad="title"></h2>
        <div data-ad="name"></div>
        <p class="ad-name-status" role="status" data-ad="name-status"></p>
        <div class="ad-sub" data-ad="sub"></div>
      </div>
    </header>
    <div data-ad="facts"></div>
    <div class="ad-body" data-ad="body">
      <div data-ad="state"></div>
      ${sec(mission, '<div data-ad="mission"></div>')}
      ${sec(convo, `<div data-ad="convo"></div><div data-ad="composer"></div><p class="ao-meta ad-when" id="ad-msg-when" data-ad="composer-note"></p><div class="ad-status" role="status" data-ad="status"></div>`)}
      ${sec(plan, '<div data-ad="plan"></div>')}
      ${sec(trace, '<div data-ad="filters"></div><div data-ad="trace"></div>')}
      ${sec(files, '<div data-ad="files"></div>')}
    </div>`;
}

const NAMES = { mission: "the mission", convo: "the conversation", plan: "the plan", trace: "the trace", files: "files and usage" };
/** A section while the detail loads: a skeleton shaped like it. */
export const sectionLoading = (section) => loadingState({ rows: section === "trace" ? 4 : 2, avatar: section === "convo" || section === "trace", label: `Loading ${NAMES[section]}` });

/** Instead of the sections: the detail couldn't load (with Retry), or the server no longer has this agent. */
export function bodyState(kind) {
  if (kind === "gone") return emptyState({ icon: "power", text: "The server has no more detail for this agent. It may be past the 30-day retention." });
  return errorState({ text: "Couldn't load this agent's details. The server didn't answer.", action: { label: "Retry", attrs: { "data-ad-retry": true } } });
}

// ---------- header ----------
/** The large avatar with a small state badge. The state is also in the pill beside it, in words. */
export function avatarBadge(a, color) {
  const k = stateKey(a.state);
  return `${avatar({ name: a.name, project: projectKey(a), color, size: "lg", decorative: true })}<span class="ad-badge ad-badge--${k}" aria-hidden="true">${icon(STATES[k].icon, { size: 12 })}</span>`;
}

/** Where the name goes before there is an agent to show: its session id, and a skeleton while its detail loads. */
export function bareName(id, { loading = false } = {}) {
  return `<p class="ad-bare"><span class="ao-name">Session</span> <code>${esc(id)}</code></p>${loading ? loadingState({ rows: 1, avatar: false, label: "Loading this agent" }) : ""}`;
}

/** The editable name: Enter saves it; empty goes back to the automatic name. */
export function nameForm(a) {
  return `<form class="ad-name" data-ad-name novalidate><label class="ao-sr" for="ad-name-in">Agent name</label>
    <input id="ad-name-in" class="ad-name-in" value="${esc(a.name || "")}" maxlength="60" autocomplete="off" spellcheck="false" aria-describedby="ad-name-hint">
    <span class="ad-name-pen" aria-hidden="true">${icon("pencil", { size: 15 })}</span>
    <span class="ao-sr" id="ad-name-hint">Press Enter to save the name. Leave it empty to go back to the automatic name.</span></form>`;
}

/** State pill, the root as a copyable path chip, "working in dist/", and Copy session ID. */
export function subLine(a, { now = Date.now() } = {}) {
  const k = stateKey(a.state), root = rootOf(a), wait = k === "needs" && a.waitingSince ? now - Date.parse(a.waitingSince) : null;
  return `${statePill(a.state, { waitMs: wait })}${root ? pathChip(root) : ""}${root && !a.gitRoot ? '<span class="ao-meta">Not a git repository</span>' : ""}` +
    `${a.relCwd ? `<span class="ao-meta ad-cwd">working in <code title="${esc(a.relCwd)}">${esc(middleTruncate(a.relCwd, 32))}/</code></span>` : ""}${copyBtn(a.session, "Copy session ID", { variant: "ghost" })}`;
}

/** Project, Machine, Model, Duration, Cost. */
export function facts(a, { now = Date.now(), avgCost = null } = {}) {
  const c = costFact(a, avgCost);
  const rows = [["Project", projectKey(a)], ["Machine", a.host || "Unknown"], ["Model", a.model || "Unknown", true], ["Duration", durationText(a, now)], ["Cost", c.text, false, c.title]];
  return `<dl class="ad-facts">${rows.map(([t, v, mono, title]) => `<div><dt class="ao-label">${t}</dt><dd${mono ? ' class="ao-mono"' : ""} title="${esc(title || v)}">${esc(v)}</dd></div>`).join("")}</dl>`;
}

// ---------- mission ----------
const fileChip = (name) => `<span class="ad-chip">${icon("file", { size: 13 })}<span>Open in your editor: <code>${esc(name)}</code></span></span>`;
/** "Show all" for a clamped text with the given element id. */
const moreBtn = (key, id, open) => `<button type="button" class="ad-more-btn" data-ad-more="${esc(key)}" aria-expanded="${open}" aria-controls="${id}">${open ? "Show less" : "Show all"}</button>`;

export function missionSection(m, { open = false, now = Date.now() } = {}) {
  if (!m) return emptyState({ icon: "chat", text: "No prompt yet. The mission is the first thing you ask this agent." });
  const long = m.text.length > LONG, n = m.followUpCount;
  const follow = m.followUps.length ? `<ol class="ad-follow" aria-label="Follow-ups">${m.followUps.map((f) =>
    `<li><time datetime="${esc(f.t)}">${esc(clock(f.t))}</time><p class="cc-clamp" title="${esc(f.text)}">${esc(f.text)}</p></li>`).join("")}</ol>` : "";
  return `<p class="ad-prompt${long && !open ? " cc-clamp" : ""}" id="ad-mission-text">${esc(m.text)}</p>${long ? moreBtn("mission", "ad-mission-text", open) : ""}
    <p class="ad-meta-row"><span class="ao-meta">You asked at ${esc(dayClock(m.at, now))}</span>${m.openedFile ? fileChip(m.openedFile) : ""}${n ? `<span class="ad-chip">+${n} ${n === 1 ? "follow-up" : "follow-ups"}</span>` : ""}</p>${follow}`;
}

// ---------- conversation ----------
function bubble(it, open) {
  if (it.side === "note") return `<li class="ad-note"><span>${esc(it.text)}</span><time>${esc(it.meta)}</time></li>`;
  const id = idOf(it.key), long = !!it.text && it.text.length > LONG, isOpen = !!open.get(it.key);
  const tone = it.side === "you" ? "you" : it.tone === "needs" ? "needs" : it.tone === "error" ? "error" : "agent";
  return `<li class="ad-b ad-b--${tone}"><p class="ad-b-meta">${esc(it.meta)}${tone === "needs" ? '<span class="ao-sr">, waiting for you</span>' : ""}</p>` +
    `${it.lead ? `<p class="ad-b-lead">${icon(it.icon || "chat", { size: 15 })}<span>${esc(it.lead)}</span></p>` : ""}` +
    `${it.text ? `<p class="ad-b-text${long && !isOpen ? ` ${it.side === "you" ? "cc-clamp" : "ad-clamp4"}` : ""}" id="${id}">${esc(it.text)}</p>${long ? moreBtn(it.key, id, isOpen) : ""}` : ""}` +
    `${it.code ? codeBox(it.code, { what: it.what || "target" }) : ""}${it.file ? fileChip(it.file) : ""}` +
    `${it.status ? `<p class="ad-b-status">${icon(it.status.startsWith("Delivered") ? "check" : "clock", { size: 13 })}<span>${esc(it.status)}</span></p>` : ""}</li>`;
}

/** The thread, newest at the bottom; older items behind "Show earlier". */
export function convoSection(items, { limit = 40, open = new Map() } = {}) {
  if (!items.length) return emptyState({ icon: "chat", text: "Nothing said yet. Your prompts and the agent's questions and replies show up here." });
  const shown = items.slice(-limit), hidden = items.length - shown.length;
  return `${hidden ? button({ label: `Show ${hidden} earlier`, size: "sm", attrs: { "data-ad-earlier": "convo", class: "ad-earlier" } }) : ""}<ol class="ad-thread" aria-label="Conversation">${shown.map((it) => bubble(it, open)).join("")}</ol>`;
}

/** The message box. Its markup never changes while it's shown, so a message you're typing survives live updates. */
export function messageForm() {
  return `<form class="ad-compose" data-ad-message novalidate>
    <label class="ad-compose-label" for="ad-msg">Message this agent. It gets it the next time it stops.</label>
    <textarea class="ad-msg" id="ad-msg" rows="2" maxlength="1000" aria-describedby="ad-msg-keys ad-msg-when"></textarea>
    <div class="cc-reply-row"><span class="ao-meta" id="ad-msg-keys">Ctrl+Enter or ⌘+Enter sends it</span>${button({ label: "Send message", variant: "primary", type: "submit", icon: "send", attrs: { "data-ad-send": true, disabled: true } })}</div>
    <p class="cc-answer-err" role="alert" data-ad-msg-error></p></form>`;
}
export const offlineNote = (a) => `<p class="ad-offline">${icon("power", { size: 16 })}<span>${esc(a.host || "Its machine")} is offline, so messages can't reach this session right now.</span></p>`;
export const endedNote = () => `<p class="ad-offline">${icon("power", { size: 16 })}<span>This session has ended, so messages can't reach it.</span></p>`;
export const statusNote = (text) => `<p class="cc-answer-note is-ok">${icon("check", { size: 16 })}<span>${esc(text)}</span></p>`;

// ---------- plan ----------
const PLAN = { completed: ["check", "Done", "is-done"], in_progress: ["half", "In progress", "is-now"], pending: ["circle", "Not started", "is-next"] };
export function planSection(p) {
  if (!p.total && !p.earlier.length) {
    return emptyState({ icon: "plan", text: "No plan yet. This agent hasn't written a to-do list." }) +
      '<p class="ao-meta ad-hint">Newer models keep one only with <code>agent-office install --with-plans</code>.</p>';
  }
  const row = (r) => {
    const [ic, word, cls] = PLAN[r.status] || PLAN.pending;
    const when = r.status === "completed" ? (r.at ? `Done ${clock(r.at)}` : "Done") : r.status === "in_progress" ? (r.at ? `since ${clock(r.at)}` : "In progress") : "Not started";
    return `<li class="ad-plan-row ${cls}">${icon(ic, { size: 15 })}<span class="ad-plan-text"><span class="ao-sr">${word}: </span>${esc(r.text)}</span><span class="ao-meta">${esc(when)}</span></li>`;
  };
  const earlier = p.earlier.length ? `<details class="ad-earlier-plan"><summary>${p.earlier.length} done in an earlier plan</summary><ol class="ad-plan">${p.earlier.map((r) => row({ ...r, status: "completed" })).join("")}</ol></details>` : "";
  return `${p.total ? `<div class="ad-plan-sum">${progressBar({ done: p.done, doing: p.doing, total: p.total, label: `${p.done} of ${p.total} done, ${p.doing} in progress` })}<span><b>${p.done} of ${p.total}</b> done</span></div>
    <ol class="ad-plan">${p.rows.map(row).join("")}</ol>` : ""}${earlier}`;
}

// ---------- trace ----------
/** Category (with counts), Errors only, and a file. */
export function traceFilters(m, f) {
  const options = FILTERS.map((x) => ({ value: x.value, label: x.label, count: m.counts[x.value] }));
  const files = f.file && !m.files.includes(f.file) ? [f.file, ...m.files] : m.files;
  return `<div class="ad-filters">${segmented({ label: "Show steps", options, value: f.cat, attrs: { class: "ad-cats" } })}
    ${filterChip({ label: "Errors only", count: m.errors, pressed: f.errors, value: "errors", attrs: { "data-key": "ad-errors" } })}
    <span class="ad-file-pick"><label for="ad-file">File</label><select id="ad-file" data-ad-files><option value="">All files</option>${files.map((p) =>
      `<option value="${esc(p)}"${p === f.file ? " selected" : ""}>${esc(middleTruncate(p, 44))}</option>`).join("")}</select></span></div>`;
}

const STATUS = { ok: ["check", "Succeeded"], error: ["x", "Failed"], denied: ["x", "Not allowed"], unknown: ["circle", "No result"] };
/** ✓ / ✕ / a live dot, with the word for screen readers (and a tooltip). */
function statusCell(s, said) {
  if (!s) return '<span class="ad-st"></span>';
  if (s === "running") return `<span class="ad-st is-running"><span class="cc-live-dot" aria-hidden="true"></span><span class="ao-sr">${said || "Running"}</span></span>`;
  const [ic, word] = STATUS[s] || STATUS.unknown;
  return `<span class="ad-st is-${s}" title="${said || word}">${icon(ic, { size: 15 })}<span class="ao-sr">${said || word}</span></span>`;
}
const durCell = (r, max) => (r.ms == null ? '<span class="ad-dur"></span>'
  : `<span class="ad-dur"><span class="ad-dur-track" aria-hidden="true"><span class="ad-dur-bar" style="width:${durWidth(r.ms, max)}%"></span></span><span class="ad-dur-text">${esc(durText(r.ms))}</span></span>`);
const costCell = (r) => (!r.cost && !r.tokens ? '<span class="ad-cost"></span>'
  : `<span class="ad-cost"><span aria-hidden="true">≈${esc(money(r.cost))} · ${esc(compact(r.tokens))}</span><span class="ao-sr">about ${esc(money(r.cost))} and ${esc(compact(r.tokens))} tokens, an estimate</span></span>`);

function rowMain(r, { max, open, id, label, note, status, toggle = true }) {
  const chev = toggle ? `<button type="button" class="ao-btn ao-btn--ghost ao-btn--icon ao-btn--sm ad-chev" data-ad-toggle="${esc(r.key)}" aria-expanded="${open}"${open ? ` aria-controls="${id}"` : ""} aria-label="${esc(label)}">${icon("chevron")}</button>` : '<span class="ad-chev"></span>';
  return `<div class="ad-row-main"><time class="ad-time" datetime="${esc(r.t)}">${esc(clock(r.t))}</time><span class="ad-tile">${icon(r.icon, { size: 15 })}</span>
    <div class="ad-what"><p class="ad-title"><span>${esc(r.title)}</span>${r.target ? ` <code class="ad-target" title="${esc(r.target)}">${esc(r.target)}</code>` : ""}</p>${note ? `<p class="ad-line" title="${esc(note)}">${esc(note)}</p>` : ""}</div>
    ${durCell(r, max)}${status}${costCell(r)}${chev}</div>`;
}

const pre = (text, cls = "") => `<pre class="${cx("ad-pre", cls)}" data-keep-scroll>${esc(text)}</pre>`;
const block = (label, body) => `<div class="ad-block">${label ? `<p class="ao-label">${esc(label)}</p>` : ""}${body}</div>`;
const SIGN = { add: ["+", "Added: "], del: ["−", "Removed: "], same: [" ", ""] };

/** What an expanded step shows: the command and the end of its output, a diff (+ teal, − gray struck through), the
 *  plan it wrote, the search, or the text. */
export function moreOf(x) {
  const err = x.error ? block("What failed", pre(x.error, "ad-pre--error")) : "";
  if (x.kind === "command") {
    return `${x.command ? block("Command", pre(x.command)) : ""}${x.exitCode != null ? `<p class="ao-meta">Exit code ${esc(x.exitCode)}</p>` : ""}` +
      `${x.tail ? block("Output, the last part", pre(x.tail)) : x.error ? "" : '<p class="ao-meta">No output was kept for this step.</p>'}${err}`;
  }
  if (x.kind === "diff") {
    const lines = x.lines.map((l) => (l.type === "gap" ? '<div class="ad-d ad-d--gap" aria-hidden="true">⋯</div>'
      : `<div class="ad-d ad-d--${l.type}"><span class="ad-d-sign" aria-hidden="true">${SIGN[l.type][0]}</span>${l.type === "same" ? esc(l.text) : `<${l.type === "add" ? "ins" : "del"}><span class="ao-sr">${SIGN[l.type][1]}</span>${esc(l.text)}</${l.type === "add" ? "ins" : "del"}>`}</div>`)).join("");
    return `${x.path ? `<p class="ao-label">Change to <code class="ad-mono-path">${esc(x.path)}</code></p>` : ""}` +
      (x.lines.length ? `<div class="ad-diff" role="group" aria-label="Diff" data-keep-scroll>${lines}</div>${x.more ? `<p class="ao-meta">+${esc(x.more)} more changes in this edit, not kept</p>` : ""}`
        : `<p class="ao-meta">The change itself wasn't kept for this step (${esc(x.added)} lines added, ${esc(x.removed)} removed).</p>`) + err;
  }
  if (x.kind === "plan") {
    return `<ol class="ad-plan ad-plan--small">${x.todos.map((t) => { const [ic, word, cls] = PLAN[t.status] || PLAN.pending; return `<li class="ad-plan-row ${cls}">${icon(ic, { size: 14 })}<span class="ad-plan-text"><span class="ao-sr">${word}: </span>${esc(t.content)}</span></li>`; }).join("")}</ol>`;
  }
  if (x.kind === "search") {
    return `${x.pattern ? block("Pattern", pre(x.pattern)) : ""}${x.glob ? block("Files", pre(x.glob)) : ""}${x.path ? `<p class="ao-meta">In <code>${esc(x.path)}</code></p>` : ""}${err}`;
  }
  return `${x.text ? block(x.label, x.mono ? pre(x.text) : `<p class="ad-text">${esc(x.text)}</p>`) : ""}${x.file ? fileChip(x.file) : ""}${err}`;
}

function stepItem(r, o) {
  const open = !!r.expand && !!o.open.get(r.key), id = idOf(r.key);
  const cls = cx("ad-row", r.status === "error" && "is-error", r.status === "running" && "is-running");
  return `<li class="${cls}" data-key="row:${esc(r.key)}">${rowMain(r, { max: o.max, open, id, label: `Details: ${r.title}`, note: r.note, status: statusCell(r.status), toggle: !!r.expand })}` +
    `${open ? `<div class="ad-more" id="${id}">${moreOf(r.expand)}</div>` : ""}</li>`;
}

function branchItem(b, o) {
  const open = o.open.has(b.key) ? !!o.open.get(b.key) : b.status === "running", id = idOf(b.key);
  const steps = b.children.filter((c) => c.type === "step").length, running = b.status === "running";
  const state = running ? "Running" : `Finished${b.finishedAt ? ` ${clock(b.finishedAt)}` : ""}`;
  const status = statusCell(running ? "running" : "ok", running ? "Running" : "Finished");
  const end = !running && b.lastMessage ? `<li class="ad-tree-end">${icon("check", { size: 14 })}<p><b>${esc(state)}:</b> <span class="ad-clamp2" title="${esc(b.lastMessage)}">${esc(b.lastMessage)}</span></p></li>` : "";
  const kids = b.children.map((c) => itemOf(c, o)).join("");
  return `<li class="${cx("ad-branch", running && "is-running")}" data-key="row:${esc(b.key)}">${rowMain(b.step, { max: o.max, open, id, label: `Steps of the sub-agent: ${b.label}`, note: `${steps} ${steps === 1 ? "step" : "steps"} · ${state}`, status })}` +
    `${open ? `<ol class="ad-tree" id="${id}" aria-label="${esc(`Steps of the sub-agent: ${b.label}`)}">${kids || '<li class="ad-tree-none ao-meta">No steps yet.</li>'}${end}</ol>` : ""}</li>`;
}

function waitItem(r) {
  return `<li class="${cx("ad-gap ad-gap--wait", r.pending && "is-pending")}">${icon("hand", { size: 15 })}<p><b>${esc(r.head)}</b> · ${esc(r.lead)}` +
    `${r.target ? ` <code title="${esc(r.target)}">${esc(r.target)}</code>` : ""} · ${esc(r.outcome)}</p><time datetime="${esc(r.t)}">${esc(clock(r.t))}</time></li>`;
}
const idleItem = (r) => `<li class="ad-gap ad-gap--idle">${icon(r.state === "idle" ? "coffee" : "power", { size: 15 })}<p><b>${esc(r.text)}</b> · ${esc(r.why)}</p></li>`;
const itemOf = (r, o) => (r.type === "branch" ? branchItem(r, o) : r.type === "wait" ? waitItem(r) : r.type === "idle" ? idleItem(r) : stepItem(r, o));

/** The timeline: the newest `limit` rows, older ones behind "Show earlier steps". */
export function traceList(rows, m, { limit = 150, open = new Map() } = {}) {
  if (!m.rows.length) return emptyState({ icon: "pulse", text: "No steps yet. They show up here as the agent works." });
  if (!rows.length) return `<div class="ao-state ao-state--empty"><span class="ao-state-icon">${icon("search", { size: 20 })}</span><p>No steps match these filters</p>${button({ label: "Clear filters", size: "sm", attrs: { "data-ad-clear": true } })}</div>`;
  const shown = rows.slice(-limit), hidden = rows.length - shown.length, o = { open, max: m.maxMs };
  return `${hidden ? button({ label: `Show earlier steps (${hidden} more)`, size: "sm", attrs: { "data-ad-earlier": "trace", class: "ad-earlier" } }) : ""}
    <ol class="ad-trace" aria-label="Trace, oldest first">${shown.map((r) => itemOf(r, o)).join("")}</ol>
    <p class="ao-meta ad-trace-key">≈ Cost per step is an estimate: each model call counts toward the step that was running at the time.</p>`;
}

// ---------- files and usage ----------
function spark(u) {
  if (!u.points.length) return emptyState({ icon: "chart", text: "No cost data for this session. Cost needs telemetry: run agent-office install." });
  const W = 300, H = 56, n = u.points.length, max = Math.max(...u.points.map((p) => p.cost)) || 1;
  const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W), y = (c) => H - 3 - (c / max) * (H - 8);
  const pts = u.points.map((p, i) => `${x(i).toFixed(1)},${y(p.cost).toFixed(1)}`).join(" ");
  const first = u.points[0].t, last = Math.min(u.points.at(-1).t + u.size, u.until ?? Infinity), pi = u.peak ? u.points.indexOf(u.peak) : -1;
  const peak = u.peak ? `Peak ${money(u.peak.cost)} at ${clock(u.peak.t)}` : "No spend yet";
  const label = `Cost per 10 minutes from ${clock(first)} to ${clock(last)}. ${peak}.`;
  return `<figure class="ad-spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}" focusable="false">` +
    `<polygon class="ad-spark-area" points="0,${H} ${pts} ${W},${H}"/><polyline class="ad-spark-line" points="${pts}" vector-effect="non-scaling-stroke"/>` +
    `${pi >= 0 ? `<line class="ad-spark-peak" x1="${x(pi).toFixed(1)}" x2="${x(pi).toFixed(1)}" y1="0" y2="${H}" vector-effect="non-scaling-stroke"/>` : ""}</svg>` +
    `<figcaption class="ao-meta"><span>${esc(peak)}</span><span>${esc(clock(first))} to ${esc(clock(last))}</span></figcaption></figure>`;
}

function cacheLine(c, tokens) {
  if (!(+tokens.cacheRead || +tokens.cacheWrite)) return "";
  if (!c) return '<p class="ao-meta">No list price is known for this model, so what the cache saved isn\'t estimated.</p>';
  const text = c.usd >= 0 ? `Cache saved about ${money(c.usd)}` : `The cache cost about ${money(-c.usd)} more than it saved`;
  return `<p class="ad-cache"><b>${esc(text)}</b> <span class="ao-meta">(estimate)</span></p><details class="ad-how"><summary>How this is estimated</summary>` +
    `<p class="ao-meta">From list prices: a cache read costs 10% of the ${esc(c.family)} input price ($${esc(c.input)} per million tokens) and a cache write 125%. ` +
    "Telemetry reports what each request cost, not what the cache saved.</p></details>";
}

/** Files edited (with Steps, which filters the trace to that file) beside the cost sparkline, tokens and cache savings. */
export function filesSection(files, u, { file = null } = {}) {
  const list = files.length ? `<ul class="ad-files">${files.map((f) => `<li><div class="ad-file-id"><code class="ad-file" title="${esc(f.rel)}">${esc(middleTruncate(f.rel, 52))}</code>` +
    `<span class="ao-meta">${esc(f.meta)}</span>${f.created ? `<span class="ad-chip">${esc(f.created)}</span>` : ""}</div>` +
    button({ label: "Steps", size: "sm", icon: "pulse", attrs: { "data-ad-file": f.rel, "aria-pressed": String(f.rel === file), "aria-label": `Show the steps that touched ${f.rel}` } }) + "</li>").join("")}</ul>`
    : emptyState({ icon: "file-edit", text: "No files edited yet." });
  return `<div class="ad-fu"><div class="ad-fu-files"><h4 class="ao-label">Files touched</h4>${list}</div>` +
    `<div class="ad-fu-use"><h4 class="ao-label">Cost per 10 minutes</h4>${spark(u)}<p class="ao-mono cc-oneline ad-tokens"><span class="ao-sr">Tokens: </span>${esc(tokensLine(u.tokens))}</p>${cacheLine(u.cache, u.tokens)}</div></div>`;
}
