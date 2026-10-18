"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { Store, localDate } = require("../src/store");

const cfg = { offlineAfterMin: 30, retentionDays: 30, dailyBudgetUsd: 0, aliases: {} };
const mk = (over = {}, dataDir = null) => new Store({ getConfig: () => ({ ...cfg, ...over }), dataDir });
const now = () => new Date().toISOString();
const M = 60000;
// A clock for scripted sessions: at(5) = five minutes after the start, at(5, 30) adds seconds.
const clock = (start = Date.now() - 10 * M) => (min, sec = 0) => new Date(start + min * M + sec * 1000).toISOString();
const hook = (s, at, ev, extra = {}) => s.apply({ type: "hook", t: at, session: "a", ev, cwd: "/p/shop", gitRoot: "/p/shop", ...extra });

test("hook events drive the agent state", () => {
  const s = mk();
  s.apply({ type: "hook", t: now(), session: "a", ev: "UserPromptSubmit", cwd: "/p/aurum", prompt: "Add tax" });
  let a = s.agents()[0];
  assert.equal(a.state, "working"); assert.equal(a.task, "Add tax"); assert.equal(a.name, "aurum · tax");
  s.apply({ type: "hook", t: now(), session: "a", ev: "PreToolUse", tool: "Edit", target: "x.ts" });
  a = s.agents()[0]; assert.equal(a.tool, "Edit"); assert.equal(a.toolCount, 1);
  s.apply({ type: "hook", t: now(), session: "a", ev: "Notification", message: "Needs permission" });
  assert.equal(s.agents()[0].state, "waiting");
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
  assert.deepEqual(snap.totals.todayTokensByType, { input: 110, output: 50, cacheRead: 10, cacheWrite: 0 });
  const day = s.report(1)[0];
  assert.equal(day.byProject.billing, 0.75); assert.equal(day.byModel.m, 0.5); assert.equal(day.byModel.unknown, 0.25);
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

test("aliases rename by folder or git root", () => {
  const s = mk({ aliases: { "/p/x": "Billing bot", "/r/repo": "Repo bot" } });
  s.apply({ type: "hook", t: now(), session: "a", ev: "SessionStart", cwd: "/p/x" });
  s.apply({ type: "hook", t: now(), session: "b", ev: "SessionStart", cwd: "/r/repo/dist", gitRoot: "/r/repo" });
  const names = s.agents().map((a) => a.name).sort();
  assert.deepEqual(names, ["Billing bot", "Repo bot"]);
});

test("bad events are rejected and oversized parts are dropped", () => {
  const s = mk();
  assert.equal(s.apply(null), false);
  assert.equal(s.apply({ type: "hook", ev: "Stop" }), false);
  assert.equal(s.apply({ type: "nope", session: "a" }), false);
  assert.equal(s.apply({ type: "hook", session: "a", ev: "x".repeat(41) }), false);
  const e = Store.clean({ type: "hook", session: "a", ev: "PreToolUse", tool: "Edit", prompt: "p".repeat(9000), detail: { hunks: [{ new: "x".repeat(40000) }] }, result: "nope" });
  assert.equal(e.prompt.length, 4096); assert.equal(e.detail, undefined); assert.equal(e.result, undefined);
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

// ---------- M2: trace, questions, plan, sub-agents, state log ----------

test("trace pairs Pre and Post by tool_use_id, with duration and error status", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "UserPromptSubmit", { prompt: "Fix the basket bill rounding" });
  hook(s, at(1), "PreToolUse", { tool: "Bash", target: "npm test", toolUseId: "t1", detail: { command: "npm test" } });
  hook(s, at(1, 5), "PreToolUse", { tool: "Bash", target: "npm run lint", toolUseId: "t2" });
  hook(s, at(1, 20), "PostToolUseFailure", { tool: "Bash", toolUseId: "t2", result: { ok: false, exitCode: 1, error: "Exit code 1\nlint failed" } });
  hook(s, at(2), "PostToolUse", { tool: "Bash", toolUseId: "t1", result: { ok: true, tail: "12 passed" }, durationMs: 55000 });
  const d = s.detail("a");
  const [t1, t2] = d.trace.filter((x) => x.kind === "tool");
  assert.equal(t1.toolUseId, "t1"); assert.equal(t1.status, "ok"); assert.equal(t1.durationMs, 55000, "the hook's duration_ms wins");
  assert.equal(t1.result.tail, "12 passed"); assert.equal(t1.end, at(2));
  assert.equal(t2.status, "error"); assert.equal(t2.durationMs, 15000); assert.equal(t2.result.exitCode, 1);
  assert.equal(d.trace[0].kind, "prompt");
});

test("older events without tool_use_id pair with the oldest open call of the same tool", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "PreToolUse", { tool: "Read", target: "a.ts" });
  hook(s, at(1), "PreToolUse", { tool: "Read", target: "b.ts" });
  hook(s, at(2), "PostToolUse", { tool: "Read", target: "a.ts" });
  const [a, b] = s.detail("a").trace;
  assert.equal(a.status, "ok"); assert.equal(a.durationMs, 2 * M);
  assert.equal(b.status, "running");
});

test("a permission question is answered when its tool call finishes (no more stuck 'Needs you')", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "UserPromptSubmit", { prompt: "Install the printer filter" });
  hook(s, at(1), "PreToolUse", { tool: "Bash", target: "sudo apt install cups-filters", toolUseId: "t1", detail: { command: "sudo apt install cups-filters" } });
  hook(s, at(1, 1), "PermissionRequest", { tool: "Bash", target: "sudo apt install cups-filters", detail: { command: "sudo apt install cups-filters" } });
  let a = s.agents()[0];
  assert.equal(a.state, "waiting"); assert.equal(a.waitingSince, at(1, 1));
  assert.equal(a.question.qkind, "permission"); assert.equal(a.question.target, "sudo apt install cups-filters");
  assert.equal(a.message, "Wants permission to run a command");
  hook(s, at(1, 7), "Notification", { notificationType: "permission_prompt", message: "Claude needs your permission to use Bash" });
  assert.equal(s.detail("a").conversation.filter((x) => x.kind === "question").length, 1, "PermissionRequest + Notification = one question");
  hook(s, at(5), "PostToolUse", { tool: "Bash", toolUseId: "t1", result: { ok: true } });
  a = s.agents()[0];
  assert.equal(a.state, "working"); assert.equal(a.waitingSince, null); assert.equal(a.question, null); assert.equal(a.message, null);
  const q = s.detail("a").conversation.find((x) => x.kind === "question");
  assert.deepEqual([q.status, q.answeredAt, q.resolvedBy, q.outcome], ["answered", at(5), "tool-finished", "approved"]);
});

test("questions are also answered by a later prompt, Stop, or tool call in the same agent", () => {
  const s = mk(), at = clock();
  const ask = (min) => {
    hook(s, at(min), "PreToolUse", { tool: "Edit", target: ".env", toolUseId: `e${min}` });
    hook(s, at(min, 1), "PermissionRequest", { tool: "Edit", target: ".env" });
    assert.equal(s.agents()[0].state, "waiting");
  };
  ask(0); hook(s, at(2), "UserPromptSubmit", { prompt: "no, skip that" });
  assert.equal(s.agents()[0].state, "working");
  ask(3); hook(s, at(4), "Stop");
  assert.equal(s.agents()[0].state, "idle");
  ask(5);
  hook(s, at(6), "PreToolUse", { tool: "Read", target: "x", toolUseId: "sub1", agentId: "agent-1" });
  assert.equal(s.agents()[0].state, "waiting", "a sub-agent's tool call doesn't answer the main agent's question");
  hook(s, at(7), "PreToolUse", { tool: "Read", target: "y", toolUseId: "r2" });
  assert.equal(s.agents()[0].state, "working");
  const by = s.detail("a").conversation.filter((x) => x.kind === "question").map((q) => q.resolvedBy);
  assert.deepEqual(by, ["prompt", "stop", "next-tool"]);
});

test("a permission prompt reopens a question that a parallel tool call cleared too early", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "PreToolUse", { tool: "Bash", target: "rm -rf dist", toolUseId: "t1" });
  hook(s, at(0, 1), "PermissionRequest", { tool: "Bash", target: "rm -rf dist" });
  hook(s, at(0, 2), "PreToolUse", { tool: "Read", target: "a.ts", toolUseId: "t2" });
  assert.equal(s.agents()[0].state, "working");
  hook(s, at(0, 7), "Notification", { notificationType: "permission_prompt", message: "Claude needs your permission to use Bash" });
  const a = s.agents()[0];
  assert.equal(a.state, "waiting"); assert.equal(a.waitingSince, at(0, 1));
  assert.equal(s.detail("a").conversation.filter((x) => x.kind === "question").length, 1);
});

test("idle notifications don't mean 'needs you'; elicitations and older notifications do", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "UserPromptSubmit", { prompt: "Write the tokens page" });
  hook(s, at(1), "Stop", { lastMessage: "Done. Want me to add copy buttons?" });
  hook(s, at(2), "Notification", { notificationType: "idle_prompt", message: "Claude is waiting for your input" });
  assert.equal(s.agents()[0].state, "idle");
  hook(s, at(3), "Notification", { message: "Claude is waiting for your input" });
  assert.equal(s.agents()[0].state, "idle", "the old idle message without a type");
  hook(s, at(4), "Notification", { notificationType: "elicitation_dialog", message: "The server asks for a token" });
  assert.equal(s.agents()[0].state, "waiting");
  assert.equal(s.agents()[0].question.qkind, "notification");
  const d = s.detail("a");
  assert.equal(d.trace.filter((x) => x.kind === "notice").length, 2);
  assert.equal(d.conversation.find((x) => x.kind === "stop").text, "Done. Want me to add copy buttons?");
});

test("AskUserQuestion waits for you until the tool returns", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "PreToolUse", { tool: "AskUserQuestion", toolUseId: "q1", detail: { question: "Whole shift or 8 hours?" } });
  hook(s, at(0, 1), "PermissionRequest", { tool: "AskUserQuestion" });
  assert.equal(s.agents()[0].state, "waiting");
  assert.equal(s.detail("a").conversation.length, 1, "no second question for the same call");
  hook(s, at(2), "PostToolUse", { tool: "AskUserQuestion", toolUseId: "q1", result: { ok: true } });
  assert.equal(s.agents()[0].state, "working");
});

test("plan from TodoWrite: diffing sets completedAt and inProgressSince only when observed", () => {
  const s = mk(), at = clock();
  const todo = (min, items) => hook(s, at(min), "PreToolUse", { tool: "TodoWrite", toolUseId: `w${min}`, detail: { todos: items.map(([content, status]) => ({ content, status, activeForm: content + "ing" })) } });
  todo(0, [["Already done", "completed"], ["Read code", "in_progress"], ["Fix bug", "pending"], ["Test", "pending"]]);
  todo(10, [["Already done", "completed"], ["Read code", "completed"], ["Fix bug", "in_progress"], ["Test", "pending"]]);
  todo(25, [["Already done", "completed"], ["Read code", "completed"], ["Fix bug", "in_progress"], ["Test", "pending"]]);
  const d = s.detail("a");
  const [done, read, fix, t] = d.plan.items;
  assert.equal(done.completedAt, null, "first seen completed: time unknown");
  assert.equal(read.completedAt, at(10));
  assert.equal(fix.inProgressSince, at(10), "kept across calls");
  assert.equal(t.status, "pending");
  assert.deepEqual(d.plan.now, { text: "Fix bug", activeForm: "Fix buging", since: at(10), step: 3, of: 4 });
  const a = s.agents()[0];
  assert.deepEqual([a.plan.done, a.plan.doneToday, a.plan.inProgress, a.plan.pending], [2, 1, 1, 1],
    "done counts the whole list; done today only counts completions we saw today");
  // A new list keeps finished items in `earlier`, so today's still count as done today.
  todo(30, [["Next thing", "in_progress"]]);
  const p = s.agents()[0].plan;
  assert.deepEqual([p.done, p.doneToday, p.inProgress, p.pending], [0, 1, 1, 0]);
  // Something finished yesterday doesn't count today.
  const y = mk(), yesterday = new Date(Date.now() - 86400000);
  y.apply({ type: "hook", t: new Date(yesterday.getTime() - 60000).toISOString(), session: "y", ev: "PreToolUse", tool: "TodoWrite", detail: { todos: [{ content: "Old", status: "in_progress" }] } });
  y.apply({ type: "hook", t: yesterday.toISOString(), session: "y", ev: "PreToolUse", tool: "TodoWrite", detail: { todos: [{ content: "Old", status: "completed" }] } });
  y.apply({ type: "hook", t: now(), session: "y", ev: "PreToolUse", tool: "TodoWrite", detail: { todos: [{ content: "Old", status: "completed" }, { content: "New", status: "pending" }] } });
  assert.deepEqual([y.agents()[0].plan.done, y.agents()[0].plan.doneToday, y.snapshot().totals.tasksDone], [1, 0, 0]);
  assert.equal(s.detail("a").plan.earlier.length, 2);
  // A sub-agent's own todo list doesn't replace the main plan.
  hook(s, at(31), "PreToolUse", { tool: "TodoWrite", agentId: "agent-1", detail: { todos: [{ content: "sub", status: "pending" }] } });
  assert.equal(s.detail("a").plan.items[0].content, "Next thing");
});

test("plan from TaskCreate / TaskUpdate (Claude Code's default task tools)", () => {
  const s = mk(), at = clock();
  const create = (min, subject, id) => {
    hook(s, at(min), "PreToolUse", { tool: "TaskCreate", toolUseId: `c${min}`, detail: { subject, activeForm: subject + "ing" } });
    hook(s, at(min, 1), "PostToolUse", { tool: "TaskCreate", toolUseId: `c${min}`, result: { ok: true, taskId: id } });
  };
  create(0, "Find routes", "1"); create(1, "Add limiter", "2"); create(2, "Load test", "3");
  hook(s, at(3), "PreToolUse", { tool: "TaskUpdate", toolUseId: "u1", detail: { taskId: "1", status: "in_progress" } });
  hook(s, at(9), "PreToolUse", { tool: "TaskUpdate", toolUseId: "u2", detail: { taskId: "1", status: "completed" } });
  hook(s, at(9, 5), "PreToolUse", { tool: "TaskUpdate", toolUseId: "u3", detail: { taskId: "3", status: "deleted" } });
  const p = s.detail("a").plan;
  assert.equal(p.source, "tasks");
  assert.deepEqual(p.items.map((x) => [x.id, x.content, x.status]), [["1", "Find routes", "completed"], ["2", "Add limiter", "pending"]]);
  assert.equal(p.items[0].completedAt, at(9));
});

test("snapshot sub-agents stay lean: counts plus at most 3, running first, descriptions cut to 60", () => {
  const s = mk(), at = clock();
  const long = "Check every receipt template for the cut-off last line and the paper feed settings";
  for (let i = 0; i < 5; i++) {
    hook(s, at(i), "PreToolUse", { tool: "Agent", toolUseId: `a${i}`, detail: { description: i === 4 ? long : `Job ${i}`, subagentType: "Explore" } });
    hook(s, at(i, 1), "SubagentStart", { agentId: `ag-${i}`, agentType: "Explore" });
  }
  for (const i of [0, 1, 2]) hook(s, at(9, i), "SubagentStop", { agentId: `ag-${i}`, agentType: "Explore" });
  const sub = s.agents()[0].subagents;
  assert.deepEqual([sub.running, sub.finished], [2, 3]);
  assert.deepEqual(sub.list.map((x) => [x.description, x.status]), [["Job 3", "running"], [long.slice(0, 59) + "…", "running"], ["Job 2", "finished"]]);
  assert.ok(sub.list.every((x) => x.id && Object.keys(x).length === 3), "only id, description and status");
});

test("sub-agent tree: Agent calls link to SubagentStart/Stop, nested steps carry agentId", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "PreToolUse", { tool: "Agent", toolUseId: "a1", detail: { description: "Explore loyalty rules", subagentType: "Explore" } });
  hook(s, at(0, 1), "PreToolUse", { tool: "Agent", toolUseId: "a2", detail: { description: "Write bill tests", subagentType: "general-purpose", background: true } });
  hook(s, at(0, 2), "SubagentStart", { agentId: "ag-tests", agentType: "general-purpose" });
  hook(s, at(0, 2), "PostToolUse", { tool: "Agent", toolUseId: "a2", result: { ok: true } });
  hook(s, at(0, 3), "SubagentStart", { agentId: "ag-explore", agentType: "Explore" });
  hook(s, at(1), "PreToolUse", { tool: "Read", target: "/p/shop/src/loyalty.ts", toolUseId: "r1", agentId: "ag-explore", agentType: "Explore" });
  hook(s, at(2), "PostToolUse", { tool: "Read", toolUseId: "r1", agentId: "ag-explore", result: { ok: true } });
  hook(s, at(3), "PreToolUse", { tool: "Write", target: "/p/shop/test/bill.test.ts", toolUseId: "w1", agentId: "ag-tests", detail: { path: "/p/shop/test/bill.test.ts", added: 12, removed: 0 } });
  hook(s, at(3, 2), "PostToolUse", { tool: "Write", toolUseId: "w1", agentId: "ag-tests", result: { ok: true, writeType: "create" } });
  hook(s, at(6), "SubagentStop", { agentId: "ag-explore", agentType: "Explore", lastMessage: "Discounts stack per line." });
  hook(s, at(6, 1), "PostToolUse", { tool: "Agent", toolUseId: "a1", result: { ok: true } });
  const d = s.detail("a");
  const [explore, tests] = d.subagents;
  assert.deepEqual([explore.agentId, explore.type, explore.description, explore.status, explore.finishedAt, explore.lastMessage],
    ["ag-explore", "Explore", "Explore loyalty rules", "finished", at(6), "Discounts stack per line."]);
  assert.deepEqual([tests.agentId, tests.status, tests.background], ["ag-tests", "running", true], "a background launch returning doesn't finish it");
  assert.equal(d.trace.find((x) => x.toolUseId === "r1").agentId, "ag-explore");
  assert.deepEqual(s.agents()[0].subagents, { running: 1, finished: 1, list: [
    { id: tests.id, description: "Write bill tests", status: "running" }, { id: explore.id, description: "Explore loyalty rules", status: "finished" }] });
  const f = d.files.find((x) => x.rel === "test/bill.test.ts");
  assert.deepEqual([f.edits, f.added, f.created, f.createdBy], [1, 12, true, "ag-tests"]);
  // Older Claude Code: no SubagentStart, so the Task call's own lifetime is the sub-agent's.
  const old = mk();
  old.apply({ type: "hook", t: at(0), session: "o", ev: "PreToolUse", tool: "Task", toolUseId: "t1", detail: { description: "Find usages" } });
  old.apply({ type: "hook", t: at(4), session: "o", ev: "PostToolUse", tool: "Task", toolUseId: "t1", result: { ok: true } });
  assert.deepEqual(old.detail("o").subagents.map((x) => [x.status, x.finishedAt]), [["finished", at(4)]]);
});

test("files touched: edits, +/− lines, last time, relative path", () => {
  const s = mk(), at = clock();
  const edit = (min, id, added, removed, ok = true) => {
    hook(s, at(min), "PreToolUse", { tool: "Edit", target: "/p/shop/src/Basket.tsx", toolUseId: id, detail: { path: "/p/shop/src/Basket.tsx", added, removed, hunks: [{ old: "a", new: "b" }] } });
    hook(s, at(min, 2), ok ? "PostToolUse" : "PostToolUseFailure", { tool: "Edit", toolUseId: id, result: { ok } });
  };
  edit(0, "e1", 5, 1); edit(3, "e2", 2, 2); edit(5, "e3", 9, 9, false);
  const [f] = s.detail("a").files;
  assert.deepEqual([f.rel, f.edits, f.added, f.removed, f.last, f.created], ["src/Basket.tsx", 2, 7, 3, at(3, 2), false]);
});

test("per-step cost is attributed to the step open at the time, marked as an estimate", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "UserPromptSubmit", { prompt: "Add a rate limiter" });
  s.apply({ type: "usage", t: at(0, 10), session: "a", cost: 0.01, input: 100 });
  hook(s, at(1), "PreToolUse", { tool: "Bash", target: "npm test", toolUseId: "t1" });
  s.apply({ type: "usage", t: at(1, 30), session: "a", cost: 0.06, output: 3900 });
  hook(s, at(2), "PostToolUse", { tool: "Bash", toolUseId: "t1", result: { ok: true } });
  const [prompt, step] = s.detail("a").trace;
  assert.deepEqual([prompt.cost, prompt.costEstimated], [0.01, true]);
  assert.deepEqual([step.cost, step.tokens, step.costEstimated], [0.06, 3900, true]);
});

test("state log records transitions; offline is computed from SessionEnd and silences", () => {
  const s = mk(), start = new Date(); start.setHours(9, 0, 0, 0);
  const at = clock(start.getTime());
  hook(s, at(0), "SessionStart");
  hook(s, at(1), "UserPromptSubmit", { prompt: "Fix the login" });
  hook(s, at(10), "PreToolUse", { tool: "Bash", target: "npm run db:migrate", toolUseId: "m" });
  hook(s, at(10, 1), "PermissionRequest", { tool: "Bash", target: "npm run db:migrate" });
  hook(s, at(18, 1), "PostToolUse", { tool: "Bash", toolUseId: "m", result: { ok: true } });
  hook(s, at(30), "Stop");
  // 90 minutes of silence: idle for the 30-minute timeout, then offline.
  hook(s, at(120), "UserPromptSubmit", { prompt: "and the midnight case" });
  hook(s, at(150), "SessionEnd");
  const nowMs = start.getTime() + 200 * M;
  const d = s.detail("a", nowMs);
  assert.deepEqual(d.stateLog.map((x) => x.state), ["idle", "working", "waiting", "working", "idle", "working", "ended"]);
  assert.deepEqual(d.segments.map((g) => [g.state, (Date.parse(g.to) - Date.parse(g.from)) / M]),
    [["idle", 1], ["working", 9 + 1 / 60], ["waiting", 8], ["working", 12 - 1 / 60], ["idle", 30], ["offline", 60], ["working", 30], ["offline", 50]]);
  assert.equal(d.segments[5].lastContact, at(30), "offline segments carry the last contact time");
  const tl = s.timeline(localDate(start), nowMs);
  const row = tl.sessions[0];
  assert.equal(row.totals.waitedMs, 8 * M); assert.equal(row.totals.idleMs, 31 * M);
  assert.equal(tl.buckets.length, Math.ceil((nowMs - Date.parse(tl.from)) / (10 * M)));
  const b = (h, m) => tl.buckets.find((x) => x.t === new Date(new Date(start).setHours(h, m)).toISOString());
  assert.deepEqual(b(9, 10), { t: b(9, 10).t, working: 0, waiting: 1, idle: 0 }, "a bucket counts the state that filled most of it");
  assert.deepEqual(b(10, 30), { t: b(10, 30).t, working: 0, waiting: 0, idle: 0 }, "offline isn't counted");
  assert.equal(s.agents(nowMs)[0].today.waitedMs, 8 * M);
  assert.equal(s.snapshot(nowMs).totals.waitedMs, 8 * M);
});

test("timeline: sessions are clipped to the day, and future days are empty", () => {
  const s = mk(), y = new Date(); y.setDate(y.getDate() - 1); y.setHours(23, 0, 0, 0);
  const at = clock(y.getTime());
  hook(s, at(0), "UserPromptSubmit", { prompt: "overnight job" });
  hook(s, at(50), "PreToolUse", { tool: "Read", target: "x", toolUseId: "r" });
  const today = localDate(Date.now());
  const tl = s.timeline(today, y.getTime() + 70 * M);
  assert.equal(tl.sessions[0].segments[0].from, new Date(new Date(y).setHours(24, 0, 0, 0)).toISOString());
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.deepEqual(s.timeline(localDate(tomorrow)).sessions, []);
});

test("snapshot carries what the Command Center needs, and stays lean", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "SessionStart", { cwd: "/p/shop", model: "claude-sonnet-4-6" });
  hook(s, at(1), "UserPromptSubmit", { prompt: "<ide_opened_file>The user opened the file /p/shop/src/Basket.tsx in the IDE.</ide_opened_file>Basket bill rounding is off by a cent", cwd: "/p/shop/dist" });
  hook(s, at(2), "PreToolUse", { tool: "Edit", target: "/p/shop/src/Basket.tsx", toolUseId: "e1", cwd: "/p/shop/dist", detail: { path: "/p/shop/src/Basket.tsx", added: 1, removed: 1, hunks: [{ old: "a", new: "b" }] } });
  const a = s.snapshot().agents[0];
  assert.deepEqual([a.project, a.label, a.name, a.gitRoot, a.relCwd, a.model], ["shop", "basket bill", "shop · basket bill", "/p/shop", "dist", "claude-sonnet-4-6"]);
  assert.equal(a.mission, "Basket bill rounding is off by a cent");
  assert.equal(a.task, "Basket bill rounding is off by a cent");
  assert.equal(a.recent.at(-1).detail.hunks, undefined, "no diffs in the live snapshot");
  assert.equal(a.recent.at(-1).detail.path, "/p/shop/src/Basket.tsx");
  for (const k of ["trace", "conversation", "files", "log", "pending", "running"]) assert.equal(a[k], undefined, k);
  assert.equal(s.detail("a").conversation[0].openedFile, "Basket.tsx");
});

test("the label comes from the first real prompt, never a slash command or system-only prompt", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "UserPromptSubmit", { prompt: "/clear" });
  hook(s, at(1), "UserPromptSubmit", { prompt: "<system-reminder>only system text</system-reminder>" });
  hook(s, at(2), "UserPromptSubmit", { prompt: "Refund flow: partial refunds go to the original card", cwd: "/p/shop/packages/api" });
  hook(s, at(3), "UserPromptSubmit", { prompt: "Now the webhook" });
  const a = s.agents()[0];
  assert.equal(a.name, "shop · refund flow");
  assert.equal(s.detail("a").conversation.length, 3, "the system-only prompt adds nothing");
  // Machines with detail capture off send only the label.
  const lite = mk();
  lite.apply({ type: "hook", t: at(0), session: "b", ev: "UserPromptSubmit", cwd: "/p/shop", label: "basket bill", openedFile: "Basket.tsx" });
  const b = lite.agents()[0];
  assert.deepEqual([b.name, b.task, b.mission, b.state], ["shop · basket bill", null, null, "working"]);
  assert.deepEqual(lite.detail("b").conversation.map((x) => [x.text, x.openedFile]), [[null, "Basket.tsx"]]);
});

test("old JSONL lines (v1 event shape) still replay into the new model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-v1-"));
  const lines = fs.readFileSync(path.join(__dirname, "fixtures", "v1-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const shift = Date.now() - 15 * M - Date.parse(lines[0].t);
  const moved = lines.map((e) => ({ ...e, t: new Date(Date.parse(e.t) + shift).toISOString() }));
  fs.writeFileSync(path.join(dir, `events-${localDate(Date.now())}.jsonl`), moved.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const s = mk({}, dir);
  assert.equal(s.replay(), lines.length);
  const a = s.agents()[0];
  assert.equal(a.state, "idle");
  assert.equal(a.name, "aurum · invoice pdf");
  assert.equal(a.cost, 0.25);
  const d = s.detail("v1-session");
  assert.deepEqual(d.trace.filter((x) => x.kind === "tool").map((x) => [x.tool, x.status, x.durationMs]), [["Read", "ok", M], ["Edit", "ok", 2 * M], ["Bash", "ok", M]]);
  const q = d.conversation.find((x) => x.kind === "question");
  assert.deepEqual([q.qkind, q.tool, q.status, q.outcome], ["permission", "Edit", "answered", "approved"]);
  assert.equal(d.conversation.find((x) => x.kind === "prompt").openedFile, "invoice.ts");
  assert.equal(d.conversation.filter((x) => x.kind === "prompt").length, 1, "the prompt that was all system text adds nothing");
  assert.deepEqual(d.files.map((f) => [f.path, f.edits]), [["/home/you/projects/aurum/src/invoice.ts", 1]]);
  assert.deepEqual(d.stateLog.map((x) => x.state), ["idle", "working", "waiting", "working", "idle"]);
});

test("memory stays bounded: trace, heavy detail, conversation and state log are capped", () => {
  const s = mk({ offlineAfterMin: 1 }), at = clock(Date.now() - 2 * 86400000);
  for (let i = 0; i < 1300; i++) {
    hook(s, at(i), "PreToolUse", { tool: "Edit", target: "a.ts", toolUseId: `t${i}`, detail: { path: "a.ts", added: 1, removed: 0, hunks: [{ old: "x", new: "y" }] } });
    hook(s, at(i, 30), "PostToolUseFailure", { tool: "Edit", toolUseId: `t${i}`, result: { ok: false, error: "boom" } });
    if (i % 2) hook(s, at(i, 40), "UserPromptSubmit", { prompt: `prompt ${i}` });
  }
  const d = s.detail("a");
  assert.ok(d.trace.length <= 1050, `trace ${d.trace.length}`);
  assert.ok(d.conversation.length <= 220, `conversation ${d.conversation.length}`);
  assert.ok(d.stateLog.length <= 1000, `log ${d.stateLog.length}`);
  const tools = d.trace.filter((x) => x.kind === "tool");
  assert.equal(tools[0].detail.hunks, undefined, "old steps lose their diff");
  assert.equal(tools[0].result.error, undefined, "and their output");
  assert.ok(tools.at(-1).detail.hunks, "recent steps keep theirs");
});

test("prune drops sessions past retention, and diffs and output tails after 2 days; names, paths, counts, plans and costs stay", () => {
  const s = mk({ retentionDays: 30 }), day = 86400000;
  const edit = (id, ago) => {
    const t = new Date(Date.now() - ago).toISOString();
    s.apply({ type: "hook", t, session: id, ev: "PreToolUse", tool: "Edit", target: "/p/a.ts", toolUseId: "e", detail: { path: "/p/a.ts", added: 3, removed: 1, hunks: [{ old: "a", new: "SECRET=1" }] } });
    s.apply({ type: "hook", t, session: id, ev: "PostToolUse", tool: "Edit", toolUseId: "e", result: { ok: true } });
    s.apply({ type: "hook", t, session: id, ev: "PreToolUse", tool: "Bash", target: "cat .env", toolUseId: "b", detail: { command: "cat .env" } });
    s.apply({ type: "hook", t, session: id, ev: "PostToolUse", tool: "Bash", toolUseId: "b", result: { ok: true, tail: "SECRET=1" } });
    s.apply({ type: "hook", t, session: id, ev: "PreToolUse", tool: "TodoWrite", toolUseId: "w", detail: { todos: [{ content: "Ship it", status: "completed" }] } });
    s.apply({ type: "usage", t, session: id, cost: 0.4 });
  };
  edit("ancient", 40 * day); edit("old", 3 * day); edit("recent", day / 2);
  s.prune();
  assert.equal(s.sessions.has("ancient"), false);
  const old = s.detail("old"), recent = s.detail("recent");
  assert.doesNotMatch(JSON.stringify(old.trace), /SECRET/, "no diffs or output after 2 days");
  assert.deepEqual(old.trace.filter((x) => x.kind === "tool").map((x) => [x.tool, x.target, x.status]), [["Edit", "/p/a.ts", "ok"], ["Bash", "cat .env", "ok"], ["TodoWrite", null, "running"]]);
  assert.deepEqual([old.files[0].added, old.files[0].removed, old.plan.items[0].content, old.agent.cost], [3, 1, "Ship it", 0.4]);
  assert.match(JSON.stringify(recent.trace), /SECRET/, "recent steps keep their detail");
});

test("event files older than 2 days are rewritten without diffs and output, and still replay", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-compact-")), day = 86400000;
  const at = (ago) => new Date(Date.now() - ago).toISOString();
  const lines = (ago, id) => [
    { type: "hook", t: at(ago), session: id, ev: "UserPromptSubmit", cwd: "/p/shop", prompt: "Basket bill rounding" },
    { type: "hook", t: at(ago), session: id, ev: "PreToolUse", tool: "Edit", target: "/p/shop/a.ts", toolUseId: "e", detail: { path: "/p/shop/a.ts", added: 2, removed: 0, hunks: [{ old: "", new: "SECRET=1" }] } },
    { type: "hook", t: at(ago), session: id, ev: "PostToolUse", tool: "Edit", toolUseId: "e", result: { ok: true } },
    { type: "hook", t: at(ago), session: id, ev: "PostToolUseFailure", tool: "Bash", toolUseId: "b", result: { ok: false, exitCode: 1, tail: "SECRET=1", error: "SECRET=1" } },
    { type: "hook", t: at(ago), session: id, ev: "PreToolUse", tool: "TodoWrite", toolUseId: "w", detail: { todos: [{ content: "Ship it", status: "in_progress" }] } },
  ];
  const write = (ago, id) => fs.writeFileSync(path.join(dir, `events-${localDate(Date.now() - ago)}.jsonl`), lines(ago, id).map((e) => JSON.stringify(e)).join("\n") + "\n");
  write(3 * day, "old"); write(0, "new");
  const s = mk({}, dir);
  assert.equal(s.replay(), 10);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, [`events-${localDate(Date.now() - 3 * day)}.lite.jsonl`, `events-${localDate(Date.now())}.jsonl`]);
  const lite = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.doesNotMatch(lite, /SECRET/); assert.match(lite, /Ship it/); assert.match(lite, /"added":2/);
  assert.match(fs.readFileSync(path.join(dir, files[1]), "utf8"), /SECRET/, "recent files keep detail");
  const again = mk({}, dir);
  assert.equal(again.replay(), 10, "compacted files replay");
  assert.equal(again.detail("old").plan.items[0].content, "Ship it");
  assert.equal(again.detail("old").files[0].added, 2);
});

test("an agent waiting on you stays 'Needs you' past the timeout (question marked stale) until 8 hours", () => {
  const s = mk(), start = Date.now() - 10 * 3600000;
  const at = (min) => new Date(start + min * M).toISOString();
  hook(s, at(0), "PreToolUse", { tool: "Edit", target: ".env", toolUseId: "e" });
  hook(s, at(0), "PermissionRequest", { tool: "Edit", target: ".env" });
  s.apply({ type: "hook", t: at(0), session: "b", ev: "UserPromptSubmit", prompt: "x" });
  const view = (min) => s.agents(start + min * M).find((a) => a.session === "a");
  assert.deepEqual([view(20).state, view(20).question.stale], ["waiting", false]);
  assert.deepEqual([view(45).state, view(45).question.stale], ["waiting", true], "past the 30-minute timeout");
  assert.equal(s.agents(start + 45 * M).find((a) => a.session === "b").state, "offline", "working agents still go offline at the timeout");
  assert.equal(view(7 * 60).state, "waiting");
  assert.equal(view(8 * 60 + 1).state, "offline", "the 8-hour cap");
  const segs = s.detail("a", start + 9 * 60 * M).segments.map((g) => [g.state, (Date.parse(g.to) - Date.parse(g.from)) / M]);
  assert.deepEqual(segs, [["waiting", 480], ["offline", 60]]);
  hook(s, at(9 * 60), "SessionEnd");
  assert.equal(view(9 * 60).state, "offline");
});

test("hasPlan is false until the agent writes a plan", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "UserPromptSubmit", { prompt: "Fix the login" });
  assert.equal(s.agents()[0].hasPlan, false);
  hook(s, at(1), "PreToolUse", { tool: "TaskCreate", toolUseId: "c", detail: { subject: "Find the bug" } });
  hook(s, at(1, 1), "PostToolUse", { tool: "TaskCreate", toolUseId: "c", result: { ok: true, taskId: "1" } });
  assert.equal(s.agents()[0].hasPlan, true);
});

// ---------- M2 review round 1 ----------
const { attachAlerts } = require("../src/alerts");

test("a denied permission ends the turn at idle_prompt (no Stop, no Post event)", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "UserPromptSubmit", { prompt: "Clean the build folder" });
  hook(s, at(1), "PreToolUse", { tool: "Bash", target: "rm -rf dist", toolUseId: "t1" });
  hook(s, at(1, 1), "PermissionRequest", { tool: "Bash", target: "rm -rf dist" });
  assert.equal(s.agents()[0].state, "waiting");
  // You chose "No": Claude Code fires nothing until the idle reminder a minute later.
  hook(s, at(2, 1), "Notification", { notificationType: "idle_prompt", message: "Claude is waiting for your input" });
  const a = s.agents()[0];
  assert.deepEqual([a.state, a.question, a.waitingSince], ["idle", null, null]);
  const d = s.detail("a");
  const q = d.conversation.find((x) => x.kind === "question");
  assert.deepEqual([q.status, q.resolvedBy, q.outcome, q.answeredAt], ["answered", "turn-ended", undefined, at(2, 1)]);
  assert.deepEqual([d.trace.find((x) => x.toolUseId === "t1").status, d.trace.at(-1).kind], ["unknown", "notice"]);
});

test("Esc during a running tool: the turn ends at idle_prompt, sub-agent questions are left alone", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "UserPromptSubmit", { prompt: "Run the slow suite" });
  hook(s, at(1), "PreToolUse", { tool: "Bash", target: "npm run e2e", toolUseId: "t1" });
  hook(s, at(1, 30), "Notification", { notificationType: "idle_prompt", agentId: "sub-1" });
  assert.equal(s.agents()[0].state, "working", "an idle_prompt from a sub-agent doesn't end the main turn");
  hook(s, at(3), "Notification", { notificationType: "idle_prompt" });
  assert.equal(s.agents()[0].state, "idle");
  assert.equal(s.detail("a").trace.find((x) => x.toolUseId === "t1").status, "unknown");
  hook(s, at(4), "UserPromptSubmit", { prompt: "try again" });
  assert.equal(s.agents()[0].state, "working");
});

test("AskUserQuestion plus its permission_prompt reminder is one question", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "PreToolUse", { tool: "AskUserQuestion", toolUseId: "q1", detail: { question: "Whole shift or 8 hours?" } });
  hook(s, at(0, 6), "Notification", { notificationType: "permission_prompt", message: "Claude needs your permission to use AskUserQuestion" });
  const qs = s.detail("a").conversation.filter((x) => x.kind === "question");
  assert.equal(qs.length, 1);
  assert.deepEqual([qs[0].qkind, qs[0].message], ["ask", "Whole shift or 8 hours?"], "the question text is kept");
});

test("a reopened question alerts once", () => {
  const s = mk(), calls = [];
  attachAlerts(s, () => ({ webhookUrl: "https://hooks.example.com/x", notifyOnWaiting: true }), { warn() {} }, async (url, o) => { calls.push(JSON.parse(o.body).text); return { ok: true }; });
  const at = clock();
  hook(s, at(0), "PreToolUse", { tool: "Bash", target: "rm -rf dist", toolUseId: "t1" });
  hook(s, at(0, 1), "PermissionRequest", { tool: "Bash", target: "rm -rf dist" });
  hook(s, at(0, 2), "PreToolUse", { tool: "Read", target: "a.ts", toolUseId: "t2" });
  hook(s, at(0, 7), "Notification", { notificationType: "permission_prompt", message: "Claude needs your permission to use Bash" });
  assert.equal(s.agents()[0].state, "waiting");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /needs you: Wants permission to run a command/);
  // A new question is a new alert.
  hook(s, at(1), "PostToolUse", { tool: "Bash", toolUseId: "t1", result: { ok: true } });
  hook(s, at(2), "PreToolUse", { tool: "Edit", target: ".env", toolUseId: "t3" });
  hook(s, at(2, 1), "PermissionRequest", { tool: "Edit", target: ".env" });
  assert.equal(calls.length, 2);
});

test("PermissionRequest keeps its own target and matches the call by target", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "PreToolUse", { tool: "Bash", target: "ls", toolUseId: "t1" });
  hook(s, at(0, 1), "PreToolUse", { tool: "Bash", target: "npm test", toolUseId: "t2" });
  hook(s, at(0, 2), "PermissionRequest", { tool: "Bash", target: "ls", detail: { command: "ls" } });
  let q = s.agents()[0].question;
  assert.deepEqual([q.target, q.detail.command], ["ls", "ls"]);
  hook(s, at(1), "PostToolUse", { tool: "Bash", toolUseId: "t2", result: { ok: true } });
  assert.equal(s.agents()[0].state, "waiting", "the other call finishing doesn't answer it");
  hook(s, at(2), "PostToolUse", { tool: "Bash", toolUseId: "t1", result: { ok: true } });
  assert.equal(s.agents()[0].state, "working");
  // No running call with that target: the question still shows the requested target.
  hook(s, at(3), "PreToolUse", { tool: "Bash", target: "make", toolUseId: "t3" });
  hook(s, at(3, 1), "PermissionRequest", { tool: "Bash", target: "make install" });
  q = s.agents()[0].question;
  assert.equal(q.target, "make install");
});

test("any Post event means the permission was granted, even a failure without an exit code", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "PreToolUse", { tool: "WebFetch", target: "https://x.dev", toolUseId: "w1" });
  hook(s, at(0, 1), "PermissionRequest", { tool: "WebFetch", target: "https://x.dev" });
  hook(s, at(1), "PostToolUseFailure", { tool: "WebFetch", toolUseId: "w1", result: { ok: false, error: "fetch failed" } });
  const q = s.detail("a").conversation.find((x) => x.kind === "question");
  assert.deepEqual([q.resolvedBy, q.outcome], ["tool-finished", "approved"]);
});

test("StopFailure ends the turn with a red error step", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "UserPromptSubmit", { prompt: "Refactor the cart" });
  hook(s, at(1), "PreToolUse", { tool: "Read", target: "cart.ts", toolUseId: "r1" });
  hook(s, at(2), "StopFailure", { failure: "rate_limit", message: "API Error: Rate limit reached" });
  assert.equal(s.agents()[0].state, "idle");
  const d = s.detail("a"), last = d.trace.at(-1);
  assert.deepEqual([last.kind, last.status, last.failure, last.text], ["stop", "error", "rate_limit", "API Error: Rate limit reached"]);
  assert.equal(d.conversation.at(-1), last);
  assert.equal(d.trace.find((x) => x.toolUseId === "r1").status, "unknown");
});

test("old steps lose their plan lists, and a result that arrives late is stripped too", () => {
  const s = mk(), at = clock(Date.now() - 3 * 3600000);
  hook(s, at(0), "PreToolUse", { tool: "Bash", target: "npm run watch", toolUseId: "long", detail: { command: "npm run watch" } });
  hook(s, at(0, 1), "PreToolUse", { tool: "TodoWrite", toolUseId: "plan", detail: { todos: [{ content: "A", status: "in_progress" }] } });
  for (let i = 0; i < 210; i++) {
    hook(s, at(1, i), "PreToolUse", { tool: "Read", target: "x", toolUseId: `r${i}` });
    hook(s, at(1, i), "PostToolUse", { tool: "Read", toolUseId: `r${i}`, result: { ok: true } });
  }
  hook(s, at(9), "PostToolUseFailure", { tool: "Bash", toolUseId: "long", result: { ok: false, exitCode: 1, tail: "x".repeat(1500), error: "boom" } });
  const d = s.detail("a");
  assert.equal(d.trace.find((x) => x.toolUseId === "plan").detail.todos, undefined);
  const long = d.trace.find((x) => x.toolUseId === "long");
  assert.deepEqual([long.status, long.result.exitCode, long.result.tail, long.result.error], ["error", 1, undefined, undefined]);
  assert.equal(d.plan.items[0].content, "A", "the plan itself is kept");
});

// ---------- crash- and lock-safe compaction of old event files ----------
const quietLog = { warns: [], warn(m) { this.warns.push(m); }, log() {}, error() {} };
function oldDay(ago = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-cmp-")), day = 86400000, base = Date.now() - ago * day;
  const date = localDate(base);
  const events = [
    { type: "hook", t: new Date(base).toISOString(), session: "s", ev: "PreToolUse", tool: "Edit", target: "/p/a.ts", toolUseId: "e", detail: { path: "/p/a.ts", added: 1, removed: 0, hunks: [{ old: "", new: "SECRET" }] } },
    ...[1, 2, 3, 4, 5].map((i) => ({ type: "usage", t: new Date(base + i * 1000).toISOString(), session: "s", cost: 0.25, input: 10 })),
  ];
  const full = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const strip = (e) => { const x = JSON.parse(JSON.stringify(e)); if (x.detail) delete x.detail.hunks; return x; };
  const lite = events.map((e) => JSON.stringify(strip(e))).join("\n") + "\n";
  const f = (name) => path.join(dir, `events-${date}${name}`);
  return { dir, date, full, lite, plain: f(".jsonl"), liteFile: f(".lite.jsonl"), tmp: f(".lite.jsonl.tmp") };
}
const replayCost = (dir) => { const s = new Store({ getConfig: () => cfg, dataDir: dir, log: quietLog }); s.replay(); return [s.sessions.get("s").cost, s]; };
const listDay = (d) => fs.readdirSync(d.dir).sort();

test("compaction: both the original and a .lite with the same events (an old crash) count once, and end as one .lite", () => {
  const d = oldDay();
  fs.writeFileSync(d.plain, d.full); fs.writeFileSync(d.liteFile, d.lite);
  assert.equal(replayCost(d.dir)[0], 1.25);
  assert.deepEqual(listDay(d), [path.basename(d.liteFile)]);
  assert.equal(fs.readFileSync(d.liteFile, "utf8"), d.lite, "duplicates are not made permanent");
  assert.equal(replayCost(d.dir)[0], 1.25);
});

test("compaction: a crash after the temp file was written is redone, without double counting", () => {
  const d = oldDay();
  fs.writeFileSync(d.plain, d.full); fs.writeFileSync(d.tmp, d.lite.slice(0, -20)); // the temp file was even cut short
  assert.equal(replayCost(d.dir)[0], 1.25);
  assert.deepEqual(listDay(d), [path.basename(d.liteFile)]);
  assert.doesNotMatch(fs.readFileSync(d.liteFile, "utf8"), /SECRET/);
});

test("compaction: a crash after the original was removed is finished at startup", () => {
  const d = oldDay();
  const [first, second] = [d.lite.split("\n").slice(0, 3).join("\n") + "\n", d.lite];
  fs.writeFileSync(d.liteFile, first); fs.writeFileSync(d.tmp, second); // tmp = old .lite plus the original's events
  assert.equal(replayCost(d.dir)[0], 1.25);
  assert.deepEqual(listDay(d), [path.basename(d.liteFile)]);
  assert.equal(fs.readFileSync(d.liteFile, "utf8"), d.lite);
});

test("compaction: a locked original (EBUSY) is left alone, logged, never throws, and is retried later", () => {
  const d = oldDay();
  fs.writeFileSync(d.plain, d.full);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (p) => { if (String(p) === d.plain) { const e = new Error("resource busy or locked"); e.code = "EBUSY"; throw e; } return unlink(p); };
  quietLog.warns.length = 0;
  try {
    for (let i = 0; i < 3; i++) assert.equal(replayCost(d.dir)[0], 1.25, `start ${i + 1}`);
    assert.deepEqual(listDay(d), [path.basename(d.plain)], "no temp file or partial .lite left behind");
    assert.match(quietLog.warns[0], /Couldn't compact the events of .*EBUSY/);
    const [, s] = replayCost(d.dir);
    assert.doesNotThrow(() => s.prune(), "the hourly prune doesn't throw either");
  } finally { fs.unlinkSync = unlink; }
  assert.equal(replayCost(d.dir)[0], 1.25, "once the lock is gone it compacts");
  assert.deepEqual(listDay(d), [path.basename(d.liteFile)]);
});

test("compaction: repeating it changes nothing, and a late event for an old day is kept", () => {
  const d = oldDay();
  fs.writeFileSync(d.plain, d.full);
  const [, s] = replayCost(d.dir);
  const once = fs.readFileSync(d.liteFile, "utf8");
  s.compactFiles(); s.compactFiles();
  assert.equal(fs.readFileSync(d.liteFile, "utf8"), once);
  // A spooled event that arrives late for that day lands in a new original next to the .lite file.
  fs.writeFileSync(d.plain, JSON.stringify({ type: "usage", t: new Date(Date.parse(JSON.parse(d.full.split("\n")[1]).t) + 60000).toISOString(), session: "s", cost: 0.5 }) + "\n");
  assert.equal(replayCost(d.dir)[0], 1.75);
  assert.equal(replayCost(d.dir)[0], 1.75);
});

test("createServer starts even when an old event file can't be compacted", async () => {
  const d = oldDay();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-srvcmp-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, "data", path.basename(d.plain)), d.full);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (p) => { if (String(p).endsWith(path.basename(d.plain))) { const e = new Error("busy"); e.code = "EBUSY"; throw e; } return unlink(p); };
  try {
    const { createServer } = require("../src/server");
    const app = createServer({ dir, log: quietLog });
    assert.equal(app.store.sessions.get("s").cost, 1.25);
    await app.close();
  } finally { fs.unlinkSync = unlink; }
});

test("SessionStart (startup, resume, clear) clears stale questions and running steps; compact doesn't", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "PreToolUse", { tool: "Bash", target: "rm -rf dist", toolUseId: "t1" });
  hook(s, at(0, 1), "PermissionRequest", { tool: "Bash", target: "rm -rf dist" });
  hook(s, at(1), "SessionStart", { source: "compact" });
  assert.equal(s.agents()[0].state, "waiting", "a compaction mid-turn changes nothing");
  hook(s, at(2), "SessionStart", { source: "resume" });
  const a = s.agents()[0], d = s.detail("a");
  assert.deepEqual([a.state, a.question], ["idle", null]);
  assert.equal(d.conversation.find((x) => x.kind === "question").resolvedBy, "session-start");
  assert.equal(d.trace.find((x) => x.toolUseId === "t1").status, "unknown");
});

test("sessions idle past the 2-day detail window keep only their last 200 steps", () => {
  const s = mk(), start = Date.now() - 3 * 86400000;
  for (let i = 0; i < 260; i++) s.apply({ type: "hook", t: new Date(start + i * 1000).toISOString(), session: "old", ev: "PreToolUse", tool: "Read", target: `f${i}`, toolUseId: `r${i}` });
  for (let i = 0; i < 260; i++) s.apply({ type: "hook", t: new Date(Date.now() - 600000 + i * 1000).toISOString(), session: "new", ev: "PreToolUse", tool: "Read", target: `f${i}`, toolUseId: `r${i}` });
  s.prune();
  const old = s.detail("old").trace;
  assert.equal(old.length, 200); assert.equal(old[0].target, "f60");
  assert.equal(s.detail("new").trace.length, 260, "recent sessions keep their full trace");
});

test("replay keeps genuinely identical events (dedupe counts per file, it doesn't collapse them)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-dup-")), day = 86400000, base = Date.now() - 3 * day, date = localDate(base);
  const usage = (sec, cost) => JSON.stringify({ type: "usage", t: new Date(base + sec * 1000).toISOString(), session: "s", cost });
  const plain = path.join(dir, `events-${date}.jsonl`), lite = path.join(dir, `events-${date}.lite.jsonl`), tmp = lite + ".tmp";
  const cost = () => replayCost(dir)[0];
  // Two identical events (same session, same millisecond, same content) in the original only.
  fs.writeFileSync(plain, [usage(1, 0.5), usage(1, 0.5), usage(2, 0.25)].join("\n") + "\n");
  assert.equal(cost(), 1.25);
  assert.equal(fs.readFileSync(lite, "utf8").trim().split("\n").length, 3, "compaction keeps both copies");
  assert.equal(cost(), 1.25, "and so does the next start");
  // Two identical events already in the .lite file, plus a late event in a recreated original.
  fs.writeFileSync(plain, usage(9, 1) + "\n");
  assert.equal(cost(), 2.25, "no loss and no double count");
  assert.equal(cost(), 2.25);
  // A crash after the original was removed: old .lite plus the finished temp file. Same cost before and after recovery.
  const all = [usage(1, 0.5), usage(1, 0.5), usage(2, 0.25), usage(9, 1)];
  fs.writeFileSync(lite, all.slice(0, 2).join("\n") + "\n"); fs.writeFileSync(tmp, all.join("\n") + "\n");
  const s = new Store({ getConfig: () => cfg, dataDir: dir, log: quietLog });
  const before = s.readDay(date, { lite, tmp }).reduce((n, e) => n + e.cost, 0);
  assert.equal(before, 2.25, "read before the rename finishes");
  s.replay();
  assert.deepEqual(fs.readdirSync(dir), [path.basename(lite)]);
  assert.equal(s.sessions.get("s").cost, 2.25, "and after");
  // The original's identical events, also already in a .lite copy from an old crash, still count twice, not four times.
  fs.writeFileSync(plain, all.slice(0, 2).join("\n") + "\n");
  assert.equal(cost(), 2.25);
});

test("a restart clears sub-agents too: their questions, running steps and running status", () => {
  const s = mk(), at = clock();
  hook(s, at(0), "PreToolUse", { tool: "Agent", toolUseId: "a1", detail: { description: "Write bill tests", subagentType: "general-purpose", background: true } });
  hook(s, at(0, 1), "SubagentStart", { agentId: "ag-1", agentType: "general-purpose" });
  hook(s, at(0, 2), "PostToolUse", { tool: "Agent", toolUseId: "a1", result: { ok: true } });
  hook(s, at(1), "PreToolUse", { tool: "Bash", target: "npm install jest", toolUseId: "b1", agentId: "ag-1" });
  hook(s, at(1, 1), "PermissionRequest", { tool: "Bash", target: "npm install jest", agentId: "ag-1" });
  // The session is killed (no Stop). The main turn's idle reminder only ends the main agent's questions.
  hook(s, at(2, 30), "Notification", { notificationType: "idle_prompt" });
  assert.equal(s.agents()[0].state, "waiting", "the sub-agent's question is still open");
  hook(s, at(3), "SessionStart", { source: "compact" });
  assert.equal(s.agents()[0].state, "waiting", "compact changes nothing");
  hook(s, at(4), "SessionStart", { source: "startup" });
  const a = s.agents()[0], d = s.detail("a");
  assert.deepEqual([a.state, a.question, a.subagents.running, a.subagents.finished, a.subagents.list.length], ["idle", null, 0, 1, 1]);
  assert.equal(d.conversation.find((x) => x.kind === "question").resolvedBy, "session-start");
  assert.equal(d.trace.find((x) => x.toolUseId === "b1").status, "unknown");
  assert.deepEqual([d.subagents[0].status, d.subagents[0].finishedAt], ["finished", at(4)]);
});
