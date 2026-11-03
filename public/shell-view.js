// The Command Center shell, markup: small functions that return HTML strings. Text is escaped; no DOM.
import { panel, emptyState, loadingState, errorState, staleNote, button, iconButton, answerButton, filterChip, segmented, themeToggle,
  statePill, waitPill, progressBar, budgetRing, codeBox, avatar, toast, STATES } from "./ui/components.js";
import { esc, clock, waitTime } from "./ui/format.js";
import { icon } from "./ui/icons.js";
import { actionOf, displayName, projectKey, rootOf } from "./office3d-model.js";
import { answerText, permissionPhrase, outsideRoot } from "./lib/describe.js";
import { APP, SCREENS, RANGES, workingOn } from "./shell-model.js";

const RETRY = { label: "Retry", attrs: { "data-retry": true } };
const proj = (i) => `--av:var(--proj-${((i % 6) + 6) % 6 + 1})`;

// ---------- page ----------
export function layout({ range = "today" } = {}) {
  const screen = (id, body = "") => `<section class="cc-screen cc-page" data-screen="${id}" aria-labelledby="cc-${id}-h" hidden>
    <h1 class="ao-title cc-page-title" id="cc-${id}-h" tabindex="-1">${esc(SCREENS.find((s) => s.id === id).label)}</h1><div class="cc-page-body">${body}</div></section>`;
  return `<a class="cc-skip ao-btn ao-btn--primary" href="#cc-main">Skip to content</a>
  <header class="cc-top">${topBar({ range })}</header>
  <main class="cc-main" id="cc-main" tabindex="-1">
    <section class="cc-screen cc-cc" data-screen="office" aria-labelledby="cc-office-h">
      <h1 class="ao-sr" id="cc-office-h" tabindex="-1">Office</h1>
      <div class="cc-office">
        <div class="cc-toasts" aria-live="polite" aria-relevant="additions"></div>
        <div class="cc-onboard" hidden></div>
        <div class="cc-office3d"></div>
      </div>
      <div class="cc-rail" role="complementary" aria-label="Needs you, progress and activity">
        <div class="cc-slot" data-slot="needs"></div><div class="cc-slot" data-slot="progress"></div><div class="cc-slot cc-slot--grow" data-slot="activity"></div>
        <div class="ao-sr" role="log" aria-live="polite" aria-label="New activity" data-log></div>
      </div>
      ${dayPanel()}
    </section>
    ${screen("board")}${screen("hall")}${screen("cost")}${screen("alerts")}${screen("settings")}
  </main>
  <dialog class="cc-dialog" data-dialog="answer" aria-labelledby="cc-answer-h"></dialog>
  <dialog class="ad" data-dialog="agent" aria-labelledby="ad-title"></dialog>`;
}

// ---------- top bar ----------
const CHIPS = ["working", "needs", "idle", "offline"];

/** The bar's fixed parts. Counts, spend and the avatar are filled in by the shell as data arrives. */
export function topBar({ range = "today" } = {}) {
  const nav = SCREENS.filter((s) => s.id !== "settings").map((s) =>
    `<a class="cc-nav-link" href="#/${s.id}" data-nav="${s.id}">${icon(s.icon)}<span class="cc-nav-text">${esc(s.label)}</span>${s.id === "alerts" ? '<span class="cc-badge" hidden></span>' : ""}</a>`).join("");
  return `<a class="cc-brand" href="#/office">${icon("office", { size: 26 })}<span class="cc-brand-name">${esc(APP)}<span class="cc-demo ao-label" hidden></span></span></a>
    <nav class="cc-nav" aria-label="Screens">${nav}</nav>
    <div class="cc-chips" role="group" aria-label="Show agents by state. Others dim in the office, on the work board, in the meeting hall and in the cost report.">${CHIPS.map((k) =>
      filterChip({ label: STATES[k].label, count: "", icon: STATES[k].icon, tone: k, value: k })).join("")}</div>
    <div class="cc-spend"><span class="cc-tokens ao-mono"></span><span class="cc-cost"></span></div>
    ${segmented({ label: "Cost period", value: range, options: RANGES, attrs: { class: "cc-range" } })}
    <div class="cc-tools">${themeToggle()}<a class="ao-btn ao-btn--ghost ao-btn--icon" href="#/settings" data-nav="settings" aria-label="Settings" title="Settings">${icon("settings")}</a><span class="cc-who"></span></div>`;
}

/** "2 agents need you" after the Alerts count, for screen readers. */
export const alertsBadge = (n) => `${n}<span class="ao-sr"> ${n === 1 ? "agent needs" : "agents need"} you</span>`;

/** Spend for the period as a budget ring, or a plain note when telemetry never reported a cost. */
export function costBlock(cv) {
  if (cv.noData) return `<span class="cc-nocost" title="Cost needs telemetry. Run agent-office install to turn it on.">No cost data ${cv.period}</span>`;
  return budgetRing({ spent: cv.spent, budget: cv.budget, period: cv.period });
}

/** The person running this dashboard; in team mode, a generic badge (everyone shares one token). */
export function who({ viewer, teamMode } = {}) {
  if (viewer) return `<span class="cc-avatar" role="img" aria-label="${esc(`You: ${viewer}`)}" title="${esc(`You: ${viewer}`)}">${avatar({ name: viewer, color: 5, round: true, decorative: true })}</span>`;
  if (teamMode) return `<span class="cc-avatar cc-avatar--team" role="img" aria-label="Team workspace" title="Team workspace: everyone signs in with the workspace token">${icon("user", { size: 18 })}</span>`;
  return "";
}

// ---------- right rail ----------
function needsCard(it, i, { offlineMin }) {
  const id = `cc-n-${i}`, where = `${it.project}${it.host ? ` · ${it.host}` : ""}`;
  return `<li class="cc-needs-card" aria-labelledby="${id}">
    <div class="cc-needs-head">${avatar({ name: it.name, color: it.color, decorative: true })}
      <div class="cc-needs-id"><h3 class="cc-needs-name" id="${id}">${esc(it.name)}</h3><div class="ao-meta cc-oneline" title="${esc(where)}">${esc(where)}</div></div>
      ${it.waitMs != null ? waitPill(it.waitMs) : ""}</div>
    <p class="cc-needs-q">${esc(it.text)}</p>
    ${it.target ? codeBox(it.target, { what: it.what }) : ""}
    ${it.stale ? `<p class="ao-meta cc-needs-stale">${icon("clock", { size: 13 })}No news for over ${esc(offlineMin)} min, so this may be out of date.</p>` : ""}
    <div class="cc-needs-foot"><span class="ao-meta cc-needs-step">${esc(it.step || "No plan step in progress")}</span>
      ${answerButton({ agent: it.name, attrs: { "data-answer": it.session, "data-key": `answer:${it.session}` } })}
      ${button({ label: "Jump", icon: "locate", attrs: { "data-jump": it.session, "data-key": `jump:${it.session}`, "aria-label": `Jump to ${it.name} in the office` } })}</div>
  </li>`;
}

const stateOf = (status, asOf) => (status === "stale" ? asOf : null);

/** Needs you now: longest wait first, with Answer and Jump. */
export function needsPanel({ items = [], status = "live", asOf = null, offlineMin = 30 } = {}) {
  const base = { id: "cc-needs", title: "Needs you now", icon: "hand", meta: "Longest wait first", cls: "cc-panel-needs" };
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows: 2, label: "Loading who needs you" }) });
  if (status === "error") return panel({ ...base, body: errorState({ text: "Couldn't load who needs you. The server didn't answer.", action: RETRY }) });
  if (!items.length) return panel({ ...base, meta: null, stale: stateOf(status, asOf), body: emptyState({ ok: true, text: "Nobody is waiting on you." }) });
  return panel({ ...base, stale: stateOf(status, asOf), badge: `<span class="ao-pill ao-pill--needs cc-count">${items.length} waiting</span>`,
    body: `<ul class="cc-needs-list">${items.map((it, i) => needsCard(it, i, { offlineMin })).join("")}</ul>` });
}

const PROJECT_ROWS = 5; // the most planned; the rest are counted
/** Today's progress: done of planned, the split bar, one row per project, and the time agents waited on you. */
export function progressPanel({ view, status = "live", asOf = null } = {}) {
  const base = { id: "cc-progress", title: "Today's progress", tools: `<a class="cc-link" href="#/board">Work board<span class="cc-chev">${icon("chevron", { size: 14 })}</span></a>` };
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows: 3, avatar: false, label: "Loading today's progress" }) });
  if (status === "error") return panel({ ...base, body: errorState({ text: "Couldn't load today's progress. The server didn't answer.", action: RETRY }) });
  const v = view, waited = v.waitedMs > 0
    ? `<p class="cc-waited">${icon("clock", { size: 14 })}<span>Waited on you <b>${esc(waitTime(v.waitedMs))}</b> today</span></p>`
    : `<p class="cc-waited">${icon("clock", { size: 14 })}<span>Nobody waited on you today</span></p>`;
  if (!v.total) return panel({ ...base, stale: stateOf(status, asOf), body: emptyState({ icon: "plan", text: "No planned tasks today yet. Plans come from each agent's to-do list." }) + waited });
  const row = (r) => `<li><span class="cc-dot" style="${proj(r.color)}"></span><span class="cc-prog-name" title="${esc(r.project)}">${esc(r.project)}</span>` +
    `${progressBar({ done: r.done, doing: r.doing, total: r.total, label: `${r.project}: ${r.done} of ${r.total} done, ${r.doing} in progress` })}<span class="cc-prog-num">${r.done}/${r.total}</span></li>`;
  const more = v.rows.length - PROJECT_ROWS;
  return panel({ ...base, stale: stateOf(status, asOf), body: `
    <p class="cc-prog-sum"><span class="ao-big">${v.done}</span><span class="cc-prog-of">of ${v.total} planned tasks done</span><b class="cc-prog-pct">${v.pct}%</b></p>
    ${progressBar({ done: v.done, doing: v.doing, total: v.total, label: `${v.done} of ${v.total} planned tasks done, ${v.doing} in progress` })}
    <ul class="cc-prog-legend"><li>${icon("check", { size: 14 })}${v.done} done</li><li>${icon("half", { size: 14 })}${v.doing} in progress</li><li>${icon("circle", { size: 14 })}${v.planned} planned</li></ul>
    <ul class="cc-prog-rows">${v.rows.slice(0, PROJECT_ROWS).map(row).join("")}${more > 0 ? `<li class="cc-prog-more ao-meta">+${more} more ${more === 1 ? "project" : "projects"}</li>` : ""}</ul>${waited}` });
}

function activityGroup(g) {
  const act = (x) => `<li${x.failed ? ' class="is-failed"' : ""}>${icon(x.icon, { size: 15 })}<span class="cc-act">${x.sub ? '<span class="cc-act-sub">Sub-agent:</span> ' : ""}${esc(x.lead)}` +
    `${x.mono ? `<code title="${esc(x.full || x.mono)}">${esc(x.mono)}</code>` : ""}${x.failed ? ' <span class="cc-act-fail">failed</span>' : ""}</span><time datetime="${esc(x.t)}">${esc(clock(x.t))}</time></li>`;
  return `<li class="cc-feed-group">
    <div class="cc-feed-head">${avatar({ name: g.name, color: g.color, size: "sm", decorative: true })}
      <button type="button" class="cc-feed-name" data-agent="${esc(g.session)}" data-key="feed:${esc(g.session)}" title="${esc(g.name)}">${esc(g.name)}</button>
      <span class="ao-meta cc-feed-proj">${esc(g.project)}</span>${statePill(g.state)}</div>
    <ul class="cc-feed-acts">${g.actions.map(act).join("")}</ul></li>`;
}

/** Live activity, grouped by agent, newest first. New lines are announced through a separate log (see layout). */
export function activityPanel({ groups = [], status = "live", asOf = null } = {}) {
  const live = status === "live" ? '<span class="cc-live-dot" aria-hidden="true"></span>' : "";
  const base = { id: "cc-activity", title: "Live activity", badge: live, meta: "Grouped by agent · newest first", cls: "cc-panel-activity" };
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows: 4, label: "Loading activity" }) });
  if (status === "error") return panel({ ...base, body: errorState({ text: "Couldn't load activity. The server didn't answer.", action: RETRY }) });
  if (!groups.length) return panel({ ...base, meta: null, stale: stateOf(status, asOf), body: emptyState({ icon: "pulse", text: "No activity yet. Start claude in any folder and its actions show up here." }) });
  return panel({ ...base, stale: stateOf(status, asOf), body: `<ul class="cc-feed">${groups.map(activityGroup).join("")}</ul>` });
}

// ---------- day timeline ----------
export function dayPanel() {
  const key = (k, label, ic) => `<li><span class="cc-sw cc-sw--${k}"></span>${icon(ic, { size: 14 })}${label}</li>`;
  return `<section class="cc-day ao-panel" aria-labelledby="cc-day-h">
    <div class="cc-day-now"><h2 class="ao-label" id="cc-day-h">Day replay</h2><div class="cc-day-clock"></div><div class="cc-day-mode"></div></div>
    <div class="cc-day-track">
      <div class="cc-ribbon" role="img" aria-label="Loading today's timeline"></div>
      <input type="range" class="cc-scrub" min="0" max="0" step="1" value="0" disabled aria-label="Replay the office at a moment today">
      <div class="cc-ticks" aria-hidden="true"></div>
      <div class="cc-day-state"></div>
    </div>
    <ul class="cc-day-legend" aria-label="Legend">${key("working", "Working", "pulse")}${key("needs", "Needs you", "hand")}${key("idle", "Idle", "coffee")}</ul>
  </section>`;
}

const pct = (f) => `${(f * 100).toFixed(3)}%`;
/** The ribbon's bars (working at the bottom, then needs you, then idle) and the now line. */
export function dayBars(rb, range) {
  const seg = (k, h) => (h > 0 ? `<span class="cc-seg cc-seg--${k}" style="height:${pct(h)}"></span>` : "");
  return rb.bars.map((b) => `<span class="cc-bar" style="left:${pct(b.x)};width:${pct(b.w)}">${seg("working", b.working)}${seg("needs", b.waiting)}${seg("idle", b.idle)}</span>`).join("") +
    `<span class="cc-now" style="left:${pct((range.now - range.start) / (range.end - range.start))}"></span>`;
}

export const dayTicks = (ticks) => ticks.map((t) => `<span style="left:${pct(t.x)}">${esc(t.label)}</span>`).join("");

/** Under the clock: "Live · today", "As of 15:40" (the stream, or else the timeline, is behind), "Loading…",
 *  "Not connected", "Not loaded" (no timeline yet), or "Replaying" with Back to live.
 *  status/asOf = the live data; day/dayAsOf = the timeline and when it last loaded. */
export function dayMode({ replayAt, status, asOf, day = "live", dayAsOf = null }) {
  if (replayAt != null) return `<span class="cc-replaying">Replaying</span>${button({ label: "Back to live", size: "sm", variant: "primary", attrs: { "data-live": true } })}`;
  if (status === "stale") return staleNote(asOf);
  if (day === "stale") return staleNote(dayAsOf);
  if (status === "loading" || day === "loading") return "<span>Loading…</span>";
  if (status === "error") return "<span>Not connected</span>";
  if (day === "error") return "<span>Not loaded</span>";
  return `<span class="cc-live-dot" aria-hidden="true"></span><span>Live · today</span>`;
}

/** Loading, error and empty states for the ribbon. */
export function dayState(status, hasRange) {
  if (status === "loading") return `<span class="ao-skel cc-day-skel" aria-hidden="true"></span>`;
  if (status === "error") return `<p class="cc-day-msg cc-day-err" role="alert">${icon("alert", { size: 15 })}Couldn't load today's timeline.${button({ label: "Retry", size: "sm", attrs: { "data-day-retry": true } })}</p>`;
  if (!hasRange) return `<p class="cc-day-msg">${icon("clock", { size: 15 })}No activity today yet. The ribbon fills in as agents work.</p>`;
  return "";
}

// ---------- toast ----------
/** "receipt printer needs you" / "supermarket-pos · Wants permission to run a command · sudo apt install cups-filters" [Answer] [Dismiss].
 *  The project tells apart two agents with the same label. */
export function needsToast(a, key) {
  const name = displayName(a), act = actionOf(a), text = [projectKey(a), act.text, act.target].filter(Boolean).join(" · ");
  return toast({ tone: "needs", title: `${name} needs you`, text, attrs: { "data-toast": key },
    actions: answerButton({ agent: name, attrs: { "data-answer": a.session, "data-key": `toast-answer:${key}` } }) +
      button({ label: "Dismiss", attrs: { "data-dismiss": key, "data-key": `toast-dismiss:${key}`, "aria-label": `Dismiss: ${name} needs you` } }) });
}

// ---------- empty office: onboarding ----------
/** A small Copy button that shows "Copied" (components.js bind() does the copying). */
export const copyBtn = (text, label, { variant = "secondary" } = {}) => `<button type="button" class="ao-btn ao-btn--${variant === "ghost" ? "ghost" : "secondary"} ao-btn--sm cc-copy" data-copy="${esc(text)}"><span class="cc-copy-label">${icon("copy", { size: 14 })}${esc(label)}</span><span class="cc-copied" aria-hidden="true">${icon("check", { size: 14 })}Copied</span></button>`;
const mask = (t) => (t.length > 12 ? `${t.slice(0, 4)}••••••••${t.slice(-4)}` : "••••••••");

/**
 * The empty office. A first run gets three steps to the first agent; a returning user (lastEvent = the newest event the
 * server still has, older than a day) gets "No agents in the last 24 hours" with the steps folded away.
 * setup = GET /api/setup, or null while it loads; failed = it couldn't load. The token is masked on screen everywhere,
 * snippet included; only the Copy buttons carry it whole.
 */
export function onboarding(setup, { failed = false, lastEvent = null } = {}) {
  const step = (n, title, body) => `<li><span class="cc-step-n" aria-hidden="true">${n}</span><div class="cc-step"><h3>${title}</h3>${body}</div></li>`;
  const hide = (s) => (setup && setup.token ? String(s).split(setup.token).join(mask(setup.token)) : String(s));
  const missing = `<p class="cc-step-err" role="alert">${icon("alert", { size: 14 })}Couldn't load the token. Run <code>agent-office token</code> on the server instead.</p>`;
  const one = setup ? `<div class="cc-token"><code aria-label="Workspace token, hidden">${esc(mask(setup.token))}</code>${copyBtn(setup.token, "Copy token")}</div><p class="ao-meta">Machines send their events with it.</p>`
    : failed ? missing : `<span class="ao-skel cc-token-skel" aria-hidden="true"></span>`;
  const install = setup && `agent-office install --url ${setup.url} --token ${setup.token}`;
  const team = setup && setup.teamMode
    ? `<p class="ao-meta">On each teammate's machine, run:</p><div class="cc-token"><code class="cc-cmd">${esc(hide(install))}</code>${copyBtn(install, "Copy command")}</div>` : "";
  const two = setup ? `<p>Run <code>agent-office install</code> on this computer. It merges this in for you and keeps a backup. Or paste it yourself:</p>
      <pre class="cc-snippet" tabindex="0" aria-label="settings.json snippet, token hidden"><code>${esc(hide(setup.snippet))}</code></pre>${copyBtn(setup.snippet, "Copy snippet")}${team}`
    : failed ? "" : `<span class="ao-skel cc-token-skel" aria-hidden="true"></span>`;
  const listen = step(3, '<span class="cc-pulse" aria-hidden="true"></span>Listening for the first event…', `<p class="ao-meta" role="status">Start claude in any folder. Restart sessions that were already running.</p>`);
  const steps = `${step(1, "Copy your workspace token", one)}${step(2, "Add the hook to ~/.claude/settings.json", two)}`;
  if (lastEvent) {
    const when = `${new Date(lastEvent).toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${clock(lastEvent)}`;
    return `<div class="cc-onboard-card ao-panel" role="region" aria-labelledby="cc-onboard-h">
    <h2 class="ao-name" id="cc-onboard-h">No agents in the last 24 hours</h2>
    <p class="ao-meta">The last event came in on ${esc(when)}. Start claude in any folder and it walks in here.</p>
    <p class="cc-listen" role="status"><span class="cc-pulse" aria-hidden="true"></span>Listening for events…</p>
    <details class="cc-more-setup"><summary>Connecting another machine?</summary><ol class="cc-steps">${steps}</ol></details></div>`;
  }
  return `<div class="cc-onboard-card ao-panel" role="region" aria-labelledby="cc-onboard-h">
    <h2 class="ao-name" id="cc-onboard-h">Connect your first agent</h2>
    <p class="ao-meta">Every Claude Code session shows up here as a person at a desk.</p>
    <ol class="cc-steps">${steps}${listen}</ol></div>`;
}

// ---------- dialogs ----------
const closeBtn = (label = "Close") => iconButton({ icon: "x", label, attrs: { "data-close": true } });

// ---------- answer an agent ----------
/** The answer dialog's parts, each filled in by shell.js. The box (buttons and reply) is redrawn only when the question
 *  changes, so a reply you're typing survives live updates. The status is a polite live region; "say" (screen readers
 *  only) tells why the box went away. */
export const answerFrame = () => `<div data-a="head"></div><div class="cc-dlg-body"><div data-a="convo"></div><div data-a="box"></div>` +
  `<div class="cc-answer-status" role="status" data-a="status"></div><p class="ao-sr" role="status" data-a="say"></p><div data-a="resume"></div></div><div class="cc-dlg-foot" data-a="foot"></div>`;

/** "<label> needs you" over "project · machine · waiting 4m"; after you answered, "You answered <label>".
 *  mode: from answerView() in shell-model.js. asOf: the live data stopped then (the stream is down). */
export function answerHead(a, { now = Date.now(), color, mode, asOf = null } = {}) {
  const name = displayName(a), waiting = (mode === "form" || mode === "terminal") && a.waitingSince;
  const title = mode === "sent" ? `You answered ${name}` : mode === "over" ? `${name} is no longer waiting` : `${name} needs you`;
  return `<div class="cc-dlg-head">${avatar({ name, color, decorative: true })}<div class="cc-dlg-id"><h2 class="ao-name" id="cc-answer-h" tabindex="-1">${esc(title)}</h2>
    <p class="ao-meta">${esc([projectKey(a), a.host, waiting && `waiting ${waitTime(now - Date.parse(a.waitingSince))}`].filter(Boolean).join(" · "))}</p></div>${asOf ? staleNote(asOf) : ""}${closeBtn()}</div>`;
}

const bubble = (who, meta, body) => `<li class="cc-bubble cc-bubble--${who}"><p class="cc-bubble-meta">${esc(meta)}</p>${body}</li>`;
const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
const whatOf = (tool) => (tool === "Bash" || tool === "PowerShell" ? "command" : EDIT_TOOLS.test(tool || "") || tool === "Read" ? "file" : "target");
const lines = (n, what) => `${n || 0} ${n === 1 ? "line" : "lines"} ${what}`;

/** The conversation: your prompt (right, teal), the agent's question (left, amber) with the command or file it's about
 *  and its plan step, then your answer. q = the question as it was when the dialog opened. gone = the agent left. */
export function answerConvo(a, { q = null, now = Date.now(), sent = null, mode, gone = false } = {}) {
  const name = displayName(a), out = [];
  if (a.task) out.push(bubble("you", `You · ${clock(a.taskAt)}`, `<p class="cc-clamp" title="${esc(a.task)}">${esc(a.task)}</p>`));
  if (q) {
    const act = actionOf({ ...a, state: "waiting", question: q }), step = workingOn(a), d = q.detail || {};
    const change = EDIT_TOOLS.test(q.tool || "") && (d.added || d.removed) ? `<p class="ao-meta">${esc(`${lines(d.added, "added")}, ${d.removed || 0} removed`)}</p>` : "";
    const said = q.qkind === "notification" && q.message ? `<p>${esc(q.message)}</p>` : "";
    // A file outside the project (or anywhere, for a session with no folder to compare) shows as "…/parent/file": say
    // so, with the whole path to hover and copy.
    const path = whatOf(q.tool) === "file" ? d.path || q.target : null, outside = path && outsideRoot(path, rootOf(a));
    const target = !act.target ? "" : outside
      ? `<div class="cc-outside"><span class="ao-label">Outside this project</span>${codeBox(act.target, { what: "file", open: true, title: path })}${copyBtn(path, "Copy full path")}</div>`
      : codeBox(act.target, { what: whatOf(q.tool), open: true });
    out.push(bubble("agent", `${name} · ${clock(q.t)}`, `<p class="cc-dlg-q">${icon("hand", { size: 16 })}<span>${esc(act.text)}</span></p>${said}` +
      `${target}${change}${step ? `<p class="ao-meta">${esc(step)}</p>` : ""}`));
  }
  if (sent) out.push(bubble("you", `You · ${now - sent.at < 60000 ? "just now" : clock(sent.at)} · from ${APP}`, `<p>${esc(answerText(sent))}</p>`));
  const over = mode === "over" ? `<p>It got an answer or moved on, so there's nothing to answer now.</p>${gone ? "" : `<p class="cc-dlg-now">Now ${statePill(a.state)}</p>`}` : "";
  return `${out.length ? `<ol class="cc-convo" aria-label="Conversation">${out.join("")}</ol>` : ""}${over}`;
}

/** The amber answer box (mode "form"), where to answer instead (mode "terminal"), or that the agent asks something new
 *  (mode "newer", with a button to show it). Depends only on the question. prefix keeps its ids apart from another
 *  answer box (the agent detail has one too). */
export function answerBox(v, a, q, { prefix = "cc-" } = {}) {
  const id = (k) => `${prefix}${k}`;
  const machine = a.host || "its machine";
  if (v.mode === "newer") {
    return `<div class="cc-terminal">${icon("hand", { size: 18 })}<div class="cc-newer"><p>That request was answered. <b>${esc(displayName(a))}</b> has a new one.</p>` +
      `${button({ label: "Show the new request", size: "sm", attrs: { "data-answer-next": true } })}</div></div>`;
  }
  if (v.mode === "terminal") {
    return `<div class="cc-terminal">${icon("terminal", { size: 18 })}<div>${v.windowClosed ? "<p>The in-app answer window has passed.</p>" : ""}<p>Answer in the Claude Code terminal on <b>${esc(machine)}</b>.</p></div></div>`;
  }
  if (v.mode !== "form") return "";
  return `<form class="cc-answer" data-answer-form="${esc(v.ask.id)}" aria-label="Your answer" novalidate>
    <div class="cc-answer-btns">${button({ label: "Approve once", variant: "primary", attrs: { "data-choice": "approve" } })}${button({ label: "Allow for this session", attrs: { "data-choice": "session", "aria-describedby": id("answer-session") } })}${button({ label: "Deny", attrs: { "data-choice": "deny" } })}</div>
    <p class="ao-meta" id="${id("answer-session")}">Allow for this session also approves every later request to ${esc(permissionPhrase(q && q.tool))} in this session, without asking.</p>
    <label class="cc-reply-label" for="${id("reply")}">Or reply in your own words. Your text is sent with a “no” and the agent adjusts.</label>
    <textarea class="cc-reply" id="${id("reply")}" rows="3" maxlength="1000" aria-describedby="${id("reply-keys")}"></textarea>
    <div class="cc-reply-row"><span class="ao-meta" id="${id("reply-keys")}">Ctrl+Enter or ⌘+Enter sends it</span><span class="ao-meta cc-answer-left" data-answer-left></span>${button({ label: "Send reply", type: "submit", attrs: { "data-choice": "reply", disabled: true } })}</div>
    <p class="cc-answer-err" role="alert" data-answer-error></p></form>`;
}

/** After you answered: sending, delivered (teal), or not delivered (red: the answer didn't arrive). d = deliveryView(). */
export function answerStatus(d) {
  if (!d) return "";
  const ic = d.tone === "ok" ? icon("check", { size: 16 }) : d.tone === "error" ? icon("alert", { size: 16 }) : '<span class="cc-pulse" aria-hidden="true"></span>';
  return `<p class="cc-answer-note is-${d.tone}">${ic}<span>${esc(d.text)}</span></p>`;
}

/** "Prefer the terminal?": answer where it runs, or pick the session up later. */
export function resumeBox(a) {
  const resume = `claude --resume ${a.session}`;
  return `<details class="cc-resume"><summary>Prefer the terminal?</summary><p class="ao-meta">Answer where it runs on ${esc(a.host || "its machine")}, or pick this session up later in its project folder:</p>
    <div class="cc-token"><code class="cc-cmd">${esc(resume)}</code>${copyBtn(resume, "Copy")}</div></details>`;
}

/** Jump and Close. Close is secondary while the answer buttons show, so teal stays on Approve once. */
export function answerFoot(mode, a, { gone = false } = {}) {
  return (gone ? "" : button({ label: "Jump to agent", icon: "locate", attrs: { "data-jump": a.session } })) +
    button({ label: "Close", variant: mode === "form" ? "secondary" : "primary", attrs: { "data-close": true } });
}
