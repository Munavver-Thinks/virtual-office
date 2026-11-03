// The Cost Report, markup: small functions that return HTML strings. Text is escaped; no DOM.
// Colour rules: teal bars and rings, project colours per project; red only for spend over the budget (a day's bar, a
// ring past 100%, "N days over budget") and for errors. No amber here. Every chart has a text alternative, and estimates
// say so ("≈", "estimate").
import { panel, emptyState, loadingState, errorState, button, segmented, budgetRing, ringSvg, avatar, statePill, toast, staleNote } from "./ui/components.js";
import { esc, money, clock } from "./ui/format.js";
import { icon } from "./ui/icons.js";
import { RANGES, PERIOD, share } from "./cost-model.js";

const cx = (...n) => n.filter(Boolean).join(" ");
const pct = (f) => `${(Math.max(0, Math.min(1, +f || 0)) * 100).toFixed(3)}%`;
const proj = (i) => `--av:var(--proj-${((i % 6) + 6) % 6 + 1})`;
/** Filtered out by the top bar's chips: dimmed, as in the office. */
const dimmed = (filter, state) => (filter && !filter.has(state) ? ' class="is-dim"' : "");
/** "≈$12.30" on screen, "about $12.30" for screen readers. */
const about = (usd) => `<span aria-hidden="true">≈</span><span class="ao-sr">about </span>${esc(money(usd))}`;
const RETRY = { label: "Retry", attrs: { "data-cr-retry": true } };
const FAILED = "Couldn't load the cost report. The server didn't answer.";
const NO_DATA = "No cost data yet. Cost tracking starts after agent-office install and a restart of your claude sessions.";

// ---------- frame and header ----------
/** The report's fixed parts; cost.js fills each [data-cr] slot. The toasts are a polite live region: Export CSV says
 *  what it saved there. */
export function frame({ range = "today" } = {}) {
  return `<div class="cr-head"><p class="cr-updated" data-cr="updated"></p>
      <div class="cr-tools">${segmented({ label: "Period of the breakdowns and the export", value: range, options: RANGES, attrs: { class: "cr-range" } })}<span data-cr="export"></span></div></div>
    <div data-cr="kpis"></div>
    <div data-cr="days"></div>
    <div class="cr-grid cr-grid--cards"><div class="cr-stack"><div data-cr="projects"></div><div data-cr="models"></div></div><div data-cr="cache"></div></div>
    <div class="cr-grid cr-grid--2"><div data-cr="agents"></div><div data-cr="top"></div></div>
    <div class="cr-toasts" data-cr="toasts" role="status" aria-live="polite"></div>`;
}

/** "Updated 15:42", or "As of 15:40" while the data is behind. */
export function updated(status, t) {
  if (status === "loading") return "<span>Loading…</span>";
  if (status === "error") return "<span>Not loaded</span>";
  if (status === "stale") return staleNote(t);
  return `<span class="cr-live">${icon("clock", { size: 14 })}Updated ${esc(clock(t))}</span>`;
}

/** Export CSV for the period; off when it had no requests. "Exporting…" while it runs (it stays focusable). */
export function exportButton({ ready = false, busy = false, range = "today" } = {}) {
  const what = ready ? `One row per API request ${PERIOD[range]}.` : `No API requests ${PERIOD[range]} to export.`;
  return button({ label: busy ? "Exporting…" : "Export CSV", icon: "download", attrs: { "data-cr-export": true, "data-key": "cr-export", disabled: !ready, "aria-describedby": "cr-export-what", title: what, "aria-busy": busy ? "true" : null } }) +
    `<span class="ao-sr" id="cr-export-what">${esc(what)}</span>`;
}

/** After Export CSV: how many requests went into which file, or what went wrong. partial: the oldest requests of the
 *  period weren't kept (the server keeps at most 100,000). */
export function exportToast({ ok, name = "", rows = 0, partial = false, range = "today", error = "" } = {}) {
  if (!ok) return toast({ icon: "alert", title: "Couldn't export the CSV", text: error || "The server didn't answer." });
  return toast({ icon: "download", title: `Exported ${rows} ${rows === 1 ? "request" : "requests"} ${PERIOD[range]}`,
    text: partial ? `${name} · the oldest weren't kept, so they're missing` : name });
}

const stateOf = (status, asOf) => (status === "stale" ? asOf : null);
/** Loading (a skeleton) and error (with Retry), the same for every panel; null once there's data. */
function pending(base, status, label, rows = 3) {
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows, avatar: false, label }) });
  if (status === "error") return panel({ ...base, body: errorState({ text: FAILED, action: RETRY }) });
  return null;
}

// ---------- KPI tiles ----------
function cacheTile(c) {
  const text = !c.used ? "No cache use reported" : !c.priced ? "No list price for these models" : c.usd < 0 ? `cost ${money(-c.usd)} more than it saved` : `estimate · ${Math.round(c.frac * 100)}% less than without the cache`;
  const amount = c.priced && c.usd >= 0 ? about(c.usd) : "None";
  return `<span class="ao-ring">${ringSvg(c.frac)}<span class="ao-ring-text"><b class="ao-ring-amount">${amount}</b><span class="ao-ring-sub">${esc(text)}</span></span></span>`;
}

function tile(k) {
  const body = k.cache ? cacheTile(k.cache) : budgetRing({ spent: k.spent, budget: k.budget, period: k.period });
  const note = k.note ? `<p class="${cx("cr-kpi-note", k.over && "is-over")}">${k.over ? icon("alert", { size: 13 }) : ""}${esc(k.note)}</p>` : "";
  return `<li class="${cx("cr-kpi", `cr-kpi--${k.key}`)}"><h3 class="ao-label">${esc(k.label)}</h3>${body}${note}</li>`;
}

/** Today, the last 7 days and the month so far against the budget; what the cache saved over 7 days. */
export function kpiPanel({ v = null, status = "live", asOf = null, budget = 0 } = {}) {
  const base = { id: "cr-kpis", title: "At a glance", icon: "chart", cls: "cr-kpis-panel" };
  const wait = pending(base, status, "Loading spend", 2);
  if (wait) return wait;
  if (v.empty) return panel({ ...base, stale: stateOf(status, asOf), body: emptyState({ icon: "chart", text: NO_DATA }) });
  const tools = budget > 0 ? "" : '<a class="cc-link" href="#/settings?section=budgets">Set a daily budget</a>';
  return panel({ ...base, stale: stateOf(status, asOf), tools, body: `<ul class="cr-kpis">${v.kpis.map(tile).join("")}</ul>` });
}

// ---------- spend by day ----------
function bar(b) {
  return `<li class="${cx("cr-bar", b.over && "is-over", b.today && "is-today")}" style="--h:${pct(b.h)}" title="${esc(b.text)}">` +
    `<span class="cr-bar-fill"></span>${b.tag ? `<span class="cr-bar-tag" aria-hidden="true">${esc(b.tag)}</span>` : ""}` +
    `<span class="ao-sr">${esc(b.text)}</span><span class="cr-bar-day" aria-hidden="true">${esc(b.label)}</span></li>`;
}

const KEY = [["", "Spend"], ["is-today", "Today, so far"], ["is-over", "Over budget"]];

/** 14 bars with the y-axis, the dashed budget line, a legend and a summary for screen readers (each bar has its own). */
export function daysPanel({ v = null, status = "live", asOf = null } = {}) {
  const base = { id: "cr-days", title: "Spend by day", cls: "cr-days-panel" };
  const wait = pending(base, status, "Loading spend by day");
  if (wait) return wait;
  const c = v.chart, stale = stateOf(status, asOf);
  if (!c) return panel({ ...base, meta: "Last 14 days", stale, body: emptyState({ icon: "chart", text: "No spend in the last 14 days." }) });
  const ticks = c.ticks.map((t) => `<span style="bottom:${pct(t.y)}">${esc(t.label)}</span>`).join("");
  const grid = c.ticks.slice(1).map((t) => `<span class="cr-gridline" style="bottom:${pct(t.y)}"></span>`).join("");
  const line = c.line ? `<span class="cr-line" style="bottom:${pct(c.line.y)}"><span>${esc(c.line.label)}</span></span>` : "";
  const key = KEY.map(([k, label]) => `<li><span class="${cx("cr-sw", k)}"></span>${label}</li>`).join("") + (c.line ? '<li><span class="cr-sw cr-sw--line"></span>Daily budget</li>' : "");
  return panel({ ...base, meta: `Last 14 days · ${money(c.total)}`, stale, body: `<div class="cr-chart">
      <div class="cr-axis" aria-hidden="true">${ticks}</div>
      <div class="cr-plot">${grid}<ol class="cr-bars" aria-label="Spend per day, oldest first">${c.bars.map(bar).join("")}</ol>${line}</div></div>
    <p class="ao-sr">${esc(c.summary)}</p><ul class="cr-key" aria-label="Legend">${key}</ul>` });
}

// ---------- by project, by model ----------
const row = (name, frac, num, { color = null, meta = "" } = {}) => `<li class="cr-row">${name}` +
  `<span class="cr-track" aria-hidden="true"><span class="${cx("cr-fill", color == null && "cr-fill--teal")}" style="width:${pct(frac)}${color == null ? "" : `;${proj(color)}`}"></span></span>` +
  `<span class="cr-num">${esc(num)}</span>${meta}</li>`;

/** Each project's spend in the period, as a bar in its colour with its share. */
export function projectsPanel({ v = null, status = "live", asOf = null } = {}) {
  const base = { id: "cr-projects", title: "By project" };
  const wait = pending(base, status, "Loading spend by project");
  if (wait) return wait;
  const stale = stateOf(status, asOf);
  if (!v.projects.length) return panel({ ...base, meta: v.period, stale, body: emptyState({ icon: "office", text: `No spend ${v.phrase} yet.` }) });
  return panel({ ...base, meta: v.period, stale, body: `<ul class="cr-rows">${v.projects.map((r) =>
    row(`<span class="cr-name"><span class="cc-dot" style="${proj(r.color)}"></span><span class="cc-oneline" title="${esc(r.project)}">${esc(r.project)}</span></span>`, r.frac, `${money(r.cost)} · ${r.share}`, { color: r.color })).join("")}</ul>` });
}

/** Each model's spend in the period: its id in mono, its share and how many requests. */
export function modelsPanel({ v = null, status = "live", asOf = null } = {}) {
  const base = { id: "cr-models", title: "By model" };
  const wait = pending(base, status, "Loading spend by model");
  if (wait) return wait;
  const stale = stateOf(status, asOf);
  if (!v.models.length) return panel({ ...base, meta: v.period, stale, body: emptyState({ icon: "chart", text: `No spend ${v.phrase} yet.` }) });
  return panel({ ...base, meta: v.period, stale, body: `<ul class="cr-rows">${v.models.map((m) =>
    row(`<span class="cr-name">${m.mono ? `<code class="cc-oneline" title="${esc(m.name)}">${esc(m.name)}</code>` : `<span class="cc-oneline">${esc(m.name)}</span>`}</span>`, m.frac,
      `${money(m.cost)} · ${m.share}`, { meta: `<span class="ao-meta cr-row-meta">${esc(`${m.requests} ${m.requests === 1 ? "request" : "requests"}`)}</span>` })).join("")}</ul>` });
}

// ---------- cache savings ----------
/** A list price, exactly: "$5", "$0.50", "$0.025". */
export function price(n) {
  const s = String(+(+n || 0).toFixed(4)), cents = s.split(".")[1];
  return `$${cents && cents.length === 1 ? `${s}0` : s}`;
}

/** The list prices behind the estimate, per million tokens; the rows this period used are marked. */
function priceTable(rows) {
  const tr = (r) => `<tr${r.used ? ' class="is-used"' : ""}><th scope="row">${esc(r.family)}${r.used ? '<span class="cr-used">used</span>' : ""}</th><td>${price(r.input)}</td><td>${price(r.read)}</td><td>${price(r.write)}</td></tr>`;
  return `<div class="cr-table-wrap cr-prices-wrap" role="region" aria-label="List prices" tabindex="0"><table class="cr-prices"><caption>List prices behind the estimate, in USD per million tokens</caption>
    <thead><tr><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Cache read</th><th scope="col">Cache write</th></tr></thead><tbody>${rows.map(tr).join("")}</tbody></table></div>`;
}

/** The token mix as a bar (cache reads solid teal, cache writes striped, fresh input and output neutral), a legend with
 *  the counts, and the bar's text alternative. */
function mixBar(c) {
  const label = `Token mix: ${c.mix.map((m) => `${m.label.toLowerCase()} ${m.text}`).join(", ")}`;
  return `<div class="cr-mix" role="img" aria-label="${esc(label)}">${c.mix.filter((m) => m.n > 0).map((m) => `<span class="cr-mix-${m.key}" style="width:${pct(m.frac)}"></span>`).join("")}</div>` +
    `<ul class="cr-mix-key" aria-hidden="true">${c.mix.map((m) => `<li><span class="cr-sw cr-mix-${m.key}"></span>${esc(m.label)} <b>${esc(m.text)}</b></li>`).join("")}</ul>`;
}

/** What prompt caching saved in the period (an estimate, said twice), what it would have cost without it, the share of
 *  input tokens read from the cache, the token mix, and the price table. */
export function cachePanel({ v = null, status = "live", asOf = null } = {}) {
  const base = { id: "cr-cache", title: "Cache savings" };
  const wait = pending(base, status, "Loading cache savings");
  if (wait) return wait;
  const c = v.cache, stale = stateOf(status, asOf), meta = v.period;
  if (!c.used) return panel({ ...base, meta, stale, body: emptyState({ icon: "chart", text: v.requests ? `No prompt caching reported ${v.phrase}.` : `No spend ${v.phrase} yet.` }) });
  const read = `${c.readShare >= 0.5 ? `${share(c.readShare)} of input tokens were cache reads` : `Cache reads were ${share(c.readShare)} of input tokens`}, billed at about a tenth of fresh input.`;
  const lead = !c.priced ? `<p class="cr-cache-lead">No list price is known for ${v.models.length === 1 ? "this model" : "these models"}, so what the cache saved isn't estimated.</p>`
    : c.usd < 0 ? `<p class="cr-cache-lead"><b>The cache cost ${about(-c.usd)} more than it saved</b> <span class="cr-est">estimate</span></p>`
    : `<p class="cr-cache-lead"><b>${about(c.usd)} saved by prompt caching</b> <span class="cr-est">estimate</span></p><p>Without the cache this would have cost ${about(c.without)}.</p>`;
  const left = c.priced && c.unpriced ? `<p class="ao-meta">Not counted: ${esc(c.unpriced.toLocaleString("en-US"))} cache tokens from models without a list price here.</p>` : "";
  return panel({ ...base, meta, stale, body: `${lead}<p class="ao-meta">${esc(read)}</p>${mixBar(c)}<p class="cr-tokens ao-mono"><span class="ao-sr">Tokens: </span>${esc(c.tokens)}</p>${left}
    ${priceTable(v.prices)}<p class="ao-meta cr-how">Telemetry reports what each request cost, not what the cache saved. This compares the cache tokens with list prices, so it's an estimate.</p>` });
}

// ---------- by agent ----------
/** Each agent's spend in the period, costliest first, as a button that opens its detail; then how many more. */
export function agentsPanel({ v = null, status = "live", asOf = null, filter = null } = {}) {
  const base = { id: "cr-agents", title: "By agent" };
  const wait = pending(base, status, "Loading spend by agent", 4);
  if (wait) return wait;
  const a = v.agents, stale = stateOf(status, asOf);
  if (!a.rows.length) return panel({ ...base, meta: v.period, stale, body: emptyState({ icon: "user", text: `No spend ${v.phrase} yet.` }) });
  const item = (r) => `<li${dimmed(filter, r.state)}><button type="button" class="cr-agent" data-agent="${esc(r.session)}" data-key="${esc(`cr-agent:${r.session}`)}" ` +
    `aria-label="${esc(`${r.name}, ${r.project}: ${money(r.cost)} ${v.phrase}. Open its details`)}">${avatar({ name: r.name, color: r.color, size: "sm", decorative: true })}` +
    `<span class="cr-agent-who"><span class="cr-agent-name">${esc(r.name)}</span><span class="ao-meta">${esc(r.project)}</span></span>` +
    `<span class="cr-track" aria-hidden="true"><span class="cr-fill" style="width:${pct(r.frac)};${proj(r.color)}"></span></span><span class="cr-num">${esc(money(r.cost))}</span></button></li>`;
  const more = a.more ? `<p class="ao-meta cr-more">+${a.more} more ${a.more === 1 ? "agent" : "agents"} · ${esc(money(a.moreCost))}</p>` : "";
  return panel({ ...base, meta: v.period, stale, body: `<ul class="cr-agents">${a.rows.map(item).join("")}</ul>${more}` });
}

// ---------- the costliest sessions ----------
function topRow(r, filter, avg) {
  const sub = [r.project, r.host].filter(Boolean).join(" · ");
  return `<tr${dimmed(filter, r.state)}><th scope="row"><span class="cr-who">${avatar({ name: r.name, color: r.color, size: "sm", decorative: true })}` +
    `<span class="cr-who-text"><span class="cr-who-name">${esc(r.name)}</span><span class="ao-meta">${esc(sub)}</span></span>${statePill(r.state)}</span></th>` +
    `<td>${r.model ? `<code>${esc(r.model)}</code>` : "Not reported"}</td><td>${esc(r.duration || "Unknown")}</td><td class="cr-nowrap"><code>${esc(r.tokens)}</code></td>` +
    `<td><b>${esc(money(r.cost))}</b></td>${avg ? `<td>${esc(r.vsAvg)}</td>` : ""}` +
    `<td>${button({ label: "View trace", icon: "pulse", size: "sm", attrs: { "data-agent": r.session, "data-agent-at": "trace", "data-key": `cr-trace:${r.session}`, "aria-label": `View the trace of ${r.name}` } })}</td></tr>`;
}

/** The 5 costliest sessions of the period, with View trace. "× vs avg" shows with 3 or more sessions to compare. */
export function topPanel({ v = null, status = "live", asOf = null, filter = null } = {}) {
  const base = { id: "cr-top", title: "Top 5 costliest sessions" };
  const wait = pending(base, status, "Loading the costliest sessions", 5);
  if (wait) return wait;
  const stale = stateOf(status, asOf), avg = v.avgCost != null;
  if (!v.top.length) return panel({ ...base, meta: v.period, stale, body: emptyState({ icon: "user", text: `No spend ${v.phrase} yet.` }) });
  const head = ["Session", "Model", "Duration", "Tokens", "Cost", ...(avg ? ["× vs avg"] : [])].map((h) => `<th scope="col">${h}</th>`).join("") + '<th scope="col"><span class="ao-sr">Trace</span></th>';
  const note = avg ? `<p class="ao-meta">× vs avg compares each session with the average session ${esc(v.phrase)} (${esc(money(v.avgCost))}).</p>`
    : '<p class="ao-meta">× vs avg shows once 3 or more sessions have spent something in this period.</p>';
  return panel({ ...base, meta: v.period, stale, body: `<div class="cr-table-wrap" role="region" aria-labelledby="cr-top-title" tabindex="0">
    <table class="cr-top"><thead><tr>${head}</tr></thead><tbody>${v.top.map((r) => topRow(r, filter, avg)).join("")}</tbody></table></div>${note}` });
}
