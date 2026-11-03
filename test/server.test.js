"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createServer } = require("../src/server");

const quiet = { log() {}, warn() {}, error() {} };
delete process.env.AGENT_OFFICE_HOLD; // the setup snippet's hold is the default, whatever this machine sets
async function boot(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-srv-"));
  Object.assign(process.env, env);
  const app = createServer({ dir, log: quiet });
  for (const k of Object.keys(env)) delete process.env[k];
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const token = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).token;
  return { app, base, token, dir };
}

test("ingest needs the token; state shows hook events and OTLP usage", async () => {
  const { app, base, token } = await boot();
  try {
    let r = await fetch(base + "/api/events", { method: "POST", body: "{}" });
    assert.equal(r.status, 401);
    r = await fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + token },
      body: JSON.stringify({ type: "hook", t: new Date().toISOString(), session: "s1", ev: "UserPromptSubmit", cwd: "/p/aurum", prompt: "go" }) });
    assert.deepEqual(await r.json(), { accepted: 1 });
    r = await fetch(base + "/v1/logs", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [
        { key: "event.name", value: { stringValue: "api_request" } }, { key: "session.id", value: { stringValue: "s1" } },
        { key: "cost_usd", value: { doubleValue: 0.3 } }] }] }] }] }) });
    assert.equal(r.status, 200);
    const s = await (await fetch(base + "/api/state")).json();
    assert.equal(s.agents[0].name, "aurum"); assert.equal(s.agents[0].cost, 0.3); assert.equal(s.totals.todayCost, 0.3);
  } finally { await app.close(); }
});

test("settings need the same-origin header and validate input", async () => {
  const { app, base } = await boot();
  try {
    let r = await fetch(base + "/api/settings", { method: "PUT", body: JSON.stringify({ dailyBudgetUsd: 5 }) });
    assert.equal(r.status, 403);
    const h = { "X-Requested-With": "agent-office", "Content-Type": "application/json" };
    r = await fetch(base + "/api/settings", { method: "PUT", headers: h, body: JSON.stringify({ offlineAfterMin: 0 }) });
    assert.equal(r.status, 400);
    r = await fetch(base + "/api/settings", { method: "PUT", headers: h, body: JSON.stringify({ dailyBudgetUsd: 5, alias: { folder: "/p", name: "Bot" } }) });
    const s = await r.json(); assert.equal(s.dailyBudgetUsd, 5); assert.equal(s.aliases["/p"], "Bot");
  } finally { await app.close(); }
});

test("static files are served and path traversal is blocked", async () => {
  const { app, base } = await boot();
  try {
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal((await fetch(base + "/app.js")).status, 200);
    assert.equal((await fetch(base + "/ui/gallery.html")).status, 200);
    const mod = await fetch(base + "/ui/components.js");
    assert.equal(mod.status, 200);
    assert.match(mod.headers.get("content-type"), /^text\/javascript/);
    // fetch() normalises "/%2e%2e/" away, so also send raw paths. (public/ has its own package.json for ESM.)
    assert.notEqual((await fetch(base + "/%2e%2e/README.md")).status, 200);
    assert.notEqual((await fetch(base + "/..%2fsrc%2fconfig.js")).status, 200);
    const raw = (p) => new Promise((resolve, reject) => require("http").get(base + "/", { path: p }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject));
    assert.equal(await raw("/%E0%A4%A"), 400, "a malformed %-encoding is a bad request, not a server error");
    assert.equal(await raw("/app.js%00.css"), 400, "so is a NUL byte");
    for (const p of ["/../README.md", "/ui/../../src/config.js", "/..%5csrc%5cconfig.js", "/..%2f..%2fpackage.json"]) assert.notEqual(await raw(p), 200, p);
  } finally { await app.close(); }
});

test("team mode asks for sign in", async () => {
  const { app, base, token } = await boot({ HOST: "0.0.0.0" });
  try {
    let r = await fetch(base + "/api/state"); assert.equal(r.status, 401);
    r = await fetch(base + "/", { redirect: "manual" }); assert.equal(r.status, 302);
    r = await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ token: "wrong" }) }); assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "That token isn't right. Run agent-office token on the server to see it." }, "plain words: the sign-in page shows it as text");
    r = await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ token }) });
    const c = r.headers.get("set-cookie").split(";")[0];
    r = await fetch(base + "/api/state", { headers: { cookie: c } }); assert.equal(r.status, 200);
  } finally { await app.close(); }
});

test("spooled events are picked up on start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-spool-"));
  fs.mkdirSync(path.join(dir, "spool"));
  fs.writeFileSync(path.join(dir, "spool", "pending.jsonl"), JSON.stringify({ type: "hook", t: new Date().toISOString(), session: "z", ev: "UserPromptSubmit", cwd: "/p/spooled" }) + "\n");
  const app = createServer({ dir, log: quiet });
  try { assert.equal(app.store.agents()[0].name, "spooled"); } finally { await app.close(); }
});

// ---------- M2: agent detail and timeline ----------
const hookEvent = (ev, extra = {}) => ({ type: "hook", t: new Date().toISOString(), session: "s-1", ev, cwd: "/p/shop", gitRoot: "/p/shop", ...extra });

test("GET /api/agents/:id returns the full detail, validates the id and needs sign-in", async () => {
  const { app, base, token } = await boot();
  try {
    const events = [hookEvent("UserPromptSubmit", { prompt: "Basket bill rounding is off" }),
      hookEvent("PreToolUse", { tool: "Edit", target: "/p/shop/src/a.ts", toolUseId: "t1", detail: { path: "/p/shop/src/a.ts", added: 2, removed: 1, hunks: [{ old: "a", new: "b\nc" }] } }),
      hookEvent("PostToolUse", { tool: "Edit", toolUseId: "t1", result: { ok: true } })];
    await fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(events) });
    let r = await fetch(base + "/api/agents/s-1");
    assert.equal(r.status, 200);
    const d = await r.json();
    for (const k of ["agent", "trace", "plan", "subagents", "conversation", "stateLog", "segments", "files"]) assert.ok(k in d, k);
    assert.equal(d.agent.name, "shop · basket bill");
    assert.equal(d.trace[1].detail.hunks[0].new, "b\nc", "detail keeps the diff");
    assert.deepEqual(d.files.map((f) => [f.rel, f.edits, f.added, f.removed]), [["src/a.ts", 1, 2, 1]]);
    assert.equal((await fetch(base + "/api/agents/nope")).status, 404);
    for (const bad of ["a%2Fb", "x".repeat(101), "%E0%A4%A", "bad%20id", "<script>"]) assert.equal((await fetch(base + "/api/agents/" + bad)).status, 400, bad);
    const s = await (await fetch(base + "/api/state")).json();
    assert.equal(s.agents[0].trace, undefined, "the live state stays lean");
    assert.equal(s.agents[0].recent.at(-1).detail.hunks, undefined);
  } finally { await app.close(); }
});

test("GET /api/timeline returns segments and 10-minute buckets, and validates the date", async () => {
  const { app, base, token } = await boot();
  try {
    await fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(hookEvent("UserPromptSubmit", { prompt: "go" })) });
    const pad = (n) => String(n).padStart(2, "0"), d = new Date();
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    for (const q of ["", "?date=" + today]) {
      const tl = await (await fetch(base + "/api/timeline" + q)).json();
      assert.equal(tl.date, today); assert.equal(tl.bucketMs, 600000);
      assert.equal(tl.sessions[0].session, "s-1"); assert.equal(tl.sessions[0].segments.at(-1).state, "working");
      assert.ok(tl.buckets.length >= 1 && tl.buckets.length <= 144);
      assert.ok("waitedMs" in tl.sessions[0].totals);
    }
    for (const bad of ["2026-02-31", "2026-1-01", "yesterday", "2026-13-01", "2026-10-17T00:00"]) assert.equal((await fetch(base + "/api/timeline?date=" + bad)).status, 400, bad);
  } finally { await app.close(); }
});

test("GET /api/board returns today's plan items; the state has spend per project; in team mode it needs sign-in", async () => {
  let { app, base, token } = await boot();
  try {
    const todos = [{ content: "Fix the rounding", status: "in_progress" }, { content: "Add tests", status: "pending" }];
    await fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + token },
      body: JSON.stringify([hookEvent("PreToolUse", { tool: "TodoWrite", toolUseId: "t1", detail: { todos } }), { type: "usage", t: new Date().toISOString(), session: "s-1", cost: 0.4 }]) });
    const r = await fetch(base + "/api/board");
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.deepEqual(b.plans.map((p) => [p.session, p.of, p.open.map((x) => `${x.step} ${x.status} ${x.text}`)]), [["s-1", 2, ["1 in_progress Fix the rounding", "2 pending Add tests"]]]);
    assert.equal(b.spend, undefined, "spend is in the live state, so it never makes the board fetch again");
    const s = await (await fetch(base + "/api/state")).json();
    assert.deepEqual(s.totals.todayByProject, { shop: 0.4 });
    assert.equal(typeof s.agents[0].planAt, "string", "the live state says when the plan changed, not the items");
    assert.equal(s.agents[0].plan.items, undefined);
  } finally { await app.close(); }
  ({ app, base, token } = await boot({ HOST: "0.0.0.0" }));
  try {
    assert.equal((await fetch(base + "/api/board")).status, 401);
    assert.equal((await fetch(base + "/api/board", { headers: { Authorization: "Bearer " + token } })).status, 200);
  } finally { await app.close(); }
});

test("team mode: the new endpoints need sign-in like /api/state", async () => {
  const { app, base, token } = await boot({ HOST: "0.0.0.0" });
  try {
    assert.equal((await fetch(base + "/api/agents/s-1")).status, 401);
    assert.equal((await fetch(base + "/api/timeline")).status, 401);
    const ok = { headers: { Authorization: "Bearer " + token } };
    assert.equal((await fetch(base + "/api/timeline", ok)).status, 200);
    assert.equal((await fetch(base + "/api/agents/s-1", ok)).status, 404);
  } finally { await app.close(); }
});

test("demo mode: shows a $25 budget in memory and never saves settings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-demo-"));
  const app = createServer({ dir, demo: true, log: quiet });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const before = fs.readFileSync(path.join(dir, "config.json"), "utf8");
    const s = await (await fetch(base + "/api/state")).json();
    assert.equal(s.settings.dailyBudgetUsd, 25); assert.equal(s.agents.length, 8); assert.equal(s.settings.viewer, "mk");
    const r = await fetch(base + "/api/settings", { method: "PUT", headers: { "X-Requested-With": "agent-office" }, body: JSON.stringify({ offlineAfterMin: 45 }) });
    assert.equal((await r.json()).dailyBudgetUsd, 25);
    assert.equal(fs.readFileSync(path.join(dir, "config.json"), "utf8"), before, "config file untouched");
    assert.equal(JSON.parse(before).dailyBudgetUsd, 0);
    const d = await (await fetch(base + "/api/agents/demo-basket")).json();
    assert.equal(d.subagents.length, 2);
  } finally { await app.close(); }
});

// ---------- M4: the Command Center's onboarding and avatar ----------
const raw = (base, p, headers = {}) => new Promise((resolve, reject) => {
  require("http").get(base + p, { headers }, (res) => { let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => resolve({ status: res.statusCode, body: s })); }).on("error", reject);
});

test("GET /api/setup: the token and settings.json snippet, same-origin only, and never under a foreign host name", async () => {
  const { app, base, token } = await boot();
  try {
    const port = app.server.address().port, same = { "X-Requested-With": "agent-office" };
    assert.equal((await raw(base, "/api/setup")).status, 403, "needs the same-origin header");
    assert.equal((await raw(base, "/api/setup", { ...same, Host: `evil.example:${port}` })).status, 403, "a rebound name gets nothing");
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) assert.equal((await raw(base, "/api/setup", { ...same, Host: host })).status, 200, host);
    const r = JSON.parse((await raw(base, "/api/setup", same)).body);
    assert.deepEqual([r.token, r.url, r.teamMode], [token, `http://127.0.0.1:${port}`, false]);
    const snippet = JSON.parse(r.snippet);
    assert.match(snippet.hooks.PermissionRequest[0].hooks[0].command, /hook\.js" --agent-office --hold=120$/);
    assert.equal(snippet.hooks.PermissionRequest[0].hooks[0].timeout, 130, "the hold plus 10 s");
    assert.equal(snippet.env.OTEL_EXPORTER_OTLP_ENDPOINT, r.url);
    assert.equal(snippet.env.OTEL_EXPORTER_OTLP_HEADERS, `Authorization=Bearer ${token}`);
    assert.equal(JSON.parse((await raw(base, "/api/state")).body).settings.viewer, require("os").userInfo().username, "the avatar is the person running the dashboard");
  } finally { await app.close(); }
});

test("GET /api/setup in team mode: sign-in first, and the address the browser used", async () => {
  const { app, base, token } = await boot({ HOST: "0.0.0.0" });
  try {
    assert.equal((await raw(base, "/api/setup", { "X-Requested-With": "agent-office" })).status, 401);
    const auth = { "X-Requested-With": "agent-office", Authorization: "Bearer " + token, Host: "office.example.com" };
    const r = JSON.parse((await raw(base, "/api/setup", auth)).body);
    assert.deepEqual([r.url, r.teamMode], ["http://office.example.com", true]);
    assert.equal(JSON.parse((await raw(base, "/api/state", auth)).body).settings.viewer, null, "nobody in particular: everyone shares the token");
  } finally { await app.close(); }
});

// ---------- M5: answering an agent from the dashboard ----------
const JSON_H = { "Content-Type": "application/json" }, SAME = { "X-Requested-With": "agent-office", ...JSON_H };
const CMD = "sudo apt install cups-filters";
/** A Bash call and its PermissionRequest from a hook that waits `hold` seconds. Returns the reply to the request. */
async function asks(base, token, { hold = 120, tool = "Bash", target = CMD, id = "t1" } = {}) {
  const post = (e) => fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + token, ...JSON_H }, body: JSON.stringify(e) }).then((r) => r.json());
  const detail = tool === "Bash" ? { command: target } : { path: target };
  await post(hookEvent("PreToolUse", { tool, target, toolUseId: id, detail }));
  return post(hookEvent("PermissionRequest", { tool, target, detail, ...(hold ? { hold } : {}) }));
}
const poll = (base, token, id, wait = 0, headers = { Authorization: "Bearer " + token }) => fetch(`${base}/api/decision/${id}?wait=${wait}`, { headers });
const answer = (base, body, headers = SAME) => fetch(base + "/api/answer", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const state = async (base, headers = {}) => (await (await fetch(base + "/api/state", { headers })).json()).agents[0];
const rawPost = (base, p, headers, body) => new Promise((resolve, reject) => {
  const req = require("http").request(base + p, { method: "POST", headers }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on("error", reject); req.end(body);
});
/** boot() with a dashboard open: asks are only opened while someone can answer them. */
async function watched(env) {
  const b = await boot(env);
  await new Promise((resolve) => {
    require("http").get(b.base + "/api/stream", { headers: { Authorization: "Bearer " + b.token } }, (res) => { res.on("data", () => {}); res.on("error", () => {}); resolve(); }).on("error", () => {});
  });
  return b;
}

test("nobody has the dashboard open: no askId, so the hook ends at once; a tool allowed for this session is still approved", async () => {
  const { app, base, token } = await boot();
  try {
    const r = await asks(base, token);
    assert.deepEqual(r, { accepted: 1 });
    const q = (await state(base)).question;
    assert.deepEqual([q.ask, q.windowClosed], [null, false], "the terminal asks");
    // Allowed earlier, while the dashboard was open (the store's default): approved for you now, with nobody watching.
    const edit = app.store.applyHeld(hookEvent("PermissionRequest", { tool: "Edit", target: "/p/shop/a.ts", detail: { path: "/p/shop/a.ts" }, hold: 120 })).ask;
    assert.equal((await answer(base, { askId: edit.id, kind: "session" })).status, 200);
    await poll(base, token, edit.id);
    assert.deepEqual((await state(base)).allowed, ["Edit"]);
    const next = await (await fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + token },
      body: JSON.stringify(hookEvent("PermissionRequest", { tool: "Edit", target: "/p/shop/b.ts", detail: { path: "/p/shop/b.ts" }, hold: 120 })) })).json();
    assert.deepEqual(await (await poll(base, token, next.askId)).json(), { status: "answered", decision: { behavior: "allow" } });
  } finally { await app.close(); }
});

test("a waiting permission request gets a random askId; the hook long-polls it with the token; the answer arrives at once", async () => {
  const { app, base, token } = await watched();
  try {
    assert.equal((await asks(base, token, { hold: 0 })).askId, undefined, "a hook that doesn't wait gets no askId");
    const r = await asks(base, token, { id: "t2" });
    assert.equal(r.accepted, 1); assert.match(r.askId, /^[A-Za-z0-9_-]{24}$/);
    const q = (await state(base)).question;
    assert.equal(q.ask.id, r.askId, "the dashboard is offered the ask");
    assert.ok(Math.abs(Date.parse(q.ask.until) - Date.now() - 120000) < 5000);
    assert.equal((await fetch(`${base}/api/decision/${r.askId}`)).status, 401, "the hook's poll needs the ingest token");
    assert.equal((await poll(base, token, "too-short")).status, 400);
    assert.equal((await poll(base, token, "x".repeat(24))).status, 404);
    assert.deepEqual(await (await poll(base, token, r.askId)).json(), { status: "pending" });

    const t0 = Date.now(), held = poll(base, token, r.askId, 10).then((x) => x.json());
    await new Promise((res) => setTimeout(res, 150));
    const a = await answer(base, { askId: r.askId, kind: "reply", text: "  Use the package without sudo  " });
    assert.equal(a.status, 200);
    assert.equal((await a.json()).delivered, true, "the waiting hook got it in the same moment");
    assert.deepEqual(await held, { status: "answered", decision: { behavior: "deny", message: "Use the package without sudo" } });
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    assert.equal((await answer(base, { askId: r.askId, kind: "approve" })).status, 409, "answered once");
    const ag = await state(base);
    assert.deepEqual([ag.state, ag.question, ag.answer.choice, ag.answer.text, !!ag.answer.delivered], ["working", null, "reply", "Use the package without sudo", true]);
    assert.equal(ag.recent.at(-1).kind, "answer", "the feed logs it");
  } finally { await app.close(); }
});

test("POST /api/answer: the same-origin header and a local host name are required, input is checked, and answers can't come in as hook events", async () => {
  const { app, base, token } = await watched();
  try {
    const { askId } = await asks(base, token), port = app.server.address().port;
    assert.equal((await answer(base, { askId, kind: "approve" }, JSON_H)).status, 403, "no same-origin header");
    assert.equal(await rawPost(base, "/api/answer", { ...SAME, Host: `evil.example:${port}` }, JSON.stringify({ askId, kind: "approve" })), 403, "a page that rebinds its name to this computer");
    const bad = [[{ askId, kind: "maybe" }, 400], [{ askId, kind: "reply" }, 400], [{ askId, kind: "reply", text: "   " }, 400], [{ askId, kind: "reply", text: "x".repeat(1001) }, 400],
      [{ askId: "nope", kind: "approve" }, 404], [{ kind: "approve" }, 404], ["{oops", 400], ["null", 404]];
    for (const [body, code] of bad) assert.equal((await answer(base, body)).status, code, String(JSON.stringify(body)).slice(0, 50));
    // A token holder can't forge an answer, or an "allow for this session", through the hook endpoint.
    const forged = await fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + token },
      body: JSON.stringify([{ type: "answer", t: new Date().toISOString(), session: "s-1", choice: "session", tool: "Bash" }]) });
    assert.deepEqual(await forged.json(), { accepted: 0 });
    let ag = await state(base);
    assert.deepEqual([ag.state, ag.allowed], ["waiting", []]);
    assert.equal((await answer(base, { askId, kind: "approve", text: "ignored" })).status, 200);
    assert.deepEqual(await (await poll(base, token, askId)).json(), { status: "answered", decision: { behavior: "allow" } });
    ag = await state(base);
    assert.deepEqual([ag.state, ag.answer.choice, ag.answer.text], ["working", "approve", null]);
  } finally { await app.close(); }
});

test("team mode: answering needs sign-in; the hook's poll needs the token, not a dashboard cookie", async () => {
  const { app, base, token } = await watched({ HOST: "0.0.0.0" });
  try {
    const { askId } = await asks(base, token);
    assert.equal((await answer(base, { askId, kind: "approve" })).status, 401);
    const c = (await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ token }) })).headers.get("set-cookie").split(";")[0];
    assert.equal((await poll(base, token, askId, 0, { cookie: c })).status, 401, "a sign-in cookie is not the ingest token");
    assert.equal((await answer(base, { askId, kind: "deny" }, { ...SAME, cookie: c })).status, 200);
    assert.deepEqual(await (await poll(base, token, askId)).json(), { status: "answered", decision: { behavior: "deny", message: "The user denied this in Virtual Office." } });
  } finally { await app.close(); }
});

test("allow for this session: the next request for that tool is approved at once, never waiting; another tool still asks", async () => {
  const { app, base, token } = await watched();
  try {
    const { askId } = await asks(base, token);
    await answer(base, { askId, kind: "session" });
    assert.deepEqual((await state(base)).allowed, [], "not until the hook picks it up");
    await poll(base, token, askId);
    assert.deepEqual((await state(base)).allowed, ["Bash"]);
    const seen = [];
    app.store.on("transition", (x) => seen.push(x.to));
    const next = await asks(base, token, { target: "npm install -D autocannon", id: "t2" });
    assert.deepEqual(await (await poll(base, token, next.askId)).json(), { status: "answered", decision: { behavior: "allow" } });
    assert.deepEqual(seen, [], "no needs-you, no toast, no alert");
    const d = await (await fetch(base + "/api/agents/s-1")).json();
    assert.equal(d.conversation.at(-1).choice, "auto");
    const edit = await asks(base, token, { tool: "Edit", target: "/p/shop/.env", id: "t3" });
    assert.deepEqual([(await state(base)).state, (await (await poll(base, token, edit.askId)).json()).status], ["waiting", "pending"]);
  } finally { await app.close(); }
});

test("an ask ends when the hook hangs up, the window passes, or it's answered in the terminal; the dashboard then says so", async () => {
  const { app, base, token } = await watched();
  let closed = false;
  try {
    // The hook hangs up mid-poll.
    let { askId } = await asks(base, token);
    await new Promise((resolve) => {
      const req = require("http").get(`${base}/api/decision/${askId}?wait=10`, { headers: { Authorization: "Bearer " + token } });
      req.on("error", () => {});
      setTimeout(() => { req.destroy(); setTimeout(resolve, 100); }, 100);
    });
    const q = (await state(base)).question;
    assert.deepEqual([q.ask, q.windowClosed], [null, true]);
    assert.equal((await answer(base, { askId, kind: "approve" })).status, 410);
    // The window passes during a poll (the last 2 s take no answers).
    ({ askId } = await asks(base, token, { hold: 1, id: "t2" }));
    assert.equal((await answer(base, { askId, kind: "approve" })).status, 410, "too close to the end");
    const t0 = Date.now();
    assert.deepEqual(await (await poll(base, token, askId, 10)).json(), { status: "closed" });
    assert.ok(Date.now() - t0 < 2500, "the poll ends with the window");
    // Approved in the terminal: the tool ran, so the waiting hook is let go.
    ({ askId } = await asks(base, token, { id: "t3" }));
    const held = poll(base, token, askId, 10).then((x) => x.json());
    await new Promise((res) => setTimeout(res, 100));
    await fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(hookEvent("PostToolUse", { tool: "Bash", toolUseId: "t3", result: { ok: true } })) });
    assert.deepEqual(await held, { status: "closed" });
    // Shutting down lets go of any waiting hook.
    ({ askId } = await asks(base, token, { id: "t4" }));
    const last = poll(base, token, askId, 10).then((x) => x.json());
    await new Promise((res) => setTimeout(res, 100));
    closed = true;
    await app.close();
    assert.deepEqual(await last, { status: "closed" });
  } finally { if (!closed) await app.close(); }
});

// ---------- M6: messages from the dashboard, delivered by the Stop hook; names ----------
const ingest = (base, token, e) => fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + token, ...JSON_H }, body: JSON.stringify(e) }).then((r) => r.json());
const message = (base, id, body, headers = SAME) => fetch(`${base}/api/agents/${id}/message`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("POST /api/agents/:id/message queues it; the next Stop from a hook that can print it gets it in the reply, once", async () => {
  const { app, base, token } = await boot();
  try {
    await ingest(base, token, hookEvent("UserPromptSubmit", { prompt: "Fix the till" }));
    let r = await message(base, "s-1", { text: "  Also update the changelog.  " });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).message.status, "queued");
    assert.equal((await state(base)).queued, 1);
    // An old hook (no inbox flag) and a Stop while Claude already carries on: nothing handed over.
    assert.deepEqual(await ingest(base, token, hookEvent("Stop")), { accepted: 1 });
    assert.equal((await state(base)).takesMessages, false, "that Stop didn't ask for messages: the dashboard can warn");
    assert.deepEqual(await ingest(base, token, hookEvent("Stop", { inbox: true, stopActive: true })), { accepted: 1 });
    assert.deepEqual(await ingest(base, token, [hookEvent("Stop", { inbox: true })]), { accepted: 1 }, "nor inside a batch");
    assert.deepEqual(await ingest(base, token, hookEvent("Stop", { inbox: true })), { accepted: 1, messages: ["Also update the changelog."] });
    assert.equal((await state(base)).state, "working", "it carries on with your message");
    assert.deepEqual(await ingest(base, token, hookEvent("Stop", { inbox: true })), { accepted: 1 }, "handed over once");
    assert.equal((await state(base)).state, "idle", "then its turn ends");
    const d = await (await fetch(base + "/api/agents/s-1")).json();
    assert.deepEqual(d.conversation.filter((x) => x.kind === "message").map((x) => x.status), ["delivered"]);
  } finally { await app.close(); }
});

test("POST /api/agents/:id/message: same-origin header and a local host name, input checked; hooks can't forge messages, deliveries or names", async () => {
  const { app, base, token } = await boot();
  try {
    await ingest(base, token, hookEvent("UserPromptSubmit", { prompt: "Fix the till" }));
    const port = app.server.address().port;
    assert.equal((await message(base, "s-1", { text: "hi" }, JSON_H)).status, 403, "no same-origin header");
    assert.equal(await rawPost(base, "/api/agents/s-1/message", { ...SAME, Host: `evil.example:${port}` }, JSON.stringify({ text: "hi" })), 403, "a rebound host name");
    for (const [id, body, code] of [["s-1", { text: "" }, 400], ["s-1", { text: "x".repeat(1001) }, 400], ["s-1", "{oops", 400], ["s-1", "null", 400], ["nope", { text: "hi" }, 404], ["a%2Fb", { text: "hi" }, 400]]) {
      assert.equal((await message(base, id, body)).status, code, `${id} ${String(JSON.stringify(body)).slice(0, 30)}`);
    }
    const forged = await ingest(base, token, [{ type: "message", t: new Date().toISOString(), session: "s-1", text: "rm -rf /" },
      { type: "delivered", t: new Date().toISOString(), session: "s-1", ids: [1, 2, 3] }, { type: "name", t: new Date().toISOString(), session: "s-1", name: "pwned" },
      { type: "release", t: new Date().toISOString(), session: "s-1", questionId: 1 }]);
    assert.deepEqual(forged, { accepted: 0 });
    const s = await state(base);
    assert.deepEqual([s.queued, s.name], [0, "shop · till"]);
  } finally { await app.close(); }
});

test("team mode: messaging and renaming need sign-in", async () => {
  const { app, base, token } = await boot({ HOST: "0.0.0.0" });
  try {
    await ingest(base, token, hookEvent("UserPromptSubmit", { prompt: "Fix the till" }));
    assert.equal((await message(base, "s-1", { text: "hi" })).status, 401);
    assert.equal((await fetch(`${base}/api/agents/s-1/name`, { method: "POST", headers: SAME, body: JSON.stringify({ name: "x" }) })).status, 401);
    const c = (await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ token }) })).headers.get("set-cookie").split(";")[0];
    assert.equal((await message(base, "s-1", { text: "hi" }, { ...SAME, cookie: c })).status, 200, "any host name in team mode, once signed in");
  } finally { await app.close(); }
});

test("POST /api/agents/:id/name renames that session (same-origin, local host name), and an empty name resets it", async () => {
  const { app, base, token } = await boot();
  try {
    await ingest(base, token, hookEvent("UserPromptSubmit", { prompt: "Fix the till" }));
    const name = (body, headers = SAME) => fetch(`${base}/api/agents/s-1/name`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await name({ name: "Till fixer" }, JSON_H)).status, 403);
    const port = app.server.address().port;
    assert.equal(await rawPost(base, "/api/agents/s-1/name", { ...SAME, Host: `evil.example:${port}` }, JSON.stringify({ name: "pwned" })), 403, "a rebound host name, like messages");
    const r = await name({ name: "Till fixer" });
    assert.deepEqual(await r.json(), { ok: true, name: "Till fixer" });
    assert.equal((await state(base)).name, "Till fixer");
    assert.equal((await name({ name: "x".repeat(61) })).status, 400);
    assert.deepEqual(await (await name({ name: "" })).json(), { ok: true, name: "shop · till" });
  } finally { await app.close(); }
});

test("a spooled Stop never takes messages: nobody would print them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-spool-"));
  const t = Date.now();
  const e = (ev, extra, dt) => ({ type: "hook", t: new Date(t + dt).toISOString(), session: "z", ev, cwd: "/p/spooled", ...extra });
  let app = createServer({ dir, log: quiet });
  app.store.apply(e("UserPromptSubmit", { prompt: "go" }, 0));
  app.store.queueMessage("z", "hello");
  await app.close();
  fs.mkdirSync(path.join(dir, "spool"), { recursive: true });
  fs.writeFileSync(path.join(dir, "spool", "pending.jsonl"), JSON.stringify(e("Stop", { inbox: true }, 1000)) + "\n");
  app = createServer({ dir, log: quiet });
  try { assert.equal(app.store.agents()[0].queued, 1, "still queued for a hook that can hand it over"); } finally { await app.close(); }
});

// ---------- M8: messages to a room ----------
const roomMsg = (base, project, body, headers = SAME) => fetch(`${base}/api/rooms/${project}/message`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const twoInShop = (base, token) => ingest(base, token, [hookEvent("UserPromptSubmit", { prompt: "Fix the till" }), hookEvent("UserPromptSubmit", { session: "s-2", prompt: "Print receipts" }),
  hookEvent("UserPromptSubmit", { session: "s-3", cwd: "/p/docs", gitRoot: "/p/docs", prompt: "Write the docs" })]);
const queuedBy = async (base) => Object.fromEntries((await (await fetch(base + "/api/state")).json()).agents.map((a) => [a.session, a.queued]));

test("POST /api/rooms/:project/message queues it for each agent of the room; GET /api/rooms shows who got it", async () => {
  const { app, base, token } = await boot();
  try {
    await twoInShop(base, token);
    const r = await roomMsg(base, "shop", { text: "  Commit first.  " });
    assert.equal(r.status, 200);
    const { ok, message } = await r.json();
    assert.deepEqual([ok, message.project, message.text, message.to.map((x) => x.session).sort(), message.skipped], [true, "shop", "Commit first.", ["s-1", "s-2"], []]);
    assert.deepEqual(await queuedBy(base), { "s-1": 1, "s-2": 1, "s-3": 0 }, "only the room's agents");
    // One agent's Stop hook gets it; the other still waits for its own stop.
    assert.deepEqual(await ingest(base, token, hookEvent("Stop", { inbox: true })), { accepted: 1, messages: ["Commit first."] });
    const rooms = await (await fetch(base + "/api/rooms")).json();
    assert.deepEqual(Object.keys(rooms), ["t", "date", "plans", "files", "messages"]);
    assert.deepEqual(rooms.messages.map((m) => [m.id, m.project, m.to.map((x) => `${x.session} ${x.status}`).sort()]), [[message.id, "shop", ["s-1 delivered", "s-2 queued"]]]);
    // sessions: only these agents of the room.
    const only = await (await roomMsg(base, "shop", { text: "Just you.", sessions: ["s-2", "s-3"] })).json();
    assert.deepEqual(only.message.to.map((x) => x.session), ["s-2"]);
    // A room's name is a folder name: spaces and other letters arrive encoded.
    await ingest(base, token, hookEvent("UserPromptSubmit", { session: "s-4", cwd: "/p/Café shop", gitRoot: "/p/Café shop", prompt: "Brew" }));
    assert.equal((await roomMsg(base, encodeURIComponent("Café shop"), { text: "hi" })).status, 200);
    assert.equal((await queuedBy(base))["s-4"], 1);
  } finally { await app.close(); }
});

test("POST /api/rooms/:project/message: same-origin header and a local host name, input checked and bounded; hooks and the spool can't forge one", async () => {
  const { app, base, token, dir } = await boot();
  let closed = false;
  try {
    await twoInShop(base, token);
    const port = app.server.address().port;
    assert.equal((await roomMsg(base, "shop", { text: "hi" }, JSON_H)).status, 403, "no same-origin header");
    assert.equal(await rawPost(base, "/api/rooms/shop/message", { ...SAME, Host: `evil.example:${port}` }, JSON.stringify({ text: "hi" })), 403, "a rebound host name");
    for (const [project, body, code] of [["shop", { text: "" }, 400], ["shop", { text: "x".repeat(1001) }, 400], ["shop", "{oops", 400], ["shop", "null", 400],
      ["shop", { text: "hi", sessions: "s-1" }, 400], ["shop", { text: "hi", sessions: Array(51).fill("s-1") }, 400], ["shop", { text: "hi", sessions: ["s-3"] }, 404],
      ["nowhere", { text: "hi" }, 404], ["a%2Fb", { text: "hi" }, 400], ["%E0%A4%A", { text: "hi" }, 400], ["a%00b", { text: "hi" }, 400]]) {
      assert.equal((await roomMsg(base, project, body)).status, code, `${project} ${String(JSON.stringify(body)).slice(0, 40)}`);
    }
    assert.deepEqual(await queuedBy(base), { "s-1": 0, "s-2": 0, "s-3": 0 }, "nothing queued by a refused message");
    // A token holder can't queue a room message, or claim one, through the hook endpoint.
    const forged = await ingest(base, token, [{ type: "message", t: new Date().toISOString(), session: "s-1", text: "rm -rf /", room: "abcdefghijkl", skipped: [{ session: "s-2", why: "offline" }] }]);
    assert.deepEqual(forged, { accepted: 0 });
    assert.deepEqual((await (await fetch(base + "/api/rooms")).json()).messages, []);
    // Nor through the spool.
    closed = true;
    await app.close();
    fs.writeFileSync(path.join(dir, "spool", "pending.jsonl"), JSON.stringify({ type: "message", t: new Date().toISOString(), session: "s-1", text: "rm -rf /", room: "abcdefghijkl" }) + "\n");
    const again = createServer({ dir, log: quiet });
    try { assert.deepEqual([again.store.agents().find((a) => a.session === "s-1").queued, again.store.rooms().messages], [0, []]); } finally { await again.close(); }
  } finally { if (!closed) await app.close(); }
});

test("team mode: messaging a room and reading the rooms need sign-in", async () => {
  const { app, base, token } = await boot({ HOST: "0.0.0.0" });
  try {
    await twoInShop(base, token);
    assert.equal((await roomMsg(base, "shop", { text: "hi" })).status, 401);
    assert.equal((await fetch(base + "/api/rooms")).status, 401);
    const c = (await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ token }) })).headers.get("set-cookie").split(";")[0];
    assert.equal((await roomMsg(base, "shop", { text: "hi" }, { ...SAME, cookie: c })).status, 200, "any host name in team mode, once signed in");
    assert.equal((await fetch(base + "/api/rooms", { headers: { cookie: c } })).status, 200);
  } finally { await app.close(); }
});
