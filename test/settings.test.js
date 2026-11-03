"use strict";
// Settings (M11): budgets, quiet hours, project names and colours and token rotation in the config; the hook's report on
// its sends (failed sends in the last hour from an append-only log, parallel hooks included; spool backlog), its sealed
// spool and the flush that sends it on reconnect; machines and projects in the store and the server, and what rotating
// the token cuts off; quiet hours in the alerts engine (held, then one digest); the model and markup (colour and text
// rules, every panel state, escaping); and the screen in the shell on a fake DOM. Every clock that matters is pinned.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), net = require("net");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const config = require("../src/config");
const hook = require("../hooks/hook");
const { Store } = require("../src/store");
const { Alerts, digestText } = require("../src/alerts");
const { createServer } = require("../src/server");
const { loadScenario, demoWebhook, DEMO_CHANNELS } = require("../src/demo");
const { withDom } = require("./helpers/dom");

const pub = (f) => import(pathToFileURL(path.join(__dirname, "..", "public", f)).href);
const M = 60000, DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const json = (x) => JSON.parse(JSON.stringify(x));
const quiet = { log() {}, warn() {}, error() {} };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const HOOK = path.join(__dirname, "..", "hooks", "hook.js");
for (const k of ["AGENT_OFFICE_URL", "AGENT_OFFICE_TOKEN", "AGENT_OFFICE_HOLD"]) delete process.env[k];

// ---------- config ----------
test("config: quiet hours default off 22:00–08:00, span midnight, and are checked; monthly budget like the daily one", () => {
  assert.deepEqual(config.DEFAULTS.quietHours, { on: false, from: "22:00", to: "08:00" });
  assert.deepEqual(config.quietOf({ on: true, from: "25:00", to: "7:00" }), { on: true, from: "22:00", to: "08:00" }, "bad times fall back");
  const q = { on: true, from: "22:00", to: "08:00" }, at = (h, m = 0) => new Date(2026, 9, 24, h, m).getTime();
  assert.deepEqual([at(21, 59), at(22), at(3), at(7, 59), at(8), at(12)].map((t) => config.isQuiet(q, t)), [false, true, true, true, false, false]);
  assert.deepEqual([at(12, 59), at(13), at(13, 30), at(14)].map((t) => config.isQuiet({ on: true, from: "13:00", to: "14:00" }, t)), [false, true, true, false], "a daytime span too");
  assert.equal(config.isQuiet({ ...q, on: false }, at(23)), false);
  const set = (body) => config.applySettings(config.DEFAULTS, body);
  assert.deepEqual(set({ quietHours: { on: true } }).cfg.quietHours, q, "a part at a time");
  assert.deepEqual(set({ quietHours: { from: "23:30", to: "06:15" } }).cfg.quietHours, { on: false, from: "23:30", to: "06:15" });
  assert.equal(set({ quietHours: { from: "8:00" } }).error, "Quiet hours need times like 22:00.");
  assert.equal(set({ quietHours: { from: "08:00" } }).error, "Quiet hours need different start and end times.");
  assert.equal(set({ quietHours: "on" }).error, "quietHours must be an object.");
  assert.equal(set({ monthlyBudgetUsd: "750.555" }).cfg.monthlyBudgetUsd, 750.56);
  assert.equal(set({ monthlyBudgetUsd: -1 }).error, "Monthly budget must be $0 to $1,000,000 (0 = none).");
  assert.equal(set({ dailyBudgetUsd: "" }).error, "Daily budget must be $0 to $1,000,000 (0 = none).", "empty isn't 0: the form sends 0 itself");
  assert.equal(set({ offlineAfterMin: "" }).error, "Offline timeout must be 1 to 1440 minutes.");
});

test("config: a project's name and colour; names can't be another project's; bad keys and colours refused; saved and loaded", () => {
  const set = (cfg, project, known = ["shop", "api"]) => config.applySettings(cfg, { project }, { known });
  let r = set(config.DEFAULTS, { key: "shop", name: "  Shop front ", color: 3 });
  assert.deepEqual(r.cfg.projects, { shop: { name: "Shop front", color: 3 } });
  assert.deepEqual(set(r.cfg, { key: "shop", color: null }).cfg.projects, { shop: { name: "Shop front" } }, "null: back to the automatic colour");
  assert.deepEqual(set(r.cfg, { key: "shop", name: "" }).cfg.projects, { shop: { color: 3 } }, "empty: back to the folder's name");
  assert.deepEqual(set(r.cfg, { key: "shop", name: "shop", color: null }).cfg.projects, {}, "its own folder name is no name; nothing left, no entry");
  assert.equal(set(r.cfg, { key: "api", name: "SHOP FRONT" }).error, "Another project is already called SHOP FRONT.");
  assert.equal(set(r.cfg, { key: "api", name: "Shop" }).error, "Another project is already called Shop.", "nor another project's folder");
  assert.equal(set(r.cfg, { key: "shop", color: 6 }).error, "Pick one of the 6 room colours.");
  assert.equal(set(r.cfg, { key: "shop", color: "2" }).error, "Pick one of the 6 room colours.");
  assert.equal(set(r.cfg, { key: "shop", name: "x".repeat(41) }).error, "Keep the name under 40 characters, on one line.");
  assert.equal(set(r.cfg, { key: "shop", name: "a\nb" }).error, "Keep the name under 40 characters, on one line.");
  for (const key of ["", "__proto__", "a\u0000", "k".repeat(201), 5]) assert.equal(set(r.cfg, { key, color: 1 }).error, "That project isn't valid.", String(key));
  assert.equal(config.applySettings(config.DEFAULTS, { project: null }).error, "project must be an object.");
  assert.deepEqual(config.projectsOf({ ok: { name: "Fine", color: 1 }, bad: { color: 9, name: "\u0007" }, __proto__: { color: 1 }, n: "x" }), { ok: { name: "Fine", color: 1 } });
  const dir = tmp("ao-set-cfg-");
  try {
    const cfg = config.load(dir);
    assert.match(cfg.tokenCreatedAt, /^\d{4}-\d\d-\d\dT/, "a new token says when it was made");
    config.save({ ...r.cfg, token: cfg.token, tokenCreatedAt: cfg.tokenCreatedAt, quietHours: { on: true, from: "21:00", to: "07:00" }, monthlyBudgetUsd: 500 }, dir);
    const back = config.load(dir);
    assert.deepEqual([back.projects, back.quietHours, back.monthlyBudgetUsd, back.tokenCreatedAt], [{ shop: { name: "Shop front", color: 3 } }, { on: true, from: "21:00", to: "07:00" }, 500, cfg.tokenCreatedAt]);
    const rotated = config.rotateToken(back, Date.UTC(2026, 9, 24));
    assert.ok(rotated.token !== back.token && /^[0-9a-f]{48}$/.test(rotated.token));
    assert.equal(rotated.tokenCreatedAt, "2026-10-24T00:00:00.000Z");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ token: "old-token-from-before" }));
    assert.equal(config.load(dir).tokenCreatedAt, undefined, "an older token has no date: nothing is made up");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the hook: its report on its sends, and the spool ----------
const ev = (i, size = 0) => JSON.stringify({ type: "hook", t: iso(Date.UTC(2026, 9, 24) + i * 1000), session: "s", ev: "PreToolUse", cwd: "/p", n: i, pad: "x".repeat(size) });
const files = (dir) => fs.readdirSync(dir).sort();
const batchLines = (dir) => files(dir).filter((f) => f.startsWith("batch-")).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n"));

test("hook: build() carries the health report, and the OS on SessionStart only", () => {
  const base = { session_id: "s1", cwd: "/p" }, o = { now: new Date(0), host: "box", user: "me", name: null, platform: "darwin" };
  const health = { fails: ["2026-10-24T15:00:00.000Z"], backlog: 3 };
  assert.deepEqual(hook.build({ ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }, { ...o, health }).health, health);
  assert.equal(hook.build({ ...base, hook_event_name: "PreToolUse" }, o).health, undefined, "nothing to tell: no field");
  assert.equal(hook.build({ ...base, hook_event_name: "SessionStart" }, o).os, "darwin");
  assert.equal(hook.build({ ...base, hook_event_name: "Stop" }, o).os, undefined);
});

test("hook: failed sends of the last hour (at most 20), and the backlog counted from batch names and pending.jsonl", () => {
  const dir = tmp("ao-health-"), now = Date.UTC(2026, 9, 24, 15), log = path.join(dir, "fails.log");
  try {
    assert.equal(hook.healthOf(dir, now), null, "all well: nothing to report");
    for (let i = 0; i < 25; i++) hook.noteFail(dir, now - 50 * M + i * M);
    assert.equal(fs.readFileSync(log, "utf8"), Array.from({ length: 25 }, (_, i) => `${now - 50 * M + i * M}\n`).join(""), "a line per failed send");
    assert.deepEqual(hook.failsOf(dir, now), Array.from({ length: 20 }, (_, i) => now - 45 * M + i * M), "the newest 20 (14:15–14:34)");
    assert.equal(hook.failsOf(dir, now + 20 * M).length, 14, "older than an hour drop out: at 15:20 only those after 14:20");
    fs.appendFileSync(log, String(now).slice(0, 7));
    assert.equal(hook.failsOf(dir, now).length, 20, "a line cut off by a crash is ignored, the rest still count");
    hook.noteFail(dir, now - M);
    assert.ok(!hook.failsOf(dir, now).includes(now - M), "the next one lands on the cut-off line: that line is ignored too");
    hook.noteFail(dir, now - M);
    assert.equal(hook.failsOf(dir, now).at(-1), now - M);
    fs.writeFileSync(log, `${now - 5 * M}\n`);
    fs.writeFileSync(path.join(dir, "pending.jsonl"), [ev(1), ev(2)].join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "batch-0000000000001-0000abcd-0000-140.jsonl"), "");
    fs.writeFileSync(path.join(dir, `sending-${now}-0000000000002-0000abcd-0000-3.jsonl`), "");
    assert.deepEqual(hook.healthOf(dir, now), { fails: [iso(now - 5 * M)], backlog: 145 });
    fs.writeFileSync(path.join(dir, "sealing-0000000000000-0000abcd-0.jsonl"), "");
    assert.deepEqual(hook.backlogOf(dir), { n: 145, more: true }, "a seal under way: some not counted yet");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hook: past 4 KB fails.log is trimmed to the newest 20 through a temp file; a rename that fails leaves no temp file and throws nothing", () => {
  const dir = tmp("ao-trim-"), now = Date.UTC(2026, 9, 24, 15), log = path.join(dir, "fails.log"), { FAILS_LOG } = hook.SPOOL_LIMITS;
  const rename = fs.renameSync;
  try {
    for (let i = 0; i < 400; i++) {
      hook.noteFail(dir, now - 400 * 1000 + i * 1000);
      assert.ok(fs.statSync(log).size <= FAILS_LOG, `${fs.statSync(log).size} bytes after ${i + 1}`);
    }
    assert.deepEqual(files(dir), ["fails.log"]);
    assert.deepEqual(hook.failsOf(dir, now), Array.from({ length: 20 }, (_, i) => now - 20 * 1000 + i * 1000));
    // Windows can refuse to replace a file another process has open.
    fs.renameSync = () => { throw Object.assign(new Error("busy"), { code: "EPERM" }); };
    for (let i = 0; i < 300; i++) hook.noteFail(dir, now + i);
    fs.renameSync = rename;
    assert.deepEqual(files(dir), ["fails.log"], "every temp file went");
    assert.ok(fs.statSync(log).size > FAILS_LOG, "the log just stays long until a rename works");
    assert.deepEqual(hook.failsOf(dir, now + 1000), Array.from({ length: 20 }, (_, i) => now + 280 + i), "still read from its end");
    hook.noteFail(dir, now + 300);
    assert.equal(fs.statSync(log).size, 20 * 14);
  } finally { fs.renameSync = rename; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hook: parallel hooks noting failed sends lose none, and trimming among them leaves no temp file", async () => {
  const dir = tmp("ao-fails-par-"), log = path.join(dir, "fails.log");
  /** n processes, each noting `each` failed sends, all starting at the same moment. */
  const race = (n, each) => {
    const start = Date.now() + 700, code = `const h = require(${JSON.stringify(HOOK)}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ${start} - Date.now())); for (let i = 0; i < ${each}; i++) h.noteFail(${JSON.stringify(dir)});`;
    return Promise.all(Array.from({ length: n }, () => new Promise((resolve) => spawn(process.execPath, ["-e", code], { stdio: "ignore" }).on("close", resolve))));
  };
  try {
    // 8 × 30 = 240 lines, under 4 KB: nothing is trimmed, so every one must be there.
    assert.deepEqual(await race(8, 30), Array(8).fill(0));
    const lines = fs.readFileSync(log, "utf8").split("\n");
    assert.equal(lines.pop(), "");
    assert.equal(lines.length, 240, "none lost");
    assert.ok(lines.every((l) => /^\d{13}$/.test(l)), "none torn or run together");
    assert.equal(hook.failsOf(dir).length, 20);
    // 8 × 200: trimmed again and again while the others append.
    assert.deepEqual(await race(8, 200), Array(8).fill(0));
    assert.deepEqual(files(dir), ["fails.log"], "no temp file left");
    assert.ok(fs.statSync(log).size <= 2 * hook.SPOOL_LIMITS.FAILS_LOG, `${fs.statSync(log).size} bytes`);
    assert.equal(hook.failsOf(dir).length, 20);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hook: an event a parallel hook appends to pending.jsonl while it's being sealed waits for the next seal", () => {
  const dir = tmp("ao-seal-race-"), now = Date.UTC(2026, 9, 24, 15), write = fs.writeFileSync;
  try {
    write(path.join(dir, "pending.jsonl"), [ev(1), ev(2)].join("\n") + "\n");
    // That hook opened pending.jsonl just before the rename, so its line lands in the file being sealed, after the read.
    let late = false;
    fs.writeFileSync = (...a) => {
      if (!late) { late = true; fs.appendFileSync(path.join(dir, files(dir).find((f) => f.startsWith("sealing-"))), ev(3) + "\n"); }
      return write(...a);
    };
    hook.seal(dir, now);
    fs.writeFileSync = write;
    assert.deepEqual(batchLines(dir).map((l) => JSON.parse(l).n), [1, 2]);
    assert.match(files(dir).find((f) => f.startsWith("sealing-")), /^sealing-0000000000000-[0-9a-f]{8}-\d+\.jsonl$/, "the rest waits, claimed by nobody");
    assert.deepEqual(hook.backlogOf(dir), { n: 2, more: true });
    hook.seal(dir, now + 1000);
    assert.deepEqual([files(dir).filter((f) => !f.startsWith("batch-")), batchLines(dir).map((l) => JSON.parse(l).n)], [[], [1, 2, 3]]);
  } finally { fs.writeFileSync = write; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hook: a line a parallel hook is still appending when the seal reads it isn't split: it waits, whole, for the next seal", () => {
  const dir = tmp("ao-seal-half-"), now = Date.UTC(2026, 9, 24, 15), read = fs.readSync, line = ev(3);
  try {
    fs.writeFileSync(path.join(dir, "pending.jsonl"), [ev(1), ev(2)].join("\n") + "\n" + line.slice(0, 40));
    // The seal reads the first half of that hook's line; the rest lands just after.
    fs.readSync = (...a) => {
      const n = read(...a);
      fs.readSync = read;
      fs.appendFileSync(path.join(dir, files(dir).find((f) => f.startsWith("sealing-"))), line.slice(40) + "\n");
      return n;
    };
    hook.seal(dir, now);
    fs.readSync = read;
    assert.deepEqual(batchLines(dir).map((l) => JSON.parse(l).n), [1, 2]);
    assert.deepEqual(hook.backlogOf(dir), { n: 2, more: true }, "the rest waits");
    hook.seal(dir, now + 1000);
    assert.deepEqual([files(dir).filter((f) => !f.startsWith("batch-")), batchLines(dir).map((l) => JSON.parse(l).n)], [[], [1, 2, 3]], "whole: none lost");
  } finally { fs.readSync = read; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hook: past 256 KB pending.jsonl is sealed into batch files of at most 500 events, named with their count; a cut-off line is dropped", () => {
  const dir = tmp("ao-seal-"), { SEAL, BATCH } = hook.SPOOL_LIMITS;
  try {
    // ~400-byte lines: the seal at 256 KB holds over 500 events, so it splits into a full batch and the rest.
    for (let i = 0; i < 700; i++) hook.spool(JSON.parse(ev(i, 300)), dir);
    const batches = files(dir).filter((f) => f.startsWith("batch-"));
    assert.ok(batches.length >= 2 && batches.every((f) => /^batch-\d{13}-[0-9a-f]{8}-\d{4}-\d+\.jsonl$/.test(f)), batches.join());
    const sizes = batches.map((f) => {
      const lines = fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n");
      assert.equal(Number(f.match(/-(\d+)\.jsonl$/)[1]), lines.length, "the name says how many");
      return lines.length;
    });
    assert.equal(Math.max(...sizes), BATCH, "never more than 500 in one");
    assert.ok(fs.statSync(path.join(dir, "pending.jsonl")).size <= SEAL + 600);
    assert.deepEqual(hook.backlogOf(dir), { n: 700, more: false });
    const all = [...batchLines(dir), ...fs.readFileSync(path.join(dir, "pending.jsonl"), "utf8").trim().split("\n")].map((l) => JSON.parse(l).n);
    assert.deepEqual(all, Array.from({ length: 700 }, (_, i) => i), "every event once, oldest first");
    // A crash mid-write leaves half a line: sealing drops it.
    fs.appendFileSync(path.join(dir, "pending.jsonl"), '{"type":"hook","t":"20');
    hook.seal(dir);
    assert.equal(fs.existsSync(path.join(dir, "pending.jsonl")), false);
    assert.equal(batchLines(dir).length, 700);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hook: a spool over 2 MB is sealed 2 MB a run, the claim saying how far it got, and picked up again", () => {
  const dir = tmp("ao-seal-big-"), now = Date.UTC(2026, 9, 24, 15);
  try {
    fs.writeFileSync(path.join(dir, "pending.jsonl"), Array.from({ length: 2600 }, (_, i) => ev(i, 900)).join("\n") + "\n");
    hook.seal(dir, now);
    const left = files(dir).find((f) => f.startsWith("sealing-"));
    assert.match(left, /^sealing-0000000000000-[0-9a-f]{8}-\d+\.jsonl$/, "the rest waits, claimed by nobody");
    assert.ok(batchLines(dir).length > 1500 && batchLines(dir).length < 2600);
    assert.equal(hook.backlogOf(dir).more, true);
    hook.seal(dir, now + 1000);
    assert.deepEqual([files(dir).filter((f) => !f.startsWith("batch-")), batchLines(dir).map((l) => JSON.parse(l).n).join()], [[], Array.from({ length: 2600 }, (_, i) => i).join()]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A stand-in server: records each POST body; status() decides the answer. */
async function stub(status = () => 200) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "null") }); const s = status(got.length); res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(s < 300 ? { accepted: 1 } : { error: "no" })); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${srv.address().port}`, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}
const flush = (cfg, dir, now) => new Promise((r) => hook.flush(cfg, r, dir, now));

test("hook: a flush sends the oldest batch in one call; refused, it goes back (and counts as a failed send); a bad request is dropped; a dead hook's claim comes back", async () => {
  const dir = tmp("ao-flush-"), now = Date.now();
  let answer = 200;
  const s = await stub(() => answer), cfg = { serverUrl: s.url, token: "tok" };
  try {
    fs.writeFileSync(path.join(dir, "batch-0000000000002-0000beef-0000-2.jsonl"), [ev(3), ev(4)].join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "batch-0000000000001-0000beef-0000-2.jsonl"), [ev(1), "{torn", ev(2)].join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "pending.jsonl"), ev(5) + "\n");
    await flush(cfg, dir, now);
    assert.deepEqual(s.got.map((g) => [g.url, g.auth, g.body.map((e) => e.n)]), [["/api/events", "Bearer tok", [1, 2]]], "oldest first, torn lines left out, as one array");
    assert.equal(files(dir).filter((f) => f.startsWith("batch-0000000000001")).length, 0, "through: gone");
    assert.equal(hook.backlogOf(dir).n, 3, "pending.jsonl was sealed on the way");
    answer = 503;
    await flush(cfg, dir, now);
    assert.equal(hook.backlogOf(dir).n, 3, "refused: it went back");
    assert.equal(hook.failsOf(dir, now).length, 1);
    answer = 400;
    await flush(cfg, dir, now);
    assert.equal(hook.backlogOf(dir).n, 1, "a bad request is never taken: dropped so it can't block the rest");
    // A hook that died mid-flush: its claim is a minute old, so it goes back to being a batch and is sent.
    const [last] = files(dir).filter((f) => f.startsWith("batch-"));
    fs.renameSync(path.join(dir, last), path.join(dir, `sending-${String(now - 2 * M).padStart(13, "0")}-${last.slice(6)}`));
    answer = 200;
    await flush(cfg, dir, now + 1000);
    assert.deepEqual([s.got.at(-1).body.map((e) => e.n), hook.backlogOf(dir).n], [[5], 0]);
    await flush(cfg, dir, now + 2000);
    assert.equal(s.got.length, 4, "nothing left: no call");
    // Nobody home: done() still comes, and nothing is lost.
    fs.writeFileSync(path.join(dir, "pending.jsonl"), ev(9) + "\n");
    await flush({ serverUrl: "http://127.0.0.1:9", token: "x" }, dir, now + 3000);
    assert.equal(hook.backlogOf(dir).n, 1);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hook: claimSpool hands the server on this machine every batch, pending.jsonl and what a dead hook left, never a live claim", () => {
  const dir = tmp("ao-claim-"), now = Date.UTC(2026, 9, 24, 15), old = String(now - 2 * M).padStart(13, "0"), fresh = String(now - 1000).padStart(13, "0");
  try {
    fs.writeFileSync(path.join(dir, "batch-0000000000001-0000beef-0000-1.jsonl"), ev(1) + "\n");
    fs.writeFileSync(path.join(dir, "pending.jsonl"), ev(2) + "\n");
    fs.writeFileSync(path.join(dir, `sending-${old}-0000000000003-0000beef-0000-1.jsonl`), ev(3) + "\n");
    fs.writeFileSync(path.join(dir, `sending-${fresh}-0000000000004-0000beef-0000-1.jsonl`), ev(4) + "\n");
    const half = ev(5) + "\n";
    fs.writeFileSync(path.join(dir, `sealing-${old}-0000beef-${Buffer.byteLength(half)}.jsonl`), half + ev(6) + "\n");
    const got = hook.claimSpool(dir, now);
    const read = got.flatMap(({ file, offset }) => fs.readFileSync(file).subarray(offset).toString("utf8").trim().split("\n").map((l) => JSON.parse(l).n));
    assert.deepEqual(read.sort(), [1, 2, 3, 6], "a seal's events already in batches aren't read twice; a claim of a hook still sending stays");
    assert.ok(got.every((g) => /ingest-\d{13}-[0-9a-f]{8}\.jsonl$/.test(g.file)));
    assert.deepEqual(files(dir).filter((f) => !f.startsWith("ingest-")), [`sending-${fresh}-0000000000004-0000beef-0000-1.jsonl`]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const MB = 1024 * 1024;
/** A batch file of `bytes` on disk named for `count` events: one real event (n = t), then zeros that no read takes. */
function bigBatch(dir, t, count, bytes) {
  const name = `batch-${String(t).padStart(13, "0")}-0000beef-0000-${count}.jsonl`;
  fs.writeFileSync(path.join(dir, name), ev(t) + "\n");
  fs.truncateSync(path.join(dir, name), bytes);
  return name;
}
const sizeOf = (dir) => files(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);

test("hook: past 50 MB in all, the oldest batches go until it's under 45 MB; drops.log says how many events; the health report carries them for a day", () => {
  const dir = tmp("ao-cap-"), now = Date.UTC(2026, 9, 24, 15), { SPOOL_MAX, SPOOL_KEEP } = hook.SPOOL_LIMITS;
  try {
    assert.deepEqual([SPOOL_MAX, SPOOL_KEEP], [50 * MB, 45 * MB]);
    // 48 batches of 1 MB, one on its way (another hook sends it) and pending.jsonl: under the cap, nothing goes.
    const names = Array.from({ length: 48 }, (_, i) => bigBatch(dir, i + 1, 500, MB)), sending = `sending-${now}-0000000000099-0000beef-0000-7.jsonl`;
    fs.writeFileSync(path.join(dir, sending), "");
    fs.truncateSync(path.join(dir, sending), MB);
    fs.writeFileSync(path.join(dir, "pending.jsonl"), ev(1) + "\n");
    assert.equal(hook.capSpool(dir, now), 0);
    assert.equal(fs.existsSync(path.join(dir, "drops.log")), false);
    // 52 MB: the 8 oldest batches go (4,000 events), never what's on its way or still to be sealed.
    for (let i = 49; i <= 51; i++) names.push(bigBatch(dir, i, 500, MB));
    assert.equal(hook.capSpool(dir, now), 4000);
    assert.deepEqual(files(dir).filter((f) => f.startsWith("batch-")), names.slice(8), "oldest first");
    assert.ok(files(dir).includes(sending) && files(dir).includes("pending.jsonl"));
    assert.ok(sizeOf(dir) <= SPOOL_KEEP, `${sizeOf(dir)} bytes`);
    assert.equal(fs.readFileSync(path.join(dir, "drops.log"), "utf8"), `${now} 4000\n`);
    assert.deepEqual(hook.healthOf(dir, now + M), { backlog: 43 * 500 + 7 + 1, dropped: 4000, droppedAt: iso(now) });
    // A seal that takes it past 50 MB again drops again: spool() checks after each seal.
    for (let i = 52; i <= 57; i++) bigBatch(dir, i, 500, MB);
    fs.writeFileSync(path.join(dir, "pending.jsonl"), Array.from({ length: 300 }, (_, i) => ev(i, 900)).join("\n") + "\n");
    hook.spool(JSON.parse(ev(999)), dir, now + 2 * M);
    assert.equal(fs.existsSync(path.join(dir, "pending.jsonl")), false, "sealed");
    assert.ok(sizeOf(dir) <= SPOOL_KEEP, `${sizeOf(dir)} bytes`);
    assert.deepEqual(hook.dropsOf(dir, now + 3 * M), { n: 7000, at: now + 2 * M }, "6 more batches");
    const newest = files(dir).filter((f) => f.startsWith("batch-")).at(-1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, newest), "utf8").trim().split("\n").at(-1)).n, 999, "the newest events stay");
    // A day after the newest drop, nothing more to report.
    assert.deepEqual(hook.dropsOf(dir, now + 2 * M + DAY), { n: 0, at: null });
    assert.equal(hook.healthOf(dir, now + 2 * M + DAY).dropped, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hook: drops.log counts the last day's drops, ignores a torn line, and past 1 KB is added up in one line", () => {
  const dir = tmp("ao-drops-"), now = Date.UTC(2026, 9, 24, 15), log = path.join(dir, "drops.log"), { DROPS_LOG } = hook.SPOOL_LIMITS;
  try {
    assert.deepEqual(hook.dropsOf(dir, now), { n: 0, at: null }, "no log: none");
    hook.noteDrop(dir, 999, now - 2 * DAY);
    hook.noteDrop(dir, 500, now - 3 * M);
    fs.appendFileSync(log, String(now).slice(0, 6));
    assert.deepEqual(hook.dropsOf(dir, now), { n: 500, at: now - 3 * M }, "the last day's; a line cut off by a crash is ignored");
    fs.writeFileSync(log, `${now - 2 * DAY} 999\n`);
    for (let i = 0; i < 100; i++) {
      hook.noteDrop(dir, 10, now - 100 * M + i * M);
      assert.ok(fs.statSync(log).size <= DROPS_LOG, `${fs.statSync(log).size} bytes after ${i + 1}`);
    }
    assert.deepEqual(hook.dropsOf(dir, now), { n: 1000, at: now - M }, "every drop of the last day still counted; the old one gone");
    assert.ok(fs.readFileSync(log, "utf8").split("\n").length < 100, "added up");
    assert.deepEqual(files(dir), ["drops.log"], "no temp file left");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function freePort() {
  return new Promise((resolve) => { const srv = net.createServer().listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });
}
function runHook(stdin, env) {
  return new Promise((resolve) => {
    const started = Date.now(), child = spawn(process.execPath, [HOOK, "--agent-office"], { env: { ...process.env, AGENT_NAME: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

test("hook process: down, it spools and notes the failed send; back up, its next event reports both and the spool flushes, still exit 0 fast", async () => {
  const dir = tmp("ao-hookflush-"), port = await freePort(), env = { AGENT_OFFICE_DIR: dir, AGENT_OFFICE_URL: `http://127.0.0.1:${port}`, AGENT_OFFICE_TOKEN: "t" };
  const payload = (id) => JSON.stringify({ session_id: "s1", cwd: dir, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_use_id: id });
  let s = null;
  try {
    const down = await runHook(payload("t1"), env);
    assert.deepEqual([down.code, down.out], [0, ""]);
    assert.equal(hook.backlogOf(path.join(dir, "spool")).n, 1);
    assert.equal(hook.failsOf(path.join(dir, "spool")).length, 1);
    s = await new Promise((resolve) => {
      const got = [], srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push(JSON.parse(b)); res.writeHead(200); res.end("{}"); }); });
      srv.listen(port, "127.0.0.1", () => resolve({ got, close: () => new Promise((r) => srv.close(r)) }));
    });
    const up = await runHook(payload("t2"), env);
    assert.deepEqual([up.code, up.out], [0, ""]);
    assert.ok(up.ms < 3000, `took ${up.ms}ms`);
    const [live, batch] = s.got;
    assert.equal(live.toolUseId, "t2");
    assert.deepEqual([live.health.fails.length, live.health.backlog], [1, 1], "it says what happened while the server was away");
    assert.deepEqual(batch.map((e) => e.toolUseId), ["t1"], "then the queued event goes, as a batch");
    assert.equal(hook.backlogOf(path.join(dir, "spool")).n, 0);
  } finally { await s?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hook process: after the token was rotated the server refuses every send; the spool stays under 50 MB, dropping its oldest, and once the token is fixed the next event says how many went", async () => {
  const dir = tmp("ao-rotated-"), spoolDir = path.join(dir, "spool");
  let status = 401;
  const s = await stub(() => status), env = { AGENT_OFFICE_DIR: dir, AGENT_OFFICE_URL: s.url, AGENT_OFFICE_TOKEN: "old" };
  const payload = (id) => JSON.stringify({ session_id: "s1", cwd: dir, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_use_id: id });
  try {
    // A machine that kept the old token a while: 50 MB of batches wait, and pending.jsonl is about to be sealed.
    fs.mkdirSync(spoolDir, { recursive: true });
    const names = Array.from({ length: 50 }, (_, i) => bigBatch(spoolDir, i + 1, 500, MB));
    fs.writeFileSync(path.join(spoolDir, "pending.jsonl"), Array.from({ length: 300 }, (_, i) => ev(i, 900)).join("\n") + "\n");
    const refused = await runHook(payload("t1"), env);
    assert.deepEqual([refused.code, refused.out], [0, ""], "still exit 0, nothing printed");
    assert.ok(refused.ms < 3000, `took ${refused.ms}ms`);
    assert.deepEqual(s.got.map((g) => [g.auth, g.body.toolUseId]), [["Bearer old", "t1"]]);
    const left = files(spoolDir).filter((f) => f.startsWith("batch-"));
    assert.deepEqual(left.slice(0, -1), names.slice(6), "the 6 oldest batches went");
    assert.ok(sizeOf(spoolDir) <= hook.SPOOL_LIMITS.SPOOL_KEEP, `${sizeOf(spoolDir)} bytes`);
    // The new token is in: the next event goes through and tells the server what happened; a batch follows.
    status = 200;
    const up = await runHook(payload("t2"), { ...env, AGENT_OFFICE_TOKEN: "new" });
    assert.deepEqual([up.code, up.out], [0, ""]);
    const { health } = s.got[1].body;
    assert.deepEqual([s.got[1].auth, s.got[1].body.toolUseId, health.fails.length, health.backlog, health.dropped], ["Bearer new", "t2", 1, 44 * 500 + 301, 3000]);
    assert.ok(Math.abs(Date.parse(health.droppedAt) - Date.now()) < 60000);
    assert.deepEqual(s.got[2].body.map((e) => e.n), [7], "the oldest batch left goes next");
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the store: machines and projects ----------
const T = new Date(2026, 9, 24, 15, 42).getTime();
const cfg0 = { offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 25 };
const hookEv = (store, t, session, host, extra = {}) => store.apply({ type: "hook", t: iso(t), session, ev: "PreToolUse", tool: "Read", toolUseId: `${session}-${t}`, cwd: "/p/shop", gitRoot: "/p/shop", host, ...extra });

test("store: each machine's health is what its newest event reported; a late spooled event doesn't undo it; reports are checked and bounded", () => {
  const s = new Store({ getConfig: () => cfg0 });
  s.apply({ type: "hook", t: iso(T - 60 * M), session: "a1", ev: "SessionStart", cwd: "/p/shop", host: "mac", os: "darwin" });
  hookEv(s, T - 2 * M, "a1", "mac", { health: { fails: [iso(T - 70 * M), iso(T - 20 * M), iso(T - 5 * M)], backlog: 12 } });
  let [m] = s.machines(T);
  assert.deepEqual([m.host, m.os, m.status, m.failed, m.lastFail, m.backlog, m.live, m.today], ["mac", "darwin", "retrying", 2, iso(T - 5 * M), 12, 1, 1], "failed sends of the last hour only");
  hookEv(s, T - 10 * M, "a1", "mac", { health: { fails: [], backlog: 999 } });
  assert.equal(s.machines(T)[0].backlog, 12, "an older event, spooled and late, says nothing new");
  hookEv(s, T - M, "a1", "mac");
  [m] = s.machines(T);
  assert.deepEqual([m.status, m.failed, m.backlog], ["healthy", 0, 0], "a newer event without a report: nothing failed, nothing waits");
  hookEv(s, T, "a1", "mac", { health: { fails: Array.from({ length: 30 }, (_, i) => iso(T - i * M)), backlog: -4, more: "yes" } });
  [m] = s.machines(T);
  assert.deepEqual([m.failed, m.capped, m.backlog, m.status], [20, true, 0, "retrying"]);
  hookEv(s, T, "a1", "mac", { health: { fails: ["nope", 5, null], backlog: 1.5 } });
  assert.equal(s.machines(T)[0].status, "healthy", "nothing usable in it: no report");
  assert.equal(s.machines(T)[0].reportedAt, iso(T));
  hookEv(s, T, "a1", "mac", { health: { backlog: 0, more: true } });
  assert.deepEqual([s.machines(T)[0].status, s.machines(T)[0].more], ["retrying", true], "some events not counted yet still wait");
});

test("store: events a machine's spool dropped show until a day after the newest drop, as its newest event said; checked and bounded", () => {
  const s = new Store({ getConfig: () => cfg0 });
  hookEv(s, T - 2 * M, "a1", "mac", { health: { dropped: 3000, droppedAt: iso(T - 3 * M) } });
  let [m] = s.machines(T);
  assert.deepEqual([m.status, m.dropped, m.droppedAt, m.backlog, m.failed], ["healthy", 3000, iso(T - 3 * M), 0, 0], "lost, not waiting: nothing to retry");
  assert.equal(s.machines(T + DAY - 4 * M)[0].dropped, 3000);
  [m] = s.machines(T + DAY - 3 * M);
  assert.deepEqual([m.dropped, m.droppedAt], [0, null], "a day after the newest drop");
  hookEv(s, T - M, "a1", "mac");
  assert.deepEqual([s.machines(T)[0].dropped, s.machines(T)[0].reportedAt], [0, iso(T - M)], "a newer event without a report: none dropped");
  const report = (t, health) => { hookEv(s, t, "a1", "mac", { health }); return s.machines(T)[0].dropped; };
  assert.deepEqual([report(T - 50 * 1000, { dropped: 50 }), report(T - 40 * 1000, { dropped: 2.5, droppedAt: iso(T) }), report(T - 30 * 1000, { dropped: 9, droppedAt: "nope" }),
    report(T - 20 * 1000, { dropped: -3, droppedAt: iso(T) }), report(T - 10 * 1000, { dropped: 1e12, droppedAt: iso(T - M) })], [0, 0, 0, 0, 1e9], "no time, not a whole number or not positive: none; at most a billion");
});

test("store: a machine is offline with no live session and no contact for the timeout; one waiting on you stays; listed for 7 days, offline last", () => {
  const s = new Store({ getConfig: () => cfg0 });
  hookEv(s, T - 2 * 60 * M, "b1", "build");
  hookEv(s, T - 60 * M, "w1", "waits", { tool: "Edit" });
  s.apply({ type: "hook", t: iso(T - 60 * M + 1000), session: "w1", ev: "PermissionRequest", tool: "Edit", cwd: "/p/shop", host: "waits" });
  hookEv(s, T - 2 * M, "e1", "ended");
  s.apply({ type: "hook", t: iso(T - M), session: "e1", ev: "SessionEnd", cwd: "/p/shop", host: "ended" });
  hookEv(s, T - 8 * DAY, "o1", "gone");
  const list = s.machines(T);
  assert.deepEqual(list.map((m) => [m.host, m.status, m.live]), [["ended", "healthy", 0], ["waits", "healthy", 1], ["build", "offline", 0]]);
  assert.equal(list[2].lastEvent, iso(T - 2 * 60 * M));
  assert.equal(list[0].os, null, "no SessionStart said: no OS, none made up");
});

test("store: a project's name and colour show everywhere: agents, names, rooms, spend, timeline, alerts; its key stays the folder", () => {
  let cfg = { ...cfg0, projects: { shop: { name: "Shop front", color: 3 } } };
  const s = new Store({ getConfig: () => cfg }), now = Date.now();
  s.apply({ type: "hook", t: iso(now - 5 * M), session: "a", ev: "UserPromptSubmit", cwd: "/p/shop", gitRoot: "/p/shop", host: "mac", prompt: "fix the basket totals" });
  s.apply({ type: "hook", t: iso(now - 4 * M), session: "b", ev: "UserPromptSubmit", cwd: "/q/api", gitRoot: "/q/api", host: "mac", prompt: "add rate limits" });
  s.apply({ type: "usage", t: iso(now - 3 * M), session: "a", cost: 2 });
  s.apply({ type: "usage", t: iso(now - 3 * M), session: "b", cost: 1 });
  const a = s.agents(now).find((x) => x.session === "a");
  assert.deepEqual([a.project, a.projectColor, a.name], ["Shop front", 3, "Shop front · basket totals"]);
  assert.equal(s.agents(now).find((x) => x.session === "b").projectColor, null);
  const snap = s.snapshot(now);
  assert.deepEqual(snap.totals.todayByProject, { "Shop front": 2, api: 1 });
  assert.deepEqual(s.cost(now).periods.today.projects.map((p) => p.project), ["Shop front", "api"]);
  assert.deepEqual(s.report(1, now)[0].byProject, { "Shop front": 2, api: 1 });
  assert.equal(s.timeline(new Date(now).toLocaleDateString("sv-SE"), now).sessions.find((r) => r.session === "a").project, "Shop front");
  assert.equal(s.watch(now).find((f) => f.session === "a").project, "Shop front");
  assert.equal(s.messageRoom("shop", "hi", {}, now).code, 404, "the room is the name every screen shows");
  assert.ok(s.messageRoom("Shop front", "hi", {}, now).message);
  assert.deepEqual(s.projectKeys().sort(), ["api", "shop"]);
  const p = s.projects(now);
  assert.deepEqual(p.map((x) => [x.key, x.name, x.named, x.color, x.roots, x.agentsToday]), [["api", "api", false, null, ["/q/api"], 1], ["shop", "Shop front", true, 3, ["/p/shop"], 1]]);
  cfg = { ...cfg0, projects: {} };
  assert.deepEqual(s.snapshot(now).totals.todayByProject, { shop: 2, api: 1 }, "renamed back: the day's spend follows, nothing split");
});

// ---------- the alerts engine: quiet hours ----------
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefgh1234", DISCORD = "https://discord.com/api/webhooks/42/zyxw9876";
// The night of Oct 14–15: no clock change in it anywhere common (Europe's clocks go back on Oct 25, 2026).
const night = (h, m = 0, d = 14) => new Date(2026, 9, d, h, m).getTime();
function quietRig(q = { on: true, from: "22:00", to: "08:00" }) {
  let c = { ...cfg0, dailyBudgetUsd: 0, slackWebhookUrl: SLACK, discordWebhookUrl: DISCORD, alertRules: config.rulesOf(), quietHours: q };
  const store = new Store({ getConfig: () => c }), sent = [], fail = {};
  const transport = async (x) => { sent.push(x); return fail[x.channel] ? { ok: false, code: fail[x.channel], error: `HTTP ${fail[x.channel]}` } : { ok: true, code: 200 }; };
  const alerts = new Alerts({ store, getConfig: () => c, transport, env: {}, log: quiet });
  const set = (o) => { c = { ...c, ...o }; };
  const e = (t, name, extra = {}) => store.apply({ type: "hook", t: iso(t), session: "a", ev: name, cwd: "/p/shop", gitRoot: "/p/shop", host: "box", ...extra });
  const wait = (t, id = "e1") => { e(t - 1000, "PreToolUse", { tool: "Edit", target: "/p/shop/.env", detail: { path: "/p/shop/.env" }, toolUseId: id }); e(t, "PermissionRequest", { tool: "Edit", target: "/p/shop/.env", detail: { path: "/p/shop/.env" } }); };
  return { store, alerts, sent, fail, set, e, wait };
}

test("alerts: in quiet hours a wait is held, with no reminders, while other rules still send; when they end, one digest per channel says what became of each", async () => {
  const { store, alerts, sent, e, wait } = quietRig();
  alerts.check(night(22, 30));
  wait(night(23, 0));
  alerts.check(night(23, 4));
  const [held] = alerts.list;
  assert.deepEqual([held.kind, held.sent.slack.status, held.sent.discord.status, sent.length], ["waiting", "held", "held", 0], "nothing leaves at night");
  alerts.check(night(23, 30));
  assert.equal(alerts.list.length, 1, "no reminders while it's quiet");
  store.apply({ type: "usage", t: iso(night(23, 31)), session: "a", cost: 5, model: "claude-sonnet-4-6" });
  alerts.check(night(23, 32));
  await alerts.idle();
  assert.deepEqual(sent.map((x) => x.channel), ["slack", "discord"], "a costly session isn't a needs-you alert: it still goes");
  assert.match(sent[0].text, /has cost \$5\.00/);
  e(night(23, 40), "PostToolUse", { tool: "Edit", toolUseId: "e1", result: { ok: true } });
  alerts.check(night(23, 41));
  assert.equal((await alerts.retry(held.id, "slack", night(23, 42))).error, "Quiet hours hold it. It goes to Slack in one message when they end, at 08:00.");
  alerts.check(night(7, 59, 15));
  assert.equal(sent.length, 2);
  alerts.check(night(8, 0, 15));
  await alerts.idle();
  const digest = sent.slice(2);
  assert.deepEqual(digest.map((x) => x.channel), ["slack", "discord"], "one message per channel");
  assert.match(digest[0].text, /^🌙 Quiet hours \(22:00–08:00\) are over\. 1 alert was held:\n• shop on box has waited 4 min to edit a file: \.env · answered at 23:40$/, "as long as it had waited when the 23:04 check held it");
  assert.deepEqual([held.sent.slack.status, held.sent.slack.digest, held.sent.slack.at], ["sent", true, iso(night(8, 0, 15))]);
  const A = await pub("alerts-model.js");
  assert.equal(A.deliveryOf(held.sent.slack, { ref: held.t }).text, "Delivered Oct 15, 08:00 in the digest");
  assert.deepEqual(A.deliveryOf({ status: "held" }), { tone: "muted", icon: "moon", text: "Held for quiet hours" });
  alerts.check(night(8, 1, 15));
  await alerts.idle();
  assert.equal(sent.length, 4, "a digest goes once");
});

test("alerts: a wait still open at the digest gets reminders 15 min after it; a failed digest can be retried alone; turning quiet hours off sends what they held", async () => {
  // A wait from 01:00: at 08:00 it's inside the store's 8 hours for a silent wait, so it still needs you. (One from
  // 23:00 would be offline by then; the digest says "went offline", see below.)
  const r = quietRig();
  r.alerts.check(night(0, 30, 15));
  r.wait(night(1, 0, 15));
  r.alerts.check(night(1, 5, 15));
  r.fail.discord = 404;
  r.alerts.check(night(8, 0, 15));
  await r.alerts.idle();
  const [held] = r.alerts.list;
  assert.deepEqual(r.sent.map((x) => x.channel), ["slack", "discord"], "the digest alone: no reminder in the same check");
  assert.match(r.sent[0].text, /waited 5 min to edit a file: \.env · still waiting · 7h 0m$/);
  assert.deepEqual([held.sent.slack.status, held.sent.discord.status, held.sent.discord.error], ["sent", "failed", "HTTP 404"]);
  r.alerts.check(night(8, 10, 15));
  assert.equal(r.alerts.list.length, 1, "no reminder right after the digest");
  r.alerts.check(night(8, 16, 15));
  await r.alerts.idle();
  assert.deepEqual([r.alerts.list.length, r.alerts.list[1].repeat, r.alerts.list[1].sent.slack.status], [2, 1, "sent"], "the next one 15 min after it");
  delete r.fail.discord;
  const back = await r.alerts.retry(held.id, "discord", night(8, 20, 15));
  assert.deepEqual([back.alert.sent.discord.status, back.alert.sent.discord.tries], ["sent", 2]);
  const A = await pub("alerts-model.js");
  assert.equal(A.deliveryOf(back.alert.sent.discord, { ref: night(8, 20, 15) }).text, "Delivered 08:20 (retried)");
  // A wait from 23:00 has been silent 9 hours by 08:00: past the store's 8, its agent is offline, and the digest says so.
  const late = quietRig();
  late.alerts.check(night(22, 30));
  late.wait(night(23, 0));
  late.alerts.check(night(23, 5));
  late.alerts.check(night(8, 0, 15));
  await late.alerts.idle();
  assert.match(late.sent[0].text, /waited 5 min to edit a file: \.env · went offline at 08:00$/);
  // Off in the middle of the night: what they held goes at the next check.
  const o = quietRig();
  o.alerts.check(night(22, 30));
  o.wait(night(23, 0));
  o.alerts.check(night(23, 5));
  o.set({ quietHours: { on: false, from: "22:00", to: "08:00" } });
  o.alerts.check(night(23, 6));
  await o.alerts.idle();
  assert.deepEqual([o.sent.length, o.alerts.list[0].sent.slack.status], [2, "sent"]);
  assert.deepEqual(o.alerts.view(night(23, 6)).quiet, { on: false, from: "22:00", to: "08:00" });
});

test("alerts: a digest lists at most 20 and points to the rest; a session that ended or went offline says so", () => {
  const a = (i, end = null) => ({ kind: "waiting", label: `job ${i}`, name: `shop · job ${i}`, project: "shop", host: "box", waited: 4, what: "for your input", since: iso(night(23)), end });
  const list = [a(0, { how: "ended", t: iso(night(23, 30)) }), a(1, { how: "offline", t: iso(night(23, 45)) }), ...Array.from({ length: 23 }, (_, i) => a(i + 2))];
  const text = digestText(list, { from: "22:00", to: "08:00" }, night(8, 0, 15));
  assert.match(text, /^🌙 Quiet hours \(22:00–08:00\) are over\. 25 alerts were held:\n• job 0 · shop on box has waited 4 min for your input · its session ended at 23:30\n• job 1 · shop on box has waited 4 min for your input · went offline at 23:45\n/);
  assert.equal(text.split("\n").filter((l) => l.startsWith("• ")).length, 20);
  assert.match(text, /\n…and 5 more in the Alerts Center\.$/);
});

// ---------- the server ----------
async function boot(env = {}, demo = false) {
  const dir = tmp("ao-set-srv-");
  Object.assign(process.env, env);
  const app = createServer({ dir, log: quiet, demo });
  for (const k of Object.keys(env)) delete process.env[k];
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const token = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).token;
  return { app, base, token, dir };
}
const H = { "X-Requested-With": "agent-office", "Content-Type": "application/json" };

test("server: GET /api/machines and /api/projects; settings take projects (no duplicate names), quiet hours and a monthly budget", async () => {
  const { app, base, token } = await boot();
  try {
    const post = (e) => fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(e) });
    await post({ type: "hook", t: iso(Date.now() - M), session: "s1", ev: "SessionStart", cwd: "/p/shop", gitRoot: "/p/shop", host: "mac", os: "darwin" });
    await post({ type: "hook", t: iso(Date.now()), session: "s1", ev: "PreToolUse", tool: "Read", cwd: "/p/shop", gitRoot: "/p/shop", host: "mac", health: { fails: [iso(Date.now() - M)], backlog: 4 } });
    const m = await (await fetch(base + "/api/machines")).json();
    assert.deepEqual([m.offlineAfterMin, m.server, m.machines.map((x) => [x.host, x.os, x.status, x.failed, x.backlog])], [30, os.hostname(), [["mac", "darwin", "retrying", 1, 4]]]);
    const p = await (await fetch(base + "/api/projects")).json();
    assert.deepEqual(p.projects.map((x) => [x.key, x.name, x.roots]), [["shop", "shop", ["/p/shop"]]]);
    const put = (body, h = H) => fetch(base + "/api/settings", { method: "PUT", headers: h, body: JSON.stringify(body) });
    assert.equal((await put({ project: { key: "shop", name: "Shop" } }, {})).status, 403, "same-origin only");
    let r = await put({ project: { key: "shop", name: "Shop front", color: 2 }, monthlyBudgetUsd: 600, quietHours: { on: true } });
    const s = await r.json();
    assert.deepEqual([s.monthlyBudgetUsd, s.quietHours, typeof s.tzOffsetMin], [600, { on: true, from: "22:00", to: "08:00" }, "number"]);
    const st = await (await fetch(base + "/api/state")).json();
    assert.deepEqual([st.agents[0].project, st.agents[0].projectColor], ["Shop front", 2]);
    r = await put({ project: { key: "api", name: "shop" } });
    assert.deepEqual([r.status, (await r.json()).error], [400, "Another project is already called shop."]);
    const saved = JSON.parse(fs.readFileSync(path.join(app.store.dataDir, "..", "config.json"), "utf8"));
    assert.deepEqual([saved.projects, saved.monthlyBudgetUsd, saved.quietHours.on], [{ shop: { name: "Shop front", color: 2 } }, 600, true]);
  } finally { await app.close(); }
});

test("server: rotating the token needs the same-origin header; the old token stops working, the new one is saved; setup says when it was made and last used", async () => {
  const { app, base, token, dir } = await boot();
  try {
    const ingest = (t) => fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + t }, body: JSON.stringify({ type: "hook", t: iso(Date.now()), session: "s", ev: "Stop", cwd: "/p" }) });
    let s = await (await fetch(base + "/api/setup", { headers: H })).json();
    assert.deepEqual([s.lastUsedAt, typeof s.since, /^\d{4}-/.test(s.createdAt)], [null, "string", true]);
    assert.ok(Math.abs(Date.now() - Date.parse(s.t)) < 5000, "t: when it was read, for the screen's As of");
    await ingest(token);
    s = await (await fetch(base + "/api/setup", { headers: H })).json();
    assert.ok(Date.now() - Date.parse(s.lastUsedAt) < 5000, "last used: the call it just let in");
    assert.equal((await fetch(base + "/api/token/rotate", { method: "POST" })).status, 403);
    const r = await fetch(base + "/api/token/rotate", { method: "POST", headers: H, body: "{}" });
    const n = await r.json();
    assert.ok(n.token !== token && n.snippet.includes(n.token) && n.lastUsedAt === null);
    assert.equal(r.headers.get("set-cookie"), null, "a local dashboard has no sign-in to renew");
    assert.equal((await ingest(token)).status, 401, "the old one is refused");
    assert.equal((await ingest(n.token)).status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.deepEqual([saved.token, saved.tokenCreatedAt], [n.token, n.createdAt]);
  } finally { await app.close(); }
  const team = await boot({ HOST: "0.0.0.0" });
  try {
    const login = await fetch(team.base + "/api/login", { method: "POST", body: JSON.stringify({ token: team.token }) }), cookie = login.headers.get("set-cookie").split(";")[0];
    const r = await fetch(team.base + "/api/token/rotate", { method: "POST", headers: { ...H, cookie } });
    const fresh = r.headers.get("set-cookie").split(";")[0];
    assert.equal(fresh, `ao_token=${(await r.json()).token}`, "whoever rotated it stays signed in");
    assert.equal((await fetch(team.base + "/api/state", { headers: { cookie } })).status, 401, "everyone else signs in again");
    assert.equal((await fetch(team.base + "/api/state", { headers: { cookie: fresh } })).status, 200);
    assert.equal((await fetch(team.base + "/api/machines")).status, 401, "machines need the sign-in too");
  } finally { await team.app.close(); }
});

/** Opens GET /api/stream; resolves with its status once it answers, and `ended`, which settles when the server ends it. */
function openStream(base, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + "/api/stream", { headers, agent: false }, (res) => {
      const ended = new Promise((r) => res.on("end", () => r(true)));
      res.on("data", () => {});
      resolve({ status: res.statusCode, ended, close: () => req.destroy() });
    });
    req.on("error", reject);
  });
}
/** true when p settles within ms, else false. */
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms, false).unref())]);

test("server: rotating the token in team mode ends every live stream opened with the old one; on a local dashboard they stay", async () => {
  const team = await boot({ HOST: "0.0.0.0" }), local = await boot(), streams = [];
  try {
    const login = await fetch(team.base + "/api/login", { method: "POST", body: JSON.stringify({ token: team.token }) }), cookie = login.headers.get("set-cookie").split(";")[0];
    const mine = await openStream(team.base, { cookie }), theirs = await openStream(team.base, { authorization: `Bearer ${team.token}` });
    streams.push(mine, theirs);
    assert.deepEqual([mine.status, theirs.status], [200, 200]);
    const r = await fetch(team.base + "/api/token/rotate", { method: "POST", headers: { ...H, cookie } });
    const fresh = r.headers.get("set-cookie").split(";")[0];
    assert.deepEqual([await within(mine.ended, 2000), await within(theirs.ended, 2000)], [true, true], "both cut off, the rotating tab's too");
    const old = await openStream(team.base, { cookie });
    streams.push(old);
    assert.equal(old.status, 401, "the old sign-in can't open it again");
    const again = await openStream(team.base, { cookie: fresh });
    streams.push(again);
    assert.equal(again.status, 200, "the rotating tab reconnects with its new cookie");
    const here = await openStream(local.base);
    streams.push(here);
    assert.equal((await fetch(local.base + "/api/token/rotate", { method: "POST", headers: H })).status, 200);
    assert.equal(await within(here.ended, 300), false, "nobody signs in to a local dashboard: its streams stay");
  } finally { for (const s of streams) s.close(); await team.app.close(); await local.app.close(); }
});

test("server: a token that couldn't be saved is never used: the old one keeps working", async () => {
  const { app, base, token, dir } = await boot();
  try {
    const ingest = (t) => fetch(base + "/api/events", { method: "POST", headers: { Authorization: "Bearer " + t }, body: JSON.stringify({ type: "hook", t: iso(Date.now()), session: "s", ev: "Stop", cwd: "/p" }) });
    fs.rmSync(path.join(dir, "config.json"));
    fs.mkdirSync(path.join(dir, "config.json", "in-the-way"), { recursive: true }); // a folder where config.json should go
    assert.equal((await fetch(base + "/api/token/rotate", { method: "POST", headers: H, body: "{}" })).status, 500);
    assert.equal((await ingest(token)).status, 200);
    assert.equal((await (await fetch(base + "/api/setup", { headers: H })).json()).token, token);
  } finally { await app.close(); }
});

test("server: on start it reads every spooled file on this machine: pending, sealed batches and what a dead hook left", async () => {
  const dir = tmp("ao-set-spool-"), sp = path.join(dir, "spool"), e = (n) => JSON.stringify({ type: "hook", t: iso(Date.now() - n * 1000), session: `s${n}`, ev: "UserPromptSubmit", cwd: `/p/p${n}`, prompt: "go" });
  fs.mkdirSync(sp, { recursive: true });
  fs.writeFileSync(path.join(sp, "pending.jsonl"), e(1) + "\n");
  fs.writeFileSync(path.join(sp, "batch-0000000000001-0000beef-0000-1.jsonl"), e(2) + "\n");
  fs.writeFileSync(path.join(sp, `sending-${String(Date.now() - 5 * M).padStart(13, "0")}-0000000000002-0000beef-0000-1.jsonl`), e(3) + "\n");
  const app = createServer({ dir, log: quiet });
  try {
    assert.deepEqual(app.store.agents().map((a) => a.session).sort(), ["s1", "s2", "s3"]);
    assert.deepEqual(fs.readdirSync(sp), [], "all read, none left");
  } finally { await app.close(); }
});

// ---------- the model ----------
const NOW = new Date(2026, 9, 24, 15, 42).getTime(); // the reference's "now"
let built = null;
/** The demo day at 15:42, as the browser gets it: the snapshot, machines, projects, the alerts view. */
async function demo() {
  if (built) return built;
  const cfg = { ...cfg0, ...DEMO_CHANNELS, alertRules: config.rulesOf(), monthlyBudgetUsd: 750 };
  const store = new Store({ getConfig: () => cfg }), alerts = new Alerts({ store, getConfig: () => cfg, transport: demoWebhook(NOW), env: {}, log: quiet });
  loadScenario(store, NOW, { alerts });
  await alerts.idle();
  return (built = { store, alerts, cfg, snap: json(store.snapshot(NOW)), machines: json({ t: iso(NOW), offlineAfterMin: 30, server: "thinkpad-x1", machines: store.machines(NOW) }),
    projects: json({ t: iso(NOW), projects: store.projects(NOW) }), alertsView: json(alerts.view(NOW)) });
}

test("demo: thinkpad-x1 healthy, studio-mac retrying with 2 failed sends in the last hour, build-server offline since 12:05 with 143 events queued", async () => {
  const S = await pub("settings-model.js"), { machines } = await demo();
  const rows = S.machineRows(machines, { now: NOW });
  assert.deepEqual(rows.map((r) => [r.host, r.health.label, r.line.text, r.line.error, r.backlog.text, r.about, r.self]), [
    ["studio-mac", "Retrying", "2 failed sends in the last hour", true, "Nothing queued", "macOS · 2 live", false],
    ["thinkpad-x1", "Healthy", "No failed sends in the last hour", false, "Nothing queued", "Linux · 5 live", true],
    ["build-server", "Offline", "No contact since 12:05", false, "143 events · queued on the machine as of 12:05, sends on reconnect", "Linux · 0 live", false],
  ]);
  assert.deepEqual(rows.map((r) => r.last), ["15:40", "15:41", "12:05"], "tokens page's 15:40 edit; basket bill's 15:41:50 edit; the 12:05 command");
  assert.deepEqual(S.navNotes({ machines }).machines.map((n) => [n.text, n.tone]), [["1 offline", "muted"], ["1 retrying", "error"]]);
  assert.equal(S.pingText(machines.machines.find((m) => m.host === "build-server"), NOW), "Checked 15:42: nothing since 12:05. Its hooks only send while claude runs there.");
  const ping = (host) => S.pingText(machines.machines.find((m) => m.host === host), NOW);
  assert.deepEqual([ping("thinkpad-x1"), ping("studio-mac")], ["Checked 15:42: its last event came 9 s ago.", "Checked 15:42: its last event came 1 min ago."]);
  assert.equal(S.pingText(null), "It hasn't reported in the last 7 days.");
});

test("model: sections from the address, the token and what rotating it means, budgets and what they used, projects, quiet hours", async () => {
  const S = await pub("settings-model.js"), { snap, projects, alertsView, machines } = await demo();
  assert.deepEqual(["#/settings?section=token", "#/settings?section=nope", "#/settings", "#/settings?agent=x&section=budgets"].map(S.sectionOf), ["token", null, null, "budgets"]);
  const setup = { token: "abcd1234efgh5678ijkl9012mnop3456qrst7890uvwx", url: "https://office.example", teamMode: true, createdAt: iso(NOW - 3 * DAY), lastUsedAt: iso(NOW - M), since: iso(NOW - 60 * M) };
  const t = S.tokenView(setup, { now: NOW, machines });
  assert.deepEqual([t.masked, t.created, t.used, t.confirm.lead, t.confirm.more], ["abcd••••••••uvwx", "Created Oct 21, 15:42", "Last used 15:41", "All 2 other machines stop reporting until their token is updated.", "Everyone signed in to this dashboard signs in again with the new token."],
    "thinkpad-x1 runs the server: its hooks read the new token by themselves");
  const lead = (list) => S.tokenView(setup, { now: NOW, machines: { ...machines, machines: list } }).confirm.lead;
  assert.equal(lead(machines.machines.filter((m) => m.host !== "build-server")), "1 other machine stops reporting until its token is updated.");
  assert.equal(lead(machines.machines.filter((m) => m.host === "thinkpad-x1")), "Machines with the old token stop reporting until it's updated.");
  const retrying = (failed) => S.navNotes({ machines: { ...machines, machines: [{ host: "a", status: "retrying", failed, backlog: 4 }] } }).machines[0];
  assert.deepEqual([retrying(2).tone, retrying(0).tone, retrying(0).text], ["error", "muted", "1 retrying"], "red only for failed sends; a spool still sending is no error");
  assert.equal(t.install, `agent-office install --url https://office.example --token ${setup.token}`);
  const local = S.tokenView({ ...setup, teamMode: false, createdAt: null, lastUsedAt: null }, { now: NOW });
  assert.deepEqual([local.created, local.used, local.confirm.lead, local.install], ["Creation date not recorded", "Not used since the server started at 14:42", "Hooks on this computer switch to the new token by themselves.", null]);
  const b = S.budgetRows({ dailyBudgetUsd: 25, monthlyBudgetUsd: 750 }, { snap, rule: alertsView.rules.session, now: NOW });
  assert.deepEqual(b.map((r) => [r.key, r.value, r.use.over]), [["daily", 25, false], ["monthly", 750, false], ["session", 3.5, true]]);
  assert.equal(b[0].use.text, "$13.72 spent today · 55% of $25");
  assert.match(b[1].use.text, /^\$[\d,.]+ spent in October · \d+% of \$750$/);
  assert.equal(b[2].use.text, "$3.84 · basket bill, the costliest session in the last 24 hours · over budget, 110% of $3.50");
  assert.equal(S.budgetRows({}, { snap: null, rule: null })[2].value, null, "the session limit waits for the alert rules");
  const noCost = { ...snap, totals: { ...snap.totals, periods: { today: { cost: 0, requests: 0 }, "30d": { cost: 0, requests: 0 }, month: { cost: 0, requests: 0 } } }, agents: [] };
  assert.equal(S.budgetRows({ dailyBudgetUsd: 25 }, { snap: noCost })[0].use.text, "No cost data yet: cost needs telemetry (agent-office install) · 0% of $25");
  const rows = S.projectRows(projects, { colors: new Map([["supermarket-pos", 0], ["checkout-api", 1], ["docs-site", 2]]) });
  assert.deepEqual(rows.map((r) => [r.key, r.name, r.root, r.more, r.today, r.color, r.picked]), [
    ["supermarket-pos", "", "/Users/mk/code/supermarket-pos", 0, "4 agents today", 0, false],
    ["checkout-api", "", "/Users/mk/code/checkout-api", 1, "3 agents today", 1, false],
    ["docs-site", "", "/Users/mk/code/docs-site", 0, "1 agent today", 2, false]]);
  assert.deepEqual(S.COLOR_NAMES, ["Violet", "Sky", "Lime", "Pink", "Indigo", "Slate"]);
  const q = S.quietView({ on: true, from: "22:00", to: "08:00" }, { serverOffset: 0, browserOffset: 120 });
  assert.equal(q.text, "Needs-you alerts to Slack and Discord wait, then go out as one message at 08:00. Desktop notifications pause too. Budget, cost and error alerts still go out.");
  assert.equal(q.tz, "These are the server's times (UTC+0). You're on UTC+2.");
  assert.equal(S.quietView({}, { serverOffset: 330, browserOffset: 330 }).tz, null);
  const at = (h, m) => Date.UTC(2026, 9, 24, h, m);
  assert.deepEqual([at(21, 59), at(22, 0), at(7, 59), at(8, 0)].map((x) => S.inQuiet({ on: true, from: "22:00", to: "08:00" }, x, 0)), [false, true, true, false]);
  assert.equal(S.inQuiet({ on: true, from: "22:00", to: "08:00" }, at(20, 30), 120), true, "by the server's clock: 20:30 UTC is 22:30 at UTC+2");
  assert.equal(S.inQuiet({ on: false, from: "22:00", to: "08:00" }, at(23, 0), 0), false);
  assert.deepEqual(S.navNotes({ alerts: alertsView }).notifications.map((n) => n.text), ["1 failing"]);
});

test("model: picked room colours win in the office, the rest still hash around them; the cost report's month tile uses the monthly budget", async () => {
  const O = await pub("office3d-model.js"), C = await pub("cost-model.js"), { projectColor } = await pub("ui/components.js");
  const a = (session, project, projectColor = null, started = iso(NOW - M)) => ({ session, project, projectColor, started });
  const auto = O.projectColors([a("1", "shop"), a("2", "api")]), want = projectColor("shop");
  const picked = O.projectColors([a("1", "shop"), a("2", "api", want, iso(NOW - 2 * M))]);
  assert.equal(picked.get("api"), want);
  assert.notEqual(picked.get("shop"), want, "an automatic colour moves off a picked one");
  assert.equal(auto.get("shop"), want);
  assert.notEqual(O.layoutKey([a("1", "shop")]), O.layoutKey([a("1", "shop", 4)]), "picking a colour redraws the office");
  const r = { date: "2026-10-24", month: "2026-10-01", days: [{ date: "2026-10-23", cost: 10 }, { date: "2026-10-24", cost: 5 }], periods: { "7d": { tokens: {}, models: [] } } };
  const [, , month] = C.kpis(r, 25, 600), [, , daily] = C.kpis(r, 25);
  assert.deepEqual([month.budget, month.note, daily.budget, daily.note], [600, "Monthly budget", 775, "$25 a day × 31 days"]);
});

// ---------- the markup ----------
const RAW = ["PreToolUse", "PermissionRequest", "<ide_", "<system-reminder", "undefined", "NaN", "[object", "null", "hooks.slack.com/services"];
const noRaw = (html, what) => { for (const r of RAW) assert.ok(!html.includes(r), `${what}: no ${r}`); };
const TOKEN = "abcd1234efgh5678ijkl9012mnop3456qrst7890uvwx";
const SETUP = { t: iso(NOW), token: TOKEN, url: "http://127.0.0.1:4380", snippet: JSON.stringify({ env: { OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${TOKEN}` } }, null, 2),
  teamMode: false, createdAt: iso(NOW - 3 * DAY), lastUsedAt: iso(NOW - M), since: iso(NOW - 60 * M) };
/** Red in this screen's markup: the error state, red pills, lines, notes and meters. */
const RED = /ao-state--error|st-pill--error|st-err|is-error|is-over|is-failing/g;

test("view: every panel's loading, error, empty and stale states; real buttons, labelled inputs and a colour radio group; no raw names", async () => {
  const S = await pub("settings-model.js"), V = await pub("settings-view.js"), d = await demo();
  const v = S.tokenView(SETUP, { now: NOW, machines: d.machines }), budgets = S.budgetRows({ dailyBudgetUsd: 25, monthlyBudgetUsd: 750 }, { snap: d.snap, rule: d.alertsView.rules.session, now: NOW });
  const live = {
    machines: (o) => V.machinesPanel({ rows: S.machineRows(d.machines, { now: NOW }), ...o }),
    token: (o) => V.tokenPanel({ v, setup: SETUP, ...o }),
    budgets: (o) => V.budgetsPanel({ rows: budgets, ...o }),
    projects: (o) => V.projectsPanel({ count: 3, ...o }),
    channels: (o) => V.channelsPanel({ rows: S.channelRows(d.alertsView, NOW), ...o }),
  };
  for (const [name, p] of Object.entries(live)) {
    assert.match(p({ status: "loading" }), /aria-busy="true"[^]*class="ao-loading"><span class="ao-sr">Loading [a-z ]+…<\/span>/, `${name} loading`);
    assert.match(p({ status: "error" }), /ao-state--error" role="alert"[^]*<p>Couldn&#39;t load [^<]+<\/p><button type="button" class="ao-btn ao-btn--secondary ao-btn--sm" data-(st-)?retry/, `${name} error`);
    assert.match(p({ status: "stale", asOf: iso(NOW) }), /ao-stale-note"><svg[^]*As of 15:42<\/span>[^]*ao-panel-body ao-stale/, `${name} stale`);
    noRaw(p({ status: "live" }), name);
  }
  for (const [name, p] of [["offline", V.offlinePanel], ["desktop", V.desktopPanel], ["quiet", V.quietPanel]]) {
    assert.match(p({ status: "loading" }), /aria-busy="true"[^]*Loading your settings…/, `${name} loading`);
    assert.match(p({ status: "error" }), /role="alert"[^]*Couldn&#39;t load your settings\. The server didn&#39;t answer\.[^]*data-retry/, `${name} error`);
  }
  assert.match(V.machinesPanel({ rows: [] }), /data-st-add[^]*ao-state--empty[^]*No machine has reported yet\. Each one shows up here with its first hook event\.[^]*id="st-add"/, "empty, and Add machine still there");
  assert.match(V.projectsPanel({ count: 0 }), /ao-state--empty[^]*No projects yet\. Each git folder an agent works in becomes a project, with a room in the office\./);
  assert.match(V.budgetForm({ ...budgets[2], value: null }), /Loading the alert rule…/, "the session limit waits for the alert rules");
  assert.match(V.budgetForm({ ...budgets[2], value: null }, { failed: true }), /st-err">Couldn&#39;t load the alert rules\. <button[^>]*data-st-retry="alerts"/);
  assert.match(V.addMachine(null), /ao-loading[^]*Loading the setup…/);
  assert.match(V.addMachine(null, { failed: true }), /st-err" role="alert">[^]*Couldn't load the token\. Run <code>agent-office token<\/code>/);

  // Real buttons and labelled inputs.
  const m = live.machines({});
  assert.equal((m.match(/<th scope="row" class="st-host">/g) || []).length, 3);
  assert.match(m, /<button type="button" class="ao-btn ao-btn--secondary ao-btn--sm" data-st-ping="studio-mac" data-key="st-ping:studio-mac" aria-label="Ping studio-mac"><span>Ping<\/span><\/button>/);
  assert.match(m, /data-st-add data-key="st-add" aria-expanded="false" aria-controls="st-add"><svg[^]*Add machine[^]*<div class="st-add" id="st-add" hidden>/);
  assert.match(V.offlinePanel({ value: 45 }), /<label for="st-offline-min">Mark agents and machines offline after<\/label><span class="st-num"><input type="number" id="st-offline-min"[^>]*value="45"/);
  const f = V.budgetForm(budgets[0]);
  assert.match(f, /<label for="st-b-daily">Daily budget<\/label>[^]*<input type="number" id="st-b-daily" inputmode="decimal" min="0" step="0\.5" value="25" data-st-budget="daily" data-key="st-b-daily" aria-describedby="st-bu-daily st-b-daily-hint">/);
  assert.match(V.budgetForm(budgets[2]), /value="3\.50"[^]*<a class="cc-link" href="#\/alerts">Alert rules<\/a>/);
  const rows = S.projectRows(d.projects, { colors: new Map() }), pf = V.projectForm(rows[0], 0);
  assert.match(pf, /<label for="st-p-0">Display name <span class="ao-sr">for supermarket-pos<\/span><\/label>[^]*<input type="text" id="st-p-0" maxlength="40"[^>]*placeholder="supermarket-pos"/);
  assert.match(pf, /<fieldset class="st-colors"><legend>Room colour<span class="ao-sr"> for supermarket-pos<\/span> <span class="ao-meta">\(automatic\)<\/span><\/legend>/);
  assert.equal((pf.match(/<input type="radio" name="st-c-0"/g) || []).length, 6, "the 6 room colours");
  assert.deepEqual([...pf.matchAll(/<span class="ao-sr">(\w+)<\/span><\/label>/g)].map((x) => x[1]), S.COLOR_NAMES, "each named, not colour alone");
  assert.equal((pf.match(/ checked>/g) || []).length, 1);
  assert.ok(!/amber|needs|--red|proj-[78]/.test(pf), "no amber or red among them");
  assert.match(V.projectInfo(rows[1]), /<button type="button" class="ao-copy" data-copy="\/Users\/mk\/code\/checkout-api"[^]*\+1 more root[^]*3 agents today/);
  const ap = V.appearancePanel({ prefs: { reduceMotion: false, nameTags: true } });
  assert.match(ap, /role="radiogroup" aria-label="Theme"[^]*Dark[^]*Light[^]*System/);
  assert.match(ap, /<input type="checkbox" role="switch" class="ao-switch" id="st-motion" data-key="st-motion" data-st-pref="reduceMotion" aria-describedby="st-motion-hint"><label for="st-motion">Reduce motion<\/label>/);
  assert.match(ap, /id="st-tags" data-key="st-tags" data-st-pref="nameTags" checked/);
  assert.match(V.appearancePanel({ system: true }), /id="st-motion"[^>]*checked disabled[^]*Your system asks for less motion, so it stays on\./);
  const qp = V.quietPanel({ v: S.quietView({ on: true, from: "22:00", to: "08:00" }, { serverOffset: 0, browserOffset: 60 }) });
  assert.match(qp, /role="switch"[^>]*id="st-quiet-on"[^>]*checked[^]*<label for="st-quiet-on">Quiet hours 22:00–08:00<\/label>[^]*<label for="st-q-from">From<\/label><input type="time" id="st-q-from" step="60" value="22:00"/);
  assert.match(qp, /These are the server&#39;s times \(UTC\+0\)\. You&#39;re on UTC\+1\./);
  noRaw(ap + qp + f + V.offlinePanel({}) + V.desktopPanel({ hint: "This browser allows them." }), "forms");
});

test("view: red only for failed sends, a failing webhook, a save that didn't go through and over budget; no amber; the token stays masked; Rotate's confirm", async () => {
  const S = await pub("settings-model.js"), V = await pub("settings-view.js"), d = await demo();
  const m = V.machinesPanel({ rows: S.machineRows(d.machines, { now: NOW }) });
  assert.deepEqual(m.match(RED), ["is-error"], "one red line: studio-mac's failed sends");
  assert.match(m, /st-pill st-pill--retry"><svg[^]*Retrying<\/span><\/span><span class="st-line is-error"><svg[^]*2 failed sends in the last hour<\/span>/);
  assert.match(m, /st-pill st-pill--ok"><svg[^]*Healthy[^]*st-line">No failed sends in the last hour/);
  assert.match(m, /st-pill st-pill--off"><svg[^]*Offline<\/span><\/span><span class="st-line">No contact since 12:05/, "offline is gray, not red");
  assert.match(m, /<span class="st-bar" aria-hidden="true"><span style="width:100\.0%"><\/span><\/span><span class="ao-meta">143 events · queued on the machine as of 12:05, sends on reconnect/, "a backlog is neutral");
  const nav = V.nav("machines", S.navNotes({ machines: d.machines, alerts: d.alertsView }));
  assert.match(nav, /aria-current="page"><svg[^]*Machines<\/span><span class="st-nav-note is-muted"><svg[^]*1 offline<\/span><span class="st-nav-note is-error"><svg[^]*1 retrying/);
  assert.match(nav, /Notifications<\/span><span class="st-nav-note is-error"><svg[^]*1 failing/);
  assert.equal((nav.match(/aria-current/g) || []).length, 1);
  const ch = V.channelsPanel({ rows: S.channelRows(d.alertsView, NOW) });
  assert.deepEqual(ch.match(RED), ["is-failing", "st-pill--error", "is-error"], "Discord only");
  assert.match(ch, /<li class="st-channel"><div class="st-ch-head"><b>Slack · #agent-office<\/b><span class="st-pill st-pill--ok">/);
  assert.match(ch, /<li class="st-channel is-failing">[^]*Failing · HTTP 404 since 15:36 · the webhook may have been deleted/);
  const rows = S.budgetRows({ dailyBudgetUsd: 25, monthlyBudgetUsd: 750 }, { snap: d.snap, rule: d.alertsView.rules.session, now: NOW });
  assert.deepEqual(rows.map((r) => (V.budgetUse(r).match(RED) || []).join()), ["", "", "is-over,is-over"], "only the session over its $3.50");
  assert.match(V.budgetUse(rows[2]), /st-use-text is-over"><svg[^]*over budget, 110% of \$3\.50/, "and says so in words");
  assert.equal((V.budgetForm(rows[0], { note: { text: "Saved" } }).match(RED) || []).length, 0);
  assert.match(V.budgetForm(rows[0], { note: { text: "Not saved. Daily budget must be $0 to $1,000,000 (0 = none).", error: true }, draft: "-5" }), /st-saved is-error" data-st-saved="daily">Not saved\.[^]*value="-5"/);
  const all = m + nav + ch + rows.map((r) => V.budgetForm(r) + V.budgetUse(r)).join("") + V.tokenPanel({ v: S.tokenView(SETUP, { now: NOW }), setup: SETUP, t: { confirming: true } });
  assert.ok(!/amber|needs|ao-btn--answer|--warn/.test(all), "nothing here is amber: nobody waits on you here");

  // The token: masked unless revealed; the whole token only in Copy.
  const setup = { ...SETUP, teamMode: true, url: "https://office.example" }, v = S.tokenView(setup, { now: NOW, machines: d.machines });
  const shut = V.tokenPanel({ v, setup, t: {} });
  assert.ok(!shut.replace(/data-copy="[^"]*"/g, "").includes(TOKEN), "hidden on screen");
  assert.match(shut, /<code class="st-token-value"><span class="ao-sr">Workspace token, hidden: <\/span>abcd••••••••uvwx<\/code>[^]*data-st-reveal data-key="st-reveal" aria-pressed="false"[^]*data-copy="abcd1234/);
  assert.match(shut, /data-st-rotate data-key="st-rotate" aria-expanded="false"><svg/, "no aria-controls while the confirm is shut");
  assert.match(V.tokenPanel({ v, setup, t: { revealed: true } }), /<code class="st-token-value">abcd1234efgh5678ijkl9012mnop3456qrst7890uvwx<\/code>[^]*aria-pressed="true"/);
  const open = V.tokenPanel({ v, setup, t: { confirming: true } });
  assert.match(open, /data-st-rotate data-key="st-rotate" aria-expanded="true" aria-controls="st-rotate-box">/);
  assert.match(open, /<div class="st-confirm" id="st-rotate-box" role="group" aria-labelledby="st-rotate-h" data-st-confirm>\s*<p id="st-rotate-h"><b>Rotate the token\?<\/b> All 2 other machines stop reporting until their token is updated\.<\/p>/);
  assert.match(open, /ao-btn--primary ao-btn--sm" data-st-rotate-yes data-key="st-rotate-yes"><span>Rotate token<\/span>[^]*ao-btn--ghost ao-btn--sm" data-st-rotate-no data-key="st-rotate-no"><span>Keep this one/);
  assert.equal((open.match(RED) || []).length, 0, "the confirm is neutral");
  assert.match(V.tokenPanel({ v, setup, t: { confirming: true, rotating: true } }), /data-st-rotate-yes data-key="st-rotate-yes" disabled aria-busy="true"><span>Rotating…/);
  assert.match(V.tokenPanel({ v, setup, t: { confirming: true, error: "Couldn't rotate it. Server error." } }), /st-err" role="alert"><svg[^]*Couldn&#39;t rotate it\. Server error\./);
  const after = V.tokenPanel({ v, setup, t: { rotated: true } });
  assert.match(after, /New token in use\.<\/b> Run this on every machine to update it:[^]*<code class="cc-cmd">agent-office install --url https:\/\/office\.example --token abcd••••••••uvwx<\/code>/);
  assert.ok(!after.replace(/data-copy="[^"]*"/g, "").includes(TOKEN));
  const add = V.addMachine(setup);
  assert.ok(!add.replace(/data-copy="[^"]*"/g, "").includes(TOKEN), "Add machine masks it too");
  assert.match(add, /Bearer abcd••••••••uvwx/);
});

test("model and view: events a full spool dropped, in plain words and in red, under what waits; nothing made up when none were", async () => {
  const S = await pub("settings-model.js"), V = await pub("settings-view.js"), { machines } = await demo();
  const list = machines.machines.map((m) => (m.host === "studio-mac" ? { ...m, dropped: 3000, droppedAt: iso(NOW - 37 * M) } : m));
  const rows = S.machineRows({ ...machines, machines: list }, { now: NOW });
  assert.deepEqual(rows.map((r) => r.dropped && r.dropped.text), ["3,000 events dropped when its spool was full, the latest at 15:05", null, null]);
  assert.equal(S.machineRows({ ...machines, machines: [{ ...list[0], dropped: 1, droppedAt: iso(NOW - DAY + M) }] }, { now: NOW })[0].dropped.text,
    "1 event dropped when its spool was full, the latest at Oct 23, 15:43");
  const html = V.machinesPanel({ rows });
  assert.match(html, /<div class="st-backlog"><span class="ao-meta">Nothing queued<\/span><span class="st-line is-error"><svg[^]*?<\/svg>3,000 events dropped when its spool was full, the latest at 15:05<\/span><\/div>/);
  assert.deepEqual(html.match(RED), ["is-error", "is-error"], "studio-mac's failed sends and what it dropped: nothing else red");
  assert.deepEqual(V.machinesPanel({ rows: S.machineRows(machines, { now: NOW }) }).match(RED), ["is-error"], "the demo's machines dropped nothing");
  // A project's saved change, shown until the list loads again, by the server's rules.
  const { projects } = await demo(), named = S.withProject(projects, { key: "checkout-api", name: " Payments ", color: 4 });
  const api = (r) => r.projects.find((p) => p.key === "checkout-api");
  assert.deepEqual([api(named).name, api(named).named, api(named).color], ["Payments", true, 4]);
  assert.equal(named.projects[0], projects.projects[0], "the others as they were");
  assert.deepEqual([api(S.withProject(named, { key: "checkout-api", name: "checkout-api" })).named, api(S.withProject(named, { key: "checkout-api", name: "" })).name], [false, "checkout-api"]);
  assert.deepEqual([api(S.withProject(named, { key: "checkout-api", color: null })).color, api(S.withProject(named, { key: "checkout-api", color: 1 })).name], [null, "Payments"]);
  assert.equal(S.withProject(null, { key: "x" }), null);
});

test("view: hostile host names, tokens, project names, channel names and times are escaped", async () => {
  const S = await pub("settings-model.js"), V = await pub("settings-view.js"), d = await demo();
  const evil = '"><img src=x onerror=alert(1)>';
  const machines = { ...d.machines, server: evil, machines: d.machines.machines.map((x) => ({ ...x, host: evil + x.host, os: evil })) };
  const mrows = S.machineRows(machines, { now: NOW, pings: new Map([[evil + "studio-mac", evil]]) });
  const setup = { ...SETUP, token: evil + "1234567890", url: evil, snippet: evil, teamMode: true };
  const v = S.tokenView(setup, { now: NOW, machines });
  const projects = { ...d.projects, projects: d.projects.projects.map((p) => ({ ...p, key: evil + p.key, name: evil, named: true, roots: [evil, evil] })) };
  const prows = S.projectRows(projects, { colors: new Map() });
  const alerts = { ...d.alertsView, channels: d.alertsView.channels.map((c) => ({ ...c, channel: evil, error: evil, hint: evil, url: evil })) };
  const snap = { ...d.snap, agents: d.snap.agents.map((a) => ({ ...a, name: evil, label: evil, project: evil })) };
  const budgets = S.budgetRows({ dailyBudgetUsd: 25 }, { snap, rule: d.alertsView.rules.session, now: NOW });
  const html = [
    V.machinesPanel({ rows: mrows, pinging: new Set([evil + "thinkpad-x1"]), adding: true, add: V.addMachine(setup) }),
    V.tokenPanel({ v, setup, t: { revealed: true, confirming: true, rotated: true, error: evil } }), V.tokenPanel({ v, setup, t: {} }),
    ...prows.map((r, i) => V.projectForm(r, i, { note: { text: evil, error: true }, draft: { name: evil } }) + V.projectInfo(r)),
    V.channelsPanel({ rows: S.channelRows(alerts, NOW) }),
    ...budgets.map((r) => V.budgetForm(r, { note: { text: evil }, draft: evil }) + V.budgetUse(r)),
    V.quietPanel({ v: S.quietView({ on: true, from: evil, to: evil }) }), V.offlinePanel({ draft: evil, note: { text: evil } }),
    V.desktopPanel({ hint: evil }), V.noteToast(evil, evil),
  ].join("");
  assert.ok(!html.includes("<img"), "no markup gets through");
  assert.ok(html.includes("&quot;&gt;&lt;img"), "it's shown as text");
});

// ---------- the screen in the shell ----------
function fakeWindow(hash = "") {
  const listeners = {}, stored = new Map();
  return {
    location: { hash, href: "/" }, localStorage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v) }, stored,
    addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    go(h) { this.location.hash = h; for (const fn of listeners.hashchange || []) fn(); },
    focus() {},
  };
}
/** A server for the shell: routes by path, with method; a route may be async, return { status, error } or be missing (500). */
function fakeServer(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const r = routes[`${opts.method || "GET"} ${url.split("?")[0]}`] ?? routes[url.split("?")[0]];
    const out = await (typeof r === "function" ? r(url, opts) : r);
    if (out === undefined) return { status: 500, ok: false, json: async () => ({ error: "Server error." }) };
    if (out && out.status) return { status: out.status, ok: false, json: async () => ({ error: out.error }) };
    return { status: 200, ok: true, json: async () => json(out) };
  };
  const sources = [];
  class ES { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } }
  return { fetch, EventSource: ES, calls, sources };
}
const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const NEW_TOKEN = "ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000";

/** The shell at #/settings on the demo day at 15:43, with a server whose PUT /api/settings really checks and keeps them
 *  (each one once gate() settles, if given). */
async function settingsShell({ routes = {}, gate = null } = {}) {
  const d = await demo(), later = NOW + M, realNow = Date.now;
  let cfg = { ...config.DEFAULTS, dailyBudgetUsd: 25, monthlyBudgetUsd: 750 };
  const settings = () => ({ offlineAfterMin: cfg.offlineAfterMin, dailyBudgetUsd: cfg.dailyBudgetUsd, monthlyBudgetUsd: cfg.monthlyBudgetUsd, notifyOnWaiting: cfg.notifyOnWaiting,
    quietHours: config.quietOf(cfg.quietHours), tzOffsetMin: -new Date(later).getTimezoneOffset(), aliases: {}, demo: false, teamMode: false, viewer: "mk" });
  const put = (body) => {
    const r = config.applySettings(cfg, body, { known: d.store.projectKeys() });
    if (r.error) return { status: 400, error: r.error };
    cfg = r.cfg;
    return settings();
  };
  Date.now = () => later;
  const dom = withDom(), win = fakeWindow("#/settings"), srv = fakeServer({
    "/api/state": { ...d.snap, alertsRev: d.alerts.rev, settings: settings() }, "/api/timeline": { date: "2026-10-24", sessions: [], buckets: [] },
    "/api/machines": d.machines, "/api/projects": d.projects, "/api/alerts": d.alertsView, "/api/setup": SETUP,
    "PUT /api/settings": (u, o) => (gate ? gate().then(() => put(JSON.parse(o.body))) : put(JSON.parse(o.body))),
    ...routes,
  });
  try {
    const { createShell } = await pub("shell.js");
    const shell = createShell({ doc: dom.document, win, fetch: srv.fetch, EventSource: srv.EventSource });
    const page = dom.document.body.querySelector('[data-screen="settings"]');
    await shell.ready;
    await ticks();
    const q = (s) => page.querySelector(s), all = (s) => page.querySelectorAll(s);
    const done = () => { Date.now = realNow; shell.destroy(); dom.restore(); };
    return { dom, win, srv, page, q, all, pane: (id) => q(`[data-st-pane="${id}"]`), done, active: () => dom.document.activeElement, cfg: () => cfg };
  } catch (e) { Date.now = realNow; dom.restore(); throw e; }
}

test("settings DOM: each section renders from its own data, one at a time, the nav marking it; Ping and Add machine", async () => {
  let t = null;
  try {
    t = await settingsShell();
    const { q, all, pane, win, srv, page, active } = t;
    assert.equal(page.hidden, false);
    for (const p of ["/api/machines", "/api/projects", "/api/setup", "/api/alerts"]) assert.ok(srv.calls.some((c) => c.url === p && c.opts.headers["X-Requested-With"] === "agent-office"), p);
    assert.match(q(".st-auto").textContent, /Changes save automatically/);
    const links = all(".st-nav-link");
    assert.deepEqual(links.map((a) => a.querySelector(".st-nav-text").textContent), ["Machines", "Token", "Budgets", "Projects", "Appearance", "Notifications"]);
    assert.deepEqual(links.map((a) => a.getAttribute("aria-current")), ["page", null, null, null, null, null]);
    assert.equal(links[0].textContent, "Machines1 offline1 retrying");
    assert.equal(links[5].textContent, "Notifications1 failing");
    assert.deepEqual(all("[data-st-pane]").map((p) => [p.getAttribute("data-st-pane"), p.hidden]), [["machines", false], ["token", true], ["budgets", true], ["projects", true], ["appearance", true], ["notifications", true]]);
    const rows = () => all("tr").filter((r) => r.parentNode.localName === "tbody");
    assert.deepEqual(rows().map((r) => r.querySelector("code").textContent), ["studio-mac", "thinkpad-x1", "build-server"]);
    assert.match(rows()[0].textContent, /Retrying2 failed sends in the last hour/);
    assert.match(rows()[2].textContent, /OfflineNo contact since 12:05143 events · queued on the machine as of 12:05, sends on reconnect/);
    assert.equal(q("#st-offline-min").getAttribute("value"), "30");
    // Ping: when the server last heard from it.
    q('[data-st-ping="build-server"]').click();
    await ticks();
    assert.match(rows()[2].querySelector(".st-ping-out").textContent, /^Checked 15:43: nothing since 12:05\./);
    // Add machine: how to connect one, the token masked.
    q("[data-st-add]").click();
    assert.equal(q("#st-add").hidden, false);
    assert.equal(q("[data-st-add]").getAttribute("aria-expanded"), "true");
    assert.ok(q("#st-add").textContent.includes("abcd••••••••uvwx") && !q("#st-add").textContent.includes(TOKEN));
    // Every other section, from the address its nav link sets.
    const heads = { token: "Workspace token", budgets: "Budgets", projects: "Projects", appearance: "Appearance", notifications: "Slack and Discord" };
    for (const [id, title] of Object.entries(heads)) {
      win.go(`#/settings?section=${id}`);
      await ticks();
      assert.equal(pane(id).hidden, false, id);
      assert.equal(all("[data-st-pane]").filter((p) => !p.hidden).length, 1, `${id}: one section at a time`);
      assert.equal(q('.st-nav-link[aria-current="page"]').getAttribute("href"), `#/settings?section=${id}`);
      assert.equal(pane(id).querySelector(".ao-panel-title").textContent, title);
      assert.equal(active(), pane(id).querySelector(".ao-panel-title"), `${id}: focus moves to it`);
      noRaw(pane(id).textContent, id);
    }
    assert.match(pane("notifications").textContent, /Failing · HTTP 404 since 15:36/);
    assert.equal(pane("notifications").querySelector("#st-quiet-on").checked, false);
    win.go("#/settings?section=projects");
    await ticks();
    assert.deepEqual(all("[data-st-name]").map((i) => i.getAttribute("placeholder")), ["supermarket-pos", "checkout-api", "docs-site"]);
    assert.equal(all('[data-st-color="0"]').length, 6);
    win.go("#/settings?section=budgets");
    await ticks();
    assert.deepEqual(["daily", "monthly", "session"].map((k) => q(`#st-b-${k}`).getAttribute("value")), ["25", "750", "3.50"]);
    assert.match(q('[data-st-bu="session"]').textContent, /over budget, 110% of \$3\.50/);
  } finally { t?.done(); }
});

test("settings DOM: a change says Saving…, then Saved; one the server refuses says Not saved with why, in red, and keeps what you typed", async () => {
  let t = null;
  try {
    t = await settingsShell();
    const { q, win, srv, cfg } = t;
    win.go("#/settings?section=budgets");
    await ticks();
    const puts = () => srv.calls.filter((c) => c.opts.method === "PUT").map((c) => [c.url, c.body]);
    q("#st-b-daily").value = "30";
    t.dom.fire(q("#st-b-daily"), "change");
    assert.equal(q('[data-st-saved="daily"]').textContent, "Saving…");
    await ticks();
    assert.deepEqual(puts(), [["/api/settings", { dailyBudgetUsd: "30" }]]);
    assert.equal(q('[data-st-saved="daily"]').textContent, "Saved");
    assert.ok(!q('[data-st-saved="daily"]').classList.contains("is-error"));
    assert.equal(cfg().dailyBudgetUsd, 30);
    assert.equal(q("#st-b-daily").getAttribute("value"), "30", "drawn from what the server kept");
    q("#st-b-monthly").value = "-5";
    t.dom.fire(q("#st-b-monthly"), "change");
    await ticks();
    const note = q('[data-st-saved="monthly"]');
    assert.equal(note.textContent, "Not saved. Monthly budget must be $0 to $1,000,000 (0 = none).");
    assert.ok(note.classList.contains("is-error"));
    assert.equal(q("#st-b-monthly").getAttribute("value"), "-5", "what you typed stays, to fix");
    assert.equal(cfg().monthlyBudgetUsd, 750);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(q('[data-st="said"]').textContent, "Monthly budget: not saved. Monthly budget must be $0 to $1,000,000 (0 = none).");
    // Fixed (Enter saves at once): saved, and the red goes.
    q("#st-b-monthly").value = "600";
    t.dom.fire(q("#st-b-monthly"), "keydown", { key: "Enter" });
    await ticks();
    assert.equal(q('[data-st-saved="monthly"]').textContent, "Saved");
    assert.ok(!q('[data-st-saved="monthly"]').classList.contains("is-error"));
    assert.equal(cfg().monthlyBudgetUsd, 600);
    // The offline timeout refuses an empty box before asking the server.
    win.go("#/settings?section=machines");
    await ticks();
    q("#st-offline-min").value = "";
    t.dom.fire(q("#st-offline-min"), "change");
    assert.equal(q('[data-st-saved="offlineAfterMin"]').textContent, "Type a number of minutes first.");
    assert.equal(puts().length, 3);
    // A project's name pins its colour, so renaming keeps it; quiet hours.
    win.go("#/settings?section=projects");
    await ticks();
    const name = q('[data-st-name="0"]'), color = Number(q('[data-st-color="0"][checked]').getAttribute("value"));
    name.value = "Checkout";
    t.dom.fire(name, "change");
    await ticks();
    assert.deepEqual(puts().at(-1)[1], { project: { key: "supermarket-pos", name: "Checkout", color } });
    assert.equal(q('[data-st-saved="project:supermarket-pos"]').textContent, "Saved");
    win.go("#/settings?section=notifications");
    await ticks();
    q("#st-quiet-on").checked = true;
    t.dom.fire(q("#st-quiet-on"), "change");
    await ticks();
    assert.deepEqual(puts().at(-1)[1], { quietHours: { on: true, from: "22:00", to: "08:00" } });
    assert.equal(q('[data-st-saved="quiet"]').textContent, "Saved");
    assert.equal(q("#st-quiet-on").checked, true);
  } finally { t?.done(); }
});

test("settings DOM: Rotate opens a neutral confirm with focus on Keep this one; Esc closes it and focus goes back; Rotate token puts the new one in use", async () => {
  let t = null, fail = true;
  try {
    t = await settingsShell({ routes: { "POST /api/token/rotate": () => (fail ? undefined : { ...SETUP, token: NEW_TOKEN, lastUsedAt: null }) } });
    const { q, win, srv, active } = t;
    win.go("#/settings?section=token");
    await ticks();
    assert.equal(q(".st-token-value").textContent, "Workspace token, hidden: abcd••••••••uvwx");
    assert.equal(q("[data-st-rotate]").getAttribute("aria-controls"), null);
    q("[data-st-rotate]").click();
    assert.ok(q("[data-st-confirm]"));
    assert.deepEqual([q("[data-st-rotate]").getAttribute("aria-expanded"), q("[data-st-rotate]").getAttribute("aria-controls")], ["true", "st-rotate-box"]);
    assert.equal(active().getAttribute("data-key"), "st-rotate-no");
    assert.match(q("[data-st-confirm]").textContent, /Rotate the token\? Hooks on this computer switch to the new token by themselves\./);
    t.dom.fire(active(), "keydown", { key: "Escape" });
    assert.equal(q("[data-st-confirm]"), null, "Esc closes it");
    assert.equal(active().getAttribute("data-key"), "st-rotate", "and focus goes back to Rotate");
    assert.deepEqual([q("[data-st-rotate]").getAttribute("aria-expanded"), q("[data-st-rotate]").getAttribute("aria-controls")], ["false", null]);
    // Reveal shows it whole.
    q("[data-st-reveal]").click();
    assert.equal(q(".st-token-value").textContent, TOKEN);
    q("[data-st-reveal]").click();
    // A rotation that fails says so in the confirm; one that works closes it and shows the new token, masked.
    q("[data-st-rotate]").click();
    q("[data-st-rotate-yes]").click();
    assert.equal(q("[data-st-rotate-yes]").textContent, "Rotating…");
    await ticks();
    assert.equal(q("[data-st-confirm]").querySelector('[role="alert"]').textContent, "Couldn't rotate it. Server error.");
    fail = false;
    q("[data-st-rotate-yes]").click();
    await ticks();
    const posts = srv.calls.filter((c) => c.url === "/api/token/rotate");
    assert.ok(posts.length === 2 && posts.every((c) => c.opts.method === "POST" && c.opts.headers["X-Requested-With"] === "agent-office"));
    assert.equal(q("[data-st-confirm]"), null);
    assert.equal(q(".st-token-value").textContent, "Workspace token, hidden: ffff••••••••0000");
    assert.match(q(".st-rotated").textContent, /New token in use\. Run agent-office install on this computer to keep cost tracking\./);
    assert.match(q('[data-st="toasts"]').textContent, /New token in use\s*Hooks here use it already\./);
    assert.equal(active().getAttribute("data-key"), "st-rotate");
  } finally { t?.done(); }
});

test("settings DOM: a change made while the same field saves is saved next, and what you typed for it stays until then", async () => {
  let t = null;
  const held = [], release = async () => { held.shift()(); await ticks(); };
  try {
    t = await settingsShell({ gate: () => new Promise((r) => held.push(r)) });
    const { q, win, srv, cfg } = t, daily = () => q("#st-b-daily"), note = () => q('[data-st-saved="daily"]');
    const type = (v) => { daily().value = v; t.dom.fire(daily(), "change"); };
    win.go("#/settings?section=budgets");
    await ticks();
    type("30");
    type("-5");
    await ticks();
    assert.equal(held.length, 1, "one save at a time");
    await release();
    assert.equal(cfg().dailyBudgetUsd, 30);
    assert.deepEqual([held.length, note().textContent, daily().getAttribute("value")], [1, "Saving…", "-5"], "the next one goes; what you typed for it stays");
    await release();
    assert.equal(note().textContent, "Not saved. Daily budget must be $0 to $1,000,000 (0 = none).");
    assert.equal(daily().getAttribute("value"), "-5", "still there, to fix");
    assert.equal(cfg().dailyBudgetUsd, 30);
    // Two that both go through: the box shows what the server kept once nothing more waits.
    type("40");
    type("45.0");
    await release();
    assert.equal(daily().getAttribute("value"), "45.0");
    await release();
    assert.deepEqual([cfg().dailyBudgetUsd, note().textContent, daily().getAttribute("value"), held.length], [45, "Saved", "45", 0]);
    assert.deepEqual(srv.calls.filter((c) => c.opts.method === "PUT").map((c) => c.body.dailyBudgetUsd), ["30", "-5", "40", "45.0"]);
  } finally { t?.done(); }
});

test("settings DOM: a picked room colour stays picked while it saves, and a rename made meanwhile is sent with it, not the old one", async () => {
  let t = null, cfgNow = () => config.DEFAULTS, stalled = null;
  const held = [], release = async () => { held.shift()(); await ticks(); }, d = await demo();
  // GET /api/projects as the server has them: the demo's projects with the names and colours saved so far.
  const projectsNow = () => ({ ...d.projects, projects: d.projects.projects.map((p) => {
    const c = (cfgNow().projects || {})[p.key] || {};
    return { ...p, name: c.name || p.key, named: !!c.name, color: c.color ?? null };
  }) });
  try {
    t = await settingsShell({ gate: () => new Promise((r) => held.push(r)), routes: { "/api/projects": () => (stalled ? new Promise((r) => stalled.push(() => r(projectsNow()))) : projectsNow()) } });
    cfgNow = t.cfg;
    const { q, all, win, srv } = t, checked = () => Number(q('[data-st-color="0"][checked]').getAttribute("value"));
    const name = () => q('[data-st-name="0"]').value, note = () => q('[data-st-saved="project:supermarket-pos"]').textContent;
    const puts = () => srv.calls.filter((c) => c.opts.method === "PUT").map((c) => c.body);
    win.go("#/settings?section=projects");
    await ticks();
    assert.match(all("legend")[0].textContent, /\(automatic\)/);
    const before = checked(), pick = (before + 1) % 6, radio = q(`[data-key="st-c:supermarket-pos:${pick}"]`);
    radio.checked = true;
    t.dom.fire(radio, "change");
    assert.deepEqual([checked(), note()], [pick, "Saving…"], "the one you picked stays checked while it saves");
    assert.doesNotMatch(all("legend")[0].textContent, /automatic/);
    // Renamed while the colour saves: it waits its turn, and you still see both.
    q('[data-st-name="0"]').value = "Checkout";
    t.dom.fire(q('[data-st-name="0"]'), "change");
    await ticks();
    assert.deepEqual(puts(), [{ project: { key: "supermarket-pos", color: pick } }], "one save at a time");
    assert.deepEqual([checked(), name()], [pick, "Checkout"]);
    await release();
    assert.deepEqual(puts().at(-1), { project: { key: "supermarket-pos", name: "Checkout", color: pick } }, "the rename carries the colour you picked");
    assert.deepEqual([checked(), name(), note()], [pick, "Checkout", "Saving…"]);
    // Saved while the list is slow to load again: it shows what was saved already, not what it had before.
    stalled = [];
    await release();
    assert.deepEqual([checked(), name(), note()], [pick, "Checkout", "Saved"]);
    assert.deepEqual(t.cfg().projects["supermarket-pos"], { name: "Checkout", color: pick });
    const go = stalled;
    stalled = null;
    go.forEach((f) => f());
    await ticks();
    assert.deepEqual([checked(), name(), held.length, puts().length], [pick, "Checkout", 0, 2]);
  } finally { t?.done(); }
});

test("settings DOM: the token is asked for again when its section, Add machine or the screen opens; a stream the server refuses sends you to sign in", async () => {
  let t = null, setup = SETUP, signedOut = false;
  const d = await demo();
  const state = { ...d.snap, alertsRev: d.alerts.rev, settings: { offlineAfterMin: 30, dailyBudgetUsd: 25, monthlyBudgetUsd: 750, notifyOnWaiting: false,
    quietHours: config.DEFAULTS.quietHours, tzOffsetMin: 0, aliases: {}, demo: false, teamMode: true, viewer: "mk" } };
  try {
    t = await settingsShell({ routes: { "/api/setup": () => setup, "/api/state": () => (signedOut ? { status: 401, error: "Sign in first." } : state) } });
    const { q, win, srv } = t, count = (p) => srv.calls.filter((c) => c.url === p).length, asked = count("/api/setup");
    setup = { ...SETUP, token: NEW_TOKEN, snippet: SETUP.snippet.replace(TOKEN, NEW_TOKEN), lastUsedAt: null }; // another tab rotated it
    q("[data-st-add]").click();
    await ticks();
    assert.equal(count("/api/setup"), asked + 1, "Add machine asks again");
    assert.match(q("#st-add").textContent, /Bearer ffff••••••••0000/);
    win.go("#/settings?section=token");
    await ticks();
    assert.equal(count("/api/setup"), asked + 2);
    assert.equal(q(".st-token-value").textContent, "Workspace token, hidden: ffff••••••••0000");
    win.go("#/board");
    win.go("#/settings?section=token");
    await ticks();
    assert.equal(count("/api/setup"), asked + 3, "and coming back to the screen");
    // A stream that drops is the browser's to retry. One the server refused it won't retry: the state is asked for
    // again, and the stream opened again a little later.
    const es = t.srv.sources[0], states = count("/api/state");
    es.readyState = 0;
    es.onerror();
    await ticks();
    assert.equal(count("/api/state"), states);
    es.readyState = 2;
    es.onerror();
    await ticks();
    assert.equal(count("/api/state"), states + 1);
    for (let i = 0; i < 40 && srv.sources.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(srv.sources.map((s) => s.url), ["/api/stream", "/api/stream"]);
    // Team mode, after another tab rotated the token: this tab's sign-in has ended.
    signedOut = true;
    srv.sources[1].readyState = 2;
    srv.sources[1].onerror();
    await ticks();
    assert.equal(win.location.href, "/login.html");
  } finally { t?.done(); }
});

/** The token panel's stale state: dimmed, with "As of" when the token was last read (15:37 here). */
function tokenState(q) {
  const p = q("#st-token"), note = p.querySelector(".ao-stale-note");
  return { stale: p.querySelector(".ao-panel-body").classList.contains("ao-stale"), note: note && note.textContent, value: q(".st-token-value").textContent };
}
const SHOWN = "Workspace token, hidden: abcd••••••••uvwx";

test("settings DOM: when the token can't be read again, its panel keeps the last one, dimmed, As of when it was read; back live once it can", async () => {
  let t = null, up = true;
  try {
    t = await settingsShell({ routes: { "/api/setup": () => (up ? { ...SETUP, t: iso(NOW - 5 * M) } : undefined) } });
    const { q, win, srv } = t, asked = () => srv.calls.filter((c) => c.url === "/api/setup").length;
    const back = async () => { win.go("#/board"); win.go("#/settings?section=token"); await ticks(); };
    win.go("#/settings?section=token");
    await ticks();
    assert.deepEqual(tokenState(q), { stale: false, note: null, value: SHOWN });
    up = false; // the server stops answering; the stream stays up
    const before = asked();
    await back();
    assert.equal(asked(), before + 1, "coming back asks for it again");
    assert.deepEqual(tokenState(q), { stale: true, note: "As of 15:37", value: SHOWN }, "the last token, dimmed");
    up = true;
    await back();
    assert.deepEqual(tokenState(q), { stale: false, note: null, value: SHOWN });
  } finally { t?.done(); }
});

test("settings DOM: when the live stream stops, the token panel dims with As of too, and comes back live with the stream", async () => {
  let t = null;
  try {
    t = await settingsShell({ routes: { "/api/setup": { ...SETUP, t: iso(NOW - 5 * M) } } });
    const { q, win, srv } = t, d = await demo();
    win.go("#/settings?section=token");
    await ticks();
    assert.deepEqual(tokenState(q), { stale: false, note: null, value: SHOWN });
    const es = srv.sources[0];
    es.readyState = 0;
    es.onerror();
    await ticks();
    assert.deepEqual(tokenState(q), { stale: true, note: "As of 15:37", value: SHOWN });
    es.onmessage({ data: JSON.stringify({ ...d.snap, alertsRev: d.alerts.rev }) });
    await ticks();
    assert.deepEqual(tokenState(q), { stale: false, note: null, value: SHOWN });
  } finally { t?.done(); }
});
