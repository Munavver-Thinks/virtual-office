"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { Store, localDate } = require("../src/store");

const cfg = { offlineAfterMin: 30, retentionDays: 30, dailyBudgetUsd: 0, aliases: {} };
const mk = (over = {}, dataDir = null) => new Store({ getConfig: () => ({ ...cfg, ...over }), dataDir });
const now = () => new Date().toISOString();

test("hook events drive the agent state", () => {
  const s = mk();
  s.apply({ type: "hook", t: now(), session: "a", ev: "UserPromptSubmit", cwd: "/p/aurum", prompt: "Add tax" });
  let a = s.agents()[0];
  assert.equal(a.state, "working"); assert.equal(a.task, "Add tax"); assert.equal(a.name, "aurum");
  s.apply({ type: "hook", t: now(), session: "a", ev: "PreToolUse", tool: "Edit", target: "x.ts" });
  a = s.agents()[0]; assert.equal(a.tool, "Edit"); assert.equal(a.toolCount, 1);
  s.apply({ type: "hook", t: now(), session: "a", ev: "Notification", message: "Needs permission" });
  assert.equal(s.agents()[0].state, "waiting");
  s.apply({ type: "hook", t: now(), session: "a", ev: "PostToolUse" });
  assert.equal(s.agents()[0].state, "waiting", "PostToolUse must not clear waiting");
  s.apply({ type: "hook", t: now(), session: "a", ev: "Stop" });
  assert.equal(s.agents()[0].state, "idle");
  s.apply({ type: "hook", t: now(), session: "a", ev: "SessionEnd" });
  assert.equal(s.agents()[0].state, "offline");
});

test("stale sessions go offline", () => {
  const s = mk({ offlineAfterMin: 1 });
  s.apply({ type: "hook", t: new Date(Date.now() - 5 * 60000).toISOString(), session: "a", ev: "UserPromptSubmit" });
  assert.equal(s.agents()[0].state, "offline");
});

test("usage adds cost, tokens and daily totals", () => {
  const s = mk();
  s.apply({ type: "hook", t: now(), session: "a", ev: "SessionStart", cwd: "/p/billing" });
  s.apply({ type: "usage", t: now(), session: "a", cost: 0.5, input: 100, output: 50, cacheRead: 10, model: "m" });
  s.apply({ type: "usage", t: now(), session: "a", cost: 0.25, input: 10 });
  const a = s.agents()[0];
  assert.equal(a.cost, 0.75); assert.equal(a.tokens.input, 110); assert.equal(a.requests, 2);
  const snap = s.snapshot();
  assert.equal(snap.totals.todayCost, 0.75); assert.equal(snap.totals.todayTokens, 170);
  assert.equal(s.report(1)[0].byProject.billing, 0.75);
});

test("budget alert fires once per day", () => {
  const s = mk({ dailyBudgetUsd: 1 });
  let fired = 0; s.on("budget", () => fired++);
  for (let i = 0; i < 3; i++) s.apply({ type: "usage", t: now(), session: "a", cost: 0.6 });
  assert.equal(fired, 1);
});

test("transition event on state change", () => {
  const s = mk(); const seen = [];
  s.on("transition", (x) => seen.push(x.to));
  s.apply({ type: "hook", t: now(), session: "a", ev: "UserPromptSubmit" });
  s.apply({ type: "hook", t: now(), session: "a", ev: "PreToolUse", tool: "Read" });
  s.apply({ type: "hook", t: now(), session: "a", ev: "Notification" });
  assert.deepEqual(seen, ["working", "waiting"]);
});

test("aliases rename by folder", () => {
  const s = mk({ aliases: { "/p/x": "Billing bot" } });
  s.apply({ type: "hook", t: now(), session: "a", ev: "SessionStart", cwd: "/p/x" });
  assert.equal(s.agents()[0].name, "Billing bot");
});

test("bad events are rejected", () => {
  const s = mk();
  assert.equal(s.apply(null), false);
  assert.equal(s.apply({ type: "hook", ev: "Stop" }), false);
  assert.equal(s.apply({ type: "nope", session: "a" }), false);
});

test("persist and replay rebuild state, old files pruned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-"));
  const s1 = mk({}, dir);
  s1.apply({ type: "hook", t: now(), session: "a", ev: "UserPromptSubmit", cwd: "/p/y", prompt: "hi" });
  s1.apply({ type: "usage", t: now(), session: "a", cost: 1.5 });
  const old = path.join(dir, `events-${localDate(Date.now() - 90 * 86400000)}.jsonl`);
  fs.writeFileSync(old, "");
  const s2 = mk({}, dir);
  assert.equal(s2.replay(), 2);
  assert.equal(s2.agents()[0].cost, 1.5);
  assert.equal(fs.existsSync(old), false);
});
