// The Meeting Hall, pure part: the rooms and who sits at each table, the standup Virtual Office writes for a room from
// each agent's plan and activity (agents don't talk to each other: every line comes from hook events, the agent's own
// to-do list or telemetry), your messages to the room with a line per agent on where each stands, the decisions
// waiting on you, where agents overlap, and the room's scorecard. Input: the live snapshot and GET /api/rooms.
// No DOM: safe to import in Node tests.
import { STATES, stateKey } from "./ui/components.js";
import { clock, money, waitTime, costText, endTruncate } from "./ui/format.js";
import { answerText, describeStep } from "./lib/describe.js";
import { actionOf, displayName, projectKey, rootOf } from "./office3d-model.js";
import { APP, colorOf, costView, actionParts } from "./shell-model.js";
import { boardAgents, relText } from "./board-model.js";
import { dayClock } from "./agent-detail-model.js";

const MIN = 60000;
// Messages that may wait per agent, and the most agents one room message reaches (src/store.js).
const INBOX = 10, ROOM_MAX = 50;
/** The All rooms tab. Replay shows one bubble every STEP_MS. */
export const ALL = "", STEP_MS = 1100;
const ms = (t) => Date.parse(t);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "a", "a and b", "a, b, and c" */
export const and = (list) => (list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")}, and ${list.at(-1)}`);
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const span = (v) => (v >= MIN ? waitTime(v) : "under a minute");
const sameDay = (t, now) => new Date(t).toDateString() === new Date(now).toDateString();
const byStart = (a, b) => (ms(a.started) || 0) - (ms(b.started) || 0) || cmp(a.session, b.session);
const URGENCY = { needs: 0, working: 1, idle: 2, offline: 3 };
const waitOf = (a, now) => (stateKey(a.state) === "needs" && a.waitingSince ? Math.max(0, now - ms(a.waitingSince)) : null);
const FILE_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|Read)$/;
const whatOf = (tool) => (tool === "Bash" || tool === "PowerShell" ? "command" : FILE_TOOLS.test(tool || "") ? "file" : "target");

// ---------- rooms ----------
/** Today's agents (the work board's: active today, or still waiting on you) in a room, or in every room (ALL). */
export function roomAgents(agents = [], room = ALL, now = Date.now()) {
  const list = boardAgents(agents, now);
  return room === ALL ? list : list.filter((a) => projectKey(a) === room);
}

/** All rooms, then a tab per project, the one that started first first (the office's order), with its colour and head count. */
export function roomTabs(agents = [], { now = Date.now(), colors = new Map() } = {}) {
  const list = boardAgents(agents, now), rooms = [];
  for (const a of [...list].sort(byStart)) if (!rooms.includes(projectKey(a))) rooms.push(projectKey(a));
  return [{ value: ALL, label: "All rooms", count: list.length },
    ...rooms.map((p) => ({ value: p, label: p, dot: colorOf(colors, p), count: list.filter((a) => projectKey(a) === p).length }))];
}

// ---------- the standup ----------
/**
 * One agent's rows, from its to-do list (GET /api/rooms plans: done today, open items) and the live snapshot:
 * Done (the last 2 finished today, +N more), Now (the step in progress, else what it's doing), Blocked (a question
 * waiting on you, or its machine went offline), Ended, Waiting (idle, with what it said last), Team (sub-agents) and
 * Next (the first step not started).
 */
function rowsOf(a, p, { now, offlineMin }) {
  const k = stateKey(a.state), root = rootOf(a), open = p ? p.open : [], out = [];
  const done = p ? [...p.done].sort((x, y) => (ms(y.at) || 0) - (ms(x.at) || 0)) : [];
  if (done.length) out.push({ k: "done", icon: "check", label: "Done", items: done.slice(0, 2).map((x) => relText(x.text, root)), more: Math.max(0, done.length - 2) });
  const doing = open.find((x) => x.status === "in_progress");
  if (doing) out.push({ k: "now", icon: "half", label: "Now", text: relText(doing.text, root) });
  else if (k === "working") { const d = actionParts(actionOf(a, { offlineMin })); out.push({ k: "now", icon: "half", label: "Now", text: d.lead, mono: d.mono, full: d.full }); }
  if (k === "needs") {
    const act = actionOf(a, { offlineMin });
    out.push({ k: "blocked", icon: "hand", label: "Blocked", tone: "needs", text: act.text, code: act.target, what: whatOf(a.question && a.question.tool), wait: waitOf(a, now) });
  } else if (k === "offline") {
    out.push(a.ended ? { k: "ended", icon: "power", label: "Ended", text: `The session ended at ${dayClock(a.updated, now)}` }
      : { k: "offline", icon: "power", label: "Blocked", text: `${a.host || "Its machine"} went offline · last seen ${dayClock(a.updated, now)}` });
  } else if (k === "idle") {
    const stop = (a.recent || []).findLast((x) => x.kind === "stop");
    out.push(stop && stop.status === "error" ? { k: "idle", icon: "alert", label: "Waiting", tone: "error", text: `${describeStep(stop).text} at ${clock(stop.t)}` }
      : { k: "idle", icon: "coffee", label: "Waiting", text: stop ? `Finished its turn at ${clock(stop.t)}, idle until it gets a new prompt` : "Idle until it gets a new prompt",
        said: stop && stop.text ? relText(stop.text, root) : null });
  }
  const sub = a.subagents || {}, running = (sub.list || []).filter((x) => x.status === "running" && x.description).map((x) => relText(x.description, root));
  if (sub.running || sub.finished) {
    out.push({ k: "team", icon: "sub-agent", label: "Team", text: [sub.running ? `${plural(sub.running, "sub-agent")} running${running.length ? `: ${running.join(", ")}` : ""}` : null,
      sub.finished ? `${sub.finished} finished` : null].filter(Boolean).join(" · ") });
  }
  const next = open.filter((x) => x.status === "pending").sort((x, y) => x.step - y.step)[0];
  if (next) out.push({ k: "next", icon: "circle", label: "Next", text: relText(next.text, root) });
  return out;
}

/** An agent's bubble: who, its state, "5 of 8 tasks · $3.84" (today's plan, as on the work board; the session's cost), its
 *  rows, and Answer only while it waits on you. */
function agentBubble(a, p, { now, colors, offlineMin, all }) {
  const n = p ? p.done.length + p.open.length : 0;
  return {
    key: `a:${a.session}`, kind: "agent", session: a.session, name: displayName(a), project: projectKey(a), color: colorOf(colors, projectKey(a)),
    state: stateKey(a.state), waitMs: waitOf(a, now), showProject: all, blocked: stateKey(a.state) === "needs",
    facts: `${n ? `${p.done.length} of ${plural(n, "task")}` : a.hasPlan ? "No tasks today" : "No plan"} · ${costText(a)}`,
    rows: rowsOf(a, p, { now, offlineMin }),
  };
}

/** The room's numbers, counted like Today's progress: today's plan (done today, open items of agents active today),
 *  today's spend (null when no agent at the table ever reported a cost: telemetry is off for them), the time its agents
 *  waited on you today, and who is blocked now. */
function totalsOf(snap, list, room) {
  const t = snap.totals || {}, cv = costView(t, "today");
  let done = t.tasksDone || 0, total = done + (t.tasksInProgress || 0) + (t.tasksPending || 0);
  if (room !== ALL) {
    const r = (t.projects || []).find((x) => (x.project || "Other") === room);
    [done, total] = r ? [r.done, r.done + r.inProgress + r.pending] : [0, 0];
  }
  const noData = cv.noData || !list.some((a) => +a.requests > 0);
  const spent = noData ? null : room === ALL ? cv.spent : (t.todayByProject || {})[list[0].project || "unknown"] || 0;
  const count = (f) => list.filter(f).length;
  return { done, total, spent, waitedMs: list.reduce((n, a) => n + ((a.today && a.today.waitedMs) || 0), 0),
    needs: count((a) => stateKey(a.state) === "needs"), offline: count((a) => stateKey(a.state) === "offline" && !a.ended) };
}

/** "Standup for checkout-api · 3 agents. 9 of 20 planned tasks are done, $4.29 spent, and agents have waited on you 21m today." */
function opening(room, list, s) {
  const rooms = new Set(list.map(projectKey)).size;
  const who = room === ALL ? `Standup for all rooms · ${plural(list.length, "agent")} in ${plural(rooms, "room")}.` : `Standup for ${room} · ${plural(list.length, "agent")}.`;
  const parts = [s.total ? `${s.done} of ${plural(s.total, "planned task")} ${s.done === 1 ? "is" : "are"} done` : "no to-do list yet today"];
  if (s.spent != null) parts.push(`${money(s.spent)} spent`);
  parts.push(s.waitedMs > 0 ? `agents have waited on you ${span(s.waitedMs)} today` : "nobody has waited on you today");
  return { key: "host:open", kind: "host", text: `${who} ${upper(and(parts))}.` };
}

/** The host's close: the decisions waiting on you, then the files more than one agent edited today. */
function closing(decided, files) {
  const open = decided.filter((d) => d.open);
  const ask = (d) => `${d.name} ${lower(d.text)}${d.target ? ` (${endTruncate(d.target, 60)})` : ""}${d.waitMs != null ? `, waiting ${waitTime(d.waitMs)}` : ""}`;
  const asks = open.map(ask);
  const first = !open.length ? "Nothing is waiting on you."
    : open.length === 1 ? `One decision is waiting on you: ${asks[0]}.` : `${open.length} decisions are waiting on you: ${asks.slice(0, -1).join("; ")}; and ${asks.at(-1)}.`;
  const who = (f) => and(f.who.map((w) => w.name));
  const shown = files.slice(0, 3).map((f) => `${f.path} (${who(f)})`), more = files.length - shown.length;
  const second = !files.length ? "No two agents edited the same file today."
    : files.length === 1 ? `${files[0].path} was edited today by ${who(files[0])}.`
      : `${files.length} files were edited by more than one agent today: ${and(more ? [...shown, plural(more, "more file")] : shown)}.`;
  return { key: "host:close", kind: "host", text: `${first} ${second}` };
}

const rowText = (r) => (r.k === "done" ? `${r.items.join("; ")}${r.more ? ` (+${r.more} more)` : ""}`
  : `${r.text}${r.mono || ""}${r.code ? `: ${r.code}` : ""}${r.wait != null ? ` (waiting ${waitTime(r.wait)})` : ""}${r.said ? `. Said: “${r.said}”` : ""}`);

/** A bubble in words, for the screen-reader log as replay reveals it. */
export const spoken = (b) => (b.kind === "host" ? `${APP}: ${b.text}`
  : `${b.name}${b.showProject ? `, ${b.project}` : ""}, ${STATES[b.state].label}, ${b.facts}. ${b.rows.map((r) => `${r.label}: ${rowText(r)}`).join(". ")}.`);

/** What Copy summary copies: the whole standup as plain text. */
export const summaryText = (bubbles) => bubbles.map((b) => (b.kind === "host" ? b.text
  : [`${b.name}${b.showProject ? ` (${b.project})` : ""} · ${STATES[b.state].label} · ${b.facts}`, ...b.rows.map((r) => `  ${r.label}: ${rowText(r)}`)].join("\n"))).join("\n\n");

// ---------- the rail ----------
/** Decisions for you: who waits on you now, longest first (Answer opens the agent's conversation), then today's answers
 *  you gave here to agents that no longer wait ("Approved once · 15:44"). */
export function decisions(list, { now = Date.now(), colors = new Map(), offlineMin = 30 } = {}) {
  const who = (a) => ({ key: `d:${a.session}`, session: a.session, name: displayName(a), project: projectKey(a), host: a.host || null, color: colorOf(colors, projectKey(a)) });
  const open = list.filter((a) => stateKey(a.state) === "needs").sort((a, b) => (ms(a.waitingSince) || 0) - (ms(b.waitingSince) || 0) || cmp(a.session, b.session)).map((a) => {
    const act = actionOf(a, { offlineMin });
    return { ...who(a), open: true, text: act.text, target: act.target, what: whatOf(a.question && a.question.tool), waitMs: waitOf(a, now) };
  });
  const decided = list.filter((a) => stateKey(a.state) !== "needs" && a.answer && a.answer.delivered && sameDay(a.answer.t, now))
    .sort((a, b) => ms(b.answer.t) - ms(a.answer.t)).map((a) => ({ ...who(a), open: false, text: answerText(a.answer), at: clock(a.answer.t) }));
  return [...open, ...decided];
}

/** Agents of one room on one machine, offline ones aside: same folder when they share its checkout. */
export function machines(list) {
  const groups = new Map();
  for (const a of list) {
    if (stateKey(a.state) === "offline" || !a.host) continue;
    const k = `${projectKey(a)}\n${a.host}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return [...groups].filter(([, g]) => g.length > 1).map(([k, g]) => {
    const roots = new Set(g.map((a) => rootOf(a) || ""));
    return { key: `h:${k}`, host: g[0].host, project: projectKey(g[0]), names: and([...g].sort(byStart).map(displayName)), sameFolder: roots.size === 1 && !roots.has("") };
  });
}

/** Files that two or more of the room's agents edited today (GET /api/rooms), each with who and when last. */
export function fileOverlaps(rooms, list, room = ALL) {
  const byId = new Map(list.map((a) => [a.session, a]));
  return ((rooms && rooms.files) || []).filter((f) => room === ALL || f.project === room).map((f) => ({
    key: `f:${f.project}\n${f.path}`, project: f.project, path: f.path,
    who: f.by.filter((b) => byId.has(b.session)).map((b) => ({ session: b.session, name: displayName(byId.get(b.session)), at: clock(b.last) })),
  })).filter((f) => f.who.length > 1);
}

/** Tasks done, spend, waited on you and blocked now. sub = text, or parts where the one about agents waiting on you is
 *  amber (tone "needs"): blocked also counts offline machines, which aren't. */
function scoreOf(s) {
  const blocked = s.needs + s.offline;
  return [
    { key: "done", icon: "check", label: "Tasks done", value: s.total ? `${s.done}/${s.total}` : "0", sub: s.total ? `${Math.round((s.done / s.total) * 100)}% of today's plan` : "no plan today" },
    { key: "spend", icon: "chart", label: "Spend", value: s.spent == null ? "No data" : money(s.spent), sub: s.spent == null ? "Cost needs telemetry" : "today" },
    { key: "waited", icon: "clock", label: "Waited on you", value: s.waitedMs >= MIN ? waitTime(s.waitedMs) : s.waitedMs > 0 ? "<1m" : "0m", sub: "today" },
    { key: "blocked", icon: "hand", label: "Blocked now", value: String(blocked),
      sub: blocked ? [s.needs && { text: `${s.needs} waiting on you`, tone: "needs" }, s.offline && { text: `${s.offline} offline` }].filter(Boolean) : "nobody blocked" },
  ];
}

// ---------- messages to the room ----------
const nameOf = (a, id) => (a ? displayName(a) : `session ${String(id).slice(0, 6)}`);
// When a queued message reaches an agent: its Stop hook hands it over the next time its turn ends.
const WHEN = { working: "gets it when this turn ends", needs: "gets it after you answer it and its turn ends", idle: "gets it after its next turn" };

/** Where your message stands with one agent it went to: delivered, not delivered, or when it gets it, by its state now. */
export function deliveryLine(r, a) {
  const line = (tone, ic, text) => ({ session: r.session, name: nameOf(a, r.session), tone, icon: ic, text });
  if (r.status === "delivered") return line("ok", "check", `got it at ${clock(r.deliveredAt)}`);
  if (r.status === "undelivered") return line("off", "power", "didn't get it: the session ended");
  if (a && a.takesMessages === false) return line("wait", "clock", "may never get it: its last stop didn't ask for messages");
  const k = a ? stateKey(a.state) : null;
  if (k === "offline") return line("off", "power", `hasn't got it: ${a.host || "its machine"} went offline`);
  // Carrying on with messages it just got: the Stop that ends this turn hands over nothing.
  if (k === "working" && a.carryingOn) return line("wait", "clock", WHEN.idle);
  return line("wait", "clock", WHEN[k] || "gets it the next time it stops");
}

const SKIP = { offline: (a) => `couldn't get it: ${(a && a.host) || "its machine"} was offline`, ended: () => "couldn't get it: the session had ended",
  full: () => `couldn't get it: ${INBOX} messages were already waiting` };
/** An agent of the room the message couldn't go to when you sent it, and why. */
export const skippedLine = (s, a) => ({ session: s.session, name: nameOf(a, s.session), tone: "off", icon: "power", text: (SKIP[s.why] || SKIP.offline)(a) });

/** Before you send: whether each agent at the table can get a message now, and when it would. One message reaches at
 *  most ROOM_MAX agents: the first ones at the table that can take it. */
export function reach(list) {
  let n = 0;
  return list.map((a) => {
    const no = (text, capped = false) => ({ session: a.session, name: displayName(a), can: false, capped, tone: "off", icon: "power", text });
    if (a.ended) return no("can't get it: the session ended");
    if (stateKey(a.state) === "offline") return no(`can't get it: ${a.host || "its machine"} is offline`);
    if ((a.queued || 0) >= INBOX) return no(`can't get it: ${INBOX} messages are already waiting`);
    if (++n > ROOM_MAX) return no(`won't get it: one message reaches at most ${ROOM_MAX} agents`, true);
    return { ...deliveryLine({ session: a.session, status: "queued" }, a), can: true };
  });
}

/** Who a message is sent to: the agents that can take it, then the ones that can't (so the server records why), at most
 *  ROOM_MAX in all. Agents past the cap aren't sent at all. */
export const recipients = (lines) => [...lines.filter((r) => r.can), ...lines.filter((r) => !r.can && !r.capped)].slice(0, ROOM_MAX).map((r) => r.session);

/** Your messages to the room today, oldest first, with a line per agent in the table's order. */
export function messageBubbles(rooms, agents = [], room = ALL, order = []) {
  const byId = new Map(agents.map((a) => [a.session, a])), rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  return ((rooms && rooms.messages) || []).filter((m) => room === ALL || m.project === room).map((m) => {
    const skipped = m.skipped || [], to = m.to.length;
    const lines = [...m.to.map((r) => deliveryLine(r, byId.get(r.session))), ...skipped.map((s) => skippedLine(s, byId.get(s.session)))]
      .sort((x, y) => rank(x.session) - rank(y.session) || cmp(x.name, y.name));
    return { key: `m:${m.id}`, kind: "you", id: m.id, text: m.text, lines,
      meta: `You · ${clock(m.t)} · to ${room === ALL ? `${m.project}: ` : ""}${skipped.length ? `${to} of ${plural(to + skipped.length, "agent")}` : plural(to, "agent")}` };
  });
}

// ---------- the whole hall ----------
/**
 * Everything the hall shows for a room (ALL = every room). The table, decisions, machines, scorecard and who a message
 * reaches come from the live snapshot alone; the transcript, file overlaps and your messages also need GET /api/rooms
 * (null until it loads, and then they're null too). now = the time the data is drawn as of. project = what a room
 * message is sent to: null for All rooms, or agents with no project folder.
 */
export function hall(snap, rooms, { room = ALL, now = Date.now(), colors = new Map(), offlineMin = 30 } = {}) {
  const agents = (snap && snap.agents) || [], list = roomAgents(agents, room, now);
  const order = roomTabs(agents, { now }).map((t) => t.value);
  const speakers = [...list].sort((a, b) => order.indexOf(projectKey(a)) - order.indexOf(projectKey(b)) || URGENCY[stateKey(a.state)] - URGENCY[stateKey(b.state)] || byStart(a, b));
  const decided = decisions(speakers, { now, colors, offlineMin }), s = list.length ? totalsOf(snap, list, room) : null;
  const base = {
    room, empty: !list.length, project: room === ALL || !list.length ? null : list[0].project || null,
    seats: speakers.map((a) => ({ session: a.session, name: displayName(a), color: colorOf(colors, projectKey(a)), state: stateKey(a.state) })),
    decisions: decided, machines: machines(speakers), score: s && scoreOf(s), reach: reach(speakers),
  };
  if (!rooms || !list.length) return { ...base, bubbles: null, files: null, messages: null, text: "" };
  const plans = new Map((rooms.plans || []).map((p) => [p.session, p]));
  const files = fileOverlaps(rooms, speakers, room);
  const bubbles = [opening(room, list, s), ...speakers.map((a) => agentBubble(a, plans.get(a.session), { now, colors, offlineMin, all: room === ALL })), closing(decided, files)];
  return { ...base, bubbles, files, messages: messageBubbles(rooms, agents, room, speakers.map((a) => a.session)), text: summaryText(bubbles) };
}

// ---------- replay ----------
/** The replay so far: the first n bubbles of the order frozen when it started (one whose agent left meanwhile is skipped),
 *  who is up next, and who is speaking (the agent whose bubble came last). */
export function replayFrame(bubbles, order, n) {
  const byKey = new Map((bubbles || []).map((b) => [b.key, b]));
  const shown = order.slice(0, n).map((k) => byKey.get(k)).filter(Boolean), next = order.slice(n).map((k) => byKey.get(k)).find(Boolean) || null, last = shown.at(-1);
  return { shown, next: next ? (next.kind === "host" ? APP : next.name) : null, speaking: last && last.kind === "agent" ? last.session : null };
}
