"use strict";
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { cleanPrompt, agentLabel, relPath, permissionPhrase, baseName } = require("../hooks/text");
const plans = require("./plan");
const tl = require("./timeline");

const HISTORY = 20, RECENT = 5;
// Per-session caps keep memory bounded. Diffs and output tails are kept on the newest HEAVY steps only.
const TRACE = 1000, HEAVY = 200, CONVO = 200, LOG = 1000, SUBAGENTS = 100, FILES = 300, RUNNING = 200;
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
const projectOf = (s) => baseName(s.gitRoot || s.cwd0 || s.folder || "") || null;

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
/** A small copy of a trace entry for the live snapshot. */
function leanStep(x) {
  const { detail, result, text, stepId, ...rest } = x;
  if (detail) rest.detail = lite(detail);
  if (result && (result.writeType || result.exitCode != null)) rest.result = { writeType: result.writeType, exitCode: result.exitCode };
  if (text) rest.text = text.length > 200 ? text.slice(0, 199) + "…" : text;
  return rest;
}
function leanQuestion(q) {
  const { id, t, qkind, tool, target, detail, message, notificationType, agentId } = q;
  return { id, t, qkind, tool, target, detail, message, notificationType, agentId };
}
const removeFrom = (list, x) => { const i = list.indexOf(x); if (i >= 0) list.splice(i, 1); };

class Store extends EventEmitter {
  /** @param {{getConfig: () => object, dataDir?: string|null, log?: Console}} opts  dataDir null = no persistence */
  constructor({ getConfig, dataDir = null, log = console }) {
    super();
    this.getConfig = getConfig;
    this.dataDir = dataDir;
    this.log = log;
    this.sessions = new Map();
    this.daily = new Map();
    this.budgetAlertedOn = null;
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  }

  timeoutMs() { return (this.getConfig().offlineAfterMin || 30) * 60000; }

  /** State segments of a session between two times (ms), offline computed. */
  segments(s, from, to) { return tl.segments(s.log, { from, to, timeoutMs: this.timeoutMs(), waitCapMs: WAIT_CAP }); }

  session(id, t) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        session: id, name: null, folder: null, host: null, user: null,
        state: "idle", ended: false, task: null, tool: null, target: null, message: null,
        toolCount: 0, requests: 0, cost: 0, model: null,
        tokens: zeroTokens(), started: t, updated: t, history: [],
        // cwd0 = where the session started; base = the state before open questions are counted
        cwd0: null, gitRoot: null, label: null, mission: null, base: "idle", turnOpen: false,
        seq: 0, trace: [], running: [], conversation: [], pending: [],
        plan: plans.empty(), subagents: [], files: new Map(), log: [],
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  day(t) {
    const key = localDate(t);
    let d = this.daily.get(key);
    if (!d) { d = { date: key, cost: 0, tokens: 0, requests: 0, byProject: {}, byModel: {}, tokensByType: zeroTokens() }; this.daily.set(key, d); }
    return d;
  }

  /** Validates an incoming event. Returns a clean copy or null. Oversized fields are cut or dropped. */
  static clean(e) {
    if (!e || typeof e !== "object" || typeof e.session !== "string" || !e.session) return null;
    const t = Date.parse(e.t);
    const out = { ...e, session: e.session.slice(0, 100), t: iso(Number.isFinite(t) ? t : Date.now()) };
    if (e.type === "usage") return out;
    if (e.type !== "hook" || typeof e.ev !== "string" || e.ev.length > 40) return null;
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (typeof v === "string" && v.length > MAX_TEXT) out[k] = v.slice(0, MAX_TEXT);
      else if ((k === "detail" || k === "result") && (!v || typeof v !== "object" || Array.isArray(v) || JSON.stringify(v).length > MAX_PART)) delete out[k];
    }
    return out;
  }

  apply(raw, { persist = true, live = true } = {}) {
    const e = Store.clean(raw);
    if (!e) return false;
    if (persist) this.persist(e);
    const s = this.session(e.session, e.t);
    const before = s.state;
    if (e.t > s.updated) s.updated = e.t;
    if (e.t < s.started) s.started = e.t;
    if (e.type === "hook") this.hook(s, e);
    else this.usage(s, e, live);
    tl.record(s.log, e.t, s.ended ? "ended" : s.state, this.timeoutMs(), LOG);

    if (live && before !== s.state) this.emit("transition", { agent: this.viewOne(s), from: before, to: s.state });
    if (live) this.emit("change");
    return true;
  }

  // ---------- hook events ----------
  hook(s, e) {
    if (e.cwd) { s.folder = e.cwd; if (!s.cwd0) s.cwd0 = e.cwd; }
    if (e.gitRoot && !s.gitRoot) s.gitRoot = e.gitRoot;
    if (e.name) s.name = e.name;
    if (e.host) s.host = e.host;
    if (e.user) s.user = e.user;
    const ctx = e.agentId || null;
    switch (e.ev) {
      case "SessionStart":
        s.ended = false;
        // A fresh start, resume or /clear: nothing from before is still waiting or running, sub-agents included.
        if (e.source !== "compact") {
          this.endTurn(s, e.t, () => true, "session-start");
          this.closeRunning(s, () => true, e.t);
          for (const n of s.subagents) if (n.status === "running") Object.assign(n, { status: "finished", finishedAt: e.t });
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
        this.push(s, { kind: "session", t: e.t, phase: "end", reason: e.reason || null });
        break;
      default: break;
    }
    s.state = s.pending.length ? "waiting" : s.base;
    s.message = s.pending.length ? questionText(s.pending[0]) : null;
    s.history.unshift({ t: e.t, ev: e.ev, tool: e.tool || null, target: e.target || null, msg: e.prompt || e.message || null });
    if (s.history.length > HISTORY) s.history.length = HISTORY;
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
    s.ended = false; s.base = "working"; s.turnOpen = true; s.tool = null; s.target = null;
    this.answer(s, () => true, e.t, "prompt");
    // With detail capture off the hook sends only the label, not the prompt text.
    const label = command ? null : c.text ? agentLabel(c.text) : e.label ? String(e.label).slice(0, 60) : null;
    if (!c.text && !command && !label) return;
    s.task = c.text || s.task;
    if (!command && c.text && !s.mission) s.mission = c.text;
    if (!s.label) s.label = label;
    const x = { kind: "prompt", t: e.t, text: c.text || null, openedFile: e.openedFile || c.openedFile || null, command };
    this.push(s, x); this.say(s, x);
  }

  preTool(s, e, ctx) {
    s.base = "working"; s.tool = e.tool || null; s.target = e.target || null; s.toolCount++;
    this.answer(s, (q) => q.agentId === ctx, e.t, "next-tool");
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
    const q = {
      kind: "question", t, qkind: f.qkind, tool: f.tool || (step && step.tool) || null, target: f.target || (step && step.target) || null,
      detail: lite(f.detail || (step && step.detail)), message: f.message || null, notificationType: f.notificationType || null,
      agentId: agentId || null, stepId: step ? step.id : null, status: "pending",
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
      return false;
    });
  }

  permission(s, e, ctx) {
    // PermissionRequest has no tool_use_id: it belongs to the newest running call of that tool, same target first.
    const sameCall = (x) => x.tool === e.tool && (x.target || null) === (e.target || null), sameTool = (x) => x.tool === e.tool;
    const step = this.newestRunning(s, (x) => sameCall(x) && x.agentId === ctx) || this.newestRunning(s, sameCall) ||
      this.newestRunning(s, (x) => sameTool(x) && x.agentId === ctx) || this.newestRunning(s, sameTool);
    if (step && s.pending.some((q) => q.stepId === step.id)) return;
    this.ask(s, step, { qkind: "permission", tool: e.tool, target: e.target, detail: e.detail }, e.t, ctx);
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
    // permission fires no Post event, so this is the only sign that the main agent's turn is over.
    if (type === "idle_prompt" && !e.agentId) this.endTurn(s, e.t, (q) => !q.agentId, "turn-ended");
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
    if (!step) {
      if (!e.tool) return;
      step = this.push(s, { kind: "tool", t: iso(ms(e.t) - (e.durationMs || 0)), tool: e.tool, target: e.target || null, detail: null,
        toolUseId: e.toolUseId || null, agentId: ctx, agentType: e.agentType || null });
    }
    removeFrom(s.running, step);
    step.end = e.t;
    step.durationMs = e.durationMs != null ? e.durationMs : Math.max(0, ms(e.t) - ms(step.t));
    step.status = r && r.ok === false ? "error" : "ok";
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
    s.base = "idle"; s.turnOpen = false;
    this.answer(s, questions, t, by);
    this.closeRunning(s, (x) => !x.agentId, t);
  }

  /** Stop, or StopFailure (the turn ended on an API error such as a rate limit: a red error step). */
  stop(s, e) {
    this.endTurn(s, e.t, () => true, "stop");
    const x = e.ev === "StopFailure"
      ? { kind: "stop", t: e.t, status: "error", failure: e.failure || null, text: e.message || null }
      : { kind: "stop", t: e.t, text: e.lastMessage || null };
    this.push(s, x); this.say(s, x);
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
  usage(s, e, live) {
    const t = { input: num(e.input), output: num(e.output), cacheRead: num(e.cacheRead), cacheWrite: num(e.cacheWrite) };
    const cost = num(e.cost), tok = t.input + t.output + t.cacheRead + t.cacheWrite;
    s.cost += cost; s.requests++;
    for (const k of Object.keys(t)) s.tokens[k] += t[k];
    if (e.model) s.model = e.model;
    const d = this.day(e.t);
    d.cost += cost; d.tokens += tok; d.requests++;
    for (const k of Object.keys(t)) d.tokensByType[k] += t[k];
    const proj = projectOf(s) || "unknown", model = e.model || "unknown";
    d.byProject[proj] = (d.byProject[proj] || 0) + cost;
    d.byModel[model] = (d.byModel[model] || 0) + cost;
    this.attribute(s, e.t, cost, tok);
    if (live) this.checkBudget();
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

  checkBudget() {
    const budget = num(this.getConfig().dailyBudgetUsd);
    if (!budget) return;
    const today = this.daily.get(localDate(Date.now()));
    if (today && today.cost >= budget && this.budgetAlertedOn !== today.date) {
      this.budgetAlertedOn = today.date;
      this.emit("budget", { spent: today.cost, budget });
    }
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
    const today = this.daily.get(localDate(Date.now()));
    const budget = num(this.getConfig().dailyBudgetUsd);
    if (today && budget && today.cost >= budget) this.budgetAlertedOn = today.date;
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

  /** Drops sessions and days past retention; diffs and output tails after DETAIL_DAYS (memory and disk). Never throws. */
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

  // ---------- views ----------
  /** Offline after the timeout with no events; an agent waiting on you stays "Needs you" up to WAIT_CAP. */
  statusOf(s, now = Date.now()) {
    const age = now - Date.parse(s.updated);
    if (s.ended || age > (s.state === "waiting" ? WAIT_CAP : this.timeoutMs())) return "offline";
    return s.state;
  }

  /** Display name: alias, AGENT_NAME, then "<project> · <label from the first real prompt>". */
  nameOf(s) {
    const aliases = this.getConfig().aliases || {}, project = projectOf(s);
    return (s.folder && aliases[s.folder]) || (s.gitRoot && aliases[s.gitRoot]) || s.name ||
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
      project: projectOf(s), label: s.label, gitRoot: s.gitRoot, relCwd: rel === "." ? null : rel, mission: s.mission,
      waitingSince: q ? q.t : null,
      // stale: no events for the offline timeout. The agent still counts as waiting (up to WAIT_CAP), but may have moved on.
      question: q ? { ...leanQuestion(q), stale: now - Date.parse(s.updated) > this.timeoutMs() } : null,
      // false when the agent never wrote a plan (newer models only plan with CLAUDE_CODE_ENABLE_TODO_TOOLS=1)
      hasPlan: s.plan.items.length + s.plan.earlier.length > 0,
      plan: { ...plans.counts(s.plan, today, localDate), now: plans.current(s.plan) },
      subagents: { running: s.subagents.filter((x) => x.status === "running").length, finished: s.subagents.filter((x) => x.status === "finished").length },
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

  /** Everything about one session: trace, plan, sub-agents, conversation, state log and files touched. */
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
        rows.push({ session: s.session, name: this.nameOf(s), project: projectOf(s), label: s.label, host: s.host, segs });
      }
    }
    rows.sort((a, b) => a.segs[0].from - b.segs[0].from);
    return {
      date, from: iso(from), to: iso(Math.max(from, to)), bucketMs: tl.BUCKET,
      sessions: rows.map(({ segs, ...r }) => ({ ...r, segments: segs.map(isoSeg), totals: tl.totals(segs) })),
      buckets: tl.buckets(rows.map((r) => r.segs), from, to),
    };
  }

  report(days = 14, now = Date.now()) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = localDate(now - i * DAY);
      const d = this.daily.get(key);
      out.push(d ? { ...d, byProject: { ...d.byProject }, byModel: { ...d.byModel }, tokensByType: { ...d.tokensByType } }
        : { date: key, cost: 0, tokens: 0, requests: 0, byProject: {}, byModel: {}, tokensByType: zeroTokens() });
    }
    return out;
  }

  snapshot(now = Date.now()) {
    const agents = this.agents(now);
    const day = localDate(now);
    const today = this.daily.get(day) || { cost: 0, tokens: 0, tokensByType: zeroTokens() };
    const week = this.report(7, now).reduce((a, d) => a + d.cost, 0);
    const count = (st) => agents.filter((a) => a.state === st).length;
    const todays = agents.filter((a) => localDate(a.updated) === day);
    const sum = (list, f) => list.reduce((n, a) => n + f(a), 0);
    return {
      t: iso(now),
      agents,
      totals: {
        todayCost: today.cost, todayTokens: today.tokens, weekCost: week,
        working: count("working"), waiting: count("waiting"), idle: count("idle"), offline: count("offline"),
        todayTokensByType: { ...today.tokensByType },
        tasksDone: sum(agents, (a) => a.plan.doneToday), tasksInProgress: sum(todays, (a) => a.plan.inProgress), tasksPending: sum(todays, (a) => a.plan.pending),
        waitedMs: sum(agents, (a) => a.today.waitedMs), activeMs: sum(agents, (a) => a.today.activeMs), idleMs: sum(agents, (a) => a.today.idleMs),
      },
    };
  }
}

module.exports = { Store, localDate, validDate };
