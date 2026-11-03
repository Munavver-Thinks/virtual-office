// The Cost Report, pure part: the KPI tiles, spend by day, spend by project, model and agent, what prompt caching saved
// (an estimate from list prices: telemetry reports what each request cost, not what the cache saved) and the costliest
// sessions. Input: GET /api/cost, the daily budget and the live snapshot's agents. No DOM: safe to import in Node tests.
import { stateKey } from "./ui/components.js";
import { money, compact, tokensLine, duration } from "./ui/format.js";
import { PRICES, CACHE_READ, CACHE_WRITE, cacheSavings } from "./lib/prices.js";
import { displayName, projectKey } from "./office3d-model.js";
import { colorOf } from "./shell-model.js";

const CHART_DAYS = 14, AGENT_ROWS = 10, TOP = 5;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sum = (list) => list.reduce((n, x) => n + x.cost, 0);

// ---------- periods and dates ----------
/** The header's switch: what the breakdowns, the top sessions and Export CSV cover. */
export const RANGES = [{ value: "today", label: "Today" }, { value: "7d", label: "7 days" }];
export const rangeOf = (v) => (v === "7d" ? "7d" : "today");
/** For sentences: "No spend today yet." / "No spend in the last 7 days yet." */
export const PERIOD = { today: "today", "7d": "in the last 7 days" };

const dateOf = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
/** "2026-10-19" → "Oct 19" */
export const dayName = (s) => dateOf(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const monthName = (s) => dateOf(s).toLocaleDateString("en-US", { month: "long" });
const daysInMonth = (s) => { const d = dateOf(s); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };

/** A share as a percentage: "62%", "99.9%" near the top, "<1%" for a sliver. */
export function share(f) {
  if (!(f > 0)) return "0%";
  if (f >= 1) return "100%";
  if (f < 0.01) return "<1%";
  return f >= 0.99 ? `${Math.floor(f * 1000) / 10}%` : `${Math.round(f * 100)}%`;
}

// ---------- KPI tiles ----------
/** The four tiles: today and the last 7 days against the daily budget (× 7), the month so far against the monthly budget
 *  (Settings; without one, the daily budget × the days in the month), and what the cache saved over the last 7 days
 *  (an estimate). */
export function kpis(r, budget = 0, monthly = 0) {
  const b = Math.max(0, +budget || 0), m = Math.max(0, +monthly || 0), week = r.days.slice(-7), n = daysInMonth(r.date);
  const over = b ? week.filter((d) => d.cost > b).length : 0;
  return [
    { key: "today", label: "Today", spent: r.days.at(-1).cost, budget: b, period: "today" },
    { key: "week", label: "Last 7 days", spent: sum(week), budget: b * 7, period: "in 7 days", over: over > 0,
      note: b ? (over ? `${plural(over, "day")} over budget` : "No day over budget") : null },
    { key: "month", label: "Month to date", spent: sum(r.days.filter((d) => d.date >= r.month)), budget: m || b * n, period: `in ${monthName(r.date)}`,
      note: m ? "Monthly budget" : b ? `${money(b, { trim: true })} a day × ${n} days` : null },
    { key: "cache", label: "Cache saved · 7 days", cache: cacheView(r.periods["7d"]) },
  ];
}

// ---------- spend by day ----------
/** A round axis top at or above max, in at most 4 steps of 1, 2, 2.5 or 5 × a power of ten. */
export function axis(max) {
  const m = Math.max(+max || 0, 0.04), raw = m / 4, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw * (1 - 1e-9)), n = Math.max(1, Math.ceil(m / step - 1e-9));
  return { top: n * step, ticks: Array.from({ length: n + 1 }, (_, i) => i * step) };
}

/**
 * The last 14 days as bars (h = a fraction of the axis top), the dashed daily budget line, and the text for each bar and
 * the whole chart. Red only over the budget; today is "so far". Null when none of the days had any spend.
 */
export function chart(r, budget = 0) {
  const b = Math.max(0, +budget || 0), days = r.days.slice(-CHART_DAYS), total = sum(days);
  if (!days.some((d) => d.cost > 0)) return null;
  const { top, ticks } = axis(Math.max(b, ...days.map((d) => d.cost))), cap = money(b, { trim: true });
  const bars = days.map((d, i) => {
    const today = i === days.length - 1, over = b > 0 && d.cost > b, name = dayName(d.date);
    return { date: d.date, cost: d.cost, h: d.cost / top, today, over,
      label: i === 0 || d.date.endsWith("-01") ? name : String(Number(d.date.slice(8))),
      tag: over ? `${money(d.cost)} · over` : today ? "so far" : null,
      text: `${name}${today ? ", today" : ""}: ${money(d.cost)}${today ? " so far" : ""}${over ? `, ${money(d.cost - b)} over the ${cap} budget` : ""}` };
  });
  const peak = bars.reduce((x, y) => (y.cost > x.cost ? y : x)), overs = bars.filter((x) => x.over);
  const budgetText = !b ? "No daily budget set." : overs.length
    ? `${plural(overs.length, "day")} over the ${cap} daily budget: ${overs.map((x) => dayName(x.date)).join(", ")}.` : `No day over the ${cap} daily budget.`;
  return {
    bars, total, top, ticks: ticks.map((v) => ({ y: v / top, label: money(v, { trim: true }) })), line: b ? { y: b / top, label: `budget ${cap}` } : null,
    summary: `${money(total)} in the last 14 days. Highest: ${dayName(peak.date)}, ${money(peak.cost)}. ${budgetText} Today so far: ${money(bars.at(-1).cost)}.`,
  };
}

// ---------- by project and by model ----------
/** Spend per project in the period, most first, with its colour and share. Sessions with no folder are "Other". */
export function projectRows(p, colors = new Map()) {
  return p.projects.filter((x) => x.cost > 0).map((x) => {
    const project = x.project || "Other", f = p.cost ? x.cost / p.cost : 0;
    return { project, color: colorOf(colors, project), cost: x.cost, frac: f, share: share(f) };
  });
}

const MODEL_NAMES = new Map([["unknown", "Model not reported"], ["other", "Other models"]]);
/** Spend per model in the period, most first. A model id is shown as is (mono); the store's buckets get words. */
export function modelRows(p) {
  return p.models.filter((m) => m.cost > 0).map((m) => {
    const f = p.cost ? m.cost / p.cost : 0;
    return { model: m.model, name: MODEL_NAMES.get(m.model) || m.model, mono: !MODEL_NAMES.has(m.model), cost: m.cost, requests: m.requests, frac: f, share: share(f) };
  });
}

// ---------- cache savings ----------
const MIX = [["cacheRead", "Cache reads"], ["cacheWrite", "Cache writes"], ["input", "Fresh input"], ["output", "Output"]];

/**
 * What prompt caching saved in the period, per model from list prices (an estimate): without the cache every cache read
 * would have been fresh input, and no cache write would have cost extra. Models with no known price are left out
 * (unpriced = their cache tokens). The share of input tokens that were cache reads and the token mix are facts.
 */
export function cacheView(p) {
  let usd = 0, priced = false, unpriced = 0;
  const families = new Set();
  for (const m of p.models) {
    const c = cacheSavings(m.tokens, m.model);
    if (c) { usd += c.usd; priced = true; families.add(c.family); } else unpriced += (+m.tokens.cacheRead || 0) + (+m.tokens.cacheWrite || 0);
  }
  const t = p.tokens, input = t.input + t.cacheRead + t.cacheWrite, all = input + t.output;
  return {
    used: t.cacheRead + t.cacheWrite > 0, priced, usd: priced ? usd : null, without: priced ? p.cost + usd : null,
    frac: priced && usd > 0 ? usd / (p.cost + usd) : 0, readShare: input ? t.cacheRead / input : 0, unpriced, families: [...families],
    mix: MIX.map(([key, label]) => ({ key, label, n: t[key], frac: all ? t[key] / all : 0, text: compact(t[key]) })), tokens: tokensLine(t),
  };
}

/** The list prices behind the estimate, per million tokens; used = a model of the period priced by that row. */
export const priceTable = (families = []) => PRICES.map((x) => ({ family: x.family, input: x.input, read: x.input * CACHE_READ, write: x.input * CACHE_WRITE, used: families.includes(x.family) }));

// ---------- by agent and the costliest sessions ----------
/** Who a session is: its name, project and colour, and its state now (from the live data while it's there). */
function who(s, live, colors) {
  const a = live.get(s.session), project = projectKey(s);
  return { session: s.session, name: displayName(s), project, host: s.host || null, color: colorOf(colors, project), state: stateKey(a ? a.state : s.state) };
}

/** Spend per agent in the period, most first (at most `limit`; bars against the costliest), then how many more and what
 *  they cost together. */
export function agentRows(p, { colors = new Map(), live = [], limit = AGENT_ROWS } = {}) {
  const byId = new Map(live.map((a) => [a.session, a])), list = p.sessions.filter((s) => s.cost > 0).slice(0, limit), max = list.length ? list[0].cost : 0;
  const rows = list.map((s) => ({ ...who(s, byId, colors), cost: s.cost, frac: max ? s.cost / max : 0 }));
  const more = Math.max(0, p.sessionCount - rows.length);
  return { rows, more, moreCost: more ? Math.max(0, p.cost - sum(rows)) : 0 };
}

/** The 5 costliest sessions of the period: who, main model, how long it ran (first to last event), tokens, cost, and
 *  how it compares with the period's average session (null with fewer than 3). */
export function topRows(p, { colors = new Map(), live = [] } = {}) {
  const byId = new Map(live.map((a) => [a.session, a]));
  return p.sessions.filter((s) => s.cost > 0).slice(0, TOP).map((s) => {
    const a = byId.get(s.session), from = Date.parse(s.started), to = Date.parse((a && a.updated) || s.updated);
    return { ...who(s, byId, colors), model: s.model || null, duration: Number.isFinite(from) && Number.isFinite(to) ? duration(to - from) : null,
      tokens: tokensLine(s.tokens), cost: s.cost, vsAvg: p.avgCost ? `${(s.cost / p.avgCost).toFixed(1)}×` : null };
  });
}

// ---------- the whole report ----------
/** Everything the screen shows for one period. empty: no spend reported in any day shown (telemetry may be off). */
export function report(r, { range = "today", budget = 0, monthly = 0, colors = new Map(), live = [] } = {}) {
  const key = rangeOf(range), p = r.periods[key], cache = cacheView(p);
  return {
    t: r.t, empty: !r.days.some((d) => d.cost > 0 || d.requests > 0), range: key,
    period: key === "today" ? "Today" : `Last 7 days · ${dayName(p.from)} to today`, phrase: PERIOD[key], requests: p.requests,
    kpis: kpis(r, budget, monthly), chart: chart(r, budget), projects: projectRows(p, colors), models: modelRows(p), cache, prices: priceTable(cache.families),
    agents: agentRows(p, { colors, live }), top: topRows(p, { colors, live }), avgCost: p.avgCost,
  };
}
