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
