"use strict";
// public/lib/describe.js: plain-English actions, and agreement with the hook/server copy in hooks/text.js.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { pathToFileURL } = require("url");
const text = require("../hooks/text");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "public", "lib", "describe.js")).href);
const loadIcons = () => import(pathToFileURL(path.join(__dirname, "..", "public", "ui", "icons.js")).href);
const ROOT = "/Users/me/code/supermarket-pos";

const PROMPTS = [
  "", null, "   ", "/clear", "/review src/app.ts", "hi", "ok go", "Fix it",
  "Basket bill rounding: totals are off by a cent when loyalty discounts stack",
  "Login fix for the cashier tablets", "Fix the login redirect after OAuth", "Can you please add a rate limiter to the API?",
  "Build the tokens page for the design docs", "why the build is failing on CI", "fix ui css bug",
  "Look at src/basket/BasketTotals.tsx and https://example.com/docs then fix rounding",
  "<ide_opened_file>The user opened the file /Users/me/pos/src/Basket.tsx in the IDE. This may or may not be related to the current task.</ide_opened_file>Webhook retries should back off",
  "<ide_selection>The user selected the lines 3 to 9 from C:\\code\\pos\\Cart.tsx:\nconst a = 1;\n</ide_selection>Explain the cart total",
  "<system-reminder>rules rules rules", "<command-name>/compact</command-name><command-args></command-args>",
  "Ünïcödé façade überprüfen bitte", "Make 2 changes to 3 files", "Refactor `useCart()` in cart.ts — it's slow",
  "<local-command-stdout>output</local-command-stdout>Then deploy staging",
];

test("describe.js and hooks/text.js agree (prompt cleaning, naming rule, paths, permission phrases)", async () => {
  const d = await load();
  for (const p of PROMPTS) {
    assert.deepEqual(d.cleanPrompt(p), text.cleanPrompt(p), `cleanPrompt(${JSON.stringify(p)})`);
    assert.equal(d.agentLabel(p), text.agentLabel(p), `agentLabel(${JSON.stringify(p)})`);
  }
  const paths = [["/Users/me/code/supermarket-pos/src/a.ts", ROOT], ["C:\\Code\\Pos\\src\\a.ts", "c:\\code\\pos"], ["/etc/cups/printers.conf", ROOT],
    [ROOT, ROOT], ["src/a.ts", ROOT], ["/x/y", null], [null, ROOT], ["/Users/me/code/supermarket-pos-old/a.ts", ROOT], [ROOT + "/dist/", ROOT + "/"]];
  for (const [p, r] of paths) assert.equal(d.relPath(p, r), text.relPath(p, r), `relPath(${p}, ${r})`);
  for (const t of ["Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "Agent", "Task", "mcp__github__create_issue", "mcp__claude_ai_Docs__read", "Monitor", null])
    assert.equal(d.permissionPhrase(t), text.permissionPhrase(t), String(t));
});

test("agent naming rule: '<project> · <2–3 word label>' from the first real prompt", async () => {
  const d = await load();
  const cases = [
    ["Basket bill rounding: totals are off by a cent", "basket bill"],
    ["Login fix for the cashier tablets", "login fix"],
    ["Add a rate limiter to the public checkout endpoints", "rate limiter"],
    ["Build the tokens page for the design docs", "tokens page"],
    ["Inventory sync keeps double-counting returns", "inventory sync"],
    ["Can you fix the login redirect?", "login redirect"],
    ["why the build is failing on CI", "build failing"],
    ["fix ui css bug", "ui css bug"],
    ["Look at src/basket/BasketTotals.tsx and fix rounding", "basket totals"], ["Refactor `useCart()` in cart.ts, it is slow", "cart slow"],
    ["/clear", null], ["", null], ["<system-reminder>only</system-reminder>", null], ["ok", null],
  ];
  for (const [p, want] of cases) assert.equal(d.agentLabel(p), want, p);
  assert.equal(d.agentName({ project: "supermarket-pos", label: "basket bill" }), "supermarket-pos · basket bill");
  assert.equal(d.agentName({ project: "supermarket-pos", label: null }), "supermarket-pos");
  assert.equal(d.agentName({ project: "x", label: "y", alias: "Till bot" }), "Till bot");
});

test("prompt cleaner strips system tags and extracts the opened-file chip", async () => {
  const d = await load();
  const r = d.cleanPrompt(PROMPTS[16]);
  assert.deepEqual(r, { text: "Webhook retries should back off", openedFile: "Basket.tsx", command: null });
  assert.equal(d.cleanPrompt(PROMPTS[17]).openedFile, "Cart.tsx");
  for (const p of PROMPTS) assert.doesNotMatch(d.cleanPrompt(p).text, /<\/?(ide_|system-reminder|command-|local-command-)/);
});

test("tools map to plain English, with paths relative to the git root", async () => {
  const d = await load();
  const say = (tool, detail = {}, extra = {}) => d.describeTool({ tool, detail, ...extra }, { root: ROOT });
  assert.deepEqual(say("Bash", { command: "ls -la" }), { text: "Ran a command", target: "ls -la", icon: "terminal" });
  assert.equal(say("Bash", { command: "npm test -- basket" }).text, "Ran tests");
  assert.equal(say("Bash", { command: "pytest -q tests/" }).text, "Ran tests");
  assert.equal(say("Bash", { command: "npm install decimal.js" }).text, "Installed a package");
  assert.equal(say("Bash", { command: "sudo apt install cups-filters" }).text, "Installed a package");
  assert.equal(say("PowerShell", { command: "Get-ChildItem" }).text, "Ran a command");
  assert.deepEqual(say("Edit", { path: `${ROOT}/src/basket/BasketTotals.tsx` }), { text: "Edited BasketTotals.tsx", target: "src/basket/BasketTotals.tsx", icon: "file-edit" });
  assert.equal(d.describeTool({ tool: "Edit", detail: { path: `${ROOT}/src/a.ts` } }, { root: ROOT, running: true }).text, "Editing a.ts");
  assert.equal(say("Write", { path: `${ROOT}/src/new.ts` }).text, "Created new.ts");
  assert.equal(say("Write", { path: `${ROOT}/src/old.ts` }, { result: { writeType: "update" } }).text, "Edited old.ts");
  assert.deepEqual(say("Read", { path: `${ROOT}/src/components/Button.mdx` }), { text: "Read Button.mdx", target: "src/components/Button.mdx", icon: "file" });
  assert.deepEqual(say("Grep", { pattern: "roundCents" }), { text: "Searched code for “roundCents”", target: "roundCents", icon: "search" });
  assert.deepEqual(say("WebFetch", { url: "https://docs.stripe.com/refunds", host: "docs.stripe.com" }), { text: "Read web page docs.stripe.com", target: "https://docs.stripe.com/refunds", icon: "globe" });
  assert.equal(d.describeTool({ tool: "WebFetch", target: "https://x.dev/a" }).text, "Read web page x.dev", "host from the target when detail is missing");
  assert.equal(say("WebSearch", { query: "express rate limit" }).text, "Searched the web for “express rate limit”");
  assert.deepEqual([say("Grep").text, say("WebSearch").text], ["Searched code", "Searched the web"], "detail capture off: no search text");
  assert.deepEqual(say("Agent", { description: "Explore loyalty rules", subagentType: "Explore" }), { text: "Started a sub-agent: Explore loyalty rules", target: "Explore", icon: "sub-agent" });
  assert.equal(say("Task").text, "Started a sub-agent");
  assert.deepEqual(say("TodoWrite"), { text: "Updated the plan", target: null, icon: "plan" });
  assert.equal(say("TaskUpdate").text, "Updated the plan");
  assert.deepEqual(say("mcp__github__create_issue", {}, { target: "Bug" }), { text: "Used github: create issue", target: "Bug", icon: "globe" });
  assert.equal(say("SomeNewTool").text, "Used some new tool");
  assert.equal(d.relPath("/etc/cups/printers.conf", ROOT), "…/cups/printers.conf", "no absolute paths outside the root");
});

test("questions, turn ends, sub-agents and offline in plain English", async () => {
  const d = await load();
  assert.equal(d.describeQuestion({ qkind: "permission", tool: "Bash" }), "Wants permission to run a command");
  assert.equal(d.describeQuestion({ qkind: "permission", tool: "Edit" }), "Wants permission to edit a file");
  assert.equal(d.describeQuestion({ qkind: "notification", notificationType: "idle_prompt" }), "Waiting for your reply");
  assert.equal(d.describeQuestion({ qkind: "ask" }), "Asked you a question");
  assert.equal(d.describeStep({ kind: "stop" }).text, "Finished turn");
  assert.deepEqual(d.describeStep({ kind: "stop", status: "error", failure: "rate_limit" }), { text: "Stopped: hit the rate limit", target: null, icon: "alert" });
  assert.equal(d.describeStep({ kind: "stop", status: "error", failure: "something_new" }).text, "Stopped: the API returned an error");
  assert.equal(d.describeStep({ kind: "notice", notificationType: "idle_prompt" }).text, "Waiting for your reply");
  assert.equal(d.describeStep({ kind: "subagent", phase: "stop", description: "Explore loyalty rules" }).text, "Sub-agent finished: Explore loyalty rules");
  assert.equal(d.describeStep({ kind: "offline" }).text, "Went offline · no events for 30 min");
  assert.equal(d.offlineText(45), "Went offline · no events for 45 min");
  assert.deepEqual(d.describeStep({ kind: "question", qkind: "permission", tool: "Edit", target: ".env.production" }), { text: "Wants permission to edit a file", target: ".env.production", icon: "hand" });
  assert.equal(d.describeStep({ kind: "tool", tool: "Bash", status: "running", detail: { command: "npm test" } }).text, "Running tests");
});

test("describe text never shows raw hook names, and every icon key exists", async () => {
  const d = await load(), { ICONS } = await loadIcons();
  const HOOKS = /\b(PreToolUse|PostToolUse|PostToolUseFailure|PermissionRequest|UserPromptSubmit|SubagentStart|SubagentStop|SessionStart|SessionEnd|Notification|TodoWrite|TaskCreate|TaskUpdate)\b/;
  const tools = ["Bash", "PowerShell", "Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "Agent", "Task",
    "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ExitPlanMode", "AskUserQuestion", "BashOutput", "KillShell", "Skill", "mcp__a__b", "Weird"];
  for (const tool of tools) for (const running of [false, true]) {
    const r = d.describeTool({ tool }, { running });
    assert.doesNotMatch(r.text, HOOKS, tool); assert.ok(ICONS[r.icon], `${tool} → ${r.icon}`);
  }
  for (const kind of ["tool", "prompt", "question", "stop", "subagent", "notice", "session", "offline", "other"]) {
    const r = d.describeStep({ kind, tool: "Bash" });
    assert.doesNotMatch(r.text, HOOKS, kind); assert.ok(ICONS[r.icon], `${kind} → ${r.icon}`);
  }
});
