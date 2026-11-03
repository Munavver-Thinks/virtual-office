"use strict";
// Adds or removes Agent Office in Claude Code's ~/.claude/settings.json.
// Pure functions (applyInstall / applyUninstall) are exported for tests.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { holdSeconds, holdSetting } = require("./hook");

// v1 registered the first 7; re-running install adds the rest.
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
  "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "SessionEnd"];
// Tool events match on the tool name; "*" means every tool.
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"]);
const MARK = "agent-office";
const TELEMETRY_KEYS = ["CLAUDE_CODE_ENABLE_TELEMETRY", "OTEL_LOGS_EXPORTER", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"];

function settingsPath() { return path.join(os.homedir(), ".claude", "settings.json"); }
function hookCommand() { return `node "${path.resolve(__dirname, "hook.js")}" --agent-office`; }
const ours = (h) => String((h && h.command) || "").includes("--agent-office");

function stripHooks(settings) {
  const hooks = { ...(settings.hooks || {}) };
  for (const ev of Object.keys(hooks)) {
    const groups = (hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
    if (groups.length) hooks[ev] = groups; else delete hooks[ev];
  }
  return hooks;
}

/**
 * plans: also set CLAUDE_CODE_ENABLE_TODO_TOOLS=1, so models newer than Opus 4.7 / Sonnet 4.6 / Haiku 4.5 keep a plan.
 * Re-running install without it keeps a plans setting made earlier; uninstall removes it.
 * hold: seconds a permission request waits for an answer from the dashboard (AGENT_OFFICE_HOLD, 0 = terminal only).
 * The hook gets it as --hold=N and Claude Code a timeout of N + 10 s, so the wait always ends before Claude Code's does.
 * @returns {{settings: object, warnings: string[], telemetry: boolean, plans: boolean, hold: number}}
 */
function applyInstall(settings, { command, telemetry = true, plans = false, url = "http://127.0.0.1:4380", token, hold = holdSetting() }) {
  const warnings = [], wait = holdSeconds(hold, 0);
  const out = { ...settings, hooks: stripHooks(settings) };
  for (const ev of EVENTS) {
    const group = { hooks: [ev === "PermissionRequest" ? { type: "command", command: `${command} --hold=${wait}`, timeout: wait + 10 } : { type: "command", command, timeout: 5 }] };
    if (TOOL_EVENTS.has(ev)) group.matcher = "*";
    out.hooks[ev] = [...(out.hooks[ev] || []), group];
  }
  let telemetryOn = false;
  if (telemetry) {
    const env = { ...(settings.env || {}) };
    const existing = env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (existing && existing !== url && env.AGENT_OFFICE_TELEMETRY !== "1") {
      warnings.push(`You already send Claude Code telemetry to ${existing}, so cost tracking was not turned on. Point a collector at ${url} to add it.`);
    } else {
      Object.assign(env, {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: url,
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
        AGENT_OFFICE_TELEMETRY: "1",
      });
      telemetryOn = true;
    }
    out.env = env;
  }
  if (plans) {
    const env = { ...(out.env || {}) };
    if (env.CLAUDE_CODE_ENABLE_TODO_TOOLS !== undefined && env.AGENT_OFFICE_PLANS !== "1") {
      warnings.push(`You already set CLAUDE_CODE_ENABLE_TODO_TOOLS=${env.CLAUDE_CODE_ENABLE_TODO_TOOLS}, so --with-plans left it alone.`);
    } else {
      Object.assign(env, { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", AGENT_OFFICE_PLANS: "1" });
    }
    out.env = env;
  }
  return { settings: out, warnings, telemetry: telemetryOn, plans: (out.env || {}).CLAUDE_CODE_ENABLE_TODO_TOOLS === "1", hold: wait };
}

/** Removes our hooks, and the telemetry and plans settings only where we set them. */
function applyUninstall(settings) {
  const out = { ...settings, hooks: stripHooks(settings) };
  if (!Object.keys(out.hooks).length) delete out.hooks;
  const env = { ...(settings.env || {}) }, ours = [];
  if (env.AGENT_OFFICE_TELEMETRY === "1") ours.push(...TELEMETRY_KEYS, "AGENT_OFFICE_TELEMETRY");
  if (env.AGENT_OFFICE_PLANS === "1") ours.push("CLAUDE_CODE_ENABLE_TODO_TOOLS", "AGENT_OFFICE_PLANS");
  if (ours.length) {
    for (const k of ours) delete env[k];
    if (Object.keys(env).length) out.env = env; else delete out.env;
  }
  return out;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  try { return JSON.parse(text || "{}"); } catch {
    throw new Error(`${file} isn't valid JSON. Fix it first, then run this again.`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".agent-office.bak");
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

const hasOurs = (settings, ev) => (settings.hooks?.[ev] || []).some((g) => (g.hooks || []).some(ours));

/** Seconds our PermissionRequest hook may wait for an answer from the dashboard, or null when it was installed before
 *  answering existed (no --hold, a 5 s timeout: it never waits). */
function installedHold(settings) {
  for (const g of settings.hooks?.PermissionRequest || []) {
    for (const h of g.hooks || []) {
      const m = ours(h) && /--hold=(\d+)/.exec(h.command);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

/** True only when every event we need is registered, the permission hook with its hold. */
function isInstalled(settings) {
  return EVENTS.every((ev) => hasOurs(settings, ev)) && installedHold(settings) != null;
}

/** "installed", "outdated" (an older install that misses newer events) or "missing". */
function installState(settings) {
  if (isInstalled(settings)) return "installed";
  return EVENTS.some((ev) => hasOurs(settings, ev)) ? "outdated" : "missing";
}

module.exports = { EVENTS, settingsPath, hookCommand, applyInstall, applyUninstall, readSettings, writeSettings, isInstalled, installState, installedHold };
