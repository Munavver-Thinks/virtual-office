"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseLogs } = require("../src/otlp");
const { build, targetOf } = require("../hooks/hook");
const { applyInstall, applyUninstall, isInstalled, installState, EVENTS } = require("../hooks/install");
const { applySettings, DEFAULTS } = require("../src/config");

// ---- OpenTelemetry ----
test("parses api_request log events into usage", () => {
  const body = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
    scopeLogs: [{ logRecords: [
      { timeUnixNano: "1760000000000000000", body: { stringValue: "claude_code.api_request" }, attributes: [
        { key: "event.name", value: { stringValue: "api_request" } },
        { key: "session.id", value: { stringValue: "s1" } },
        { key: "cost_usd", value: { doubleValue: 0.042 } },
        { key: "input_tokens", value: { intValue: "1200" } },
        { key: "output_tokens", value: { stringValue: "300" } },
        { key: "cache_read_tokens", value: { intValue: 5000 } },
        { key: "model", value: { stringValue: "claude-sonnet-4-5" } } ] },
      { body: { stringValue: "claude_code.tool_result" }, attributes: [{ key: "session.id", value: { stringValue: "s1" } }] },
      { attributes: [{ key: "event.name", value: { stringValue: "api_request" } }] },
    ] }] }] };
  const out = parseLogs(body);
  assert.equal(out.length, 1);
  const { t, ...rest } = out[0];
  assert.deepEqual(rest, { type: "usage", session: "s1", cost: 0.042, input: 1200, output: 300, cacheRead: 5000, cacheWrite: 0, model: "claude-sonnet-4-5" });
  assert.equal(t, new Date(1760000000000).toISOString());
});

test("handles empty and malformed OTLP bodies", () => {
  assert.deepEqual(parseLogs({}), []);
  assert.deepEqual(parseLogs(null), []);
  assert.deepEqual(parseLogs({ resourceLogs: [{}] }), []);
});

// ---- hook ----
test("hook builds compact events", () => {
  const e = build({ session_id: "s", hook_event_name: "PreToolUse", cwd: "/p", tool_name: "Bash", tool_input: { command: "npm   test" } });
  assert.equal(e.type, "hook"); assert.equal(e.tool, "Bash"); assert.equal(e.target, "npm test"); assert.equal(e.prompt, null);
  const p = build({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "x".repeat(900) });
  assert.equal(p.prompt.length, 600);
  assert.equal(build({}), null);
});

test("hook target picks the useful field", () => {
  assert.equal(targetOf({ file_path: "a.ts", command: "b" }), "a.ts");
  assert.equal(targetOf({ pattern: "TODO" }), "TODO");
  assert.equal(targetOf(null), null);
});

// ---- installer ----
const cmd = 'node "/x/hook.js" --agent-office';
const theirs = { type: "command", command: "echo mine" };

test("install keeps user hooks and env, and is idempotent", () => {
  const start = { model: "opus", env: { FOO: "1" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [theirs] }] } };
  const once = applyInstall(start, { command: cmd, token: "t" }).settings;
  const twice = applyInstall(once, { command: cmd, token: "t" }).settings;
  assert.equal(twice.model, "opus"); assert.equal(twice.env.FOO, "1");
  assert.equal(twice.env.OTEL_EXPORTER_OTLP_HEADERS, "Authorization=Bearer t");
  assert.ok(isInstalled(twice));
  assert.equal(twice.hooks.PreToolUse.length, 2);
  for (const ev of EVENTS) assert.equal(twice.hooks[ev].flatMap((g) => g.hooks).filter((h) => h.command === cmd).length, 1);
});

test("re-running install upgrades an old 7-event setup", () => {
  const OLD = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
  const hooks = {};
  for (const ev of OLD) hooks[ev] = [{ ...(ev.endsWith("ToolUse") ? { matcher: "*" } : {}), hooks: [{ type: "command", command: 'node "/old/place/hook.js" --agent-office', timeout: 5 }] }];
  hooks.Stop.push({ hooks: [theirs] });
  const old = { hooks };
  assert.equal(isInstalled(old), false);
  assert.equal(installState(old), "outdated");
  assert.equal(installState({}), "missing");
  const up = applyInstall(old, { command: cmd, token: "t", telemetry: false }).settings;
  assert.equal(installState(up), "installed");
  for (const ev of ["PermissionRequest", "SubagentStart", "SubagentStop", "PostToolUseFailure", "StopFailure"]) assert.ok(up.hooks[ev], ev);
  for (const ev of EVENTS) {
    const mine = up.hooks[ev].flatMap((g) => g.hooks).filter((h) => String(h.command).includes("--agent-office"));
    assert.equal(mine.length, 1, ev); assert.equal(mine[0].command, cmd, "old path replaced"); assert.equal(mine[0].timeout, 5);
  }
  assert.equal(up.hooks.PermissionRequest[0].matcher, "*"); assert.equal(up.hooks.PostToolUseFailure[0].matcher, "*");
  assert.equal(up.hooks.SubagentStart[0].matcher, undefined);
  assert.ok(up.hooks.Stop.some((g) => g.hooks.includes(theirs)), "user hooks kept");
  assert.deepEqual(applyInstall(up, { command: cmd, token: "t", telemetry: false }).settings, up, "idempotent");
});

test("install does not override another telemetry endpoint", () => {
  const r = applyInstall({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.corp" } }, { command: cmd, token: "t" });
  assert.equal(r.telemetry, false); assert.equal(r.warnings.length, 1);
  assert.equal(r.settings.env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://otel.corp");
});

test("uninstall removes only our parts", () => {
  const start = { env: { FOO: "1" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [theirs] }] } };
  assert.deepEqual(applyUninstall(applyInstall(start, { command: cmd, token: "t" }).settings), start);
});

test("install --with-plans turns on task tools; uninstall removes them only if we set them", () => {
  const r = applyInstall({ env: { FOO: "1" } }, { command: cmd, token: "t", telemetry: false, plans: true });
  assert.equal(r.plans, true);
  assert.deepEqual(r.settings.env, { FOO: "1", CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", AGENT_OFFICE_PLANS: "1" });
  assert.deepEqual(applyInstall(r.settings, { command: cmd, token: "t", telemetry: false }).settings.env, r.settings.env, "a later install keeps it");
  assert.deepEqual(applyUninstall(r.settings), { env: { FOO: "1" } });
  // The user set it themselves: left alone on install and on uninstall.
  const mine = applyInstall({ env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" } }, { command: cmd, token: "t", telemetry: false, plans: true });
  assert.equal(mine.plans, false); assert.equal(mine.warnings.length, 1);
  assert.equal(mine.settings.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "0");
  assert.deepEqual(applyUninstall(mine.settings), { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" } });
  // With telemetry too, everything we added comes off and the user's env stays.
  const both = applyInstall({ env: { FOO: "1" } }, { command: cmd, token: "t", plans: true }).settings;
  assert.deepEqual(applyUninstall(both), { env: { FOO: "1" } });
  assert.deepEqual(applyUninstall({ env: {} }), { env: {} }, "an env we didn't touch is left as is");
  assert.equal(applyInstall({}, { command: cmd, token: "t", telemetry: false }).plans, false);
});

test("no-telemetry install leaves env alone", () => {
  assert.equal(applyInstall({}, { command: cmd, token: "t", telemetry: false }).settings.env, undefined);
});

// ---- settings validation ----
test("settings validation", () => {
  assert.ok(applySettings(DEFAULTS, { offlineAfterMin: 0 }).error);
  assert.ok(applySettings(DEFAULTS, { dailyBudgetUsd: -1 }).error);
  assert.ok(applySettings(DEFAULTS, { webhookUrl: "ftp://x" }).error);
  assert.equal(applySettings(DEFAULTS, { dailyBudgetUsd: "12.345" }).cfg.dailyBudgetUsd, 12.35);
  const r = applySettings({ ...DEFAULTS, aliases: { "/a": "A" } }, { alias: { folder: "/a", name: "" } });
  assert.deepEqual(r.cfg.aliases, {});
});
