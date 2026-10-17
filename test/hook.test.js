"use strict";
// The hook: event building for every hook type, prompt cleaning, git root detection, the detail opt-out,
// and the real process (exit 0, fast, silent, spools when the server is down).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { spawn } = require("child_process");
const { build, gitRootOf, walkUp, wantDetail, changed } = require("../hooks/hook");
const { cleanPrompt } = require("../hooks/text");

const HOOK = path.join(__dirname, "..", "hooks", "hook.js");
const base = { session_id: "s1", cwd: "/p/app", transcript_path: "/t.jsonl", permission_mode: "default" };
const opts = { now: new Date("2026-10-17T10:00:00Z"), gitRoot: "/p/app", host: "box", user: "me", name: null };
const ev = (hook_event_name, extra = {}, o = {}) => build({ ...base, hook_event_name, ...extra }, { ...opts, ...o });

test("hook: every event type builds a small event with the shared fields", () => {
  const names = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
    "Notification", "Stop", "SubagentStart", "SubagentStop", "SessionEnd"];
  for (const n of names) {
    const e = ev(n, { tool_name: "Read", tool_input: { file_path: "/p/app/a.ts" }, tool_use_id: "toolu_1" });
    assert.equal(e.type, "hook"); assert.equal(e.ev, n); assert.equal(e.session, "s1");
    assert.equal(e.cwd, "/p/app"); assert.equal(e.gitRoot, "/p/app"); assert.equal(e.host, "box");
    assert.equal(e.t, "2026-10-17T10:00:00.000Z");
    assert.ok(JSON.stringify(e).length < 2000, n);
    assert.ok(!Object.values(e).some((v) => v === null || v === undefined), `${n} drops empty fields`);
  }
  assert.equal(build({}), null);
  assert.equal(build({ session_id: "x" }), null);
  assert.equal(build(null), null);
});

test("hook: SessionStart, SessionEnd, Notification and sub-agent fields", () => {
  const start = ev("SessionStart", { source: "resume", model: "claude-opus-4-7" });
  assert.equal(start.source, "resume"); assert.equal(start.model, "claude-opus-4-7");
  assert.equal(ev("SessionEnd", { reason: "prompt_input_exit" }).reason, "prompt_input_exit");
  const n = ev("Notification", { message: "Claude needs your permission to use Bash", title: "Permission needed", notification_type: "permission_prompt" });
  assert.equal(n.notificationType, "permission_prompt"); assert.equal(n.message, "Claude needs your permission to use Bash"); assert.equal(n.title, "Permission needed");
  const sub = ev("SubagentStart", { agent_id: "agent-1", agent_type: "Explore" });
  assert.equal(sub.agentId, "agent-1"); assert.equal(sub.agentType, "Explore");
  const inSub = ev("PreToolUse", { tool_name: "Grep", tool_input: { pattern: "TODO" }, tool_use_id: "t9", agent_id: "agent-1", agent_type: "Explore" });
  assert.equal(inSub.agentId, "agent-1"); assert.equal(inSub.toolUseId, "t9");
  const stop = ev("SubagentStop", { agent_id: "agent-1", stop_hook_active: true, last_assistant_message: "x".repeat(5000) });
  assert.equal(stop.stopActive, true); assert.ok(stop.lastMessage.length <= 1536);
});

test("hook: tool input detail is bounded per tool", () => {
  const b = ev("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test " + "x".repeat(900), description: "Run tests", run_in_background: true }, tool_use_id: "t1" });
  assert.equal(b.toolUseId, "t1"); assert.equal(b.detail.command.length, 500); assert.equal(b.detail.description, "Run tests"); assert.equal(b.detail.background, true);
  assert.equal(b.target.length, 140);
  const g = ev("PreToolUse", { tool_name: "Grep", tool_input: { pattern: "roundCents", path: "/p/app/src", glob: "*.ts" } });
  assert.deepEqual(g.detail, { pattern: "roundCents", path: "/p/app/src", glob: "*.ts" });
  const w = ev("PreToolUse", { tool_name: "WebFetch", tool_input: { url: "https://docs.stripe.com/refunds?x=1", prompt: "p" } });
  assert.equal(w.detail.host, "docs.stripe.com");
  assert.equal(ev("PreToolUse", { tool_name: "WebSearch", tool_input: { query: "rate limit" } }).detail.query, "rate limit");
  const a = ev("PreToolUse", { tool_name: "Agent", tool_input: { description: "Explore loyalty rules", subagent_type: "Explore", prompt: "long secret prompt" } });
  assert.deepEqual(a.detail, { description: "Explore loyalty rules", subagentType: "Explore" });
  const todos = Array.from({ length: 80 }, (_, i) => ({ content: "step " + i + " " + "y".repeat(300), status: i ? "pending" : "in_progress", activeForm: "doing " + i }));
  const t = ev("PreToolUse", { tool_name: "TodoWrite", tool_input: { todos } });
  assert.equal(t.detail.todos.length, 50); assert.ok(t.detail.todos[0].content.length <= 200); assert.equal(t.detail.todos[0].status, "in_progress");
  assert.deepEqual(ev("PreToolUse", { tool_name: "TaskUpdate", tool_input: { taskId: 3, status: "completed" } }).detail, { taskId: "3", status: "completed" });
  assert.deepEqual(ev("PreToolUse", { tool_name: "TaskCreate", tool_input: { subject: "Add tests", active_form: "Adding tests" } }).detail, { subject: "Add tests", activeForm: "Adding tests" });
  assert.equal(ev("PreToolUse", { tool_name: "mcp__github__create_issue", tool_input: { title: "x" } }).detail, undefined);
});

test("hook: edits keep a bounded diff plus added and removed line counts", () => {
  const e = ev("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/p/app/a.ts", old_string: "a\nb\nc", new_string: "a\nB\nB2\nc" } });
  assert.deepEqual(e.detail, { path: "/p/app/a.ts", added: 2, removed: 1, hunks: [{ old: "a\nb\nc", new: "a\nB\nB2\nc" }] });
  const big = ev("PreToolUse", { tool_name: "Write", tool_input: { file_path: "/p/app/big.txt", content: "line\n".repeat(5000) } });
  assert.equal(big.detail.added, 5001); assert.ok(big.detail.hunks[0].new.length <= 4096);
  const multi = ev("PreToolUse", { tool_name: "MultiEdit", tool_input: { file_path: "/p/app/m.ts", edits: Array.from({ length: 12 }, () => ({ old_string: "x", new_string: "y\nz" })) } });
  assert.equal(multi.detail.hunks.length, 10); assert.equal(multi.detail.moreHunks, 2); assert.equal(multi.detail.added, 24); assert.equal(multi.detail.removed, 12);
  assert.deepEqual(changed("same", "same"), { added: 0, removed: 0 });
});

test("hook: tool results say ok or error, with a short output tail", () => {
  const ok = ev("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1", tool_response: { stdout: "a".repeat(3000) + "END", stderr: "", interrupted: false }, duration_ms: 1234 });
  assert.equal(ok.result.ok, true); assert.ok(ok.result.tail.endsWith("END")); assert.ok(ok.result.tail.length <= 1536); assert.equal(ok.durationMs, 1234);
  assert.equal(ok.detail, undefined, "Post events don't repeat the input detail");
  const fail = ev("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t2", error: "Exit code 1\nError: Cannot find module 'express'", is_interrupt: false });
  assert.deepEqual(fail.result, { ok: false, exitCode: 1, error: "Exit code 1\nError: Cannot find module 'express'" });
  const intr = ev("PostToolUse", { tool_name: "Bash", tool_input: { command: "sleep 9" }, tool_response: { stdout: "", stderr: "", interrupted: true } });
  assert.equal(intr.result.ok, false); assert.equal(intr.result.interrupted, true);
  const write = ev("PostToolUse", { tool_name: "Write", tool_input: { file_path: "/p/app/n.ts", content: "x" }, tool_response: { filePath: "/p/app/n.ts", type: "create" } });
  assert.deepEqual(write.result, { ok: true, writeType: "create" });
  const web = ev("PostToolUse", { tool_name: "WebFetch", tool_input: { url: "https://x.dev" }, tool_response: { code: 200, result: "page" } });
  assert.deepEqual(web.result, { ok: true }, "HTTP codes are not exit codes, and page text is not kept");
  assert.equal(ev("PostToolUse", { tool_name: "TaskCreate", tool_input: { subject: "s" }, tool_response: { task: { id: 7, subject: "s" } } }).result.taskId, "7");
  assert.equal(ev("PostToolUse", { tool_name: "mcp__x__y", tool_response: { isError: true } }).result.ok, false);
});

test("hook: PermissionRequest carries tool and target; Stop keeps the last message", () => {
  const p = ev("PermissionRequest", { tool_name: "Bash", tool_input: { command: "sudo apt install cups-filters", description: "Install" }, permission_suggestions: [] });
  assert.equal(p.tool, "Bash"); assert.equal(p.target, "sudo apt install cups-filters"); assert.equal(p.detail.command, "sudo apt install cups-filters");
  assert.equal(p.toolUseId, undefined);
  const s = ev("Stop", { stop_hook_active: false, last_assistant_message: "Done. Tests pass." });
  assert.equal(s.lastMessage, "Done. Tests pass."); assert.equal(s.stopActive, undefined);
});

test("prompt cleaning strips system blocks before truncating and keeps the opened file", () => {
  const block = `<system-reminder>${"Do this and that. ".repeat(400)}</system-reminder>`;
  const raw = `<ide_opened_file>The user opened the file /Users/me/pos/src/basket/Basket.tsx in the IDE. This may or may not be related to the current task.</ide_opened_file>${block}\nFix the basket bill rounding`;
  const e = ev("UserPromptSubmit", { prompt: raw });
  assert.equal(e.prompt, "Fix the basket bill rounding");
  assert.equal(e.openedFile, "Basket.tsx");
  const long = ev("UserPromptSubmit", { prompt: "word ".repeat(400) });
  assert.equal(long.prompt.length, 600);
  assert.deepEqual(cleanPrompt('<ide_selection>The user selected the lines 1 to 4 from c:\\code\\pos\\Cart.tsx:\nconst a = 1;\n</ide_selection>Explain this'), { text: "Explain this", openedFile: "Cart.tsx", command: null });
  assert.deepEqual(cleanPrompt("<command-message>review is running…</command-message><command-name>/review</command-name><command-args>src</command-args>"), { text: "", openedFile: null, command: "/review" });
  assert.equal(cleanPrompt("/deploy staging").command, "/deploy");
  assert.equal(cleanPrompt("<system-reminder>cut off before the end").text, "", "an unclosed block runs to the end");
  assert.equal(cleanPrompt("keep </system-reminder> this").text, "keep this");
  assert.equal(cleanPrompt("compare a < b and <b>bold</b>").text, "compare a < b and <b>bold</b>", "other tags stay");
});

test("git root: walks up to .git (folder or file) and caches per cwd", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ao-git-"));
  const repo = path.join(tmp, "shop"), deep = path.join(repo, "src", "deep");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true }); fs.mkdirSync(deep, { recursive: true });
  const wt = path.join(tmp, "worktree"); fs.mkdirSync(wt); fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../shop/.git/worktrees/w");
  const plain = path.join(tmp, "plain"); fs.mkdirSync(plain);
  assert.equal(walkUp(deep), repo);
  assert.equal(walkUp(wt), wt);
  const cache = path.join(tmp, "cache", "gitroots.json");
  assert.equal(gitRootOf(deep, cache), repo);
  assert.equal(JSON.parse(fs.readFileSync(cache, "utf8"))[deep].root, repo);
  // A cached answer is used while fresh, and dropped once the repo is gone.
  fs.writeFileSync(cache, JSON.stringify({ [plain]: { root: repo, t: Date.now() } }));
  assert.equal(gitRootOf(plain, cache), repo, "cache hit");
  fs.rmSync(path.join(repo, ".git"), { recursive: true });
  assert.notEqual(gitRootOf(plain, cache), repo, "stale cache entry is rechecked");
  assert.equal(gitRootOf(null, cache), null);
  fs.writeFileSync(cache, "not json");
  assert.equal(gitRootOf(wt, cache), wt, "a broken cache file is ignored");
});

test("detail opt-out keeps only names, paths and counts", () => {
  assert.equal(wantDetail({}, {}), true);
  assert.equal(wantDetail({}, { AGENT_OFFICE_DETAIL: "0" }), false);
  assert.equal(wantDetail({}, { AGENT_OFFICE_DETAIL: "off" }), false);
  assert.equal(wantDetail({ captureDetail: false }, {}), false);
  const lite = { detail: false };
  const edit = ev("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/p/app/.env", old_string: "A=1", new_string: "A=2\nB=secret" } }, lite);
  assert.deepEqual(edit.detail, { path: "/p/app/.env", added: 2, removed: 1 });
  const bash = ev("PreToolUse", { tool_name: "Bash", tool_input: { command: "curl -H 'Authorization: Bearer abc' x", description: "Call the API" } }, lite);
  assert.deepEqual(bash.detail, { description: "Call the API" });
  assert.equal(bash.target, "Call the API", "the command text never leaves the machine");
  const fetchUrl = ev("PreToolUse", { tool_name: "WebFetch", tool_input: { url: "https://x.dev/private?token=1" } }, lite);
  assert.deepEqual([fetchUrl.target, fetchUrl.detail], ["x.dev", { host: "x.dev" }]);
  const grep = ev("PreToolUse", { tool_name: "Grep", tool_input: { pattern: "API_KEY=", path: "/p/app/src", glob: "*secret*" } }, lite);
  assert.deepEqual([grep.target, grep.detail], [undefined, { path: "/p/app/src" }], "no search text and no file filter");
  const mcp = ev("Notification", { notification_type: "elicitation_dialog", message: "Enter the production DB password", title: "db-server" }, lite);
  assert.deepEqual([mcp.notificationType, mcp.message, mcp.title], ["elicitation_dialog", undefined, undefined], "notification text can come from an MCP server");
  assert.equal(ev("PreToolUse", { tool_name: "WebSearch", tool_input: { query: "private thing" } }, lite).target, undefined);
  assert.equal(ev("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/p/app/a.ts" } }, lite).target, "/p/app/a.ts");
  const prompt = ev("UserPromptSubmit", { prompt: "<ide_opened_file>The user opened the file /p/app/Basket.tsx in the IDE.</ide_opened_file>Basket bill rounding is off for customer 4411" }, lite);
  assert.deepEqual([prompt.prompt, prompt.label, prompt.openedFile], [undefined, "basket bill", "Basket.tsx"], "only the 2–3 word label is sent");
  const out = ev("PostToolUse", { tool_name: "Bash", tool_input: { command: "cat .env" }, tool_response: { stdout: "SECRET=1" } }, lite);
  assert.deepEqual(out.result, { ok: true });
  const failed = ev("PostToolUseFailure", { tool_name: "Bash", error: "Exit code 2\nsecret output" }, lite);
  assert.deepEqual(failed.result, { ok: false, exitCode: 2 });
  assert.equal(ev("Stop", { last_assistant_message: "Here is the key: abc" }, lite).lastMessage, undefined);
  assert.equal(ev("PreToolUse", { tool_name: "WebFetch", tool_input: { url: "https://x.dev/private?token=1" } }, lite).detail.url, undefined);
  assert.equal(ev("PreToolUse", { tool_name: "TodoWrite", tool_input: { todos: [{ content: "Plan item", status: "pending" }] } }, lite).detail.todos.length, 1);
});

// ---- the real process ----
function freePort() {
  return new Promise((resolve) => { const srv = net.createServer().listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });
}
function runHook(stdin, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, "--agent-office"], { env: { ...process.env, AGENT_NAME: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

test("hook process: server down → exit 0 fast, prints nothing, event spooled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-hook-"));
  const env = { AGENT_OFFICE_DIR: dir, AGENT_OFFICE_URL: `http://127.0.0.1:${await freePort()}`, AGENT_OFFICE_TOKEN: "t" };
  const payload = JSON.stringify({ ...base, cwd: dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_x" });
  const r = await runHook(payload, env);
  assert.equal(r.code, 0); assert.equal(r.out, ""); assert.ok(r.ms < 2000, `took ${r.ms}ms`);
  const lines = fs.readFileSync(path.join(dir, "spool", "pending.jsonl"), "utf8").trim().split("\n");
  const e = JSON.parse(lines[0]);
  assert.equal(e.ev, "PreToolUse"); assert.equal(e.toolUseId, "toolu_x"); assert.equal(e.detail.command, "npm test");
});

test("hook process: malformed or empty stdin → exit 0, nothing printed, nothing spooled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-hook-"));
  const env = { AGENT_OFFICE_DIR: dir, AGENT_OFFICE_URL: `http://127.0.0.1:${await freePort()}` };
  for (const input of ["{not json", "", "null", "[]", '{"hook_event_name":"Stop"}']) {
    const r = await runHook(input, env);
    assert.equal(r.code, 0, input); assert.equal(r.out, "", input);
  }
  assert.equal(fs.existsSync(path.join(dir, "spool", "pending.jsonl")), false);
});

test("hook process: opt-out via AGENT_OFFICE_DETAIL=0 reaches the spooled event", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-hook-"));
  const env = { AGENT_OFFICE_DIR: dir, AGENT_OFFICE_URL: `http://127.0.0.1:${await freePort()}`, AGENT_OFFICE_DETAIL: "0" };
  await runHook(JSON.stringify({ ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "cat x" }, tool_response: { stdout: "secret" } }), env);
  const e = JSON.parse(fs.readFileSync(path.join(dir, "spool", "pending.jsonl"), "utf8"));
  assert.deepEqual(e.result, { ok: true });
});

// ---- adversarial input and concurrency (the hook must never hang a session) ----
const MB = 1000000;
const ADVERSARIAL = {
  "minified JSON": JSON.stringify(Array.from({ length: 60000 }, (_, i) => ({ id: i, k: "v" + i }))).slice(0, MB),
  "one long word": "a".repeat(MB),
  "slashes": "a/".repeat(MB / 2),
  "system-reminder without >": "<system-reminder ".repeat(MB / 17),
  "ide_x without >": "<ide_x ".repeat(MB / 7),
  "command- then a-a-a": "<command-" + "a-".repeat(MB / 2),
  "unclosed selection": "<ide_selection>The user selected the lines 1 to 9 from " + "x".repeat(MB),
  "closing-tag spam": "<system-reminder>" + "</system-reminder".repeat(MB / 18),
};

test("prompt cleaning and labels stay linear on 1 MB adversarial prompts", () => {
  const { agentLabel } = require("../hooks/text");
  for (const [name, p] of Object.entries(ADVERSARIAL)) {
    const t = Date.now();
    const c = cleanPrompt(p); agentLabel(p); agentLabel(c.text);
    assert.ok(Date.now() - t < 300, `${name} took ${Date.now() - t}ms`);
  }
  assert.equal(cleanPrompt("<system-reminder>x</system-reminder>".repeat(20000) + " real prompt").text, "real prompt");
});

test("hook process: 1 MB adversarial prompts finish in under 500 ms (beyond Node startup) and are spooled, in both modes", async () => {
  const startup = await new Promise((resolve) => {
    const t = Date.now();
    spawn(process.execPath, ["-e", ""]).on("close", () => resolve(Date.now() - t));
  });
  for (const detail of ["1", "0"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-adv-"));
    const env = { AGENT_OFFICE_DIR: dir, AGENT_OFFICE_URL: `http://127.0.0.1:${await freePort()}`, AGENT_OFFICE_DETAIL: detail };
    const names = Object.keys(ADVERSARIAL);
    for (const name of names) {
      const r = await runHook(JSON.stringify({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: ADVERSARIAL[name] }), env);
      assert.equal(r.code, 0, name); assert.equal(r.out, "", name);
      assert.ok(r.ms - startup < 500, `${name} (detail ${detail}): ${r.ms}ms vs ${startup}ms startup`);
    }
    const spooled = fs.readFileSync(path.join(dir, "spool", "pending.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(spooled.length, names.length, `every event spooled (detail ${detail})`);
    assert.ok(spooled.every((e) => e.ev === "UserPromptSubmit" && (detail === "1" ? e.prompt.length <= 600 : e.prompt === undefined)));
  }
});

test("hook process: 40 parallel hooks leave no temp files and lose no events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-par-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const env = { AGENT_OFFICE_DIR: dir, AGENT_OFFICE_URL: `http://127.0.0.1:${await freePort()}` };
  const runs = Array.from({ length: 40 }, (_, i) => {
    const cwd = path.join(repo, `pkg${i}`);
    fs.mkdirSync(cwd);
    return runHook(JSON.stringify({ ...base, session_id: `s${i}`, cwd, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_use_id: `t${i}` }), env);
  });
  const results = await Promise.all(runs);
  assert.ok(results.every((r) => r.code === 0 && r.out === ""));
  const spoolDir = path.join(dir, "spool");
  assert.deepEqual(fs.readdirSync(spoolDir).filter((f) => f !== "pending.jsonl" && f !== "gitroots.json"), [], "no temp files left behind");
  const events = fs.readFileSync(path.join(spoolDir, "pending.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.length, 40);
  assert.ok(events.every((e) => e.gitRoot === repo), "every hook found the git root");
});

test("captureDetail in config: false, \"false\", 0, \"off\" and \"no\" all turn detail off", () => {
  for (const v of [false, "false", "FALSE", 0, "0", "off", "no", " false "]) assert.equal(wantDetail({ captureDetail: v }, {}), false, JSON.stringify(v));
  for (const v of [true, "true", undefined, null, "", 1]) assert.equal(wantDetail({ captureDetail: v }, {}), true, JSON.stringify(v));
});

test("hook: StopFailure carries the error type and Claude Code's error text", () => {
  const e = ev("StopFailure", { error: "rate_limit", error_details: "429 Too Many Requests", last_assistant_message: "API Error: Rate limit reached" });
  assert.deepEqual([e.failure, e.message], ["rate_limit", "API Error: Rate limit reached"]);
  const lite = ev("StopFailure", { error: "overloaded", error_details: "529" }, { detail: false });
  assert.deepEqual([lite.failure, lite.message], ["overloaded", undefined]);
});
