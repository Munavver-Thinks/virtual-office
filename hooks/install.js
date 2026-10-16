"use strict";
// Adds or removes Agent Office in Claude Code's ~/.claude/settings.json.
// Pure functions (applyInstall / applyUninstall) are exported for tests.
const fs = require("fs");
const path = require("path");
const os = require("os");

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
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
 * @returns {{settings: object, warnings: string[], telemetry: boolean}}
 */
function applyInstall(settings, { command, telemetry = true, url = "http://127.0.0.1:4380", token }) {
  const warnings = [];
  const out = { ...settings, hooks: stripHooks(settings) };
  for (const ev of EVENTS) {
    const group = { hooks: [{ type: "command", command, timeout: 5 }] };
    if (ev === "PreToolUse" || ev === "PostToolUse") group.matcher = "*";
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
  return { settings: out, warnings, telemetry: telemetryOn };
}

function applyUninstall(settings) {
  const out = { ...settings, hooks: stripHooks(settings) };
  if (!Object.keys(out.hooks).length) delete out.hooks;
  if (settings.env && settings.env.AGENT_OFFICE_TELEMETRY === "1") {
    const env = { ...settings.env };
    for (const k of [...TELEMETRY_KEYS, "AGENT_OFFICE_TELEMETRY"]) delete env[k];
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

function isInstalled(settings) {
  return EVENTS.every((ev) => (settings.hooks?.[ev] || []).some((g) => (g.hooks || []).some(ours)));
}

module.exports = { EVENTS, settingsPath, hookCommand, applyInstall, applyUninstall, readSettings, writeSettings, isInstalled };
