// The Work Board, pure part: the daily summary and its six KPIs, the Kanban columns, the project cards and the
// swimlanes. Input: the live snapshot, GET /api/board (plan items) and GET /api/timeline (state segments built from each
// session's state-change log). No DOM: safe to import in Node tests.
import { STATES, stateKey } from "./ui/components.js";
import { clock, duration, waitTime, money, costText } from "./ui/format.js";
import { relPath, outsideRoot, baseName } from "./lib/describe.js";
import { actionOf, displayName, projectKey, rootOf } from "./office3d-model.js";
import { colorOf, costView, dayRange, hourTicks } from "./shell-model.js";
import { dayClock } from "./agent-detail-model.js";

const MIN = 60000;
const ms = (t) => Date.parse(t);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "a", "a and b", "a, b and c" */
const and = (list) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);
const sameDay = (t, now) => new Date(t).toDateString() === new Date(now).toDateString();
const URGENCY = { needs: 0, working: 1, idle: 2, offline: 3 };

export const VIEWS = [{ value: "kanban", label: "Kanban" }, { value: "projects", label: "Projects" }, { value: "swimlanes", label: "Swimlanes" }];
export const viewOf = (v) => (VIEWS.some((x) => x.value === v) ? v : "kanban");

/** "Thursday, Oct 23" */
export const dayTitle = (now = Date.now()) => new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

/** For sentences: "52 min", "1 h 5 min", "under a minute". */
export function spokenTime(v) {
  const m = Math.floor(Math.max(0, +v || 0) / MIN);
  if (m < 1) return "under a minute";
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${m} min`;
}

/** For totals: "2h 5m", "<1m", "0m". */
const shortTime = (v) => (v >= MIN ? duration(v) : v > 0 ? "<1m" : "0m");

// An absolute path in free text: after a space, quote or bracket, from "/" or a drive letter, up to the next space.
const ABS = /(^|[\s("'`[])((?:[A-Za-z]:[\\/]|\/)[^\s"'`<>()[\]]+)/g;
// Outside the agent's root, only what is surely a file path is shortened, so a route like /api/board stays as written.
const FS = /^(?:[A-Za-z]:[\\/]|\/(?:Users|home|root|srv|var|tmp|opt|mnt|Volumes|private|etc|usr)\/)/;

/** A task or mission in the agent's own words with its paths as the rest of the UI shows them: relative to the agent's
 *  root ("src/a.ts"), else shortened ("…/parent/file"). Slashes and a Windows drive's case don't matter. */
export function relText(text, root) {
  return String(text ?? "").replace(ABS, (all, pre, raw) => {
    const [, p, tail] = /^(.*?)([.,;:!?]*)$/.exec(raw);
    if (outsideRoot(p, root) && !FS.test(p)) return all;
    const r = relPath(p, root);
    return pre + (r === "." ? baseName(p) : r) + tail;
  });
}

/** The agents the board's day is about: the ones active today, and any still waiting on you from before midnight. */
export const boardAgents = (agents = [], now = Date.now()) => agents.filter((a) => sameDay(a.updated, now) || stateKey(a.state) === "needs");

const waitOf = (a, now) => (stateKey(a.state) === "needs" && a.waitingSince ? Math.max(0, now - ms(a.waitingSince)) : null);

// ---------- daily summary ----------
/** "8 agents across 3 projects completed 26 of 50 planned tasks, spent $13.72 (55% of the $25 budget) and waited on you
 *  52 min. Right now 2 are waiting for you, and webhook retries is offline, last seen at 12:05." Last seen is its last
 *  event; it is called offline after the offline timeout with nothing more (the swimlanes show the same). */
function sentence({ list, projects, done, total, cv, pct, over, waitedMs, waiting, offline, now }) {
  const who = `${plural(list.length, "agent")} ${projects === 1 ? "in 1 project" : `across ${projects} projects`}`, b = money(cv.budget, { trim: true });
  const did = [total ? `completed ${done} of ${plural(total, "planned task")}` : "wrote no to-do list yet"];
  if (!cv.noData) did.push(`spent ${money(cv.spent)}${!cv.budget ? "" : over ? ` (over the ${b} budget, at ${pct}%)` : ` (${pct}% of the ${b} budget)`}`);
  did.push(waitedMs > 0 ? `waited on you ${spokenTime(waitedMs)}` : "didn't wait on you");
  const right = waiting ? `Right now ${waiting} ${waiting === 1 ? "is" : "are"} waiting for you` : "Nobody is waiting for you right now";
  const seen = (a) => dayClock(a.updated, now);
  const off = offline.length === 1 ? `${displayName(offline[0])} is offline, last seen at ${seen(offline[0])}`
    : offline.length ? `${offline.length} are offline: ${and([...offline.slice(0, 3).map((a) => `${displayName(a)} (last seen ${seen(a)})`), ...(offline.length > 3 ? [`${offline.length - 3} more`] : [])])}` : "";
  return `${who} ${and(did)}. ${right}${off ? `, and ${off}` : ""}.`;
}

/** Under In progress: how many of its steps aren't moving, by their agent's state ("2 waiting on you · 1 stalled"). */
function doingSub(list, doing, now) {
  const n = (k) => list.filter((a) => sameDay(a.updated, now) && stateKey(a.state) === k).reduce((s, a) => s + ((a.plan && a.plan.inProgress) || 0), 0);
  const parts = [[n("needs"), "waiting on you"], [n("idle"), "paused"], [n("offline"), "stalled"]].filter(([c]) => c).map(([c, w]) => `${c} ${w}`);
  return !doing ? "nothing under way" : parts.length ? parts.join(" · ") : "all being worked on";
}

/**
 * The daily summary, written from the snapshot: plan counts (each agent's own to-do list), spend (telemetry), the time
 * agents waited on you (the state-change log), who waits now and who went quiet (offline, not ended). text is what Copy
 * summary copies. KPIs: Done, In progress, Needs you, Planned, Waited on you, Spend. The agents are the board's (see
 * boardAgents), the same as Projects'.
 */
export function summary(snap, { now = Date.now(), budget = 0 } = {}) {
  const t = (snap && snap.totals) || {}, list = boardAgents((snap && snap.agents) || [], now);
  const done = t.tasksDone || 0, doing = t.tasksInProgress || 0, planned = t.tasksPending || 0, total = done + doing + planned;
  const cv = costView(t, "today", budget), waiting = t.waiting || 0, waitedMs = t.waitedMs || 0;
  const pct = cv.budget ? Math.round((cv.spent / cv.budget) * 100) : null, over = cv.budget > 0 && cv.spent > cv.budget;
  const offline = list.filter((a) => stateKey(a.state) === "offline" && !a.ended).sort((a, b) => ms(a.updated) - ms(b.updated));
  const projects = new Set(list.map(projectKey)).size;
  const kpis = [
    { key: "done", label: "Done", icon: "check", value: String(done), sub: total ? `of ${total} planned` : "nothing planned yet" },
    { key: "doing", label: "In progress", icon: "half", value: String(doing), sub: doingSub(list, doing, now) },
    { key: "needs", label: "Needs you", icon: "hand", value: String(waiting), sub: waiting ? `${waiting === 1 ? "agent" : "agents"} waiting now` : "nobody waiting", tone: waiting ? "needs" : null },
    { key: "planned", label: "Planned", icon: "circle", value: String(planned), sub: "not started yet" },
    { key: "waited", label: "Waited on you", icon: "clock", value: shortTime(waitedMs), sub: "today, all agents" },
    { key: "spend", label: "Spend", icon: "chart", value: cv.noData ? "No data" : money(cv.spent), tone: over ? "over" : null,
      sub: cv.noData ? "Cost needs telemetry" : !cv.budget ? "No budget set" : `${over ? "Over budget · " : ""}${pct}% of ${money(cv.budget, { trim: true })}` },
  ];
  return { empty: !list.length, agents: list.length, projects, kpis,
    text: list.length ? sentence({ list, projects, done, total, cv, pct, over, waitedMs, waiting, offline, now }) : "" };
}

// ---------- kanban ----------
const DOING = { working: 0, needs: 1, idle: 1, offline: 2 };
const waitText = (w) => (w == null ? "waiting on you" : `waiting ${waitTime(w)}`);

/** An in-progress item, by its agent's state now: since when; paused (idle); stalled (offline). */
function doingMeta(k, since, now) {
  if (k === "offline") return { icon: "power", text: "stalled · offline" };
  if (k === "idle") return { icon: "coffee", text: "paused · agent idle" };
  return { icon: "pulse", text: since ? `since ${dayClock(since, now)}` : "in progress" };
}

/**
 * The four columns. Planned: pending items. In progress: in-progress items of agents not waiting on you. Needs you: the
 * in-progress items of agents waiting on you, longest wait first (one waiting with nothing in progress shows its
 * question instead, so nobody waiting is left out). Done today: newest first. The items come from GET /api/board; each
 * card follows its agent's state in the live snapshot. hasPlans: some agent has a plan that counts today.
 */
export function kanban(snap, board, { now = Date.now(), colors = new Map() } = {}) {
  const agents = (snap && snap.agents) || [], byId = new Map(agents.map((a) => [a.session, a]));
  const cols = { planned: [], doing: [], needs: [], done: [] }, asked = new Set();
  const who = (a) => ({ session: a.session, name: displayName(a), project: projectKey(a), color: colorOf(colors, projectKey(a)), state: stateKey(a.state), start: ms(a.started) || 0 });
  for (const p of (board && board.plans) || []) {
    const a = byId.get(p.session);
    if (!a) continue;
    const w = who(a), root = rootOf(a), wait = waitOf(a, now);
    for (const x of p.open) {
      const c = { ...w, key: `${a.session}:${x.step}:${x.text}`, text: relText(x.text, root), step: x.step };
      if (x.status === "pending") cols.planned.push({ ...c, meta: { icon: "circle", text: `Step ${x.step} of ${p.of}` } });
      else if (w.state === "needs") { asked.add(a.session); cols.needs.push({ ...c, wait, tone: "needs", meta: { icon: "hand", text: waitText(wait) } }); }
      else cols.doing.push({ ...c, since: ms(x.since) || 0, meta: doingMeta(w.state, x.since, now) });
    }
    for (const x of p.done) cols.done.push({ ...w, key: `${a.session}:done:${x.at}:${x.text}`, text: relText(x.text, root), at: ms(x.at) || 0, meta: { icon: "check", text: `done ${clock(x.at)}` } });
  }
  for (const a of agents) {
    if (stateKey(a.state) !== "needs" || asked.has(a.session)) continue;
    const wait = waitOf(a, now);
    cols.needs.push({ ...who(a), key: `${a.session}:question`, text: actionOf(a).text, wait, tone: "needs", meta: { icon: "hand", text: `${waitText(wait)} · no plan step` } });
  }
  cols.needs.sort((x, y) => (y.wait ?? -1) - (x.wait ?? -1) || cmp(x.key, y.key));
  cols.doing.sort((x, y) => DOING[x.state] - DOING[y.state] || x.since - y.since || cmp(x.key, y.key));
  cols.planned.sort((x, y) => cmp(x.project, y.project) || URGENCY[x.state] - URGENCY[y.state] || x.start - y.start || cmp(x.session, y.session) || x.step - y.step);
  cols.done.sort((x, y) => y.at - x.at || cmp(x.key, y.key));
  return { cols, hasPlans: !!(board && board.plans && board.plans.length) };
}

// ---------- projects ----------
/**
 * One card per project of the board's agents (the summary's), most planned first: its colour and last activity, the goal
 * (each agent's mission: its first real prompt), today's progress (counted like Today's progress), today's spend, the
 * time its agents waited on you, and its agents with their state and cost. All from the snapshot.
 */
export function projects(snap, { now = Date.now(), colors = new Map() } = {}) {
  const agents = boardAgents((snap && snap.agents) || [], now), t = (snap && snap.totals) || {}, groups = new Map();
  for (const a of agents) {
    if (!groups.has(projectKey(a))) groups.set(projectKey(a), []);
    groups.get(projectKey(a)).push(a);
  }
  const rows = new Map((t.projects || []).map((r) => [r.project || "Other", r]));
  const noCost = costView(t, "today").noData, spend = t.todayByProject || {};
  return [...groups].map(([project, list]) => {
    const r = rows.get(project) || { done: 0, inProgress: 0, pending: 0 };
    const sorted = [...list].sort((a, b) => URGENCY[stateKey(a.state)] - URGENCY[stateKey(b.state)] || ms(a.started) - ms(b.started) || cmp(a.session, b.session));
    return {
      project, color: colorOf(colors, project), last: Math.max(...list.map((a) => ms(a.updated) || 0)),
      goals: sorted.filter((a) => a.mission).map((a) => ({ session: a.session, name: displayName(a), state: stateKey(a.state), text: relText(a.mission, rootOf(a)) })),
      done: r.done, doing: r.inProgress, total: r.done + r.inProgress + r.pending,
      // The cost report's key: the project, or "unknown" for a session with no folder. None of its agents ever reported a
      // cost (telemetry off on their machines): no data, as on each agent, never a misleading $0.00.
      spend: noCost || !list.some((a) => +a.requests > 0) ? "No cost data" : money(spend[list[0].project || "unknown"] || 0),
      waited: shortTime(list.reduce((n, a) => n + ((a.today && a.today.waitedMs) || 0), 0)),
      agents: sorted.map((a) => ({ session: a.session, name: displayName(a), state: stateKey(a.state), waitMs: waitOf(a, now), cost: costText(a) })),
    };
  }).sort((a, b) => b.total - a.total || b.last - a.last || cmp(a.project, b.project));
}

// ---------- swimlanes ----------
const LANE = { working: "working", waiting: "needs", idle: "idle", offline: "offline" };
const CHAR_PX = 6.6, PAD_PX = 14, GAP_PX = 6, LISTED = 12;
const textPx = (s) => s.length * CHAR_PX + PAD_PX;

/** A segment's short label and its full description. A wait still going says "waiting"; an offline spell says when the
 *  agent was last heard from, or that its session ended. */
function segWords(g) {
  const d = g.to - g.from, when = g.current ? `since ${clock(g.from)}` : `${clock(g.from)} to ${clock(g.to)}`;
  if (g.state === "working") return { label: duration(d), long: `Working ${when}, ${duration(d)}` };
  if (g.state === "waiting") return { label: `${g.current ? "waiting" : "waited"} ${waitTime(d)}`, long: `Waiting on you ${when}, ${waitTime(d)}` };
  if (g.state === "idle") return { label: `idle ${duration(d)}`, long: `Idle ${when}, ${duration(d)}` };
  if (g.ended) return { label: "session ended", long: `Session ended at ${clock(g.from)}` };
  return g.lastContact ? { label: `offline · last seen ${clock(g.lastContact)}`, long: `Offline from ${clock(g.from)}, last seen ${clock(g.lastContact)}` }
    : { label: "offline", long: `Offline ${when}` };
}

/**
 * One row per agent with activity today, grouped by project, over the day's range (08:00, or the hour of the first
 * activity, to the end of this hour). Segments come from each session's state-change log (GET /api/timeline). Nothing is
 * drawn past the data's end: now, but never past the live snapshot's own time (snap.t) nor `until` (the time an older
 * timeline is shown "As of"). Only while live (both the stream and the timeline) does the segment still running when the
 * timeline was fetched run on to that end, and only while the agent is still in that state. Row totals and the text
 * alternative come from the same segments. px = the track's width, to tell which labels fit inside their segment; a wait
 * too short for its label gets a tag above it instead, unless that would cover the tag before it. Null with no activity.
 */
export function swimlanes(timeline, snap, { now = Date.now(), live = true, until = null, colors = new Map(), px = 900 } = {}) {
  const span = timeline ? dayRange(timeline, now) : null;
  if (!span) return null;
  const full = span.end - span.start, fetched = ms(timeline.to), x = (t) => (t - span.start) / full;
  const end = Math.min(now, until ?? Infinity, (snap && ms(snap.t)) || Infinity);
  const byId = new Map(((snap && snap.agents) || []).map((a) => [a.session, a]));
  const rows = (timeline.sessions || []).map((s) => {
    const a = byId.get(s.session), raw = s.segments || [];
    const segs = raw.map((g, i) => {
      const running = i === raw.length - 1 && ms(g.to) >= fetched, on = running && live && !!a && a.state === g.state;
      return { state: g.state, from: Math.max(ms(g.from), span.start), to: Math.min(on ? Math.max(ms(g.to), end) : ms(g.to), end), current: on || (running && !live),
        lastContact: g.lastContact || null, ended: g.state === "offline" && ms(g.from) === ms(g.lastContact) };
    }).filter((g) => g.to > g.from);
    let edge = -Infinity;
    const items = segs.map((g) => {
      const w = (g.to - g.from) / full, words = segWords(g);
      const inside = textPx(words.label) <= w * px && (g.state !== "working" || g.to - g.from >= 60 * MIN);
      let tag = null;
      if (g.state === "waiting" && !inside) {
        const half = textPx(words.label) / 2, at = Math.min(Math.max(((x(g.from) + x(g.to)) / 2) * px, half), px - half);
        if (at - half >= edge + GAP_PX) { tag = { x: at / px, label: words.label }; edge = at + half; }
      }
      return { k: LANE[g.state], x: x(g.from), w, label: inside ? words.label : null, tag, title: words.long };
    });
    const sum = (st) => segs.reduce((n, g) => n + (g.state === st ? g.to - g.from : 0), 0);
    const tot = { active: sum("working"), waited: sum("waiting"), idle: sum("idle") };
    const id = a || s, name = displayName(id), project = projectKey(id), k = a ? stateKey(a.state) : null;
    const listed = segs.filter((g) => g.to - g.from >= MIN), shown = listed.slice(-LISTED).map((g) => segWords(g).long), more = listed.length - shown.length;
    const story = shown.length ? `${more ? `${plural(more, "earlier change")} not listed. ` : ""}${shown.join(". ")}.` : "No time recorded yet.";
    return {
      session: s.session, name, project, color: colorOf(colors, project), state: k, items,
      totals: `${shortTime(tot.active)} active · ${shortTime(tot.waited)} waited · ${shortTime(tot.idle)} idle`,
      aria: `${name}, ${project}${k ? `, ${STATES[k].label} ${live ? "now" : `at ${clock(end)}`}` : ""}. ${story} Today: ${shortTime(tot.active)} active, ${shortTime(tot.waited)} waited on you, ${shortTime(tot.idle)} idle.`,
    };
  });
  // Grouped by project, in the order projects first got busy; within one, first busy first (the timeline's order).
  const order = [...new Set(rows.map((r) => r.project))];
  rows.sort((a, b) => order.indexOf(a.project) - order.indexOf(b.project));
  return { range: `${clock(span.start)} to ${clock(span.end)}`, ticks: hourTicks(span), now: x(now), nowLabel: clock(now), rows };
}
