// The Work Board, markup: small functions that return HTML strings. Text is escaped; no DOM.
// Colour rules: amber only for "needs you" (the Needs you column, its cards and KPI, waits in the swimlanes); red only
// for errors and spend over budget. States always carry an icon, a word or a pattern too.
import { panel, emptyState, loadingState, errorState, button, segmented, statePill, avatar, progressBar, toast } from "./ui/components.js";
import { esc } from "./ui/format.js";
import { icon } from "./ui/icons.js";
import { dayClock } from "./agent-detail-model.js";
import { VIEWS } from "./board-model.js";

const cx = (...n) => n.filter(Boolean).join(" ");
const pct = (f) => `${(f * 100).toFixed(3)}%`;
const proj = (i) => `--av:var(--proj-${((i % 6) + 6) % 6 + 1})`;
const idOf = (s) => String(s).replace(/[^\w-]/g, "_");
/** Filtered out by the top bar's chips: dimmed, like the office. */
const dim = (filter, state) => !!filter && !filter.has(state);
/** Each view's heading (an h2 for screen readers; what's in it starts at h3). */
export const VIEW_TITLES = { kanban: "Tasks by status", projects: "Projects", swimlanes: "Swimlanes" };
/** "project · label", or the project alone when the agent has no label of its own. */
const whoText = (project, name) => (name === project ? project : `${project} · ${name}`);

// ---------- frame ----------
/** The board's fixed parts; board.js fills each [data-wb] slot and shows one pane. The toast only repeats what
 *  Copy summary already announced, so it's hidden from screen readers. */
export function frame({ view = "kanban" } = {}) {
  return `<div class="wb-head"><p class="wb-sub" data-wb="date"></p>${segmented({ label: "Board view", value: view, options: VIEWS, attrs: { class: "wb-views" } })}</div>
    <div data-wb="summary"></div>
    <section class="wb-view" aria-labelledby="wb-view-h">
      <h2 class="ao-sr" id="wb-view-h" data-wb="view-h"></h2><div class="wb-view-bar"><span data-wb="note"></span></div>
      ${VIEWS.map((v) => `<div class="wb-pane" data-wb-pane="${v.value}"${v.value === view ? "" : " hidden"}></div>`).join("")}
    </section>
    <div class="wb-toasts" data-wb="toasts" aria-hidden="true"></div>`;
}

const FAILED = {
  state: ["Couldn't load today's work. The server didn't answer.", { "data-retry": true }],
  plans: ["Couldn't load today's plans. The server didn't answer.", { "data-wb-retry": true }],
  timeline: ["Couldn't load today's timeline. The server didn't answer.", { "data-day-retry": true }],
};
/** What failed (the live data, the plan items or the timeline) and Retry. */
export const failedPanel = (kind, label) => panel({ label, body: errorState({ text: FAILED[kind][0], action: { label: "Retry", attrs: FAILED[kind][1] } }) });

// ---------- daily summary ----------
const kpi = (k) => `<div class="${cx("wb-kpi", `wb-kpi--${k.key}`, k.tone && `is-${k.tone}`)}"><dt class="ao-label">${icon(k.icon, { size: 14 })}${esc(k.label)}</dt>` +
  `<dd class="wb-kpi-n">${esc(k.value)}</dd><dd class="ao-meta">${esc(k.sub)}</dd></div>`;

/** The auto-written summary, Copy summary and the six KPIs. status: loading, live, stale (asOf) or error. */
export function summaryPanel({ s = null, status = "live", asOf = null } = {}) {
  const base = { id: "wb-summary", title: "Daily summary", icon: "board", cls: "wb-summary" };
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows: 2, avatar: false, label: "Loading today's summary" }) });
  if (status === "error") return panel({ ...base, body: errorState({ text: FAILED.state[0], action: { label: "Retry", attrs: FAILED.state[1] } }) });
  const stale = status === "stale" ? asOf : null;
  if (s.empty) return panel({ ...base, stale, body: emptyState({ icon: "board", text: "No agents worked today yet. Start claude in any folder and its to-do list shows up here." }) });
  const copy = button({ label: "Copy summary", icon: "copy", size: "sm", attrs: { "data-copy": s.text, "data-wb-copy": true, "data-key": "wb-copy" } });
  return panel({ ...base, stale, meta: "Written from today's events", tools: copy, body: `<p class="wb-sum-text">${esc(s.text)}</p><dl class="wb-kpis">${s.kpis.map(kpi).join("")}</dl>` });
}

/** After Copy summary: done, or that the browser blocked it. */
export const copyToast = (ok) => (ok ? toast({ icon: "copy", title: "Summary copied", text: "Paste it into Slack, an email or a doc." })
  : toast({ icon: "alert", title: "Couldn't copy the summary", text: "The browser blocked the clipboard. Select the text and copy it instead." }));

// ---------- kanban ----------
const COLUMNS = [
  { key: "planned", title: "Planned", icon: "circle", empty: "Nothing planned yet. Plans come from each agent's own to-do list." },
  { key: "doing", title: "In progress", icon: "half", empty: "Nothing in progress right now." },
  { key: "needs", title: "Needs you", icon: "hand", empty: "Nobody is waiting on you.", ok: true },
  { key: "done", title: "Done today", icon: "check", empty: "Nothing finished yet today." },
];

/** A task: 2 lines of its text, the agent (avatar, "project · label") and a meta line. It opens the agent's detail. */
function card(c, filter) {
  return `<li><button type="button" class="${cx("wb-card", c.tone && `wb-card--${c.tone}`, dim(filter, c.state) && "is-dim")}" data-agent="${esc(c.session)}" data-key="${esc(`card:${c.key}`)}" title="${esc(c.text)}">` +
    `<span class="wb-card-text">${esc(c.text)}</span>` +
    `<span class="wb-card-who">${avatar({ name: c.name, color: c.color, size: "sm", decorative: true })}<span class="wb-card-name">${esc(whoText(c.project, c.name))}</span></span>` +
    `<span class="wb-card-meta">${icon(c.meta.icon, { size: 13 })}<span>${esc(c.meta.text)}</span></span></button></li>`;
}

/** A column: its cards, or its own empty state; a skeleton while the items load (cards null). */
function column(col, cards, { filter = null } = {}) {
  const base = { id: `wb-col-${col.key}`, title: col.title, icon: col.icon, level: 3, cls: `wb-col wb-col--${col.key}` };
  if (!cards) return panel({ ...base, busy: true, body: loadingState({ rows: 3, label: `Loading ${col.title.toLowerCase()}` }) });
  const badge = `<span class="${cx("wb-count", col.key === "needs" && cards.length && "is-needs")}">${cards.length}</span>`;
  return panel({ ...base, badge, body: cards.length ? `<ul class="wb-cards">${cards.map((c) => card(c, filter)).join("")}</ul>`
    : emptyState({ icon: col.ok ? "check" : col.icon, text: col.empty, ok: !!col.ok }) });
}

/** Planned, In progress, Needs you, Done today (k null: loading). hint: nobody has a plan today, so say how to get one. */
export function kanbanPane({ k = null, hint = false, filter = null } = {}) {
  return `<div class="wb-kanban">${COLUMNS.map((c) => column(c, k ? k.cols[c.key] : null, { filter })).join("")}</div>` +
    (hint ? `<p class="wb-hint">${icon("plan", { size: 15 })}<span>None of today's agents wrote a to-do list yet. Newer models keep one only with <code>agent-office install --with-plans</code>.</span></p>` : "");
}

// ---------- projects ----------
function projectCard(p, filter, now) {
  const id = `wb-p-${idOf(p.project)}`, off = !!filter && !p.agents.some((a) => filter.has(a.state));
  const row = (cls, body) => `<li${cls ? ` class="${cls}"` : ""}>${body}</li>`;
  const goals = p.goals.length ? `<ul class="wb-goals">${p.goals.map((g) => row(dim(filter, g.state) && "is-dim",
    `${avatar({ name: g.name, color: p.color, size: "sm", decorative: true })}<p class="cc-clamp" title="${esc(`${g.name}: ${g.text}`)}"><span class="ao-sr">${esc(g.name)}: </span>${esc(g.text)}</p>`)).join("")}</ul>`
    : '<p class="ao-meta">No prompt yet.</p>';
  const progress = p.total ? `${progressBar({ done: p.done, doing: p.doing, total: p.total, label: `${p.project}: ${p.done} of ${p.total} done, ${p.doing} in progress` })}` +
    `<p class="ao-meta wb-proj-prog"><b>${p.done} of ${p.total}</b> done today · ${p.doing} in progress</p>` : '<p class="ao-meta">No plan today yet.</p>';
  const agents = p.agents.map((a) => row(dim(filter, a.state) && "is-dim",
    `<button type="button" class="wb-agent" data-agent="${esc(a.session)}" data-key="${esc(`proj:${a.session}`)}">${avatar({ name: a.name, color: p.color, size: "sm", decorative: true })}<span class="wb-agent-name">${esc(a.name)}</span></button>` +
    `${statePill(a.state, { waitMs: a.waitMs })}<span class="wb-agent-cost" title="This session's cost">${esc(a.cost)}</span>`)).join("");
  return `<section class="${cx("ao-panel wb-proj", off && "is-dim")}" aria-labelledby="${id}">
    <header class="wb-proj-head"><span class="cc-dot" style="${proj(p.color)}"></span><h3 class="ao-panel-title" id="${id}">${esc(p.project)}</h3><span class="ao-meta">Last activity ${esc(dayClock(p.last, now))}</span></header>
    <h4 class="ao-label">Goal</h4>${goals}<h4 class="ao-label">Today</h4>${progress}
    <dl class="wb-proj-facts"><div><dt class="ao-label">Spent today</dt><dd>${esc(p.spend)}</dd></div><div><dt class="ao-label">Waited on you</dt><dd>${esc(p.waited)}</dd></div></dl>
    <h4 class="ao-label">Agents</h4><ul class="wb-proj-agents">${agents}</ul></section>`;
}

/** A card per project (cards null: loading). */
export function projectsPane({ cards = null, filter = null, now = Date.now() } = {}) {
  if (!cards) return `<div class="wb-projects">${[0, 1, 2].map(() => panel({ label: "Loading a project", busy: true, body: loadingState({ rows: 3, label: "Loading a project" }) })).join("")}</div>`;
  if (!cards.length) return panel({ label: "Projects", body: emptyState({ icon: "office", text: "No projects today yet. Every git project an agent works in gets a card here." }) });
  return `<div class="wb-projects">${cards.map((p) => projectCard(p, filter, now)).join("")}</div>`;
}

// ---------- swimlanes ----------
const LEGEND = [["working", "pulse", "Working"], ["needs", "hand", "Waiting on you"], ["idle", "coffee", "Idle"], ["offline", "power", "Offline"]];

/** A row: who (opens the detail), the day's segments with the now line, and its totals. The row's aria-label tells the
 *  whole story in words; the drawing is hidden from screen readers. */
function lane(r, filter) {
  const seg = (s) => `<span class="wb-seg wb-seg--${s.k}" style="left:${pct(s.x)};width:${pct(s.w)}" title="${esc(s.title)}">${s.label ? `<span class="wb-seg-label">${esc(s.label)}</span>` : ""}</span>`;
  const tags = r.items.filter((s) => s.tag).map((s) => `<span class="wb-tag" style="left:${pct(s.tag.x)}">${esc(s.tag.label)}</span>`).join("");
  return `<div class="${cx("wb-lane", dim(filter, r.state) && "is-dim")}" role="group" aria-label="${esc(r.aria)}">
    <div class="wb-lane-who">${avatar({ name: r.name, color: r.color, size: "sm", decorative: true })}<button type="button" class="wb-lane-name" data-agent="${esc(r.session)}" data-key="${esc(`lane:${r.session}`)}" title="${esc(r.name)}">${esc(r.name)}</button>${r.name === r.project ? "" : `<span class="ao-meta wb-lane-proj">${esc(r.project)}</span>`}</div>
    <div class="wb-track" aria-hidden="true"><div class="wb-tags">${tags}</div><div class="wb-bar">${r.items.map(seg).join("")}<span class="wb-now"></span></div></div>
    <p class="wb-lane-tot" aria-hidden="true">${esc(r.totals)}</p></div>`;
}

/** One row per agent over the day, hour ticks, the now line and the legend. L null: no activity today. */
export function lanesPane({ L = null, loading = false, filter = null } = {}) {
  const base = { id: "wb-lanes", title: "Agents over the day", icon: "clock", level: 3, cls: "wb-lanes-panel" };
  if (loading) return panel({ ...base, busy: true, body: loadingState({ rows: 4, label: "Loading today's timeline" }) });
  if (!L || !L.rows.length) return panel({ ...base, body: emptyState({ icon: "clock", text: "No activity today yet. Each agent gets a row here as it works." }) });
  const ticks = L.ticks.map((t) => `<span style="left:${pct(t.x)}">${esc(t.label)}</span>`).join("");
  const key = LEGEND.map(([k, ic, text]) => `<li><span class="wb-sw wb-seg--${k}"></span>${icon(ic, { size: 14 })}${text}</li>`).join("");
  return panel({ ...base, meta: L.range, body: `<div class="wb-lanes" style="--now:${pct(L.now)}">
      <div class="wb-lane wb-lane--head" aria-hidden="true"><span></span><div class="wb-track"><div class="wb-tags"><span class="wb-now-tag" style="left:${pct(L.now)}">Now ${esc(L.nowLabel)}</span></div><div class="wb-ticks">${ticks}</div></div><span class="ao-label">Active · waited · idle</span></div>
      ${L.rows.map((r) => lane(r, filter)).join("")}</div>
    <ul class="wb-legend" aria-label="Legend">${key}<li><span class="wb-sw wb-sw--now"></span>Now</li></ul>` });
}
