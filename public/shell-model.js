// The Command Center shell, pure part: routes, the top bar's numbers, the right rail's data, the day timeline and its
// replay, and which agents just started waiting. No DOM: safe to import in Node tests.
import { stateKey, projectColor } from "./ui/components.js";
import { clock } from "./ui/format.js";
import { describeStep, describeTool, baseName } from "./lib/describe.js";
import { actionOf, displayName, projectKey, queueOrder, rootOf } from "./office3d-model.js";

const MIN = 60000, HOUR = 3600000;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- routes ----------
export const APP = "Virtual Office";
export const SCREENS = [
  { id: "office", label: "Office", icon: "office" },
  { id: "board", label: "Work board", icon: "board" },
  { id: "hall", label: "Meeting hall", icon: "meeting" },
  { id: "cost", label: "Cost report", icon: "chart" },
  { id: "alerts", label: "Alerts", icon: "bell" },
  { id: "settings", label: "Settings", icon: "settings" },
];
const IDS = new Set(SCREENS.map((s) => s.id));

/** "#/board" → "board". Empty or unknown hashes are the office. */
export function parseRoute(hash) {
  const id = String(hash ?? "").replace(/^#\/?/, "").split(/[/?#]/)[0].toLowerCase();
  return IDS.has(id) ? id : "office";
}

/** "#/board?agent=demo-basket" → "demo-basket": an agent's detail to open over that screen, or null. */
export function routeAgent(hash) {
  const m = /[?&]agent=([^&#]*)/.exec(String(hash ?? ""));
  if (!m) return null;
  try { return decodeURIComponent(m[1]).slice(0, 100) || null; } catch { return null; }
}

/** "(2) Work board · Virtual Office": the waiting count first, so it shows in a crowded tab bar. */
export function pageTitle(route, waiting = 0) {
  const s = SCREENS.find((x) => x.id === route);
  return `${waiting > 0 ? `(${waiting}) ` : ""}${s && s.id !== "office" ? `${s.label} · ` : ""}${APP}`;
}

// ---------- top bar ----------
export const RANGES = [
  { value: "today", label: "Today", period: "today" },
  { value: "7d", label: "7d", period: "in 7 days" },
  { value: "30d", label: "30d", period: "in 30 days" },
];
export const rangeOf = (v) => RANGES.find((r) => r.value === v) || RANGES[0];

/** Spend and tokens for the chosen period. The daily budget scales with its days ($25 a day is $175 for 7 days).
 *  noData: no API request was ever reported (telemetry off), so there is no cost to show. */
export function costView(totals = {}, range = "today", dailyBudget = 0) {
  const r = rangeOf(range), p = (totals.periods || {})[r.value] || { days: 1, cost: 0, requests: 0, tokensByType: {} };
  return { spent: +p.cost || 0, budget: Math.max(0, +dailyBudget || 0) * p.days, period: r.period, tokens: p.tokensByType || {}, noData: !p.requests && !p.cost };
}

/** Filter chip counts, in the design's state names. */
export const stateCounts = (t = {}) => ({ working: t.working || 0, needs: t.waiting || 0, idle: t.idle || 0, offline: t.offline || 0 });

// ---------- right rail ----------
/** Colour index per project, falling back to the hash colour for a project the office hasn't placed. */
export const colorOf = (colors, project) => colors.get(project) ?? projectColor(project);

/** "Plan step 4 of 9 · Add the refund webhook secret", or null when no step is in progress. */
export function planStep(a) {
  const n = a.plan && a.plan.now;
  return n && n.text ? `Plan step ${n.step} of ${n.of} · ${n.text}` : null;
}

const FILE_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|Read)$/;
const what = (tool) => (tool === "Bash" || tool === "PowerShell" ? "command" : FILE_TOOLS.test(tool || "") ? "file" : "target");

/** Needs you now, longest wait first: the question in plain English, its target (relative path or command), the plan step. */
export function needsItems(agents = [], { now = Date.now(), colors = new Map() } = {}) {
  return queueOrder(agents).map((a) => {
    const act = actionOf(a), q = a.question || {};
    return {
      session: a.session, name: displayName(a), project: projectKey(a), host: a.host || null, color: colorOf(colors, projectKey(a)),
      waitMs: a.waitingSince ? Math.max(0, now - Date.parse(a.waitingSince)) : null,
      text: act.text, target: act.target, what: what(q.tool), step: planStep(a), stale: !!q.stale,
    };
  });
}

/** Today's progress: totals, one row per project (most planned first) and the time agents waited on you. */
export function progressView(totals = {}, colors = new Map()) {
  const done = totals.tasksDone || 0, doing = totals.tasksInProgress || 0, planned = totals.tasksPending || 0, total = done + doing + planned;
  const rows = (totals.projects || []).map((r) => {
    const project = r.project || "Other";
    return { project, color: colorOf(colors, project), done: r.done, doing: r.inProgress, total: r.done + r.inProgress + r.pending };
  });
  return { done, doing, planned, total, pct: total ? Math.round((done / total) * 100) : 0, rows, waitedMs: totals.waitedMs || 0 };
}

/** A trace step in plain English. A question's target goes through the tool describer, so paths are relative. */
function stepAction(x, root) {
  const d = describeStep(x, { root });
  if (x.kind === "question" && x.tool) d.target = describeTool({ tool: x.tool, target: x.target, detail: x.detail }, { root }).target;
  return d;
}

/** Splits the file or pattern a sentence names into mono: "Edited " + "BasketTotals.tsx". full = the whole target, for a tooltip. */
export function actionParts({ text, target, icon }) {
  if (!target || icon === "sub-agent") return { lead: text, mono: null, full: null };
  const name = baseName(target);
  if (name && text.endsWith(` ${name}`)) return { lead: text.slice(0, -name.length), mono: name, full: target };
  if (text.includes(`“${target}”`)) return { lead: text, mono: null, full: null };
  return { lead: `${text} `, mono: target, full: target };
}

const SHOWN = 3;
/** Live activity: per agent its last 3 actions, newest first; agents with the newest action first. */
export function activityGroups(agents = [], { colors = new Map(), limit = 20 } = {}) {
  const groups = [];
  for (const a of agents) {
    const steps = (a.recent || []).filter((x) => x.kind !== "notice").slice(-SHOWN).reverse();
    if (!steps.length) continue;
    const root = rootOf(a);
    groups.push({
      session: a.session, name: displayName(a), project: projectKey(a), color: colorOf(colors, projectKey(a)), state: a.state,
      latest: Math.max(...steps.map((x) => Date.parse(x.t) || 0)),
      actions: steps.map((x) => {
        const d = stepAction(x, root);
        return { key: `${a.session}:${x.id}`, icon: d.icon, ...actionParts(d), t: x.t, sub: !!x.agentId && x.kind !== "subagent", failed: x.status === "error" };
      }),
    });
  }
  return groups.sort((a, b) => b.latest - a.latest || cmp(a.session, b.session)).slice(0, limit);
}

const SEEN = 500;
/** Lines for the screen-reader log: actions not seen before, oldest first. The first call only fills `seen`.
 *  `seen` is trimmed to about SEEN keys, oldest first, but never loses a key that is still on screen. */
export function freshLines(groups, seen, { first = false } = {}) {
  const out = [], shown = new Set();
  for (const g of groups) {
    for (const x of g.actions) {
      shown.add(x.key);
      if (seen.has(x.key)) continue;
      seen.add(x.key);
      if (!first) out.push({ t: Date.parse(x.t) || 0, line: `${g.name}: ${x.lead}${x.mono || ""}${x.failed ? " (failed)" : ""}` });
    }
  }
  for (const k of seen) {
    if (seen.size <= SEEN) break;
    if (!shown.has(k)) seen.delete(k);
  }
  return out.sort((a, b) => a.t - b.t).map((x) => x.line);
}

// ---------- answering an agent ----------
const LATE = 2000; // the server stops taking answers this close to the end of the window (src/store.js)

/** "Working on step 3 of 6: Install the printer filter package", or null. */
export function workingOn(a) {
  const n = a.plan && a.plan.now;
  return n && n.text ? `Working on step ${n.step} of ${n.of}: ${n.text}` : null;
}

/**
 * What the answer dialog shows. a = the agent now (null once it left the snapshot); q = the question the dialog is on,
 * as last seen (it stays on that one: another question's ask belongs to another hook); sent = the answer sent from it.
 * mode: "form" (answer here, until ask.until), "terminal" (a notification, an AskUserQuestion, or a request whose hook
 * isn't waiting: windowClosed says it was and stopped), "sent" (you answered), "newer" (that question went and the
 * agent asks something else), "over" (it stopped waiting).
 */
export function answerView(a, { q = null, sent = null, now = Date.now() } = {}) {
  const none = { ask: null, windowClosed: false };
  if (sent) return { mode: "sent", ...none };
  if (!a || stateKey(a.state) !== "needs" || !a.question) return { mode: "over", ...none };
  if (!q || a.question.id !== q.id) return { mode: "newer", ...none };
  const cur = a.question, ask = cur.ask && Date.parse(cur.ask.until) - now > LATE ? cur.ask : null;
  return { mode: ask ? "form" : "terminal", ask, windowClosed: !ask && (!!cur.windowClosed || !!cur.ask) };
}

/** What a screen reader hears when the answer box goes away under you, or "" when there's nothing to say. */
export function answerNotice(v, a) {
  const name = a ? displayName(a) : "The agent", machine = (a && a.host) || "its machine";
  if (v.mode === "terminal") return `${v.windowClosed ? "The in-app answer window has passed. " : ""}Answer in the Claude Code terminal on ${machine}.`;
  if (v.mode === "newer") return `That request was answered. ${name} has a new one.`;
  if (v.mode === "over") return `${name} is no longer waiting.`;
  return "";
}

/** "1:42 left to answer here" */
export function answerLeft(until, now = Date.now()) {
  const s = Math.max(0, Math.floor((Date.parse(until) - LATE - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left to answer here`;
}

/** After you answered: on its way, delivered (its hook picked it up), or not delivered (the hook stopped waiting first, so
 *  the question is still open, for the terminal). sent = { questionId, until, delivered } from POST /api/answer; the
 *  server logs the answer (a.answer) only once it's delivered. */
export function deliveryView(a, sent, now = Date.now()) {
  const name = a ? displayName(a) : "The agent", machine = (a && a.host) || "its machine";
  if ((a && a.answer && a.answer.questionId === sent.questionId) || sent.delivered) {
    return { tone: "ok", text: `${name} ${a && stateKey(a.state) === "working" ? "is working again" : "got your answer"} · Delivered to ${machine}` };
  }
  const q = a && a.question && a.question.id === sent.questionId ? a.question : null;
  if ((q && q.windowClosed) || now > Date.parse(sent.until) + 3000) {
    return { tone: "error", text: `Couldn't deliver your answer: ${machine} stopped waiting. Answer in the Claude Code terminal on ${machine}.` };
  }
  return { tone: "busy", text: `Sending your answer to ${machine}…` };
}

// ---------- toasts ----------
/** Identifies one wait: the same agent waiting on a new question is a new wait. */
export const waitKey = (a) => (stateKey(a.state) === "needs" ? `${a.session}:${a.waitingSince || ""}` : null);

/** Agents that just started waiting. prev = the wait keys of the last snapshot; on the first snapshot (prev null),
 *  the ones that started waiting in the last `recentMs`, so opening the dashboard shows what you just missed. */
export function newWaiters(prev, agents = [], { now = Date.now(), recentMs = 5 * MIN } = {}) {
  return agents.filter((a) => {
    const k = waitKey(a);
    if (!k) return false;
    if (prev) return prev.get(a.session) !== k;
    return !!a.waitingSince && now - Date.parse(a.waitingSince) <= recentMs;
  }).sort((a, b) => Date.parse(a.waitingSince || 0) - Date.parse(b.waitingSince || 0));
}

// ---------- day timeline ----------
const floorHour = (ms) => { const d = new Date(ms); d.setMinutes(0, 0, 0); return d.getTime(); };
const at8 = (ms) => { const d = new Date(ms); d.setHours(8, 0, 0, 0); return d.getTime(); };
const busy = (b) => b.working + b.waiting + b.idle;

/** The span the ribbon shows: from 08:00 (or the hour of the first activity, if earlier) to the end of the current hour. */
export function dayRange(timeline, now = Date.now()) {
  const first = ((timeline && timeline.buckets) || []).find((b) => busy(b) > 0);
  if (!first) return null;
  return { start: Math.min(at8(now), floorHour(Date.parse(first.t))), end: floorHour(now) + HOUR, now };
}

/** One bar per 10-minute bucket in the range, positioned as fractions of the width and sized against the busiest bucket.
 *  The current bucket's bar ends at now. */
export function ribbon(timeline, range) {
  const span = range.end - range.start, size = timeline.bucketMs || 10 * MIN;
  const list = (timeline.buckets || []).map((b) => ({ ...b, ms: Date.parse(b.t) })).filter((b) => b.ms >= range.start && b.ms < Math.min(range.end, range.now));
  const max = Math.max(1, ...list.map(busy));
  return {
    max,
    bars: list.filter((b) => busy(b) > 0).map((b) => ({ t: b.ms, x: (b.ms - range.start) / span, w: (Math.min(b.ms + size, range.now) - b.ms) / span,
      working: b.working / max, waiting: b.waiting / max, idle: b.idle / max, count: { working: b.working, waiting: b.waiting, idle: b.idle } })),
  };
}

/** CSS width of the scrubber: the ribbon from its start to now, plus one thumb width. With the input shifted left by
 *  half a thumb (shell.css), the thumb's centre sits exactly over start + value minutes. */
export const scrubWidth = (range) => `calc(${(((range.now - range.start) / (range.end - range.start)) * 100).toFixed(3)}% + var(--cc-thumb))`;

/** Hour labels along the ribbon; every second hour once the span passes 10 hours. */
export function hourTicks(range) {
  const out = [], span = range.end - range.start, step = span > 10 * HOUR ? 2 : 1;
  for (let t = range.start, i = 0; t <= range.end; t += HOUR, i++) if (i % step === 0) out.push({ t, x: (t - range.start) / span, label: clock(t) });
  return out;
}

/** Text alternative for the ribbon. */
export function ribbonSummary(timeline, range) {
  const list = (timeline.buckets || []).filter((b) => { const t = Date.parse(b.t); return t >= range.start && t < range.now; });
  const peak = list.reduce((best, b) => (b.working > (best ? best.working : 0) ? b : best), null);
  const waited = list.filter((b) => b.waiting > 0).length;
  return `Today from ${clock(range.start)} to ${clock(range.now)}.` +
    (peak ? ` At most ${peak.working} ${peak.working === 1 ? "agent" : "agents"} working at once, first at ${clock(peak.t)}.` : " Nobody worked yet.") +
    (waited ? ` Someone waited on you in ${waited} of ${list.length} ten-minute periods.` : " Nobody waited on you.");
}

/** The office at a past moment: every session that had started by then, in the state it was in. Only states are known.
 *  A moment after the timeline was fetched keeps each session's last state. */
export function replayAgents(timeline, live = [], at) {
  const byId = new Map(live.map((a) => [a.session, a]));
  const out = [];
  for (const s of (timeline && timeline.sessions) || []) {
    const segs = s.segments || [], last = segs[segs.length - 1];
    const seg = segs.find((g) => Date.parse(g.from) <= at && at < Date.parse(g.to)) || (last && at >= Date.parse(last.to) ? last : null);
    if (!seg) continue;
    const a = byId.get(s.session) || {};
    out.push({
      session: s.session, name: s.name, project: s.project, label: s.label, host: s.host, gitRoot: a.gitRoot || null, root: a.root || null,
      started: a.started || segs[0].from, state: seg.state, waitingSince: seg.state === "waiting" ? seg.from : null,
    });
  }
  return out;
}
