#!/usr/bin/env node
"use strict";
// Claude Code hook for Agent Office.
// Sends each event to the Agent Office server. If the server is down, it saves the
// event to a local spool file that the server picks up later.
// It never blocks Claude: errors are swallowed, nothing is printed, and it always exits 0 quickly.

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { cleanPrompt, agentLabel } = require("./text");

const DIR = process.env.AGENT_OFFICE_DIR || path.join(os.homedir(), ".agent-office");
// Size bounds for everything we keep from Claude Code's payload.
const CMD = 500, ITEM = 200, PROMPT = 600, DIFF = 4096, TAIL = 1536, TODOS = 50, HUNKS = 10;
const TERMINAL = new Set(["Bash", "PowerShell"]);
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const ROOT_TTL = 10 * 60000, ROOT_CACHE = 200;

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
 * Builds the event we send. Pure apart from the defaults for host, user and name.
 * @param {object} e  Claude Code's hook payload
 * @param {{now?: Date, detail?: boolean, gitRoot?: string|null, host?: string, user?: string|null, name?: string|null}} opts
 */
function build(e, { now = new Date(), detail = true, gitRoot = null, host = os.hostname(), user = whoami(), name = process.env.AGENT_NAME || null } = {}) {
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
    name, host, user,
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
    case "Stop": case "SubagentStop": Object.assign(out, { lastMessage: detail ? head(e.last_assistant_message, TAIL) : null, stopActive: e.stop_hook_active === true || null }); break;
    case "SessionStart": Object.assign(out, { source: short(e.source, 20), model: short(e.model, 80) }); break;
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

function spool(event) {
  const dir = path.join(DIR, "spool");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "pending.jsonl"), JSON.stringify(event) + "\n");
}

function readConfig() {
  try { return obj(JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"))); } catch { return {}; }
}

function send(event, cfg, done) {
  const base = process.env.AGENT_OFFICE_URL || cfg.serverUrl || `http://127.0.0.1:${cfg.port || 4380}`;
  const token = process.env.AGENT_OFFICE_TOKEN || cfg.token;
  let url;
  try { url = new URL("/api/events", base); } catch { spool(event); return done(); }
  const body = JSON.stringify(event);
  const lib = url.protocol === "https:" ? https : http;
  let finished = false;
  const finish = (ok) => { if (finished) return; finished = true; if (!ok) { try { spool(event); } catch {} } done(); };
  const req = lib.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${token || ""}` },
    timeout: 1500,
  }, (res) => { res.resume(); finish(res.statusCode >= 200 && res.statusCode < 300); });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", () => finish(false));
  req.end(body);
}

function main() {
  const chunks = [];
  const hardStop = setTimeout(() => process.exit(0), 4000);
  hardStop.unref();
  process.stdin.on("data", (d) => chunks.push(d));
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("end", () => {
    try {
      const e = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const cfg = readConfig();
      const event = build(e, { detail: wantDetail(cfg), gitRoot: gitRootOf(e && e.cwd) });
      if (!event) return process.exit(0);
      send(event, cfg, () => process.exit(0));
    } catch { process.exit(0); }
  });
}

if (require.main === module) main();
module.exports = { build, targetOf, changed, gitRootOf, walkUp, wantDetail };
