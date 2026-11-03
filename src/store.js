"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { cleanPrompt, agentLabel, relPath, permissionPhrase, baseName, DENIED } = require("../hooks/text");
const plans = require("./plan");
const tl = require("./timeline");

const HISTORY = 20, RECENT = 5;
// Per-session caps keep memory bounded. Diffs and output tails are kept on the newest HEAVY steps only.
const TRACE = 1000, HEAVY = 200, CONVO = 200, LOG = 1000, SUBAGENTS = 100, FILES = 300, RUNNING = 200, RUNS = 20;
const DETAIL_DAYS = 2; // diffs and output tails are dropped after this; names, paths, counts, plans and costs stay until retention
const WAIT_CAP = 8 * 3600000; // an agent waiting on you stays "Needs you" this long without events, then goes offline
const MAX_TEXT = 4096, MAX_PART = 32768;
const DAY_FILE = /^events-(\d{4}-\d{2}-\d{2})(\.jsonl|\.lite\.jsonl|\.lite\.jsonl\.tmp)$/;
const DAY = 86400000;
const STATE_ORDER = { waiting: 0, working: 1, idle: 2, offline: 3 };
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
// Notification types that mean "an agent waits for a human". idle_prompt only means the turn finished.
const NEEDS = new Set(["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input", "legacy"]);
// Asks (see applyHeld): how many are kept, how long a finished one is remembered, the longest hold, how close to the end of
// the window an answer is still taken (it must reach the hook before it gives up), and the longest reply.
const ASKS = 500, ASK_KEEP = 10 * 60000, HOLD_MAX = 600, LATE = 2000, REPLY_MAX = 1000;
const CHOICES = new Set(["approve", "session", "deny", "reply"]);
// Messages from the dashboard (see queueMessage): how many may wait per session and how long one may be. Names you set
// for a session. Cost per session in 10-minute buckets, for its sparkline: the newest SPEND buckets are kept.
const INBOX = 10, MESSAGE_MAX = 1000, NAME_MAX = 60, SPEND = 300, SPEND_MS = 10 * 60000;
// Messages to a room (see messageRoom): the most agents one reaches, its id, why an agent was skipped, and how many
// room messages and shared files the meeting hall gets.
const ROOM_MAX = 50, ROOM_ID = /^[\w-]{8,40}$/, SKIPPED = new Set(["offline", "ended", "full"]), ROOM_MESSAGES = 50, OVERLAPS = 100;
// The cost report (see cost()): API requests kept for its CSV export (the last REQUEST_DAYS days, at most REQUESTS), the
// costliest sessions it lists per period, and how many models a day or a session tallies apart (the rest are "other").
const REQUESTS = 100000, REQUEST_DAYS = 7, COST_SESSIONS = 50, MODELS = 50;
// Machines (see machines()): how many hosts' send health is kept, the days a machine stays listed after its last session,
// and the failed sends one report carries (the hook's own cap). Projects listed in Settings (see projects()).
const HOSTS = 500, MACHINE_DAYS = 7, FAILS = 20, HOUR = 3600000, PROJECT_LIST = 200;
// Events only the dashboard (or the store itself) makes. Hooks and the spool can't send them (see the server).
const INTERNAL = new Set(["answer", "message", "delivered", "name", "release"]);
// Of those, the ones that say nothing about the agent: they don't count as contact, so an offline agent stays offline.
const QUIET = new Set(["message", "name", "release"]);

function localDate(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}
/** Local midnight of a "YYYY-MM-DD" day, plus whole days. */
function dayStart(date, plus = 0) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d + plus).getTime();
}
const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && localDate(dayStart(s)) === s;
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }
const ms = (t) => Date.parse(t);
const iso = (n) => new Date(n).toISOString();
const isoSeg = (g) => ({ ...g, from: iso(g.from), to: iso(g.to) });
const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
/** The project's key: its git root's folder name. What it's called on screen is projectName(). */
const projectOf = (s) => baseName(s.gitRoot || s.cwd0 || s.folder || "") || null;

/** A hook's report on its machine's sends (see healthOf in hooks/hook.js), checked and bounded, or null. */
function cleanHealth(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  const fails = (Array.isArray(h.fails) ? h.fails : []).filter((t) => typeof t === "string" && Number.isFinite(Date.parse(t))).slice(-FAILS).map((t) => iso(Date.parse(t)));
  const n = Number(h.backlog), backlog = Number.isInteger(n) && n > 0 ? Math.min(n, 1e9) : 0;
  // Events its spool dropped for lack of room, counted only with the time of the newest drop (so they can age out).
  const d = Number(h.dropped), at = typeof h.droppedAt === "string" ? Date.parse(h.droppedAt) : NaN;
  const dropped = Number.isInteger(d) && d > 0 && Number.isFinite(at) ? Math.min(d, 1e9) : 0;
  return fails.length || backlog || h.more === true || dropped ? { fails, backlog, more: h.more === true, dropped, droppedAt: dropped ? iso(at) : null } : null;
}

/** Adds spend (cost, requests, tokens by type) to map's tally for key. A map holding `cap` keys tallies new ones as "other". */
function tally(map, key, cost, tokens, requests = 1, cap = Infinity) {
  const k = map.has(key) || map.size < cap ? key : "other";
  let u = map.get(k);
  if (!u) map.set(k, (u = { cost: 0, requests: 0, tokens: zeroTokens() }));
  u.cost += cost; u.requests += requests;
  for (const x of Object.keys(u.tokens)) u.tokens[x] += tokens[x];
}
const byCost = (a, b) => b.cost - a.cost;

/** Notification type for old events that only carried a message. */
function legacyType(message) {
  const m = String(message || "");
  if (/permission/i.test(m)) return "permission_prompt";
  if (/waiting for your input/i.test(m)) return "idle_prompt";
  return "legacy";
}

/** Plain text for a question, used for the `message` field and alerts. The UI uses public/lib/describe.js. */
function questionText(q) {
  if (q.qkind === "permission") return `Wants permission to ${permissionPhrase(q.tool)}`;
  if (q.qkind === "ask") return "Asked you a question";
  return q.message || "Needs your input";
}

/** Detail without diffs and plan lists. */
function lite(d) {
  if (!d) return null;
  const { hunks, moreHunks, todos, ...rest } = d;
  return rest;
}
/** Drops the heavy parts (diffs, plan lists, output) of an older step. */
function strip(x) {
  if (x.detail && (x.detail.hunks || x.detail.todos)) x.detail = lite(x.detail);
  if (x.result) { delete x.result.tail; delete x.result.error; }
}
/** A saved event without diffs and output tails. Plan lists stay, so the plan still replays. */
function stripEvent(e) {
  const out = { ...e };
  if (out.detail && out.detail.hunks) { const { hunks, moreHunks, ...rest } = out.detail; out.detail = rest; }
  if (out.result) { const { tail, error, ...rest } = out.result; out.result = rest; }
  return out;
}
/** A small copy of a trace entry for the live snapshot. An open ask is offered on the agent's question, not here. */
function leanStep(x) {
  const { detail, result, text, stepId, askId, sig, holdUntil, ...rest } = x;
  if (detail) rest.detail = lite(detail);
  if (result && (result.writeType || result.exitCode != null)) rest.result = { writeType: result.writeType, exitCode: result.exitCode };
  if (text) rest.text = text.length > 200 ? text.slice(0, 199) + "…" : text;
  return rest;
}
/** Sub-agent counts plus the first three (running ones first) for the office's interns: id, short description, status. */
function leanSubagents(list) {
  const running = list.filter((x) => x.status === "running"), finished = list.filter((x) => x.status === "finished");
  const short = (t) => (t && t.length > 60 ? t.slice(0, 59) + "…" : t || null);
  return {
    running: running.length, finished: finished.length,
    list: [...running, ...finished.reverse()].slice(0, 3).map((x) => ({ id: x.id, description: short(x.description || x.type), status: x.status })),
  };
}
function leanQuestion(q) {
  const { id, t, qkind, tool, target, detail, message, notificationType, agentId } = q;
  return { id, t, qkind, tool, target, detail, message, notificationType, agentId };
}
/** The latest answer from the dashboard, logged when its hook picked it up (delivered); until = when that hook would have
 *  stopped waiting. */
function leanAnswer(x) {
  const { id, t, choice, text, tool, questionId, delivered = null, until = null } = x;
  return { id, t, choice, text, tool, questionId, delivered, until };
}
const removeFrom = (list, x) => { const i = list.indexOf(x); if (i >= 0) list.splice(i, 1); };
/** Sets key last in the map, dropping the oldest past max. */
function keepLast(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}
/** What a call or a question is about, as the UI shows it: a command as typed, a file relative to the project, else its
 *  target (a pattern, a URL). Cut to 300 characters. */
function shownTarget(x, root) {
  const d = x.detail || {}, shell = x.tool === "Bash" || x.tool === "PowerShell";
  const t = shell ? d.command || x.target : d.path || EDIT_TOOLS.has(x.tool) || x.tool === "Read" ? relPath(d.path || x.target, root) : x.target;
  return t ? String(t).slice(0, 300) : null;
}
/** What a call asks to do, whole: its tool, target and detail (the full command or URL, the file and the change), hashed.
 *  A PermissionRequest and its PreToolUse are built from the same input, so they match exactly. */
const callSig = (x) => crypto.createHash("sha256").update(JSON.stringify([x.tool || null, x.target || null, x.detail || null])).digest("base64url");
const FULL = ["command", "url", "path", "pattern", "query", "hunks"];
/** Same tool and target, and nothing in their details says otherwise (older or synthetic events may carry less). */
const agrees = (x, e) => x.tool === e.tool && (x.target || null) === (e.target || null) && FULL.every((k) => !x.detail || !e.detail ||
  x.detail[k] === undefined || e.detail[k] === undefined || JSON.stringify(x.detail[k]) === JSON.stringify(e.detail[k]));
const holdOf = (e) => (Number(e.hold) > 0 ? Math.min(HOLD_MAX, Math.floor(Number(e.hold))) : 0);
/** An ask: "open" (answerable here), "sending" (answered, the hook hasn't picked it up yet), "done" (delivered) or "closed". */
function askState(a, now) {
  if (!a || a.closed) return "closed";
  if (a.delivered) return "done";
  if (now >= a.until) return "closed";
  return a.decision ? "sending" : "open";
}

class Store extends EventEmitter {
  /** @param {{getConfig: () => object, dataDir?: string|null, log?: Console}} opts  dataDir null = no persistence */
  constructor({ getConfig, dataDir = null, log = console }) {
    super();
    this.getConfig = getConfig;
    this.dataDir = dataDir;
    this.log = log;
    this.sessions = new Map();
    this.daily = new Map();
    // askId → { id, session, tool, until, questionId, decision, choice, text, closed, delivered }. In memory only: a
    // restart forgets them, and the hooks waiting on them get a 404 and leave the question to the terminal.
    this.asks = new Map();
    this.raised = null; // set by permission() while a PermissionRequest is applied (see applyHeld)
    // API requests for the cost report's CSV export; requestsCut = the newest time of any dropped to stay under REQUESTS.
    this.requests = [];
    this.requestsCut = 0;
    // host → its sends as its newest hook event reported them: { t, fails, backlog, more } (see noteHealth).
    this.hostHealth = new Map();
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  }

  timeoutMs() { return (this.getConfig().offlineAfterMin || 30) * 60000; }

  /** State segments of a session between two times (ms), offline computed. */
  segments(s, from, to) { return tl.segments(s.log, { from, to, timeoutMs: this.timeoutMs(), waitCapMs: WAIT_CAP }); }

  session(id, t) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        session: id, name: null, folder: null, host: null, user: null, os: null,
        state: "idle", ended: false, task: null, tool: null, target: null, message: null,
        toolCount: 0, requests: 0, cost: 0, model: null,
        tokens: zeroTokens(), started: t, updated: t, history: [],
        // cwd0 = where the session started; base = the state before open questions are counted
        cwd0: null, gitRoot: null, label: null, mission: null, base: "idle", turnOpen: false, taskAt: null,
        // the first real prompt's time, opened file and id; prompts = how many real prompts it had
        missionAt: null, missionFile: null, missionId: null, prompts: 0,
        seq: 0, trace: [], running: [], conversation: [], pending: [],
        plan: plans.empty(), subagents: [], files: new Map(), log: [],
        // allow = tools the dashboard allowed for this session; lastAnswer = its latest answer from the dashboard
        allow: new Set(), lastAnswer: null,
        // inbox = your messages waiting for its next Stop; alias = the name you gave it here; spend = cost per 10 minutes;
        // modelCost = cost per model, for its main model
        inbox: [], alias: null, spend: new Map(), modelCost: new Map(),
        // takesMessages = its latest Stop (not one Claude was already carrying on from) asked for messages: true, false
        // (AGENT_OFFICE_INBOX=0 on its machine, or an older hook), or null before any Stop. carryingOn = this turn began
        // with your messages, so the Stop that ends it hands over nothing (stop_hook_active): the next message waits a turn.
        takesMessages: null, carryingOn: false,
        // For the alert rule on failed calls, per agent ("" = the main one, else a sub-agent's id): fails = its tool
        // results that failed in a row (n, since the first, last = the newest step); recovered = its latest such run
        // that a call that worked ended (since, endedAt = that call's result).
        fails: new Map(), recovered: new Map(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** A day's spend: totals, tokens by type, cost per project, and spend (cost, requests, tokens) per model and session. */
  day(t) {
    const key = localDate(t);
    let d = this.daily.get(key);
    if (!d) { d = { date: key, cost: 0, tokens: 0, requests: 0, byProject: {}, tokensByType: zeroTokens(), models: new Map(), sessions: new Map() }; this.daily.set(key, d); }
    return d;
  }

  /** Validates an incoming event. Returns a clean copy or null. Oversized fields are cut or dropped. */
  static clean(e) {
    if (!e || typeof e !== "object" || typeof e.session !== "string" || !e.session) return null;
    const t = Date.parse(e.t);
    const out = { ...e, session: e.session.slice(0, 100), t: iso(Number.isFinite(t) ? t : Date.now()) };
    if (e.type === "usage") return out;
    const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
    const base = { type: e.type, t: out.t, session: out.session };
    if (e.type === "answer") {
      if (!CHOICES.has(e.choice)) return null;
      return { ...base, choice: e.choice, text: str(e.text, REPLY_MAX), tool: str(e.tool, 100),
        questionId: Number.isInteger(e.questionId) ? e.questionId : null };
    }
    if (e.type === "message") {
      const text = str(e.text, MESSAGE_MAX);
      if (!text) return null;
      if (typeof e.room !== "string" || !ROOM_ID.test(e.room)) return { ...base, text };
      const skipped = (Array.isArray(e.skipped) ? e.skipped : []).filter((x) => x && typeof x.session === "string" && x.session && SKIPPED.has(x.why))
        .slice(0, ROOM_MAX).map((x) => ({ session: x.session.slice(0, 100), why: x.why }));
      return skipped.length ? { ...base, text, room: e.room, skipped } : { ...base, text, room: e.room };
    }
    if (e.type === "delivered") {
      const ids = (Array.isArray(e.ids) ? e.ids : []).filter(Number.isInteger).slice(0, INBOX);
      return ids.length ? { ...base, ids } : null;
    }
    if (e.type === "name") return { ...base, name: str(e.name, NAME_MAX) };
    if (e.type === "release") return Number.isInteger(e.questionId) ? { ...base, questionId: e.questionId } : null;
    if (e.type !== "hook" || typeof e.ev !== "string" || e.ev.length > 40) return null;
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (typeof v === "string" && v.length > MAX_TEXT) out[k] = v.slice(0, MAX_TEXT);
      else if ((k === "detail" || k === "result") && (!v || typeof v !== "object" || Array.isArray(v) || JSON.stringify(v).length > MAX_PART)) delete out[k];
    }
    if ("health" in out) { const h = cleanHealth(out.health); if (h) out.health = h; else delete out.health; }
    if ("os" in out) { const o = str(out.os, 20); if (o) out.os = o; else delete out.os; }
    return out;
  }

  apply(raw, { persist = true, live = true } = {}) {
    const e = Store.clean(raw);
    if (!e) return false;
    if (QUIET.has(e.type)) return this.note(e, { persist, live });
    if (persist) this.persist(e);
    const s = this.session(e.session, e.t);
    const before = s.state;
    if (e.t > s.updated) s.updated = e.t;
    if (e.t < s.started) s.started = e.t;
    if (e.type === "hook") this.hook(s, e);
    else if (e.type === "answer") this.reply(s, e);
    else if (e.type === "delivered") this.delivered(s, e);
    else this.usage(s, e);
    tl.record(s.log, e.t, s.ended ? "ended" : s.state, this.timeoutMs(), LOG);

    if (live && before !== s.state) this.emit("transition", { agent: this.viewOne(s), from: before, to: s.state });
    if (live) this.emit("change");
    return true;
  }

  /** A message queued, a name set or a hold released: about a session that exists, and never counted as contact. */
  note(e, { persist, live }) {
    const s = this.sessions.get(e.session);
    if (!s) return false;
    if (persist) this.persist(e);
    if (e.type === "message") this.enqueue(s, e);
    else if (e.type === "name") s.alias = e.name;
    else this.release(s, e);
    if (live) this.emit("change");
    return true;
  }

  // ---------- hook events ----------
  hook(s, e) {
    if (e.cwd) { s.folder = e.cwd; if (!s.cwd0) s.cwd0 = e.cwd; }
    if (e.gitRoot && !s.gitRoot) s.gitRoot = e.gitRoot;
    if (e.name) s.name = e.name;
    if (e.host) { s.host = e.host; this.noteHealth(e); }
    if (e.user) s.user = e.user;
    if (e.os) s.os = e.os;
    const ctx = e.agentId || null;
    switch (e.ev) {
      case "SessionStart":
        s.ended = false;
        // A fresh start, resume or /clear: nothing from before is still waiting or running, sub-agents included.
        if (e.source !== "compact") {
          this.endTurn(s, e.t, () => true, "session-start");
          this.closeRunning(s, () => true, e.t);
          for (const n of s.subagents) if (n.status === "running") Object.assign(n, { status: "finished", finishedAt: e.t });
          s.allow.clear(); // "Allow for this session" lasts one run of claude, like Claude Code's own
        }
        if (e.model) s.model = e.model;
        this.push(s, { kind: "session", t: e.t, phase: "start", source: e.source || null });
        break;
      case "UserPromptSubmit": this.prompt(s, e); break;
      case "PreToolUse": this.preTool(s, e, ctx); break;
      case "PermissionRequest": this.permission(s, e, ctx); break;
      case "PostToolUse": case "PostToolUseFailure": this.postTool(s, e, ctx); break;
      case "Notification": this.notification(s, e); break;
      case "Stop": case "StopFailure": this.stop(s, e); break;
      case "SubagentStart": this.subagentStart(s, e); break;
      case "SubagentStop": this.subagentStop(s, e); break;
      case "SessionEnd":
        s.base = "idle"; s.ended = true; s.turnOpen = false;
        this.answer(s, () => true, e.t, "session-end");
        this.closeRunning(s, () => true, e.t);
        s.allow.clear();
        for (const m of s.inbox.splice(0)) m.status = "undelivered"; // no Stop will come to hand them over
        this.push(s, { kind: "session", t: e.t, phase: "end", reason: e.reason || null });
        break;
      default: break;
    }
    this.settle(s);
    s.history.unshift({ t: e.t, ev: e.ev, tool: e.tool || null, target: e.target || null, msg: e.prompt || e.message || null });
    if (s.history.length > HISTORY) s.history.length = HISTORY;
  }

  /** The machine's sends as this event reports them: no report means none failed and nothing waits. An older event (a
   *  spooled one arriving late) says nothing new. */
  noteHealth(e) {
    const h = this.hostHealth.get(e.host);
    if (h && h.t > e.t) return;
    keepLast(this.hostHealth, e.host, { t: e.t, ...(e.health || { fails: [], backlog: 0, more: false, dropped: 0, droppedAt: null }) }, HOSTS);
  }

  /** Waiting while any question is open, else the base state. */
  settle(s) {
    s.state = s.pending.length ? "waiting" : s.base;
    s.message = s.pending.length ? questionText(s.pending[0]) : null;
  }

  /** Adds a trace entry, trimming old ones and their heavy parts. */
  push(s, x) {
    x.id = ++s.seq;
    s.trace.push(x);
    const n = s.trace.length;
    if (n > HEAVY) strip(s.trace[n - HEAVY - 1]);
    if (n > TRACE + 50) for (const old of s.trace.splice(0, n - TRACE)) removeFrom(s.running, old);
    return x;
  }

  say(s, x) {
    s.conversation.push(x);
    if (s.conversation.length > CONVO + 20) s.conversation.splice(0, s.conversation.length - CONVO);
  }

  prompt(s, e) {
    const c = cleanPrompt(e.prompt); // events from older hooks were not cleaned
    const command = e.command || c.command || null;
    s.ended = false; s.base = "working"; s.turnOpen = true; s.tool = null; s.target = null; s.carryingOn = false;
    this.answer(s, () => true, e.t, "prompt");
    // With detail capture off the hook sends only the label, not the prompt text.
    const label = command ? null : c.text ? agentLabel(c.text) : e.label ? String(e.label).slice(0, 60) : null;
    if (!c.text && !command && !label) return;
    if (c.text) { s.task = c.text; s.taskAt = e.t; }
    if (!s.label) s.label = label;
    const x = { kind: "prompt", t: e.t, text: c.text || null, openedFile: e.openedFile || c.openedFile || null, command };
    this.push(s, x); this.say(s, x);
    if (command || !c.text) return;
    s.prompts++;
    if (!s.mission) Object.assign(s, { mission: c.text, missionAt: e.t, missionFile: x.openedFile, missionId: x.id });
  }

  preTool(s, e, ctx) {
    s.base = "working"; s.tool = e.tool || null; s.target = e.target || null; s.toolCount++;
    // A question whose hook still waits is still open in Claude Code, whatever runs beside it.
    this.answer(s, (q) => q.agentId === ctx && !this.held(q, ms(e.t)), e.t, "next-tool");
    const step = this.push(s, {
      kind: "tool", t: e.t, tool: e.tool || null, target: e.target || null, detail: e.detail || null,
      toolUseId: e.toolUseId || null, agentId: ctx, agentType: e.agentType || null, status: "running", end: null, durationMs: null,
    });
    s.running.push(step);
    if (s.running.length > RUNNING) s.running.shift();
    const d = e.detail || {};
    if (SUBAGENT_TOOLS.has(step.tool)) this.addSubagent(s, { id: step.toolUseId || `step-${step.id}`, type: d.subagentType, description: d.description, background: d.background, startedAt: e.t, parentAgentId: ctx, stepId: step.id });
    if (!ctx && step.tool === "TodoWrite" && Array.isArray(d.todos)) plans.todos(s.plan, d.todos, e.t);
    if (!ctx && step.tool === "TaskUpdate" && d.taskId != null) plans.update(s.plan, d, e.t);
    if (step.tool === "AskUserQuestion") this.ask(s, step, { qkind: "ask", message: d.question || null }, e.t, ctx);
  }

  newestRunning(s, pred) {
    for (let i = s.running.length - 1; i >= 0; i--) if (pred(s.running[i])) return s.running[i];
    return null;
  }

  ask(s, step, f, t, agentId) {
    // What it shows: the request's own fields, else its call's.
    const tool = f.tool || (step && step.tool) || null, target = f.target || (step && step.target) || null, detail = f.detail || (step && step.detail) || null;
    const q = {
      kind: "question", t, qkind: f.qkind, tool, target, detail: lite(detail), message: f.message || null, notificationType: f.notificationType || null,
      agentId: agentId || null, stepId: step ? step.id : null, status: "pending",
      // sig = the whole request it shows (see callSig), so a PermissionRequest gets an ask on it only when it asks exactly
      // that: one with less in it (an empty input) that borrowed its call's command doesn't.
      sig: step || f.tool ? callSig({ tool, target, detail }) : null,
    };
    this.push(s, q); this.say(s, q);
    s.pending.push(q);
    return q;
  }

  /** Marks matching open questions answered. outcome "approved" = the tool ran after the ask. */
  answer(s, pred, t, by, outcome = null) {
    s.pending = s.pending.filter((q) => {
      if (!pred(q)) return true;
      Object.assign(q, { status: "answered", answeredAt: t, resolvedBy: by });
      if (outcome) q.outcome = outcome;
      // Answered some other way, so its hook stops waiting. (A dashboard answer is already decided: no-op.)
      if (q.askId) this.closeAsk(q.askId, by);
      return false;
    });
  }

  /** Links a PermissionRequest to its call and question. Reports in this.raised the question that shows exactly this
   *  request (the one it raised, or an identical one it joined), or q null when it joined another request's question. */
  permission(s, e, ctx) {
    const wait = holdOf(e);
    // Allowed for this session from the dashboard: approved at once, with no question, when the hook waits for the answer.
    if (wait && s.allow.has(e.tool)) {
      const x = { kind: "answer", t: e.t, choice: "auto", tool: e.tool, target: e.target || null, agentId: ctx };
      this.push(s, x); this.say(s, x);
      this.raised = { s, q: null, auto: true };
      return;
    }
    // PermissionRequest has no tool_use_id: it belongs to the newest running call asking exactly the same thing, else one
    // that agrees with it, not asking already (two identical calls side by side get a question each), then the same
    // with one that is asking (a second request for the same call), else the newest call of that tool not asking
    // (its PreToolUse may come late). Same agent first each time.
    const sig = callSig(e), free = (x) => x.tool === e.tool && !s.pending.some((q) => q.stepId === x.id);
    const exact = (x) => callSig(x) === sig, close = (x) => agrees(x, e);
    const step = [(x) => exact(x) && free(x), (x) => close(x) && free(x), exact, close, free]
      .reduce((found, match) => found || this.newestRunning(s, (x) => match(x) && x.agentId === ctx) || this.newestRunning(s, match), null);
    const joined = step && s.pending.find((q) => q.stepId === step.id);
    const q = joined || this.ask(s, step, { qkind: "permission", tool: e.tool, target: e.target, detail: e.detail }, e.t, ctx);
    const same = q.qkind === "permission" && q.sig === sig;
    // Saved with the event, so a replay knows the hook was waiting (see held()).
    if (wait && same) q.holdUntil = Math.max(q.holdUntil || 0, ms(e.t) + wait * 1000);
    this.raised = { s, q: same ? q : null, auto: false };
  }

  notification(s, e) {
    const type = e.notificationType || legacyType(e.message);
    if (type === "permission_prompt") return this.permissionPrompt(s, e);
    if (NEEDS.has(type)) {
      const q = s.pending.find((x) => x.qkind === "notification");
      if (q) { q.message = e.message || q.message; return; }
      this.ask(s, null, { qkind: "notification", notificationType: type === "legacy" ? null : type, message: e.message }, e.t, e.agentId);
      return;
    }
    if (type === "elicitation_complete" || type === "elicitation_response") this.answer(s, (q) => q.qkind === "notification", e.t, "answered");
    // Claude has been quiet for a minute with nothing running. Stop doesn't fire on an interrupt, and a denied
    // permission fires no Post event, so this is the only sign that the main agent's turn is over. Not while a hook
    // still waits on one of its questions: Claude Code is waiting for that hook.
    if (type === "idle_prompt" && !e.agentId && !s.pending.some((q) => this.held(q, ms(e.t)))) this.endTurn(s, e.t, (q) => !q.agentId, "turn-ended");
    this.push(s, { kind: "notice", t: e.t, notificationType: type, message: e.message || null });
  }

  /** Claude Code's ~6s reminder for a permission dialog. It joins the PermissionRequest question instead of adding one. */
  permissionPrompt(s, e) {
    const open = [...s.pending].reverse().find((q) => q.qkind === "permission");
    if (open) { open.message = open.message || e.message || null; return; }
    // A parallel tool call can clear a question while its dialog is still up: reopen it.
    const stillUp = s.conversation.slice(-20).reverse().find((q) => q.kind === "question" && q.qkind === "permission" &&
      q.resolvedBy === "next-tool" && s.running.some((x) => x.id === q.stepId));
    if (stillUp) {
      Object.assign(stillUp, { status: "pending", message: e.message || stillUp.message });
      delete stillUp.answeredAt; delete stillUp.resolvedBy;
      s.pending.push(stillUp);
      s.pending.sort((a, b) => ms(a.t) - ms(b.t));
      return;
    }
    // Older Claude Code: no PermissionRequest, only "Claude needs your permission to use Bash".
    const named = (/permission to use (\S+)/i.exec(e.message || "") || [])[1];
    const step = (named && this.newestRunning(s, (x) => x.tool === named)) || this.newestRunning(s, () => true);
    // The call may already have a question of its own (AskUserQuestion): join it.
    const linked = step && s.pending.find((q) => q.stepId === step.id);
    if (linked) { linked.message = linked.message || e.message || null; return; }
    this.ask(s, step, { qkind: "permission", tool: named, message: e.message }, e.t, step ? step.agentId : null);
  }

  postTool(s, e, ctx) {
    s.base = "working";
    const r = e.result || null;
    // Pair by tool_use_id; older events fall back to the oldest open call of the same tool.
    let step = e.toolUseId && s.running.find((x) => x.toolUseId === e.toolUseId);
    if (!step) step = s.running.find((x) => !x.toolUseId && x.tool === (e.tool || null) && x.agentId === ctx);
    // Denied from the dashboard, but the answer never reached the hook and it was allowed in the terminal after all.
    if (!step && e.toolUseId) step = s.trace.findLast((x) => x.status === "denied" && x.toolUseId === e.toolUseId);
    if (!step) {
      if (!e.tool) return;
      step = this.push(s, { kind: "tool", t: iso(ms(e.t) - (e.durationMs || 0)), tool: e.tool, target: e.target || null, detail: null,
        toolUseId: e.toolUseId || null, agentId: ctx, agentType: e.agentType || null });
    }
    removeFrom(s.running, step);
    step.end = e.t;
    step.durationMs = e.durationMs != null ? e.durationMs : Math.max(0, ms(e.t) - ms(step.t));
    step.status = r && r.ok === false ? "error" : "ok";
    if (!(r && r.interrupted)) this.failRun(s, step, ctx, e.t);
    if (r) { const { ok, ...rest } = r; if (Object.keys(rest).length) step.result = rest; }
    if (s.seq - step.id >= HEAVY) strip(step); // a late result on a step that is already outside the heavy window
    // Any Post event means the tool ran, so a permission asked for it was granted.
    this.answer(s, (q) => q.stepId === step.id, e.t, "tool-finished", "approved");
    if (step.status === "ok" && EDIT_TOOLS.has(step.tool)) this.touchFile(s, step, r);
    if (!ctx && step.status === "ok" && step.tool === "TaskCreate") plans.create(s.plan, step.detail || {}, r && r.taskId, e.t);
    if (SUBAGENT_TOOLS.has(step.tool)) {
      // Without SubagentStart/Stop (older Claude Code) a foreground call is the sub-agent's lifetime.
      // A background launch returns at once; its SubagentStop ends it.
      const n = s.subagents.find((x) => x.stepId === step.id);
      if (n && !n.agentId && !n.background && n.status === "running") Object.assign(n, { status: "finished", finishedAt: e.t });
    }
  }

  /** A tool result in its agent's run of failures: one more, or the call that worked and ended it (then kept with when).
   *  A call you interrupted counts neither way (see postTool). */
  failRun(s, step, ctx, t) {
    const k = ctx || "", run = s.fails.get(k);
    if (step.status === "error") keepLast(s.fails, k, { n: run ? run.n + 1 : 1, since: run ? run.since : t, last: step }, RUNS);
    else if (run) { s.fails.delete(k); keepLast(s.recovered, k, { since: run.since, endedAt: t }, RUNS); }
  }

  touchFile(s, step, r) {
    const p = (step.detail && step.detail.path) || step.target;
    if (!p) return;
    const f = s.files.get(p) || { path: p, edits: 0, added: 0, removed: 0, last: null, created: false, createdBy: null };
    s.files.delete(p);
    f.edits++; f.added += num(step.detail && step.detail.added); f.removed += num(step.detail && step.detail.removed); f.last = step.end;
    if (step.tool === "Write" && (r && r.writeType ? r.writeType === "create" : f.edits === 1)) { f.created = true; f.createdBy = step.agentId; }
    s.files.set(p, f);
    if (s.files.size > FILES) s.files.delete(s.files.keys().next().value);
  }

  /** Steps that never got a result when their turn ended. */
  closeRunning(s, pred, t) {
    for (const x of s.running.filter(pred)) {
      removeFrom(s.running, x);
      Object.assign(x, { status: "unknown", end: t, durationMs: Math.max(0, ms(t) - ms(x.t)) });
    }
  }

  /** The main agent's turn is over: its open questions are answered and its unfinished steps closed. */
  endTurn(s, t, questions, by) {
    s.base = "idle"; s.turnOpen = false; s.carryingOn = false;
    this.answer(s, questions, t, by);
    this.closeRunning(s, (x) => !x.agentId, t);
  }

  /** Stop, or StopFailure (the turn ended on an API error such as a rate limit: a red error step). */
  stop(s, e) {
    this.endTurn(s, e.t, () => true, "stop");
    if (e.ev === "Stop" && !e.stopActive) s.takesMessages = e.inbox === true;
    const x = e.ev === "StopFailure"
      ? { kind: "stop", t: e.t, status: "error", failure: e.failure || null, text: e.message || null }
      : { kind: "stop", t: e.t, text: e.lastMessage || null };
    this.push(s, x); this.say(s, x);
  }

  /** An answer from the dashboard, logged once its hook picked it up (see pollAsk): closes its question, by id only, and
   *  logs it. If something else closed that question first (a replay can see a parallel call before the answer), the
   *  answer wins. A denied call never runs, so its step closes here; "session" allows the tool for the rest of the session. */
  reply(s, e) {
    const q = e.questionId == null ? null : s.pending.find((x) => x.id === e.questionId) ||
      s.conversation.findLast((x) => x.kind === "question" && x.id === e.questionId) || null;
    const no = e.choice === "deny" || e.choice === "reply", outcome = no ? "denied" : "approved";
    if (q && q.status === "pending") this.answer(s, (x) => x === q, e.t, "dashboard", outcome);
    else if (q) Object.assign(q, { status: "answered", answeredAt: e.t, resolvedBy: "dashboard", outcome });
    if (e.choice === "session" && e.tool) s.allow.add(e.tool);
    const step = no && q && q.stepId != null ? s.running.find((x) => x.id === q.stepId) : null;
    if (step) {
      removeFrom(s.running, step);
      Object.assign(step, { status: "denied", end: e.t, durationMs: Math.max(0, ms(e.t) - ms(step.t)) });
    }
    const x = { kind: "answer", t: e.t, choice: e.choice, text: e.text || null, tool: e.tool || (q && q.tool) || null,
      target: q ? q.target : null, questionId: q ? q.id : null, agentId: q ? q.agentId : null };
    this.push(s, x); this.say(s, x);
    s.lastAnswer = x;
    this.settle(s);
  }

  addSubagent(s, f) {
    const n = { id: f.id, agentId: f.agentId || null, type: f.type || null, description: f.description || null, background: !!f.background, status: "running",
      startedAt: f.startedAt, finishedAt: null, parentAgentId: f.parentAgentId || null, stepId: f.stepId || null, lastMessage: null };
    s.subagents.push(n);
    if (s.subagents.length > SUBAGENTS) s.subagents.shift();
    return n;
  }

  subagentStart(s, e) {
    if (!e.agentId) return;
    s.base = "working";
    let n = s.subagents.find((x) => x.agentId === e.agentId);
    if (!n) {
      // Link to the Agent/Task call that launched it: same type first, oldest first.
      const free = s.subagents.filter((x) => !x.agentId && x.status === "running");
      n = free.find((x) => x.type && x.type === e.agentType) || free.find((x) => !x.type);
      if (n) n.agentId = e.agentId;
      else n = this.addSubagent(s, { id: e.agentId, agentId: e.agentId, type: e.agentType, startedAt: e.t });
    }
    n.type = n.type || e.agentType || null;
    this.push(s, { kind: "subagent", t: e.t, phase: "start", agentId: e.agentId, agentType: n.type, description: n.description });
  }

  subagentStop(s, e) {
    let n = e.agentId ? s.subagents.find((x) => x.agentId === e.agentId) : null;
    if (!n && e.agentId) n = this.addSubagent(s, { id: e.agentId, agentId: e.agentId, type: e.agentType, startedAt: e.t });
    if (n) Object.assign(n, { status: "finished", finishedAt: e.t, lastMessage: e.lastMessage || null });
    if (e.agentId) {
      this.answer(s, (q) => q.agentId === e.agentId, e.t, "stop");
      this.closeRunning(s, (x) => x.agentId === e.agentId, e.t);
    }
    this.push(s, { kind: "subagent", t: e.t, phase: "stop", agentId: e.agentId || null, agentType: (n && n.type) || e.agentType || null, description: n ? n.description : null });
    // A background sub-agent that finishes after the turn ended leaves the agent idle again.
    if (!s.turnOpen && !s.running.length && !s.subagents.some((x) => x.status === "running")) s.base = "idle";
  }

  // ---------- usage (OpenTelemetry) ----------
  usage(s, e) {
    const t = { input: num(e.input), output: num(e.output), cacheRead: num(e.cacheRead), cacheWrite: num(e.cacheWrite) };
    const cost = num(e.cost), tok = t.input + t.output + t.cacheRead + t.cacheWrite, model = e.model ? String(e.model).slice(0, 100) : null;
    s.cost += cost; s.requests++;
    for (const k of Object.keys(t)) s.tokens[k] += t[k];
    if (model) {
      s.model = model;
      if (s.modelCost.has(model) || s.modelCost.size < MODELS) s.modelCost.set(model, (s.modelCost.get(model) || 0) + cost);
    }
    const d = this.day(e.t);
    d.cost += cost; d.tokens += tok; d.requests++;
    for (const k of Object.keys(t)) d.tokensByType[k] += t[k];
    const proj = projectOf(s) || "unknown";
    d.byProject[proj] = (d.byProject[proj] || 0) + cost;
    tally(d.models, model || "unknown", cost, t, 1, MODELS);
    tally(d.sessions, s.session, cost, t);
    this.keepRequest({ t: ms(e.t), session: s.session, model, cost, ...t });
    const k = Math.floor(ms(e.t) / SPEND_MS) * SPEND_MS, b = s.spend.get(k) || { cost: 0, tokens: 0 };
    b.cost += cost; b.tokens += tok;
    s.spend.set(k, b);
    if (s.spend.size > SPEND) s.spend.delete(Math.min(...s.spend.keys()));
    this.attribute(s, e.t, cost, tok);
  }

  /** Per-step cost is an estimate: each model call is added to the step open at that time (innermost running tool, else the latest entry). */
  attribute(s, t, cost, tok) {
    const T = ms(t);
    let hit = null, latest = null;
    for (let i = s.trace.length - 1, k = 0; i >= 0 && k < 300; i--, k++) {
      const x = s.trace[i];
      if (ms(x.t) > T) continue;
      if (!latest) latest = x;
      if (x.kind === "tool" && (x.end == null || ms(x.end) >= T)) { hit = x; break; }
    }
    const x = hit || latest;
    if (!x) return;
    x.cost = (x.cost || 0) + cost; x.tokens = (x.tokens || 0) + tok; x.costEstimated = true;
  }

  /** One API request for the CSV export. Past REQUESTS (and a tenth more, so it sorts rarely) the oldest go. */
  keepRequest(r) {
    this.requests.push(r);
    if (this.requests.length <= REQUESTS * 1.1) return;
    this.requests.sort((a, b) => a.t - b.t);
    for (const x of this.requests.splice(0, this.requests.length - REQUESTS)) if (x.t > this.requestsCut) this.requestsCut = x.t;
  }

  persist(e) {
    if (!this.dataDir) return;
    fs.appendFileSync(path.join(this.dataDir, `events-${localDate(e.t)}.jsonl`), JSON.stringify(e) + "\n");
  }

  /** Rebuilds state from saved event files and deletes files past retention. Never throws on file trouble. */
  replay() {
    if (!this.dataDir) return 0;
    const cutoff = localDate(Date.now() - (this.getConfig().retentionDays || 30) * DAY);
    let count = 0;
    for (const [date, files] of this.dayFiles()) {
      if (date < cutoff) { for (const f of Object.values(files)) this.tryUnlink(f); continue; }
      for (const e of this.readDay(date, files)) {
        try { if (this.apply(e, { persist: false, live: false })) count++; } catch {}
      }
    }
    this.prune();
    return count;
  }

  /**
   * Saved event files by day, oldest first: { plain: events-<d>.jsonl, lite: events-<d>.lite.jsonl, tmp: events-<d>.lite.jsonl.tmp }.
   * plain = as received; lite = compacted (no diffs or output); tmp = a compaction that hasn't finished.
   */
  dayFiles() {
    const days = new Map();
    let names = [];
    try { names = fs.readdirSync(this.dataDir); } catch (err) { this.log.warn(`Can't read ${this.dataDir}: ${err.message}`); }
    for (const f of names) {
      const m = DAY_FILE.exec(f);
      if (!m) continue;
      if (!days.has(m[1])) days.set(m[1], {});
      days.get(m[1])[m[2] === ".jsonl" ? "plain" : m[2] === ".lite.jsonl" ? "lite" : "tmp"] = path.join(this.dataDir, f);
    }
    return new Map([...days].sort(([a], [b]) => a.localeCompare(b)));
  }

  /**
   * A day's events: the .lite file first, then anything new in the temp file, then anything new in the original.
   * Events are matched by their stripped form (with or without diffs) and counted per file. The day holds as many
   * copies of an event as the file with the most of them: .lite and .tmp are copies of originals, so an interrupted
   * compaction never double-counts, and two genuinely identical events in one file both stay.
   */
  readDay(date, files) {
    const paths = [files.lite, files.tmp, files.plain].filter(Boolean), lists = paths.map((f) => this.readEvents(f, paths.length > 1));
    if (lists.length < 2) return (lists[0] || []).map((x) => x.e);
    const want = new Map(), have = new Map(), out = [];
    for (const list of lists) {
      const counts = new Map();
      for (const { key } of list) counts.set(key, (counts.get(key) || 0) + 1);
      for (const [key, n] of counts) if (n > (want.get(key) || 0)) want.set(key, n);
    }
    for (const list of lists) {
      for (const { e, key } of list) {
        const n = have.get(key) || 0;
        if (n < want.get(key)) { out.push(e); have.set(key, n + 1); }
      }
    }
    return out;
  }

  /** The events of one file, with their stripped form as a key when keyed. Lines cut off by a crash are skipped. */
  readEvents(f, keyed) {
    let text = "";
    try { text = fs.readFileSync(f, "utf8"); } catch (err) { this.log.warn(`Can't read ${f}: ${err.message}`); return []; }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const e = JSON.parse(line); out.push({ e, key: keyed ? JSON.stringify(stripEvent(e)) : null }); } catch {}
    }
    return out;
  }

  tryUnlink(f) { try { fs.unlinkSync(f); } catch {} }

  /** Drops sessions and days past retention; diffs and output tails after DETAIL_DAYS (memory and disk); requests kept for
   *  the CSV export after REQUEST_DAYS. Never throws. */
  prune(now = Date.now()) {
    const keep = (this.getConfig().retentionDays || 30) * DAY, old = now - DETAIL_DAYS * DAY;
    for (const [id, s] of this.sessions) {
      if (now - ms(s.updated) > keep) { this.sessions.delete(id); continue; }
      for (const x of s.trace) { if (ms(x.t) >= old) break; strip(x); }
      // Sessions idle past the detail window keep only their last HEAVY steps.
      if (ms(s.updated) < old && s.trace.length > HEAVY) for (const x of s.trace.splice(0, s.trace.length - HEAVY)) removeFrom(s.running, x);
    }
    const cutoff = localDate(now - keep);
    for (const k of this.daily.keys()) if (k < cutoff) this.daily.delete(k);
    const from = dayStart(localDate(now), 1 - REQUEST_DAYS);
    if (this.requests.some((r) => r.t < from)) this.requests = this.requests.filter((r) => r.t >= from);
    this.compactFiles(now);
  }

  /** Compacts every day older than DETAIL_DAYS that still has an original or an unfinished temp file. A failed day is retried at the next prune. */
  compactFiles(now = Date.now()) {
    if (!this.dataDir) return;
    const before = localDate(now - DETAIL_DAYS * DAY);
    for (const [date, files] of this.dayFiles()) {
      if (date >= before || (!files.plain && !files.tmp)) continue;
      try { this.compactDay(date, files); } catch (err) { this.log.warn(`Couldn't compact the events of ${date} (${err.code || err.message}). Will retry later.`); }
    }
  }

  /**
   * Crash-safe: (1) write the day's deduplicated, stripped events to the temp file; (2) remove the original;
   * (3) rename the temp file over the .lite file. A crash at any point leaves files readDay() reads correctly, and
   * the next run finishes the job: an original still there means start again; only a temp file means finish the rename.
   */
  compactDay(date, files) {
    const lite = path.join(this.dataDir, `events-${date}.lite.jsonl`), tmp = lite + ".tmp";
    if (files.plain) {
      const lines = this.readDay(date, files).map((e) => JSON.stringify(stripEvent(e)));
      fs.writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "");
      try { fs.unlinkSync(files.plain); } catch (err) { this.tryUnlink(tmp); throw err; } // original busy: nothing changed
    }
    try { fs.renameSync(tmp, lite); } catch { this.tryUnlink(lite); fs.renameSync(tmp, lite); }
  }

  // ---------- asks: a hook waiting on a PermissionRequest for the dashboard's answer ----------
  /**
   * Applies a PermissionRequest whose hook waits up to e.hold seconds, and opens an ask on exactly the question that shows
   * this request: the one it raised, or an identical one it joined. Joined to a different request's question, it gets no
   * ask, so its hook ends and the terminal asks. The random id is what the hook long-polls (with the ingest token) and
   * what the dashboard answers. A tool allowed for this session is decided at once (permission() logged it).
   * watched = someone has the dashboard open. If not, nobody can answer: unless the tool is allowed for this session, the
   * request is applied as one that doesn't wait (and saved so), and the terminal asks at once.
   * @returns {{applied: boolean, ask: {id: string, until: number} | null}}
   */
  applyHeld(raw, { watched = true, ...opts } = {}, now = Date.now()) {
    const e = Store.clean(raw);
    if (!e || e.type !== "hook" || e.ev !== "PermissionRequest") return { applied: false, ask: null };
    const s = this.sessions.get(e.session);
    if (!holdOf(e) || (!watched && !(s && s.allow.has(e.tool)))) { delete e.hold; return { applied: this.apply(e, opts), ask: null }; }
    this.raised = null;
    const applied = this.apply(e, opts), r = this.raised;
    this.raised = null;
    return { applied, ask: applied && r && (r.auto || r.q) ? this.openAsk(r, holdOf(e), now) : null };
  }

  openAsk({ s, q, auto }, secs, now) {
    const a = { id: crypto.randomBytes(18).toString("base64url"), session: s.session, tool: null, until: now + secs * 1000,
      questionId: null, decision: null, choice: null, text: null, closed: null, delivered: null };
    if (auto) a.decision = { behavior: "allow" };
    else {
      if (q.askId) this.closeAsk(q.askId, "replaced");
      Object.assign(a, { tool: q.tool, questionId: q.id });
      q.askId = a.id;
    }
    this.asks.set(a.id, a);
    for (const old of this.asks.values()) {
      if (this.asks.size <= ASKS) break;
      this.closeAsk(old.id, "dropped");
      this.asks.delete(old.id);
    }
    this.emit("change");
    return { id: a.id, until: a.until };
  }

  /** The hook behind this question still waits: per its ask (server time), else, when replayed or the ask is long gone,
   *  per the hold its saved event asked for (event time t). */
  held(q, t, now = Date.now()) {
    const a = q.askId ? this.asks.get(q.askId) : null;
    if (a) { const st = askState(a, now); return st === "open" || st === "sending"; }
    return q.holdUntil != null && t < q.holdUntil;
  }

  /** The hook stops waiting: answered elsewhere, replaced, expired or gone. Emits "ask" so its long-poll returns. When
   *  it stops before its window ends with its question still open (it hung up, or the ask was dropped), that is saved,
   *  so a replay stops treating the question as held then too (see held()). */
  closeAsk(id, why, now = Date.now()) {
    const a = this.asks.get(id);
    if (!a || a.closed || a.delivered) return;
    a.closed = a.decision ? `undelivered: ${why}` : why;
    this.emit("ask", a);
    const s = why !== "replaced" && now < a.until && a.questionId != null ? this.sessions.get(a.session) : null;
    if (s && s.pending.some((q) => q.id === a.questionId && q.askId === id && q.status === "pending")) {
      this.apply({ type: "release", t: iso(now), session: a.session, questionId: a.questionId });
    }
  }

  /** A saved release: the hook behind this question stopped waiting at t. */
  release(s, e) {
    const q = s.pending.find((x) => x.id === e.questionId);
    if (q && q.holdUntil != null) q.holdUntil = Math.min(q.holdUntil, ms(e.t));
  }

  /**
   * The dashboard's answer: approve (once), session (and every later request for that tool in this session), deny, or
   * reply (a deny whose text tells the agent what to do instead). It takes effect when the hook picks it up (pollAsk),
   * which a waiting hook does at once. Until then the question stays open, so an answer that never arrives leaves the
   * agent on "Needs you", for the terminal.
   * @returns {{questionId: number, until: string, delivered: boolean} | {code: number, error: string}}
   */
  answerAsk(id, { kind, text } = {}, now = Date.now()) {
    const a = typeof id === "string" ? this.asks.get(id) : null;
    if (!a || a.questionId == null) return { code: 404, error: "This question can't be answered here. Answer it in the Claude Code terminal." };
    if (a.decision) return { code: 409, error: "Someone already answered this question." };
    if (askState(a, now) !== "open" || now >= a.until - LATE) return { code: 410, error: "The agent stopped waiting for an answer here. Answer it in the Claude Code terminal." };
    if (!CHOICES.has(kind)) return { code: 400, error: "kind must be approve, session, deny or reply." };
    const reply = typeof text === "string" ? text.trim() : "";
    if (reply.length > REPLY_MAX) return { code: 400, error: `Keep the reply under ${REPLY_MAX} characters.` };
    if (kind === "reply" && !reply) return { code: 400, error: "Type a reply first." };
    const no = kind === "deny" || kind === "reply";
    Object.assign(a, { decision: no ? { behavior: "deny", message: reply || DENIED } : { behavior: "allow" }, choice: kind, text: no ? reply || null : null });
    this.emit("ask", a);
    this.emit("change");
    return { questionId: a.questionId, until: iso(a.until), delivered: !!a.delivered };
  }

  /** What the hook's long-poll gets: "answered" with the decision, "pending" (left = ms to the end of the window) or
   *  "closed". Handing over an answer delivers it: it is logged (and saved) now. null for an unknown id. */
  pollAsk(id, now = Date.now()) {
    const a = this.asks.get(id);
    if (!a) return null;
    const st = askState(a, now);
    if (st === "sending") this.deliver(a, now);
    if (st === "sending" || st === "done") return { status: "answered", decision: a.decision };
    if (st === "closed") {
      if (!a.closed) { this.closeAsk(id, "expired", now); this.emit("change"); }
      return { status: "closed" };
    }
    return { status: "pending", left: a.until - now };
  }

  deliver(a, now) {
    a.delivered = now;
    if (!a.choice) return this.emit("change"); // decided at once (allowed for this session): logged when it came in
    this.apply({ type: "answer", t: iso(now), session: a.session, choice: a.choice, text: a.text, tool: a.tool, questionId: a.questionId });
    Object.assign(this.sessions.get(a.session).lastAnswer, { delivered: iso(now), until: iso(a.until) });
  }

  /** The hook hung up before it got an answer. */
  leaveAsk(id) {
    const a = this.asks.get(id);
    if (!a || a.closed || a.delivered) return;
    this.closeAsk(id, "left");
    this.emit("change");
  }

  /** Closes asks whose window passed (an answer that never got picked up included) and forgets them ASK_KEEP later. */
  sweepAsks(now = Date.now()) {
    let changed = false;
    for (const a of [...this.asks.values()]) {
      if (!a.closed && askState(a, now) === "closed") { this.closeAsk(a.id, "expired", now); changed = true; }
      if (now >= a.until + ASK_KEEP) this.asks.delete(a.id);
    }
    if (changed) this.emit("change");
  }

  /** For the dashboard: the ask it can answer, or that the in-app window has passed (expired, the hook left, or an
   *  answer never reached it). While an answer is on its way, neither. */
  askView(q, now) {
    const a = q.askId ? this.asks.get(q.askId) : null, st = a ? askState(a, now) : null;
    return { ask: st === "open" ? { id: q.askId, until: iso(a.until) } : null, windowClosed: !!q.askId && (!a || st === "closed") };
  }

  // ---------- messages from the dashboard, handed to the agent by its next Stop hook ----------
  /**
   * Queues your message for a session. Its hook hands it to Claude on the session's next Stop (applyStop) and Claude
   * carries on with it. Saved with the events, so a restart keeps it queued; dropped as undelivered if the session ends.
   * @returns {{message: {id: number, t: string, status: string}} | {code: number, error: string}}
   */
  queueMessage(id, text, now = Date.now()) {
    const s = typeof id === "string" ? this.sessions.get(id) : null;
    if (!s) return { code: 404, error: "No agent with that id." };
    const t = typeof text === "string" ? text.trim() : "";
    if (!t) return { code: 400, error: "Type a message first." };
    if (t.length > MESSAGE_MAX) return { code: 400, error: `Keep the message under ${MESSAGE_MAX} characters.` };
    if (s.ended) return { code: 409, error: "This session has ended, so messages can't reach it." };
    if (s.inbox.length >= INBOX) return { code: 429, error: `${INBOX} messages are already waiting for this agent. Send more after it stops.` };
    this.apply({ type: "message", t: iso(now), session: s.session, text: t });
    const m = s.inbox.at(-1);
    return { message: { id: m.id, t: m.t, status: m.status } };
  }

  /**
   * Your message to a room: each agent of that project (of the last 24 hours) gets it in its own inbox, as with
   * queueMessage, except one that can't take it now: offline, ended, or with INBOX messages already waiting. sessions =
   * only these agents of the room (the ones the dashboard showed). At most ROOM_MAX agents. Every copy is saved with the
   * room message's random id and who was skipped and why, so the whole list survives a restart, and any one copy aging
   * out of its conversation.
   * @returns {{message: {id: string, project: string, t: string, text: string, to: object[], skipped: object[]}} | {code: number, error: string}}
   */
  messageRoom(project, text, { sessions } = {}, now = Date.now()) {
    const t = typeof text === "string" ? text.trim() : "";
    if (!t) return { code: 400, error: "Type a message first." };
    if (t.length > MESSAGE_MAX) return { code: 400, error: `Keep the message under ${MESSAGE_MAX} characters.` };
    if (sessions != null && (!Array.isArray(sessions) || sessions.length > ROOM_MAX || sessions.some((x) => typeof x !== "string"))) {
      return { code: 400, error: `sessions must be a list of up to ${ROOM_MAX} agent ids.` };
    }
    const pick = sessions ? new Set(sessions) : null;
    // A room is a project as the hall shows it: by its shown name.
    const members = [...this.sessions.values()].filter((s) => this.shownProject(s) === project && now - ms(s.updated) < DAY && (!pick || pick.has(s.session)));
    if (!members.length) return { code: 404, error: "No agents in that room." };
    if (members.length > ROOM_MAX) return { code: 400, error: `A message reaches at most ${ROOM_MAX} agents. Pick them with sessions.` };
    const why = (s) => (s.ended ? "ended" : this.statusOf(s, now) === "offline" ? "offline" : s.inbox.length >= INBOX ? "full" : null);
    const to = [], skipped = [];
    for (const s of members) { const w = why(s); if (w) skipped.push({ session: s.session, why: w }); else to.push(s); }
    if (!to.length) return { code: 409, error: `None of these agents can get messages right now: they're offline, their sessions ended, or ${INBOX} messages already wait for them.` };
    const id = crypto.randomBytes(12).toString("base64url"), at = iso(now);
    for (const s of to) this.apply({ type: "message", t: at, session: s.session, text: t, room: id, ...(skipped.length ? { skipped } : {}) });
    return { message: { id, project, t: at, text: t, to: to.map((s) => ({ session: s.session, status: "queued", deliveredAt: null })), skipped } };
  }

  enqueue(s, e) {
    const m = { kind: "message", id: ++s.seq, t: e.t, text: e.text, status: "queued", deliveredAt: null };
    if (e.room) Object.assign(m, { room: e.room }, e.skipped ? { skipped: e.skipped } : {});
    this.say(s, m);
    s.inbox.push(m);
    if (s.inbox.length > INBOX) s.inbox.shift().status = "undelivered"; // a bound queueMessage never reaches
  }

  /**
   * A Stop from a hook that can hand messages over (inbox: true): applies it, then hands over the queued messages,
   * oldest first. Never while Claude is already carrying on because of a Stop hook (stopActive): no loops.
   * now = server time, saved as when they were delivered.
   * @returns {{applied: boolean, messages: string[]}}
   */
  applyStop(raw, opts = {}, now = Date.now()) {
    const e = Store.clean(raw);
    if (!e || e.type !== "hook" || e.ev !== "Stop") return { applied: false, messages: [] };
    const applied = this.apply(e, opts), s = this.sessions.get(e.session);
    if (!applied || e.inbox !== true || e.stopActive || !s.inbox.length) return { applied, messages: [] };
    const list = s.inbox.slice(0, INBOX);
    // Server time: when they were handed over, whatever the hook's clock says.
    this.apply({ type: "delivered", t: iso(now), session: s.session, ids: list.map((m) => m.id) }, opts);
    return { applied, messages: list.map((m) => m.text) };
  }

  /** Its Stop hook handed these messages to Claude, which carries on with them instead of stopping. */
  delivered(s, e) {
    const got = s.inbox.filter((m) => e.ids.includes(m.id));
    if (!got.length) return;
    s.inbox = s.inbox.filter((m) => !got.includes(m));
    for (const m of got) Object.assign(m, { status: "delivered", deliveredAt: e.t });
    s.ended = false; s.base = "working"; s.turnOpen = true; s.carryingOn = true;
    this.push(s, { kind: "inbox", t: e.t, ids: got.map((m) => m.id), count: got.length, text: got[0].text });
    this.settle(s);
  }

  /** Names a session here; an empty name goes back to the automatic one. Saved with the events. */
  rename(id, name, now = Date.now()) {
    const s = typeof id === "string" ? this.sessions.get(id) : null;
    if (!s) return { code: 404, error: "No agent with that id." };
    if (name != null && typeof name !== "string") return { code: 400, error: "The name must be text." };
    const n = (name || "").trim();
    if (n.length > NAME_MAX) return { code: 400, error: `Keep the name under ${NAME_MAX} characters.` };
    this.apply({ type: "name", t: iso(now), session: s.session, name: n });
    return { name: this.nameOf(s) };
  }

  /** Average cost of the other sessions that reported any, over the retention window: "2.2× your avg". Null with
   *  fewer than 3 to compare with. */
  avgCost(skip) {
    let n = 0, sum = 0;
    for (const s of this.sessions.values()) if (s !== skip && s.requests > 0) { n++; sum += s.cost; }
    return n >= 3 ? sum / n : null;
  }

  // ---------- views ----------
  /** Offline after the timeout with no events; an agent waiting on you stays "Needs you" up to WAIT_CAP. */
  statusOf(s, now = Date.now()) {
    const age = now - Date.parse(s.updated);
    if (s.ended || age > (s.state === "waiting" ? WAIT_CAP : this.timeoutMs())) return "offline";
    return s.state;
  }

  /** What you set for a project in Settings: { name?, color? }, or null. */
  projectSet(key) {
    const p = this.getConfig().projects || {};
    return key && Object.hasOwn(p, key) ? p[key] : null;
  }

  /** A project as every screen shows it: the name you gave it, else its git folder's. */
  projectName(key) {
    const c = this.projectSet(key);
    return (c && c.name) || key;
  }
  shownProject(s) { return this.projectName(projectOf(s)); }

  /** Spend per project key as spend per shown name ("unknown", no folder, stays). */
  shownSpend(byProject) {
    const out = {};
    for (const [k, v] of Object.entries(byProject)) { const n = k === "unknown" ? k : this.projectName(k); out[n] = (out[n] || 0) + v; }
    return out;
  }

  /** Display name: the name you gave it here, a folder alias, AGENT_NAME, then "<project> · <label from the first real prompt>". */
  nameOf(s) {
    const aliases = this.getConfig().aliases || {}, project = this.shownProject(s);
    return s.alias || (s.folder && aliases[s.folder]) || (s.gitRoot && aliases[s.gitRoot]) || s.name ||
      (project && s.label ? `${project} · ${s.label}` : project) || `session ${s.session.slice(0, 6)}`;
  }

  /** Lean agent summary for the live snapshot. Full detail is in detail(). */
  viewOne(s, now = Date.now()) {
    const today = localDate(now), q = s.pending[0] || null, root = s.gitRoot || s.cwd0;
    const rel = s.folder && root ? relPath(s.folder, root) : null;
    const { offlineMs, ...todayTotals } = tl.totals(this.segments(s, dayStart(today), now));
    return {
      session: s.session, name: this.nameOf(s), folder: s.folder, host: s.host, user: s.user,
      state: this.statusOf(s, now), ended: s.ended, task: s.task, tool: s.tool, target: s.target, message: s.message,
      toolCount: s.toolCount, requests: s.requests, cost: s.cost, model: s.model, tokens: { ...s.tokens },
      started: s.started, updated: s.updated, history: s.history.slice(0, 10),
      // root = what paths are shown relative to: the git root, else the folder the session started in. project = its shown
      // name; projectColor = the room colour you picked for it (0–5), null for the automatic one.
      project: this.shownProject(s), projectColor: (this.projectSet(projectOf(s)) || {}).color ?? null,
      label: s.label, gitRoot: s.gitRoot, root: root || null, relCwd: rel === "." ? null : rel, mission: s.mission, taskAt: s.taskAt,
      waitingSince: q ? q.t : null, queued: s.inbox.length, takesMessages: s.takesMessages, carryingOn: s.carryingOn,
      // stale: no events for the offline timeout. The agent still counts as waiting (up to WAIT_CAP), but may have moved on.
      // ask: answerable from the dashboard until `until`; windowClosed: it was, and the hook has stopped waiting.
      question: q ? { ...leanQuestion(q), stale: now - Date.parse(s.updated) > this.timeoutMs(), ...this.askView(q, now) } : null,
      allowed: [...s.allow],
      answer: s.lastAnswer ? leanAnswer(s.lastAnswer) : null,
      // false when the agent never wrote a plan (newer models only plan with CLAUDE_CODE_ENABLE_TODO_TOOLS=1)
      hasPlan: s.plan.items.length + s.plan.earlier.length > 0,
      plan: { ...plans.counts(s.plan, today, localDate), now: plans.current(s.plan) },
      planAt: s.plan.updatedAt, // when the plan last changed: the work board fetches its items again then
      subagents: leanSubagents(s.subagents),
      recent: s.trace.slice(-RECENT).map(leanStep),
      today: todayTotals,
    };
  }

  /** Agents active in the last 24 hours, most urgent first. */
  agents(now = Date.now()) {
    return [...this.sessions.values()]
      .filter((s) => now - Date.parse(s.updated) < DAY)
      .map((s) => this.viewOne(s, now))
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.started.localeCompare(b.started));
  }

  /**
   * What the alert rules look at (src/alerts.js), for each session active in the last 24 hours: who it is, its state,
   * the question it waits on (while it waits), its cost, and per agent (ctx "" = the main one, else a sub-agent's id)
   * its failed tool calls in a row and the latest such run a working call ended. Targets are shown as in the UI: a
   * command as typed, a path relative to the project.
   */
  watch(now = Date.now()) {
    const out = [], from = iso(now - DAY);
    for (const s of this.sessions.values()) {
      if (s.updated <= from) continue;
      const state = this.statusOf(s, now), root = s.gitRoot || s.cwd0, q = state === "waiting" ? s.pending[0] : null;
      out.push({
        session: s.session, name: this.nameOf(s), label: s.label, project: this.shownProject(s), host: s.host, state, cost: s.cost, model: s.model,
        question: q ? { id: q.id, t: q.t, qkind: q.qkind, tool: q.tool, notificationType: q.notificationType, target: shownTarget(q, root) } : null,
        fails: [...s.fails].map(([ctx, f]) => ({ ctx, n: f.n, since: f.since, tool: f.last.tool, target: shownTarget(f.last, root) })),
        recovered: [...s.recovered].map(([ctx, x]) => ({ ctx, ...x })),
      });
    }
    return out;
  }

  /** Today's spend so far. */
  spent(now = Date.now()) {
    const d = this.daily.get(localDate(now));
    return d ? d.cost : 0;
  }

  /** Where a question stands: still pending, or answered (when, and by what). Null once the store no longer has it. */
  questionState(id, questionId) {
    const s = this.sessions.get(id);
    const q = s && (s.pending.find((x) => x.id === questionId) || s.conversation.findLast((x) => x.kind === "question" && x.id === questionId));
    return q ? { status: q.status, answeredAt: q.answeredAt || null, resolvedBy: q.resolvedBy || null } : null;
  }

  /** Everything about one session: trace, plan, sub-agents, conversation (your messages included), state log, files
   *  touched, its mission and follow-ups, cost per 10 minutes, and the average cost of your other sessions. */
  detail(id, now = Date.now()) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const root = s.gitRoot || s.cwd0;
    const from = s.log.length ? ms(s.log[0].t) : ms(s.started);
    return {
      agent: this.viewOne(s, now),
      trace: s.trace,
      plan: { items: s.plan.items, earlier: s.plan.earlier, updatedAt: s.plan.updatedAt, source: s.plan.source, now: plans.current(s.plan) },
      subagents: s.subagents,
      conversation: s.conversation,
      stateLog: s.log.map(({ t, state }) => ({ t, state })),
      segments: this.segments(s, from, now).map(isoSeg),
      files: [...s.files.values()].reverse().map((f) => ({ ...f, rel: relPath(f.path, root) })),
      // followUps = the later real prompts still in the conversation; followUpCount counts every one
      mission: s.mission ? { text: s.mission, at: s.missionAt, openedFile: s.missionFile, followUpCount: Math.max(0, s.prompts - 1),
        followUps: s.conversation.filter((x) => x.kind === "prompt" && x.text && !x.command && x.id > s.missionId).map(({ t, text, openedFile }) => ({ t, text, openedFile })) } : null,
      usage: { bucketMs: SPEND_MS, buckets: [...s.spend].sort((a, b) => a[0] - b[0]).map(([t, b]) => ({ t: iso(t), cost: b.cost, tokens: b.tokens })) },
      avgCost: this.avgCost(s),
    };
  }

  /**
   * The work board's plan items, counted like the snapshot's totals: for every agent of the last 24 hours, the items it
   * finished today (earlier lists included) and, when it was active today, its open items with their place in the list.
   */
  board(now = Date.now()) {
    const day = localDate(now);
    const doneToday = (x) => x.status === "completed" && !!x.completedAt && localDate(x.completedAt) === day;
    const plans = [];
    for (const s of this.sessions.values()) {
      if (now - ms(s.updated) >= DAY) continue;
      const { items, earlier } = s.plan, active = localDate(s.updated) === day;
      const open = active ? items.flatMap((x, i) => (x.status === "completed" ? [] : [{ text: x.content, status: x.status, step: i + 1, since: x.inProgressSince || null }])) : [];
      const done = [...items, ...earlier].filter(doneToday).map((x) => ({ text: x.content, at: x.completedAt }));
      if (open.length || done.length) plans.push({ session: s.session, of: items.length, open, done });
    }
    return { t: iso(now), date: day, plans };
  }

  /**
   * The meeting hall's data beyond the snapshot: the work board's plan items; the files that two or more agents of one
   * project edited today, compared by their path in the project (so two clones of a repo count; files outside it don't);
   * and today's messages to a room, with each agent's copy (queued, delivered or undelivered) and who was skipped and why.
   */
  rooms(now = Date.now()) {
    const day = localDate(now), today = (t) => !!t && localDate(t) === day;
    const files = new Map(), messages = new Map();
    for (const s of this.sessions.values()) {
      const project = this.shownProject(s), root = s.gitRoot || s.cwd0;
      if (!project || now - ms(s.updated) >= DAY) continue;
      for (const f of s.files.values()) {
        const rel = root && today(f.last) ? relPath(f.path, root) : null;
        if (!rel || rel === "." || rel.startsWith("…/") || /^(\/|[a-z]:[\\/])/i.test(rel)) continue;
        const k = `${project}\n${rel}`;
        if (!files.has(k)) files.set(k, { project, path: rel, by: [] });
        files.get(k).by.push({ session: s.session, last: f.last });
      }
      for (const m of s.conversation) {
        if (m.kind !== "message" || !m.room || !today(m.t)) continue;
        if (!messages.has(m.room)) messages.set(m.room, { id: m.room, project, t: m.t, text: m.text, to: [], skipped: [] });
        const r = messages.get(m.room);
        r.to.push({ session: s.session, status: m.status, deliveredAt: m.deliveredAt });
        for (const x of m.skipped || []) if (!r.skipped.some((y) => y.session === x.session)) r.skipped.push(x);
      }
    }
    const latest = (f) => f.by.reduce((t, b) => (b.last > t ? b.last : t), "");
    return {
      t: iso(now), date: day, plans: this.board(now).plans,
      files: [...files.values()].filter((f) => f.by.length > 1).sort((a, b) => latest(b).localeCompare(latest(a)) || a.path.localeCompare(b.path)).slice(0, OVERLAPS)
        .map((f) => ({ ...f, by: f.by.sort((a, b) => b.last.localeCompare(a.last)) })),
      messages: [...messages.values()].sort((a, b) => a.t.localeCompare(b.t) || a.id.localeCompare(b.id)).slice(-ROOM_MESSAGES),
    };
  }

  /** One local day: state segments per session (offline computed) and 10-minute buckets. */
  timeline(date, now = Date.now()) {
    const from = dayStart(date), to = Math.min(dayStart(date, 1), now);
    const rows = [];
    if (to > from) {
      for (const s of this.sessions.values()) {
        if (!s.log.length || ms(s.log[0].t) >= to) continue;
        const segs = this.segments(s, from, to);
        if (!segs.some((g) => g.state !== "offline")) continue;
        rows.push({ session: s.session, name: this.nameOf(s), project: this.shownProject(s), label: s.label, host: s.host, segs });
      }
    }
    rows.sort((a, b) => a.segs[0].from - b.segs[0].from);
    return {
      date, from: iso(from), to: iso(Math.max(from, to)), bucketMs: tl.BUCKET,
      sessions: rows.map(({ segs, ...r }) => ({ ...r, segments: segs.map(isoSeg), totals: tl.totals(segs) })),
      buckets: tl.buckets(rows.map((r) => r.segs), from, to),
    };
  }

  /** The last `days` local days, oldest first: cost, tokens and requests, cost per project and per model. */
  report(days = 14, now = Date.now()) {
    const out = [], today = localDate(now);
    for (let i = days - 1; i >= 0; i--) {
      const date = localDate(dayStart(today, -i)), d = this.daily.get(date);
      out.push(d ? { date, cost: d.cost, tokens: d.tokens, requests: d.requests, byProject: this.shownSpend(d.byProject),
        byModel: Object.fromEntries([...d.models].map(([m, u]) => [m, u.cost])), tokensByType: { ...d.tokensByType } }
        : { date, cost: 0, tokens: 0, requests: 0, byProject: {}, byModel: {}, tokensByType: zeroTokens() });
    }
    return out;
  }

  /**
   * The cost report: spend per day (the last 14 days, or since the 1st once the month is longer), and today's and the
   * last 7 days' spend by project, model and session. A project of null is a session with no folder.
   */
  cost(now = Date.now()) {
    const today = localDate(now), month = `${today.slice(0, 8)}01`, days = [];
    for (let i = Math.max(14, Number(today.slice(8))) - 1; i >= 0; i--) {
      const date = localDate(dayStart(today, -i)), d = this.daily.get(date);
      days.push({ date, cost: d ? d.cost : 0, requests: d ? d.requests : 0 });
    }
    return { t: iso(now), date: today, month, days, periods: { today: this.spendOver(1, now), "7d": this.spendOver(7, now) } };
  }

  /** Spend over the last n days (today included): totals, tokens by type, and by project, model and session, most first.
   *  Sessions: the COST_SESSIONS costliest, with sessionCount and the average per session (null with fewer than 3). */
  spendOver(n, now = Date.now()) {
    const today = localDate(now), tokens = zeroTokens(), projects = new Map(), models = new Map(), sessions = new Map();
    let cost = 0, requests = 0;
    for (let i = 0; i < n; i++) {
      const d = this.daily.get(localDate(dayStart(today, -i)));
      if (!d) continue;
      cost += d.cost; requests += d.requests;
      for (const k of Object.keys(tokens)) tokens[k] += d.tokensByType[k];
      for (const [k, v] of Object.entries(this.shownSpend(d.byProject))) projects.set(k, (projects.get(k) || 0) + v);
      for (const [k, u] of d.models) tally(models, k, u.cost, u.tokens, u.requests);
      for (const [k, u] of d.sessions) tally(sessions, k, u.cost, u.tokens, u.requests);
    }
    const ranked = [...sessions].sort((a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0]));
    return {
      days: n, from: localDate(dayStart(today, 1 - n)), cost, requests, tokens,
      projects: [...projects].map(([k, c]) => ({ project: k === "unknown" ? null : k, cost: c })).sort(byCost),
      models: [...models].map(([model, u]) => ({ model, ...u })).sort(byCost),
      sessionCount: ranked.length, avgCost: ranked.length >= 3 ? cost / ranked.length : null,
      sessions: ranked.slice(0, COST_SESSIONS).map(([id, u]) => ({ ...this.costOf(id, now), ...u })),
    };
  }

  /** Who a session in the cost report is: name, project, machine, main model (the one it spent most on), state, times. */
  costOf(id, now) {
    const s = this.sessions.get(id);
    if (!s) return { session: id, name: `session ${id.slice(0, 6)}`, project: null, label: null, host: null, model: null, state: "offline", ended: false, started: null, updated: null };
    const main = [...s.modelCost].sort((a, b) => b[1] - a[1])[0];
    return { session: id, name: this.nameOf(s), project: this.shownProject(s), label: s.label, host: s.host, model: main ? main[0] : s.model,
      state: this.statusOf(s, now), ended: s.ended, started: s.started, updated: s.updated };
  }

  /** The API requests of the last n days (today included), oldest first, for the CSV export. partial: some in that
   *  range were dropped to stay under REQUESTS. */
  requestRows(n, now = Date.now()) {
    const today = localDate(now), from = dayStart(today, 1 - n), to = dayStart(today, 1);
    const rows = this.requests.filter((r) => r.t >= from && r.t < to).sort((a, b) => a.t - b.t).map(({ t, session, ...usage }) => {
      const s = this.sessions.get(session);
      return { t: iso(t), date: localDate(t), session, name: s ? this.nameOf(s) : null, project: s ? this.shownProject(s) : null, host: s ? s.host : null, ...usage };
    });
    return { from: localDate(from), to: today, rows, partial: this.requestsCut >= from };
  }

  /** Cost, requests and tokens by type over the last 1, 7 and 30 days (today included), for the top bar's period switch,
   *  and the month so far (Settings' monthly budget). */
  periods(now = Date.now()) {
    const mday = Number(localDate(now).slice(8)), days = this.report(Math.max(30, mday), now), out = {};
    for (const [key, n] of [["today", 1], ["7d", 7], ["30d", 30], ["month", mday]]) {
      const p = { days: n, cost: 0, requests: 0, tokensByType: zeroTokens() };
      for (const d of days.slice(-n)) {
        p.cost += d.cost; p.requests += d.requests;
        for (const k of Object.keys(p.tokensByType)) p.tokensByType[k] += d.tokensByType[k];
      }
      out[key] = p;
    }
    return out;
  }

  /**
   * Settings' machines: every host with a session in the last MACHINE_DAYS days, with its OS (as its newest session that
   * said reported it), live sessions, sessions active today and newest event, and its hooks' health as its newest event
   * reported it: failed sends in the last hour (failed; capped: the report holds only the newest FAILS) and events
   * waiting in its spool (more: some not counted yet), and events its spool dropped for lack of room (dropped, until a
   * day after the newest drop, droppedAt). status: offline = no live session and no contact for the offline timeout;
   * retrying = sends failed in the last hour, or events still wait; else healthy. Offline last, then by name.
   */
  machines(now = Date.now()) {
    const from = now - MACHINE_DAYS * DAY, today = localDate(now), list = new Map();
    for (const s of this.sessions.values()) {
      if (!s.host || ms(s.updated) < from) continue;
      let m = list.get(s.host);
      if (!m) list.set(s.host, (m = { host: s.host, os: null, osAt: "", live: 0, today: 0, lastEvent: s.updated }));
      if (s.os && s.started > m.osAt) Object.assign(m, { os: s.os, osAt: s.started });
      if (s.updated > m.lastEvent) m.lastEvent = s.updated;
      if (this.statusOf(s, now) !== "offline") m.live++;
      if (localDate(s.updated) === today) m.today++;
    }
    const out = [...list.values()].map(({ osAt, ...m }) => {
      const h = this.hostHealth.get(m.host), fails = h ? h.fails.filter((t) => now - ms(t) <= HOUR) : [];
      const offline = !m.live && now - ms(m.lastEvent) > this.timeoutMs(), backlog = h ? h.backlog : 0;
      const dropped = h && h.dropped && now - ms(h.droppedAt) < DAY ? h.dropped : 0;
      return { ...m, status: offline ? "offline" : fails.length || backlog || (h && h.more) ? "retrying" : "healthy",
        failed: fails.length, capped: fails.length >= FAILS, lastFail: fails.at(-1) || null, backlog, more: !!(h && h.more),
        dropped, droppedAt: dropped ? h.droppedAt : null, reportedAt: h ? h.t : null };
    });
    return out.sort((a, b) => (a.status === "offline") - (b.status === "offline") || a.host.localeCompare(b.host));
  }

  /** The newest event of any session still kept (up to retention), so an empty office can tell a first run from a quiet day. */
  lastEvent() {
    let t = null;
    for (const s of this.sessions.values()) if (!t || s.updated > t) t = s.updated;
    return t;
  }

  /** The git folders the store knows (each a project's key). */
  projectKeys() {
    const out = new Set();
    for (const s of this.sessions.values()) { const k = projectOf(s); if (k) out.add(k); }
    return [...out];
  }

  /**
   * Settings' projects: every project kept (up to retention), most agents today first: its key (the git folder name),
   * shown name and whether you named it, the colour you picked (null = automatic), its roots (newest first, at most 3,
   * and how many more) and how many of its sessions were active today.
   */
  projects(now = Date.now()) {
    const today = localDate(now), list = new Map();
    for (const s of this.sessions.values()) {
      const key = projectOf(s), root = s.gitRoot || s.cwd0;
      if (!key) continue;
      let p = list.get(key);
      if (!p) list.set(key, (p = { key, roots: new Map(), today: 0, last: "" }));
      if (root && !(p.roots.get(root) > s.updated)) p.roots.set(root, s.updated);
      if (localDate(s.updated) === today) p.today++;
      if (s.updated > p.last) p.last = s.updated;
    }
    return [...list.values()].sort((a, b) => b.today - a.today || b.last.localeCompare(a.last) || a.key.localeCompare(b.key)).slice(0, PROJECT_LIST).map((p) => {
      const set = this.projectSet(p.key) || {}, roots = [...p.roots].sort((a, b) => b[1].localeCompare(a[1])).map(([r]) => r);
      return { key: p.key, name: this.projectName(p.key), named: !!set.name, color: set.color ?? null, roots: roots.slice(0, 3), moreRoots: Math.max(0, roots.length - 3), agentsToday: p.today, last: p.last };
    });
  }

  snapshot(now = Date.now()) {
    const agents = this.agents(now);
    const day = localDate(now);
    const today = this.daily.get(day) || { cost: 0, tokens: 0, tokensByType: zeroTokens(), byProject: {} };
    const periods = this.periods(now);
    const count = (st) => agents.filter((a) => a.state === st).length;
    const isToday = (a) => localDate(a.updated) === day;
    const sum = (list, f) => list.reduce((n, a) => n + f(a), 0);
    // Today's plan per project, counted like the totals: done today from every agent, open items from agents active today.
    const projects = new Map();
    for (const a of agents) {
      const r = projects.get(a.project) || { project: a.project, done: 0, inProgress: 0, pending: 0 };
      r.done += a.plan.doneToday;
      if (isToday(a)) { r.inProgress += a.plan.inProgress; r.pending += a.plan.pending; }
      projects.set(a.project, r);
    }
    const planned = (r) => r.done + r.inProgress + r.pending;
    return {
      t: iso(now),
      lastEvent: this.lastEvent(),
      agents,
      totals: {
        todayCost: today.cost, todayTokens: today.tokens, weekCost: periods["7d"].cost,
        working: count("working"), waiting: count("waiting"), idle: count("idle"), offline: count("offline"),
        todayTokensByType: { ...today.tokensByType },
        // today's spend per project, keyed like the cost report ("unknown" for a session with no folder)
        todayByProject: this.shownSpend(today.byProject),
        tasksDone: sum(agents, (a) => a.plan.doneToday), tasksInProgress: sum(agents.filter(isToday), (a) => a.plan.inProgress), tasksPending: sum(agents.filter(isToday), (a) => a.plan.pending),
        waitedMs: sum(agents, (a) => a.today.waitedMs), activeMs: sum(agents, (a) => a.today.activeMs), idleMs: sum(agents, (a) => a.today.idleMs),
        periods,
        projects: [...projects.values()].filter(planned).sort((a, b) => planned(b) - planned(a) || String(a.project).localeCompare(String(b.project))),
      },
    };
  }
}

module.exports = { Store, localDate, validDate, INTERNAL };
