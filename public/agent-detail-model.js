// The Agent Detail slide-over, pure part: header facts, mission, conversation thread, plan, the trace timeline (steps,
// sub-agent branches, waits for you and idle spells, filters) and files & usage. Input: GET /api/agents/:id and the
// agent from the live snapshot. No DOM: safe to import in Node tests.
import { stateKey } from "./ui/components.js";
import { clock, duration, waitTime, costText, money } from "./ui/format.js";
import { describeStep, describeQuestion, describeTool, permissionPhrase, relPath, answerText } from "./lib/describe.js";
import { cacheSavings } from "./lib/prices.js";
import { displayName, rootOf } from "./office3d-model.js";
import { APP } from "./shell-model.js";

const MIN = 60000;
const ms = (t) => Date.parse(t);
const firstLine = (s) => (s ? String(s).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- header ----------
/** "13:10" today, "Oct 17, 13:10" on another day. */
export function dayClock(t, now = Date.now()) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  return d.toDateString() === new Date(now).toDateString() ? clock(d) : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${clock(d)}`;
}

/** "2h 32m since 13:10" while it's around; "2h 55m · 09:10 to 12:05" once it's offline (with the day, if not today). */
export function durationText(a, now = Date.now()) {
  const start = ms(a.started);
  if (!Number.isFinite(start)) return "Unknown";
  if (stateKey(a.state) !== "offline") return `${duration(now - start)} since ${dayClock(start, now)}`;
  return `${duration(ms(a.updated) - start)} · ${dayClock(start, now)} to ${clock(a.updated)}`;
}

/** "$3.84 · 2.2× your avg" (your other sessions over the retention window); the cost alone without 3 to compare. */
export function costFact(a, avgCost) {
  const base = costText(a);
  if (!avgCost || !(+a.requests > 0)) return { text: base, title: null };
  return { text: `${base} · ${(a.cost / avgCost).toFixed(1)}× your avg`, title: `Your other sessions cost ${money(avgCost)} on average` };
}

/** "Back to office", or the screen it was opened from. */
const BACK = { office: "office", board: "work board", hall: "meeting hall", cost: "cost report", alerts: "alerts", settings: "settings" };
export const backLabel = (route) => `Back to ${BACK[route] || "office"}`;

// ---------- conversation ----------
// How a question ended when nobody answered it from here, in plain English.
const ENDED = { "next-tool": "it moved on", stop: "its turn ended", "turn-ended": "its turn ended", prompt: "you sent a new prompt",
  "session-start": "the session restarted", "session-end": "the session ended", replaced: "it asked again" };

/** The question's target in plain English: the command, or the file relative to the root. */
function questionTarget(q, root) {
  if (q.qkind === "ask") return null;
  return q.tool ? describeTool({ tool: q.tool, target: q.target, detail: q.detail }, { root }).target : q.target || null;
}

/**
 * The you ↔ agent thread in order: your prompts and messages (you), its questions and finished turns (agent), your
 * answers (you: "from Virtual Office" or "in the terminal"), and how questions ended otherwise (a note).
 * @returns {{key: string, side: "you"|"agent"|"note", meta: string, lead?: string, text?: string, code?: string, what?: string,
 *   tone?: "needs"|"error", status?: string, file?: string, icon?: string}[]}
 */
export function conversation(d, a) {
  const root = rootOf(a), name = displayName(a), out = [];
  for (const x of d.conversation || []) {
    const at = clock(x.t);
    if (x.kind === "prompt") {
      out.push(x.command ? { key: `p${x.id}`, side: "you", meta: `You · ${at}`, lead: "Ran a slash command", code: x.command, what: "command" }
        : { key: `p${x.id}`, side: "you", meta: `You · ${at}`, text: x.text, file: x.openedFile || null });
    } else if (x.kind === "question") {
      const pending = x.status === "pending", ask = x.qkind === "ask";
      out.push({ key: `q${x.id}`, side: "agent", tone: pending ? "needs" : null, icon: "hand", meta: `${x.agentId ? "Sub-agent" : name} · ${at}`,
        lead: describeQuestion(x), code: questionTarget(x, root), what: x.tool === "Bash" || x.tool === "PowerShell" ? "command" : "target",
        text: ask ? (x.detail && x.detail.question) || x.message || null : x.qkind === "notification" ? x.message || null : null });
      if (pending || x.resolvedBy === "dashboard") continue;
      const when = clock(x.answeredAt);
      if (x.resolvedBy === "tool-finished" || x.resolvedBy === "answered") {
        out.push({ key: `r${x.id}`, side: "you", meta: `You · ${when}`, text: x.qkind === "permission" ? "Approved · in the terminal" : "Answered · in the terminal" });
      } else out.push({ key: `r${x.id}`, side: "note", meta: when, text: `No longer waiting: ${ENDED[x.resolvedBy] || "it moved on"}` });
    } else if (x.kind === "answer") {
      if (x.choice === "auto") out.push({ key: `a${x.id}`, side: "note", meta: at, text: `${answerText(x)} (${permissionPhrase(x.tool)})` });
      else out.push({ key: `a${x.id}`, side: "you", meta: `You · ${at} · from ${APP}`, text: answerText(x) });
    } else if (x.kind === "stop") {
      out.push(x.status === "error"
        ? { key: `s${x.id}`, side: "agent", tone: "error", icon: "alert", meta: `${name} · ${at}`, lead: describeStep(x).text, text: x.text || null }
        : { key: `s${x.id}`, side: "agent", icon: "check", meta: `${name} · ${at}`, lead: "Finished turn", text: x.text || null });
    } else if (x.kind === "message") {
      const status = x.status === "delivered" ? `Delivered ${clock(x.deliveredAt)}` : x.status === "undelivered" ? "Not delivered: the session ended"
        : "Waiting for its next stop";
      out.push({ key: `m${x.id}`, side: "you", meta: `You · ${at} · ${x.room ? "to the room, " : ""}from ${APP}`, text: x.text, status });
    }
  }
  return out;
}

/** Under the thread: answer it (it needs you), message it, or why you can't. */
export function composerMode(a) {
  const k = stateKey(a.state);
  if (k === "needs" && a.question) return "answer";
  if (a.ended) return "ended";
  return k === "offline" ? "offline" : "message";
}

/** When a message reaches it, by its state now; or that it may not, when its last stop didn't ask for messages. */
export function deliveryHint(a) {
  if (a.takesMessages === false) return "Its last stop didn't ask for messages (AGENT_OFFICE_INBOX=0 on its machine, or an older hook), so it may never get this.";
  const k = stateKey(a.state);
  if (k === "idle") return "It's idle now, so that's after its next turn ends.";
  // The Stop that ends a turn begun by your messages hands over nothing.
  if (k === "working" && a.carryingOn) return "It's carrying on with your last message, so that's after its next turn ends.";
  if (k === "working") return "It's working now, so that's when this turn ends.";
  return "";
}

// ---------- plan ----------
/** "5 of 8 done", and a row per item: done (with when, if we saw it), in progress (since when), or pending. */
export function planView(p = {}) {
  const items = p.items || [], earlier = p.earlier || [];
  const count = (s) => items.filter((x) => x.status === s).length;
  return {
    done: count("completed"), doing: count("in_progress"), total: items.length,
    rows: items.map((x, i) => ({ key: `${x.id ?? i}:${x.content}`, status: x.status, text: x.content,
      at: x.status === "completed" ? x.completedAt || null : x.status === "in_progress" ? x.inProgressSince || null : null })),
    earlier: earlier.map((x, i) => ({ key: `e${i}`, text: x.content, at: x.completedAt || null })),
  };
}

// ---------- trace ----------
export const FILTERS = [
  { value: "all", label: "All" }, { value: "commands", label: "Commands" }, { value: "edits", label: "Edits" },
  { value: "reads", label: "Reads" }, { value: "web", label: "Web" }, { value: "subagents", label: "Sub-agents" },
];
const CAT = {
  Bash: "commands", PowerShell: "commands", BashOutput: "commands", KillShell: "commands", KillBash: "commands",
  Edit: "edits", MultiEdit: "edits", Write: "edits", NotebookEdit: "edits",
  Read: "reads", Grep: "reads", Glob: "reads", LS: "reads", WebFetch: "web", WebSearch: "web", Agent: "subagents", Task: "subagents",
};
const TERMINAL = new Set(["Bash", "PowerShell"]), EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const FILES = new Set([...EDITS, "Read"]);
const GAP = MIN; // idle and offline spells shorter than this aren't shown

const lines = (s) => (s ? String(s).split(/\r?\n/) : []);
/** A diff from an edit's hunks: unchanged lines at the start and end of each hunk are context; the rest is removed
 *  (old) then added (new). At most 400 lines. */
export function diffLines(hunks = []) {
  const out = [];
  hunks.forEach((h, i) => {
    if (i) out.push({ type: "gap", text: "" });
    const a = lines(h.old), b = lines(h.new);
    let s = 0, e = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    for (const text of a.slice(0, s)) out.push({ type: "same", text });
    for (const text of a.slice(s, a.length - e)) out.push({ type: "del", text });
    for (const text of b.slice(s, b.length - e)) out.push({ type: "add", text });
    for (const text of a.slice(a.length - e)) out.push({ type: "same", text });
  });
  return out.slice(0, 400);
}

/** "Exit code 1 · FAIL src/basket/BasketTotals.test.tsx": the first lines of an error, on one line. */
function errorLine(err) {
  const ls = String(err || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return ls.length ? (/^Exit code \d+$/.test(ls[0]) && ls[1] ? `${ls[0]} · ${ls[1]}` : ls[0]) : null;
}

/** One line under a step's title: the command's own description, lines changed, where it searched, or what failed. */
function noteOf(x, root) {
  const d = x.detail || {}, r = x.result || {};
  if (x.status === "error") return errorLine(r.error) || (r.exitCode > 0 ? `Exit code ${r.exitCode}` : "It failed");
  if (x.status === "denied") return `You said no from ${APP}`;
  if (x.status === "unknown") return "No result came back";
  if (TERMINAL.has(x.tool)) return d.description || null;
  if (EDITS.has(x.tool)) return d.added || d.removed ? `+${d.added || 0} −${d.removed || 0}` : null;
  if ((x.tool === "Grep" || x.tool === "Glob") && d.path) return `In ${relPath(d.path, root)}`;
  if (x.tool === "TodoWrite" && Array.isArray(d.todos)) return `${d.todos.filter((t) => t.status === "completed").length} of ${d.todos.length} done`;
  return null;
}

/** What expanding a step shows, or null when there's nothing more. */
function expandOf(x, root) {
  const d = x.detail || {}, r = x.result || {};
  if (x.kind === "tool") {
    if (TERMINAL.has(x.tool)) {
      // With detail capture off the target is the command's description, not the command.
      const command = d.command || (d.description ? null : x.target) || null;
      return command || r.tail || r.error || r.exitCode != null ? { kind: "command", command, tail: r.tail || null, error: r.error || null, exitCode: r.exitCode ?? null } : null;
    }
    if (EDITS.has(x.tool)) return { kind: "diff", path: relPath(d.path || x.target, root), lines: diffLines(d.hunks || []), more: d.moreHunks || 0, added: d.added || 0, removed: d.removed || 0, error: r.error || null };
    if (x.tool === "TodoWrite" && Array.isArray(d.todos)) return { kind: "plan", todos: d.todos };
    if (x.tool === "Grep" || x.tool === "Glob") return d.pattern || d.glob || r.error ? { kind: "search", pattern: d.pattern || null, glob: d.glob || null, path: d.path ? relPath(d.path, root) : null, error: r.error || null } : null;
    if (x.tool === "WebFetch" && (d.url || r.error)) return { kind: "text", label: "Web page", text: d.url || x.target, mono: true, error: r.error || null };
    if (x.tool === "WebSearch" && (d.query || r.error)) return { kind: "text", label: "Searched for", text: d.query || x.target, mono: true, error: r.error || null };
    return r.error ? { kind: "text", label: null, text: null, error: r.error } : null;
  }
  if (x.kind === "prompt" && x.text) return x.text.length > 90 || x.openedFile ? { kind: "text", label: "Your prompt", text: x.text, file: x.openedFile || null } : null;
  if ((x.kind === "stop" || x.kind === "inbox") && x.text) return { kind: "text", label: x.kind === "stop" ? "Its last message" : "Your message", text: x.text };
  return null;
}

/** A trace entry as a row. maxMs is filled in later for the duration bars. */
function stepRow(x, { root, now }) {
  const d = describeStep(x, { root }), running = x.status === "running";
  const quoted = d.target && d.text.includes(`“${d.target}”`);
  const status = x.kind === "tool" ? x.status || "ok" : x.kind === "stop" && x.status === "error" ? "error" : null;
  const file = x.kind === "tool" && FILES.has(x.tool) ? relPath((x.detail && x.detail.path) || x.target, root) : null;
  return {
    type: "step", key: `s${x.id}`, id: x.id, t: x.t, kind: x.kind, tool: x.tool || null, cat: x.kind === "tool" ? CAT[x.tool] || null : null,
    title: d.text, target: quoted ? null : d.target, icon: d.icon, sub: !!x.agentId,
    note: x.kind === "tool" ? noteOf(x, root) : x.kind === "prompt" ? (x.command ? null : x.text) : x.kind === "stop" || x.kind === "inbox" ? firstLine(x.text) : null,
    status, ms: x.kind !== "tool" ? null : running ? Math.max(0, now - ms(x.t)) : x.durationMs ?? null,
    cost: x.cost || 0, tokens: x.tokens || 0, file, expand: expandOf(x, root),
  };
}

/** "Waited 4m for you · Asked permission to run a command · npm install · You approved it once at 13:44". */
function waitRow(q, answer, { root, now }) {
  const pending = q.status === "pending", to = pending ? now : ms(q.answeredAt) || ms(q.t);
  const lead = q.qkind === "permission" ? `Asked permission to ${permissionPhrase(q.tool)}` : q.qkind === "ask" ? "Asked you a question" : "Needed your input";
  const when = clock(q.answeredAt);
  let outcome = null;
  if (pending) outcome = "Still waiting";
  else if (answer) outcome = `${answer.choice === "approve" ? "You approved it once" : answer.choice === "session" ? "You allowed it for this session"
    : answer.text ? `You said no (“${answer.text}”)` : "You denied it"} at ${clock(answer.t)} · from ${APP}`;
  else if (q.resolvedBy === "tool-finished" || q.resolvedBy === "answered") outcome = `${q.qkind === "permission" ? "Approved" : "Answered"} at ${when} in the terminal`;
  else outcome = `No longer waiting at ${when}: ${ENDED[q.resolvedBy] || "it moved on"}`;
  return {
    type: "wait", key: `w${q.id}`, t: q.t, from: ms(q.t), to, pending, sub: !!q.agentId,
    head: pending ? `Waiting for you · ${waitTime(to - ms(q.t))} so far` : `Waited ${waitTime(to - ms(q.t))} for you`,
    lead, target: q.qkind === "ask" ? (q.detail && q.detail.question) || null : questionTarget(q, root), outcome,
  };
}

/** Idle and offline spells from the state segments: "Idle 18m · 12:12 to 12:30". The last one runs on to now. */
function idleRows(segments = [], now) {
  const out = [];
  segments.forEach((g, i) => {
    const current = i === segments.length - 1, from = ms(g.from), to = current ? Math.max(ms(g.to), now) : ms(g.to);
    if ((g.state !== "idle" && g.state !== "offline") || to - from < GAP) return;
    const label = g.state === "idle" ? "Idle" : "Offline";
    const span = current ? `since ${clock(from)}` : `${clock(from)} to ${clock(to)}`;
    const why = g.state === "idle" ? "waiting for a prompt" : "no events came in";
    out.push({ type: "idle", key: `i${from}`, t: g.from, from, to, state: g.state, text: `${label} ${duration(to - from)} · ${span}`, why });
  });
  return out;
}

/**
 * The trace as rows, oldest first: steps; each sub-agent as a branch (its Agent/Task call, or its start) with its own
 * steps; a wait row per question; idle and offline rows between. Also the counts for the filters and the files.
 */
export function traceModel(d, { now = Date.now() } = {}) {
  const root = d.agent ? rootOf(d.agent) : null, trace = d.trace || [], o = { root, now };
  const byStep = new Map(), byAgent = new Map(), branches = new Map(), answers = new Map(), asked = new Set();
  for (const n of d.subagents || []) { if (n.stepId != null) byStep.set(n.stepId, n); if (n.agentId) byAgent.set(n.agentId, n); }
  for (const x of trace) {
    if (x.kind === "question") asked.add(x.id);
    if (x.kind === "answer" && x.questionId != null) answers.set(x.questionId, x);
  }
  const top = [];
  // A branch's duration is the sub-agent's life, not its launch call (a background launch returns at once).
  const branch = (n, head) => {
    const life = Math.max(0, (n.finishedAt ? ms(n.finishedAt) : now) - ms(n.startedAt || head.t));
    const b = { type: "branch", key: `b${n.id}`, t: head.t, step: { ...head, ms: Number.isFinite(life) ? life : head.ms }, children: [], status: n.status,
      finishedAt: n.finishedAt || null, lastMessage: n.lastMessage || null, label: n.description || n.type || "Sub-agent" };
    branches.set(n.id, b);
    top.push(b);
    return b;
  };
  /** Where a sub-agent's entry goes: its branch, or the top level when its branch is gone. */
  const home = (agentId) => { const n = agentId && byAgent.get(agentId); return (n && branches.get(n.id)?.children) || top; };
  for (const x of trace) {
    if (x.kind === "notice" || (x.kind === "answer" && x.choice !== "auto" && asked.has(x.questionId))) continue;
    if (x.kind === "question") { home(x.agentId).push(waitRow(x, answers.get(x.id), o)); continue; }
    if (x.kind === "subagent") {
      const n = x.agentId && byAgent.get(x.agentId);
      // A sub-agent started without an Agent/Task call we saw: its start heads the branch.
      if (x.phase === "start" && n && !branches.has(n.id) && (n.stepId == null || !trace.some((y) => y.id === n.stepId))) branch(n, stepRow(x, o));
      continue;
    }
    const row = stepRow(x, o);
    if (x.kind === "tool" && !x.agentId && byStep.has(x.id)) { branch(byStep.get(x.id), row); continue; }
    (x.kind === "tool" && x.agentId ? home(x.agentId) : top).push(row);
  }
  // Idle spells go between the rows they fall between.
  const rows = [];
  let gaps = idleRows(d.segments, now);
  for (const r of top) {
    while (gaps.length && gaps[0].from < ms(r.t)) rows.push(gaps.shift());
    rows.push(r);
  }
  rows.push(...gaps);
  const steps = rows.flatMap((r) => (r.type === "branch" ? [r.step, ...r.children] : [r])).filter((r) => r.type === "step");
  const tools = steps.filter((r) => r.kind === "tool"), heads = new Set(rows.filter((r) => r.type === "branch").map((r) => r.step));
  const counts = Object.fromEntries(FILTERS.map((f) => [f.value, f.value === "all" ? tools.length : f.value === "subagents" ? rows.filter((r) => r.type === "branch").length : tools.filter((r) => r.cat === f.value).length]));
  const files = [...new Set(tools.map((r) => r.file).filter(Boolean))].sort((x, y) => x.localeCompare(y));
  return { rows, counts, errors: steps.filter((r) => r.status === "error").length, files,
    // Bars scale to the longest step; a sub-agent's whole life (its branch) would flatten the rest, so it caps at full.
    maxMs: Math.max(0, ...tools.filter((r) => !heads.has(r)).map((r) => r.ms || 0)) };
}

/** The rows that match: a category (sub-agents = whole branches), failed only, and one file. With any filter on, only
 *  steps show (no waits, idle spells or prompts); a branch shows with the steps of it that match. */
export function filterRows(rows, { cat = "all", errors = false, file = null } = {}) {
  if (cat === "all" && !errors && !file) return rows;
  const hit = (r, c) => r.type === "step" && (c === "all" || r.cat === c) && (!errors || r.status === "error") && (!file || r.file === file);
  const out = [];
  for (const r of rows) {
    if (r.type === "branch") {
      const kids = r.children.filter((x) => hit(x, cat === "subagents" ? "all" : cat));
      if (kids.length || hit(r.step, cat)) out.push({ ...r, children: kids });
    } else if (hit(r, cat)) out.push(r);
  }
  return out;
}

/** Bar width for a duration, on a square-root scale so short steps still show. */
export const durWidth = (v, max) => (max > 0 && v > 0 ? Math.min(100, Math.max(3, Math.round(Math.sqrt(v / max) * 100))) : 0);
/** "38s", "<1s", "2m 5s"… */
export function durText(v) {
  if (v == null) return "";
  if (v < 1000) return "<1s";
  if (v < MIN) return `${Math.floor(v / 1000)}s`;
  const m = Math.floor(v / MIN), s = Math.floor((v % MIN) / 1000);
  return m < 60 && s ? `${m}m ${s}s` : duration(v);
}

// ---------- files and usage ----------
/** "3 edits · +71 −12 · last 15:41", plus who created it. */
export function fileRows(files = []) {
  return files.map((f) => ({ key: f.path, rel: f.rel || f.path, meta: `${plural(f.edits, "edit")} · +${f.added} −${f.removed}${f.last ? ` · last ${clock(f.last)}` : ""}`,
    created: f.created ? (f.createdBy ? "Created by a sub-agent" : "Created here") : null }));
}

/**
 * Cost per 10 minutes from the first reported request to now (or to its last event once offline), gaps filled with 0,
 * at most `cap` buckets. The peak, the tokens, and what the cache saved: an estimate from list prices (see prices.js).
 */
export function usageView(d, a, { now = Date.now(), cap = 288 } = {}) {
  const u = d.usage || {}, size = u.bucketMs || 10 * MIN, list = (u.buckets || []).map((b) => ({ t: ms(b.t), cost: +b.cost || 0 }));
  const cache = cacheSavings(a.tokens, a.model);
  if (!list.length) return { points: [], peak: null, size, cache, tokens: a.tokens || {} };
  const byT = new Map(list.map((b) => [b.t, b.cost])), until = stateKey(a.state) !== "offline" ? now : ms(a.updated);
  const end = Math.max(list.at(-1).t, Math.floor(until / size) * size);
  const start = Math.max(list[0].t, end - (cap - 1) * size), points = [];
  for (let t = start; t <= end; t += size) points.push({ t, cost: byT.get(t) || 0 });
  const peak = points.reduce((p, x) => (x.cost > p.cost ? x : p), points[0]);
  return { points, peak: peak.cost > 0 ? peak : null, size, until: Math.max(until, list.at(-1).t), cache, tokens: a.tokens || {} };
}
