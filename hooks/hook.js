#!/usr/bin/env node
"use strict";
// Claude Code hook for Agent Office.
// Sends each event to the Agent Office server. If the server is down, it saves the
// event to a local spool file that the server picks up later.
// It never blocks Claude: errors are swallowed and it always exits 0 quickly.

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");

const DIR = process.env.AGENT_OFFICE_DIR || path.join(os.homedir(), ".agent-office");

function short(s, n = 200) {
  if (s == null) return null;
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function targetOf(input) {
  if (!input || typeof input !== "object") return null;
  return short(
    input.file_path || input.notebook_path || input.command || input.pattern ||
    input.url || input.query || input.description || input.prompt || null, 140
  );
}

function whoami() {
  try { return os.userInfo().username; } catch { return null; }
}

function build(e, now = new Date()) {
  if (!e || !e.session_id || !e.hook_event_name) return null;
  const ev = e.hook_event_name;
  return {
    type: "hook",
    t: now.toISOString(),
    session: String(e.session_id),
    ev,
    cwd: e.cwd || null,
    tool: e.tool_name || null,
    target: targetOf(e.tool_input),
    prompt: ev === "UserPromptSubmit" ? short(e.prompt) : null,
    message: ev === "Notification" ? short(e.message) : null,
    name: process.env.AGENT_NAME || null,
    host: os.hostname(),
    user: whoami(),
  };
}

function spool(event) {
  const dir = path.join(DIR, "spool");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "pending.jsonl"), JSON.stringify(event) + "\n");
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8")); } catch { return {}; }
}

function send(event, done) {
  const cfg = readConfig();
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
  let raw = "";
  const hardStop = setTimeout(() => process.exit(0), 4000);
  hardStop.unref();
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let event = null;
    try { event = build(JSON.parse(raw || "{}")); } catch {}
    if (!event) process.exit(0);
    try { send(event, () => process.exit(0)); } catch { process.exit(0); }
  });
}

if (require.main === module) main();
module.exports = { build, targetOf, short };
