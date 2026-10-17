"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createServer } = require("../src/server");

const quiet = { log() {}, warn() {}, error() {} };
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
    r = await fetch(base + "/api/settings", { method: "PUT", headers: h, body: JSON.stringify({ webhookUrl: "http://insecure" }) });
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
    assert.notEqual((await fetch(base + "/%2e%2e/package.json")).status, 200);
    assert.notEqual((await fetch(base + "/..%2fsrc%2fconfig.js")).status, 200);
  } finally { await app.close(); }
});

test("team mode asks for sign in", async () => {
  const { app, base, token } = await boot({ HOST: "0.0.0.0" });
  try {
    let r = await fetch(base + "/api/state"); assert.equal(r.status, 401);
    r = await fetch(base + "/", { redirect: "manual" }); assert.equal(r.status, 302);
    r = await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ token: "wrong" }) }); assert.equal(r.status, 401);
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
    assert.equal(s.settings.dailyBudgetUsd, 25); assert.equal(s.agents.length, 8);
    const r = await fetch(base + "/api/settings", { method: "PUT", headers: { "X-Requested-With": "agent-office" }, body: JSON.stringify({ offlineAfterMin: 45 }) });
    assert.equal((await r.json()).dailyBudgetUsd, 25);
    assert.equal(fs.readFileSync(path.join(dir, "config.json"), "utf8"), before, "config file untouched");
    assert.equal(JSON.parse(before).dailyBudgetUsd, 0);
    const d = await (await fetch(base + "/api/agents/demo-basket")).json();
    assert.equal(d.subagents.length, 2);
  } finally { await app.close(); }
});
