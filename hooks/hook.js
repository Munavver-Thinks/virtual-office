#!/usr/bin/env node
"use strict";
// Claude Code hook for Agent Office.
// Sends each event to the Agent Office server. If the server can't take it, it saves the event to a local spool that
// the server picks up later (on this machine), or that a later send that goes through flushes, a batch at a time (see
// flush). Each event also says how many sends failed in the last hour, how many events wait in the spool, and how
// many the spool dropped in the last day for lack of room.
// It never blocks Claude: errors are swallowed, nothing is printed, and it always exits 0 quickly.
// Two exceptions: a PermissionRequest may wait up to its hold (see holdFor) for an answer from the dashboard,
// and then prints that answer. No answer, or no server, and it exits 0 silently so the terminal prompt appears.
// And a Stop prints the messages you sent from the dashboard, if the server's reply to it carries any (see blockOf),
// so Claude carries on with them; never while Claude is already carrying on because of a Stop hook.

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { cleanPrompt, agentLabel, DENIED } = require("./text");

const DIR = process.env.AGENT_OFFICE_DIR || path.join(os.homedir(), ".agent-office");
// Size bounds for everything we keep from Claude Code's payload.
const CMD = 500, ITEM = 200, PROMPT = 600, DIFF = 4096, TAIL = 1536, TODOS = 50, HUNKS = 10;
const TERMINAL = new Set(["Bash", "PowerShell"]);
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const ROOT_TTL = 10 * 60000, ROOT_CACHE = 200;
// Waiting for the dashboard's answer: default and longest hold (seconds), one long-poll, the longest deny message
// (and the longest message from the dashboard), and how many messages one Stop hands over.
const HOLD_DEFAULT = 120, HOLD_MAX = 600, POLL = 25, MESSAGE = 1000, INBOX = 10;
// Tools whose request the dashboard shows (a command in full, or the file and the size of the change), so an answer
// there is an informed one. Questions, plan approval, sub-agent launches and MCP tools are answered in the terminal.
const HOLDABLE = new Set([...TERMINAL, ...EDITS, "Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
// The spool. pending.jsonl takes each event the server couldn't; past SEAL bytes, and before a flush, it's sealed into
// batch files of at most BATCH events and BATCH_BYTES (what one POST may carry), named with their count, at most
// SEAL_RUN bytes a run. Files are claimed by renaming them, so parallel hooks (and the server on this machine) never
// take the same events; a claim older than ORPHAN belongs to a hook that died, and is taken again. fails.log gets a
// line per failed send (see noteFail), and is read for the last HOUR's, at most FAILS. pending.jsonl is counted only up
// to COUNT_MAX bytes. A flush follows only a send that went through within FAST ms, and gets FLUSH_MS.
// The spool's files may hold SPOOL_MAX bytes in all (a server that refuses every send, say after the token was rotated,
// would fill the disk): past that after a seal, the oldest batches go until it's under SPOOL_KEEP (see capSpool).
const SPOOL = path.join(DIR, "spool");
const SEAL = 256 * 1024, SEAL_RUN = 2 * 1024 * 1024, BATCH = 500, BATCH_BYTES = 1024 * 1024, COUNT_MAX = 1024 * 1024;
const SPOOL_MAX = 50 * 1024 * 1024, SPOOL_KEEP = 45 * 1024 * 1024;
const ORPHAN = 60000, FAILS = 20, HOUR = 3600000, DAY = 86400000, FAST = 500, FLUSH_MS = 1500;
// fails.log: read from its last FAILS_TAIL bytes; past FAILS_LOG bytes it's trimmed to the newest FAILS.
// drops.log: a line per drop, "<time> <events>", read for the last DAY's; past DROPS_LOG bytes they're added up in one.
const FAILS_FILE = "fails.log", FAILS_TAIL = 1024, FAILS_LOG = 4096, SKEW = 1000;
const DROPS_FILE = "drops.log", DROPS_TAIL = 4096, DROPS_LOG = 1024;
const BATCH_FILE = /^batch-\d{13}-[0-9a-f]{8}-\d{4}-(\d+)\.jsonl$/;
const SENDING_FILE = /^sending-(\d{13})-(\d{13}-[0-9a-f]{8}-\d{4}-(\d+)\.jsonl)$/; // sending-<claimed at>-<the batch's own name>
const SEALING_FILE = /^sealing-(\d{13})-([0-9a-f]{8})-(\d+)\.jsonl$/; // sealing-<claimed at>-<id>-<bytes sealed so far>
const stamp = (t) => String(Math.max(0, Math.floor(t))).padStart(13, "0");
const rand8 = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
const parses = (l) => { try { JSON.parse(l); return true; } catch { return false; } };

/** One line, end-truncated. */
function short(s, n = 200) {
  if (s == null) return null;
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
/** Keeps line breaks, end-truncated. */
function head(s, n) {
  if (s == null || s === "") return null;
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
/** Keeps the last n characters (command output ends with the interesting part). */
function tail(s, n) {
  if (s == null || s === "") return null;
  s = String(s);
  return s.length > n ? "…" + s.slice(-(n - 1)) : s;
}
/** Drops null and undefined values so events stay small. */
function pick(o) {
  for (const k of Object.keys(o)) if (o[k] == null) delete o[k];
  return o;
}
const obj = (v) => (v && typeof v === "object" ? v : {});

function targetOf(input) {
  if (!input || typeof input !== "object") return null;
  return short(
    input.file_path || input.notebook_path || input.command || input.pattern || input.url ||
    input.query || input.subject || input.skill || input.description || input.prompt || null, 140
  );
}

/** Target when detail capture is off: paths and names only, never command text, search text or full URLs. */
function liteTarget(tool, input) {
  if (!input || typeof input !== "object") return null;
  if (TERMINAL.has(tool)) return short(input.description, 140);
  if (tool === "WebFetch") { try { return new URL(input.url).host; } catch { return null; } }
  const name = tool === "Agent" || tool === "Task" ? input.description : null;
  return short(input.file_path || input.notebook_path || input.subject || input.skill || name || null, 140);
}

const lines = (s) => (s ? String(s).split(/\r?\n/) : []);
/** Lines added and removed, ignoring unchanged lines at the start and end. */
function changed(before, after) {
  const a = lines(before), b = lines(after);
  let i = 0, j = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { removed: a.length - i - j, added: b.length - i - j };
}

function editDetail(tool, input, full) {
  const raw = tool === "MultiEdit" ? (Array.isArray(input.edits) ? input.edits : []).map((e) => [obj(e).old_string, obj(e).new_string])
    : tool === "Write" ? [["", input.content]]
    : tool === "NotebookEdit" ? [["", input.new_source]]
    : [[input.old_string, input.new_string]];
  const d = { path: input.file_path || input.notebook_path || null, added: 0, removed: 0 };
  for (const [o, n] of raw) { const c = changed(o, n); d.added += c.added; d.removed += c.removed; }
  if (full) {
    const per = Math.floor(DIFF / Math.max(1, Math.min(raw.length, HUNKS)));
    d.hunks = raw.slice(0, HUNKS).map(([o, n]) => pick({ old: head(o, per), new: head(n, per) }));
    if (raw.length > HUNKS) d.moreHunks = raw.length - HUNKS;
  }
  return d;
}

/** Bounded, tool-specific input detail. full = false keeps only names, paths and counts. */
function detailOf(tool, input, full) {
  if (!input || typeof input !== "object") return null;
  let d;
  if (TERMINAL.has(tool)) d = { command: full ? head(input.command, CMD) : null, description: short(input.description, ITEM), background: input.run_in_background === true || null };
  else if (EDITS.has(tool)) d = editDetail(tool, input, full);
  else if (tool === "Read") d = { path: input.file_path || null };
  else if (tool === "LS") d = { path: input.path || null };
  else if (tool === "Grep" || tool === "Glob") d = { pattern: full ? short(input.pattern, ITEM) : null, path: input.path || null, glob: full ? short(input.glob, ITEM) : null };
  else if (tool === "WebFetch") { let host = null; try { host = new URL(input.url).host; } catch {} d = { url: full ? head(input.url, CMD) : null, host }; }
  else if (tool === "WebSearch") d = { query: full ? short(input.query, ITEM) : null };
  else if (tool === "Agent" || tool === "Task") d = { description: short(input.description, ITEM), subagentType: short(input.subagent_type, 60), background: input.run_in_background === true || null };
  else if (tool === "TodoWrite") {
    d = { todos: (Array.isArray(input.todos) ? input.todos : []).slice(0, TODOS).map((t) =>
      pick({ content: short(obj(t).content, ITEM), status: short(obj(t).status, 20), activeForm: short(obj(t).activeForm, ITEM) })) };
  }
  else if (tool === "TaskCreate") d = { subject: short(input.subject, ITEM), activeForm: short(input.activeForm || input.active_form, ITEM) };
  else if (tool === "TaskUpdate") {
    const id = input.taskId ?? input.id ?? input.task_id;
    d = { taskId: id == null ? null : short(id, 40), status: short(input.status, 20), subject: short(input.subject, ITEM), activeForm: short(input.activeForm || input.active_form, ITEM) };
  }
  else if (tool === "AskUserQuestion") d = { question: full ? short(obj(Array.isArray(input.questions) ? input.questions[0] : null).question, 300) : null };
  else return null;
  pick(d);
  return Object.keys(d).length ? d : null;
}

/** ok/error for PostToolUse and PostToolUseFailure, plus a short output tail. */
function resultOf(e, full) {
  const failed = e.hook_event_name === "PostToolUseFailure";
  const r = e.tool_response, o = obj(r), terminal = TERMINAL.has(e.tool_name);
  const error = failed ? String(e.error ?? "") : "";
  const m = /^Exit code (\d+)/.exec(error);
  let exitCode = m ? Number(m[1]) : null;
  if (exitCode == null && terminal) { const c = Number(o.exitCode ?? o.exit_code ?? o.returnCode); if (Number.isInteger(c)) exitCode = c; }
  const interrupted = o.interrupted === true || e.is_interrupt === true;
  const res = { ok: !failed && !o.is_error && !o.isError && !interrupted && !(exitCode > 0), exitCode, interrupted: interrupted || null };
  if (e.tool_name === "Write" && typeof o.type === "string") res.writeType = o.type.slice(0, 10);
  if (o.task && o.task.id != null) res.taskId = String(o.task.id).slice(0, 40);
  if (full) {
    if (terminal) res.tail = tail(typeof r === "string" ? r : [o.stdout, o.stderr].filter(Boolean).join("\n"), TAIL);
    if (failed) res.error = tail(error, TAIL);
  }
  return pick(res);
}

function whoami() {
  try { return os.userInfo().username; } catch { return null; }
}

/**
 * Builds the event we send. Pure apart from the defaults for host, user, name and platform.
 * inbox: this hook prints the messages the server hands it on a Stop (see blockOf), so the event says it can take them.
 * health: this machine's sends (see healthOf). platform: the machine's OS, sent with SessionStart.
 * @param {object} e  Claude Code's hook payload
 * @param {{now?: Date, detail?: boolean, gitRoot?: string|null, host?: string, user?: string|null, name?: string|null, inbox?: boolean, health?: object|null, platform?: string}} opts
 */
function build(e, { now = new Date(), detail = true, gitRoot = null, host = os.hostname(), user = whoami(), name = process.env.AGENT_NAME || null, inbox = false, health = null, platform = process.platform } = {}) {
  if (!e || typeof e !== "object" || !e.session_id || !e.hook_event_name) return null;
  const ev = String(e.hook_event_name).slice(0, 40);
  const tool = e.tool_name ? String(e.tool_name).slice(0, 100) : null;
  const out = {
    type: "hook", t: now.toISOString(), session: String(e.session_id), ev,
    cwd: e.cwd || null, gitRoot,
    tool, target: !tool ? null : detail ? targetOf(e.tool_input) : liteTarget(tool, e.tool_input),
    toolUseId: e.tool_use_id ? String(e.tool_use_id).slice(0, 100) : null,
    agentId: e.agent_id ? String(e.agent_id).slice(0, 100) : null,
    agentType: short(e.agent_type, 60),
    name, host, user, health,
  };
  switch (ev) {
    case "UserPromptSubmit": {
      const c = cleanPrompt(e.prompt);
      // Detail off: send the 2–3 word label instead of the prompt text.
      Object.assign(out, detail ? { prompt: short(c.text, PROMPT) } : { label: c.command ? null : agentLabel(c.text.slice(0, 1000)) },
        { openedFile: short(c.openedFile, ITEM), command: short(c.command, 60) });
      break;
    }
    case "PreToolUse": case "PermissionRequest": out.detail = detailOf(tool, e.tool_input, detail); break;
    case "PostToolUse": case "PostToolUseFailure":
      out.result = resultOf(e, detail);
      if (Number.isFinite(e.duration_ms) && e.duration_ms >= 0) out.durationMs = Math.round(e.duration_ms);
      break;
    // Detail off: only the type. The text can come from an MCP server asking for input.
    case "Notification": Object.assign(out, { message: detail ? short(e.message, 300) : null, title: detail ? short(e.title, 100) : null, notificationType: short(e.notification_type, 40) }); break;
    // stop_hook_active: Claude is already carrying on because a Stop hook blocked it. Then it never asks for messages,
    // so a message can't keep it going round in a loop.
    case "Stop": case "SubagentStop": Object.assign(out, { lastMessage: detail ? head(e.last_assistant_message, TAIL) : null, stopActive: e.stop_hook_active === true || null,
      inbox: (ev === "Stop" && inbox && e.stop_hook_active !== true) || null }); break;
    case "SessionStart": Object.assign(out, { source: short(e.source, 20), model: short(e.model, 80), os: short(platform, 20) }); break;
    case "SessionEnd": out.reason = short(e.reason, 40); break;
    // The turn ended on an API error. The message is Claude Code's error text, not Claude's reply.
    case "StopFailure": Object.assign(out, { failure: short(e.error, 40), message: detail ? short(e.last_assistant_message || e.error_details, 300) : null }); break;
    default: break;
  }
  return pick(out);
}

// ---- git root: walk up for .git (a folder, or a file in worktrees and submodules), cached per cwd ----
const isRepo = (dir) => { try { fs.statSync(path.join(dir, ".git")); return true; } catch { return false; } };

function walkUp(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (isRepo(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Git root for cwd, using a small cache file so most events cost one read. */
function gitRootOf(cwd, cacheFile = path.join(DIR, "spool", "gitroots.json"), now = Date.now()) {
  if (!cwd || typeof cwd !== "string") return null;
  let cache = {};
  try { cache = obj(JSON.parse(fs.readFileSync(cacheFile, "utf8"))); } catch {}
  const hit = cache[cwd];
  if (hit && now - hit.t < ROOT_TTL && (hit.root === null || isRepo(hit.root))) return hit.root;
  const root = walkUp(cwd);
  try {
    delete cache[cwd];
    cache[cwd] = { root, t: now };
    const keys = Object.keys(cache);
    for (const k of keys.slice(0, Math.max(0, keys.length - ROOT_CACHE))) delete cache[k];
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    // Written in place, no temp file: a torn write by a parallel hook just fails to parse next time.
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  } catch {}
  return root;
}

const isOff = (v) => v === false || /^(0|false|off|no)$/i.test(String(v ?? "").trim());
/** Detail capture is on unless AGENT_OFFICE_DETAIL=0 or config captureDetail is false (or "false", "0", "off", "no"). */
function wantDetail(cfg, env = process.env) {
  return !isOff(env.AGENT_OFFICE_DETAIL) && !isOff(cfg.captureDetail);
}
/** Messages from the dashboard reach this machine's sessions unless AGENT_OFFICE_INBOX=0. */
const wantInbox = (env = process.env) => !isOff(env.AGENT_OFFICE_INBOX);

// ---- waiting for the dashboard's answer to a permission request ----
/** "120" → 120 seconds, at most HOLD_MAX; empty or not a number → dflt. */
function holdSeconds(v, dflt) {
  const s = String(v ?? "").trim(), n = Number(s);
  return s && Number.isFinite(n) && n >= 0 ? Math.min(HOLD_MAX, Math.floor(n)) : dflt;
}
/** The wait the installer sets up: AGENT_OFFICE_HOLD seconds, 120 by default, 0 to answer only in the terminal. */
const holdSetting = (env = process.env) => holdSeconds(env.AGENT_OFFICE_HOLD, HOLD_DEFAULT);

/** How long this hook may wait: the --hold=N the installer added (it gave Claude Code a timeout of N + 10 s), lowered
 *  by AGENT_OFFICE_HOLD. Without --hold (installed before answering existed, with a 5 s timeout) it never waits. */
function holdFor(argv = process.argv, env = process.env) {
  const arg = argv.find((a) => String(a).startsWith("--hold="));
  const max = arg ? holdSeconds(arg.slice(7), 0) : 0;
  return Math.min(max, holdSeconds(env.AGENT_OFFICE_HOLD, max));
}

/** A PermissionRequest may wait for the dashboard only with detail capture on, for a tool whose request the dashboard
 *  shows, and only when the event carries the command, URL, search pattern, file filter or query exactly as given (not
 *  cut short, not folded onto one line): you never approve a part you can't see. */
function canHold(e, detail) {
  if (!detail || !e || e.hook_event_name !== "PermissionRequest" || !HOLDABLE.has(e.tool_name)) return false;
  const input = obj(e.tool_input), whole = (v, cut) => typeof v !== "string" || !v || cut(v) === v;
  return whole(input.command, (v) => head(v, CMD)) && whole(input.url, (v) => head(v, CMD)) &&
    ["pattern", "glob", "query"].every((k) => whole(input[k], (v) => short(v, ITEM)));
}

/** The only two answers that ever reach Claude Code, whatever the server sends: allow, or deny with a message. */
function decisionOf(d) {
  const x = obj(d);
  if (x.behavior === "allow") return { behavior: "allow" };
  if (x.behavior === "deny") return { behavior: "deny", message: head(typeof x.message === "string" ? x.message.trim() : "", MESSAGE) || DENIED };
  return null;
}
const hookOutput = (decision) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });

/** The Stop hook's reply that makes Claude carry on with your messages from the dashboard, oldest first, or null when
 *  the server sent none. Built here from plain strings only, bounded, whatever else the server sends. */
function blockOf(reply) {
  const raw = obj(reply).messages, list = (Array.isArray(raw) ? raw : []).filter((m) => typeof m === "string" && m.trim())
    .slice(0, INBOX).map((m) => head(m.trim(), MESSAGE));
  if (!list.length) return null;
  const reason = list.length === 1 ? `New message from your lead: ${list[0]}` : `New messages from your lead:\n${list.map((m) => `- ${m}`).join("\n")}`;
  return JSON.stringify({ decision: "block", reason });
}

// ---- the spool (see SPOOL above) ----
function spool(event, dir = SPOOL, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pending.jsonl");
  fs.appendFileSync(file, JSON.stringify(event) + "\n");
  try { if (fs.statSync(file).size > SEAL) { seal(dir, now); capSpool(dir, now); } } catch {}
}

/** Keeps the spool's files under SPOOL_MAX bytes in all: past it, the oldest batch files go until they're under
 *  SPOOL_KEEP (so most seals drop nothing), and drops.log notes how many events went. Batches on their way and what's
 *  still to be sealed stay. Returns how many events were dropped; never throws. */
function capSpool(dir = SPOOL, now = Date.now()) {
  let names, total = 0, n = 0;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const batches = [];
  for (const f of names) {
    let size;
    try { size = fs.statSync(path.join(dir, f)).size; } catch { continue; }
    total += size;
    const m = BATCH_FILE.exec(f);
    if (m) batches.push([f, size, Number(m[1])]);
  }
  if (total <= SPOOL_MAX) return 0;
  for (const [f, size, count] of batches.sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (total <= SPOOL_KEEP) break;
    try { fs.unlinkSync(path.join(dir, f)); } catch { continue; } // a flush or the server took it meanwhile
    total -= size;
    n += count;
  }
  if (n) noteDrop(dir, n, now);
  return n;
}

/** Seals up to SEAL_RUN bytes of spooled events into batch files: first a seal that a dead hook left, or that stopped at
 *  SEAL_RUN (its name says how far it got), else pending.jsonl. */
function seal(dir = SPOOL, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const left = names.map((f) => SEALING_FILE.exec(f)).find((m) => m && now - Number(m[1]) > ORPHAN);
  const from = left ? left[0] : names.includes("pending.jsonl") ? "pending.jsonl" : null;
  if (!from) return;
  const id = left ? left[2] : rand8(), offset = left ? Number(left[3]) : 0, work = path.join(dir, `sealing-${stamp(now)}-${id}-${offset}.jsonl`);
  try { fs.renameSync(path.join(dir, from), work); } catch { return; } // another hook, or the server, got there first
  let fd = null;
  try {
    fd = fs.openSync(work, "r");
    const buf = Buffer.alloc(SEAL_RUN), n = fs.readSync(fd, buf, 0, SEAL_RUN, offset);
    // A hook that opened pending.jsonl just before the rename appends to this file. If it grew while we read, the line
    // read last may be half there: this run takes whole lines only, and the rest waits. A full read takes whole lines
    // too (all of it if one line fills it).
    const whole = n ? buf.lastIndexOf(10, n - 1) + 1 : 0, grown = () => fs.fstatSync(fd).size > offset + n;
    const cut = n === SEAL_RUN ? whole || n : grown() ? whole : n;
    writeBatches(dir, buf.toString("utf8", 0, cut), now, id);
    // Checked again after the batches are written, for one that appended meanwhile. (One that appends between this
    // check and the unlink is lost: a window of microseconds.)
    const grew = grown();
    fs.closeSync(fd);
    fd = null;
    // The rest waits for the next run, claimed by nobody (time 0).
    if (n < SEAL_RUN && !grew) fs.unlinkSync(work); else fs.renameSync(work, path.join(dir, `sealing-${stamp(0)}-${id}-${offset + cut}.jsonl`));
  } catch {} finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

/** Spooled lines as batch files, oldest first by name. A line a crash cut short is dropped. */
function writeBatches(dir, text, now, id) {
  let list = [], size = 0, i = 0;
  const out = () => {
    if (!list.length) return;
    fs.writeFileSync(path.join(dir, `batch-${stamp(now)}-${id}-${String(i++).padStart(4, "0")}-${list.length}.jsonl`), list.join("\n") + "\n");
    list = []; size = 0;
  };
  for (const l of text.split("\n")) {
    if (!l || !parses(l)) continue;
    const b = Buffer.byteLength(l) + 1;
    if (list.length >= BATCH || (list.length && size + b > BATCH_BYTES)) out();
    list.push(l);
    size += b;
  }
  out();
}

/** Lines in a file of at most COUNT_MAX bytes; null when it's bigger. */
function linesIn(file) {
  try {
    if (fs.statSync(file).size > COUNT_MAX) return null;
    const b = fs.readFileSync(file);
    let n = 0;
    for (let i = b.indexOf(10); i >= 0; i = b.indexOf(10, i + 1)) n++;
    return n;
  } catch { return 0; }
}

/** Events waiting in the spool: batch files (and ones on their way) say how many in their name; pending.jsonl is
 *  counted. more = some aren't counted yet (a seal under way, or an old spool too big to count here). */
function backlogOf(dir = SPOOL) {
  let names, n = 0, more = false;
  try { names = fs.readdirSync(dir); } catch { return { n, more }; }
  for (const f of names) {
    const m = BATCH_FILE.exec(f) || SENDING_FILE.exec(f);
    if (m) n += Number(m[m.length - 1]);
    else if (SEALING_FILE.test(f)) more = true;
    else if (f === "pending.jsonl") { const c = linesIn(path.join(dir, f)); if (c == null) more = true; else n += c; }
  }
  return { n, more };
}

/** The whole lines in the last `bytes` bytes of a log: the first may start mid-line, and the last may still be on its
 *  way (or was cut off by a crash). None when there's no log. */
function tailLines(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, from = Math.max(0, size - bytes), buf = Buffer.alloc(size - from);
    const lines = buf.toString("latin1", 0, fs.readSync(fd, buf, 0, buf.length, from)).split("\n");
    lines.pop();
    if (from) lines.shift();
    return lines;
  } catch { return []; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

/** Appends a line to a log: one append, so parallel hooks never lose one. Past max bytes the log is rewritten with
 *  keep()'s lines: a temp file of this hook's own, then a rename (a line noted by another hook in between is lost). If
 *  the rename fails, the temp file goes and the log stays as it is. Never throws. */
function noteLine(file, line, max, keep) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
    if (fs.statSync(file).size <= max) return;
  } catch { return; }
  const tmp = `${file}-${process.pid}-${rand8()}.tmp`;
  try {
    fs.writeFileSync(tmp, keep().map((l) => `${l}\n`).join(""));
    fs.renameSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch {} }
}

/** The times (ms) in the last FAILS_TAIL bytes of fails.log, oldest first. */
const failTimes = (file) => tailLines(file, FAILS_TAIL).filter((l) => /^\d{13}$/.test(l)).map(Number).sort((a, b) => a - b);

/** This machine's failed sends of the last hour (ms), at most FAILS, newest last. Two processes' clocks can disagree by
 *  a few ms, so one up to SKEW ahead still counts; further ahead, it's not a time this machine's clock gave. */
function failsOf(dir = SPOOL, now = Date.now()) {
  return failTimes(path.join(dir, FAILS_FILE)).filter((t) => t - now <= SKEW && now - t < HOUR).slice(-FAILS);
}

/** Notes a send that didn't go through. Past FAILS_LOG bytes, fails.log keeps its newest FAILS. */
function noteFail(dir = SPOOL, now = Date.now()) {
  const file = path.join(dir, FAILS_FILE);
  noteLine(file, stamp(now), FAILS_LOG, () => failTimes(file).slice(-FAILS).map((t) => stamp(t)));
}

/** The events dropped from the spool in the last DAY (see capSpool), and when the newest went (ms, null for none). */
function dropsOf(dir = SPOOL, now = Date.now()) {
  let n = 0, at = null;
  for (const l of tailLines(path.join(dir, DROPS_FILE), DROPS_TAIL)) {
    const m = /^(\d{13}) (\d{1,12})$/.exec(l), t = m ? Number(m[1]) : 0;
    if (!m || t - now > SKEW || now - t >= DAY) continue;
    n += Number(m[2]);
    if (at == null || t > at) at = t;
  }
  return { n, at };
}

/** Notes n events dropped. Past DROPS_LOG bytes, drops.log is one line: the last DAY's added up, at the newest's time. */
function noteDrop(dir, n, now = Date.now()) {
  noteLine(path.join(dir, DROPS_FILE), `${stamp(now)} ${n}`, DROPS_LOG, () => { const d = dropsOf(dir, now); return d.n ? [`${stamp(d.at)} ${d.n}`] : []; });
}

/** What the event tells the server about this machine's sends: the failed ones of the last hour, how many events wait
 *  in the spool (more: and some not counted yet), and how many it dropped in the last day for lack of room (droppedAt:
 *  the newest drop). Null when there's nothing to tell. */
function healthOf(dir = SPOOL, now = Date.now()) {
  const fails = failsOf(dir, now), b = backlogOf(dir), d = dropsOf(dir, now);
  if (!fails.length && !b.n && !b.more && !d.n) return null;
  return pick({ fails: fails.length ? fails.map((t) => new Date(t).toISOString()) : null, backlog: b.n || null, more: b.more || null,
    dropped: d.n || null, droppedAt: d.n ? new Date(d.at).toISOString() : null });
}

/**
 * After a send that went through: seals what's pending, then sends the oldest batch in one call. Through: deleted.
 * Refused as a bad request or too large (the server will never take it): dropped, so it can't hold up the rest.
 * Anything else: it goes back, noted as a failed send at now. done() when that's settled; never throws.
 */
function flush(cfg, done, dir = SPOOL, now = Date.now()) {
  let claim = null, body = null;
  try {
    seal(dir, now);
    for (const f of fs.readdirSync(dir)) {
      const m = SENDING_FILE.exec(f);
      if (m && now - Number(m[1]) > ORPHAN) try { fs.renameSync(path.join(dir, f), path.join(dir, `batch-${m[2]}`)); } catch {}
    }
    for (const f of fs.readdirSync(dir).sort()) {
      if (!BATCH_FILE.test(f)) continue;
      const to = path.join(dir, `sending-${stamp(now)}-${f.slice(6)}`);
      try { fs.renameSync(path.join(dir, f), to); claim = { to, back: path.join(dir, f) }; break; } catch {}
    }
    if (!claim) return done();
    body = `[${fs.readFileSync(claim.to, "utf8").split("\n").filter((l) => l && parses(l)).join(",")}]`;
  } catch {
    if (claim) try { fs.renameSync(claim.to, claim.back); } catch {}
    return done();
  }
  request("POST", "/api/events", cfg, { body, timeout: FLUSH_MS }, (code) => {
    try {
      if ((code >= 200 && code < 300) || code === 400 || code === 413) fs.unlinkSync(claim.to);
      else { fs.renameSync(claim.to, claim.back); noteFail(dir, now); }
    } catch {}
    done();
  });
}

/** For the server on this machine: claims every spooled file it should read now (batches, pending.jsonl, and what a dead
 *  hook left), renamed to ingest-*. Returns [{ file, offset }]: read each from offset, then delete it. */
function claimSpool(dir, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  const out = [];
  for (const f of names) {
    const s = SENDING_FILE.exec(f), m = SEALING_FILE.exec(f);
    if (!BATCH_FILE.test(f) && f !== "pending.jsonl" && !((s || m) && now - Number((s || m)[1]) > ORPHAN)) continue;
    const file = path.join(dir, `ingest-${stamp(now)}-${rand8()}.jsonl`);
    try { fs.renameSync(path.join(dir, f), file); out.push({ file, offset: m ? Number(m[3]) : 0 }); } catch {}
  }
  return out;
}

function readConfig() {
  try { return obj(JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"))); } catch { return {}; }
}

/** One call to the server, over within `timeout` ms however slowly the server sends. done(status, json) once: status 0
 *  when no reply came; a reply cut off after its status line keeps that status with json null, since the server had
 *  already handled the call. Replies over 64 KB are cut off. */
function request(method, pathname, cfg, { body = null, timeout }, done) {
  const base = process.env.AGENT_OFFICE_URL || cfg.serverUrl || `http://127.0.0.1:${cfg.port || 4380}`;
  const token = process.env.AGENT_OFFICE_TOKEN || cfg.token;
  let url;
  try { url = new URL(pathname, base); } catch { return done(0, null); }
  let finished = false, status = 0, deadline = null;
  const finish = (data) => { if (!finished) { finished = true; clearTimeout(deadline); done(status, data); } };
  const headers = { Authorization: `Bearer ${token || ""}` };
  if (body != null) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  const req = (url.protocol === "https:" ? https : http).request(url, { method, headers, timeout }, (res) => {
    status = res.statusCode;
    const chunks = [];
    let size = 0;
    res.on("data", (c) => { size += c.length; if (size > 65536) req.destroy(); else chunks.push(c); });
    res.on("end", () => { let data = null; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {} finish(data); });
    res.on("close", () => finish(null)); // cut off before the end
  });
  // The socket timeout only notices silence; a server that trickles bytes is stopped by this.
  deadline = setTimeout(() => req.destroy(new Error("deadline")), timeout);
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", () => finish(null));
  req.end(body == null ? undefined : body);
}

/** Sends the event, or spools it (and notes the failed send) when the server can't take it. done(reply, ok): the
 *  server's JSON, or null; ok = it went through. */
function send(event, cfg, done) {
  request("POST", "/api/events", cfg, { body: JSON.stringify(event), timeout: 1500 }, (code, data) => {
    const ok = code >= 200 && code < 300;
    // By the time the server reads the spool, the terminal has had the question: the copy doesn't wait. A Stop's copy
    // keeps inbox (the dashboard shows this machine takes messages) but never gets any: the server hands them over
    // only in its reply to a live Stop, never to a batch. A reply cut off after a 2xx status line was already taken: no copy.
    if (!ok) { const { hold, ...rest } = event; try { spool(rest); } catch {} noteFail(); }
    done(ok ? data : null, ok);
  });
}

/** Long-polls the dashboard's answer until the deadline. done(decision), or done(null): no answer, or the server went away. */
function waitForDecision(askId, cfg, deadline, done) {
  // The server closes the poll at the end of its window, which it started before this deadline, so rounding up is safe.
  const left = deadline - Date.now();
  if (left < 1000) return done(null);
  const wait = Math.min(POLL, Math.ceil(left / 1000)), asked = Date.now();
  request("GET", `/api/decision/${encodeURIComponent(askId)}?wait=${wait}`, cfg, { timeout: (wait + 5) * 1000 }, (code, data) => {
    if (code !== 200 || !data) return done(null);
    if (data.status === "answered") return done(decisionOf(data.decision));
    if (data.status !== "pending") return done(null);
    // A server that says "pending" straight away is asked again a second later, not in a busy loop.
    setTimeout(() => waitForDecision(askId, cfg, deadline, done), Math.max(0, 1000 - (Date.now() - asked)));
  });
}

function main() {
  const quit = () => process.exit(0);
  process.on("uncaughtException", quit);
  const chunks = [];
  const hardStop = setTimeout(quit, 4000);
  hardStop.unref();
  process.stdin.on("data", (d) => chunks.push(d));
  process.stdin.on("error", quit);
  process.stdout.on("error", quit);
  process.stdin.on("end", () => {
    try {
      const e = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const cfg = readConfig(), detail = wantDetail(cfg), health = healthOf();
      const event = build(e, { detail, gitRoot: gitRootOf(e && e.cwd), inbox: wantInbox(), health });
      if (!event) return quit();
      // A Stop that can take messages: the server's reply carries any you sent, and printing them is all it adds.
      if (event.inbox) return send(event, cfg, (reply) => { const out = blockOf(reply); if (!out) return quit(); process.stdout.write(out + "\n", quit); });
      const hold = canHold(e, detail) ? holdFor() : 0;
      // Events wait in the spool and the server answered quickly: one batch of them goes too.
      const queued = !!(health && (health.backlog || health.more)), t0 = Date.now();
      if (!hold) return send(event, cfg, (reply, ok) => (ok && queued && Date.now() - t0 < FAST ? flush(cfg, quit) : quit()));
      // The one wait the hook allows: `hold` seconds for an answer from the dashboard, well inside Claude Code's timeout.
      clearTimeout(hardStop);
      setTimeout(quit, (hold + 5) * 1000).unref();
      event.hold = hold;
      send(event, cfg, (reply) => {
        const askId = reply && typeof reply.askId === "string" ? reply.askId : null;
        if (!askId) return quit();
        waitForDecision(askId, cfg, Date.now() + hold * 1000, (decision) => {
          if (!decision) return quit();
          process.stdout.write(hookOutput(decision) + "\n", quit);
        });
      });
    } catch { quit(); }
  });
}

if (require.main === module) main();
module.exports = { build, targetOf, changed, gitRootOf, walkUp, wantDetail, wantInbox, holdSeconds, holdSetting, holdFor, canHold, decisionOf, hookOutput, blockOf,
  spool, seal, capSpool, backlogOf, failsOf, noteFail, dropsOf, noteDrop, healthOf, flush, claimSpool,
  SPOOL_LIMITS: { SEAL, SEAL_RUN, BATCH, BATCH_BYTES, ORPHAN, FAILS, FAILS_LOG, SPOOL_MAX, SPOOL_KEEP, DROPS_LOG } };
