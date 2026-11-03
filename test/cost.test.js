"use strict";
// The Cost Report (M9): the store's per-day, per-model and per-session spend and its request log, the CSV export (with
// formula injection neutralised), the endpoints, the model and markup (colour and text rules, estimates labelled), and
// the report in the shell on a fake DOM. Every clock is pinned, so nothing depends on the time of day.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { pathToFileURL } = require("url");
const { Store, localDate } = require("../src/store");
const { loadScenario } = require("../src/demo");
const { cell, toCsv, requestsCsv } = require("../src/csv");
const { createServer } = require("../src/server");
const { withDom } = require("./helpers/dom");

const pub = (f) => import(pathToFileURL(path.join(__dirname, "..", "public", f)).href);
const M = 60000, DAY = 86400000;
const NOW = new Date(2026, 9, 24, 15, 42).getTime(); // Sat Oct 24 2026, 15:42 local: the reference's "now"
const json = (x) => JSON.parse(JSON.stringify(x));
const cfg = { offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 25 };
const mk = (over = {}, dataDir = null) => new Store({ getConfig: () => ({ ...cfg, ...over }), dataDir });
const iso = (t) => new Date(t).toISOString();
const round = (n) => Math.round(n * 100) / 100;

let day = null;
/** The demo day at the pinned 15:42, as the browser gets it. Built once; the tests only read it. */
function demo() {
  if (day) return day;
  const store = mk();
  loadScenario(store, NOW);
  return (day = { store, cost: json(store.cost(NOW)), snap: json(store.snapshot(NOW)), timeline: json(store.timeline(localDate(NOW), NOW)), detail: (id) => json(store.detail(id, NOW)) });
}
const mods = async () => { const [C, V, O] = await Promise.all([pub("cost-model.js"), pub("cost-view.js"), pub("office3d-model.js")]); return { C, V, O }; };
// Never in the UI: raw hook names, absolute paths, system tags, broken values.
const RAW = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "TodoWrite", "<ide_", "<system-reminder", "/Users/", "/srv/", "undefined", "NaN", "[object", "Infinity"];
const noRaw = (html, what) => { for (const r of RAW) assert.ok(!html.includes(r), `${what}: no ${r}`); };

// ---------- the store ----------
test("cost store: per day, per project, model and session; today and 7 days; the month so far; a session's main model", () => {
  const s = mk(), at = (d, min = 0) => iso(new Date(2026, 9, 24 - d, 10, min).getTime());
  const hook = (session, cwd, t) => s.apply({ type: "hook", t, session, ev: "SessionStart", cwd, gitRoot: cwd, host: "box" });
  const use = (session, t, cost, model, tok = {}) => s.apply({ type: "usage", t, session, cost, model, input: 10, output: 20, cacheRead: 300, cacheWrite: 4, ...tok });
  hook("a", "/p/shop", at(0)); hook("b", "/p/api", at(3)); hook("c", "/p/shop", at(10));
  use("a", at(0, 1), 1, "claude-sonnet-4-6"); use("a", at(0, 2), 0.5, "claude-haiku-4-5"); use("a", at(0, 3), 0.25, "claude-sonnet-4-6");
  use("b", at(3, 1), 2, "claude-opus-4-7");
  use("z", at(5, 1), 0.75, null); // no folder, no model reported
  use("c", at(10, 1), 4, "claude-sonnet-4-6"); // 10 days ago: in the month and the chart, not in 7 days
  const r = s.cost(NOW);
  assert.deepEqual([r.date, r.month, r.days.length, r.days[0].date, r.days.at(-1).date], ["2026-10-24", "2026-10-01", 24, "2026-10-01", "2026-10-24"], "since the 1st once the month is longer than 14 days");
  assert.deepEqual(r.days.filter((d) => d.cost).map((d) => [d.date, d.cost, d.requests]), [["2026-10-14", 4, 1], ["2026-10-19", 0.75, 1], ["2026-10-21", 2, 1], ["2026-10-24", 1.75, 3]]);
  const t = r.periods.today, w = r.periods["7d"];
  assert.deepEqual([t.days, t.from, t.cost, t.requests, t.tokens], [1, "2026-10-24", 1.75, 3, { input: 30, output: 60, cacheRead: 900, cacheWrite: 12 }]);
  assert.deepEqual([w.days, w.from, w.cost, w.requests], [7, "2026-10-18", 4.5, 5]);
  assert.deepEqual(w.projects, [{ project: "api", cost: 2 }, { project: "shop", cost: 1.75 }, { project: null, cost: 0.75 }], "most first; no folder is null");
  assert.deepEqual(w.models.map((m) => [m.model, m.cost, m.requests, m.tokens.cacheRead]), [["claude-opus-4-7", 2, 1, 300], ["claude-sonnet-4-6", 1.25, 2, 600], ["unknown", 0.75, 1, 300], ["claude-haiku-4-5", 0.5, 1, 300]]);
  assert.deepEqual(w.sessions.map((x) => [x.session, x.name, x.project, x.host, x.model, x.cost, x.requests]),
    [["b", "api", "api", "box", "claude-opus-4-7", 2, 1], ["a", "shop", "shop", "box", "claude-sonnet-4-6", 1.75, 3], ["z", "session z", null, null, null, 0.75, 1]], "main model = the one it spent most on");
  assert.deepEqual([w.sessionCount, w.avgCost, t.sessionCount, t.avgCost], [3, 1.5, 1, null], "an average needs 3 sessions");
  assert.deepEqual(w.sessions[1].tokens, { input: 30, output: 60, cacheRead: 900, cacheWrite: 12 });
  assert.deepEqual(Object.keys(w.sessions[0]).sort(), ["cost", "ended", "host", "label", "model", "name", "project", "requests", "session", "started", "state", "tokens", "updated"]);
  // The old report keeps its shape: cost per model.
  assert.deepEqual(s.report(1, NOW)[0].byModel, { "claude-sonnet-4-6": 1.25, "claude-haiku-4-5": 0.5 });
  // Early in a month the chart still shows 14 days.
  assert.equal(s.cost(new Date(2026, 10, 3, 9).getTime()).days.length, 14);
});

test("cost store: days are calendar days across daylight-saving changes; costly sessions capped; models capped; long ids cut", () => {
  for (const t of [new Date(2026, 2, 30, 0, 30), new Date(2026, 10, 2, 0, 30), new Date(2026, 9, 26, 23, 30), new Date(2026, 2, 9, 0, 10)]) {
    const r = mk().cost(t.getTime()), dates = r.days.map((d) => d.date);
    assert.equal(new Set(dates).size, dates.length, `${t}: no day twice`);
    for (let i = 1; i < dates.length; i++) assert.equal(Date.parse(`${dates[i]}T12:00:00Z`) - Date.parse(`${dates[i - 1]}T12:00:00Z`), DAY, `${t}: no day skipped`);
    assert.equal(dates.at(-1), localDate(t.getTime()));
  }
  const s = mk(), t = iso(NOW - 60 * M);
  for (let i = 0; i < 60; i++) s.apply({ type: "usage", t, session: `s${String(i).padStart(2, "0")}`, cost: i + 1, model: `model-${i}` });
  const w = s.cost(NOW).periods.today;
  assert.deepEqual([w.sessions.length, w.sessionCount, w.sessions[0].session, w.sessions[0].cost], [50, 60, "s59", 60], "the 50 costliest, most first; the count of all");
  assert.equal(w.avgCost, (60 * 61) / 2 / 60);
  assert.equal(w.models.length, 51, "50 models a day, the rest as other");
  assert.deepEqual(w.models.find((m) => m.model === "other").requests, 10);
  s.apply({ type: "usage", t, session: "long", cost: 1, model: "m".repeat(5000) });
  assert.equal(s.sessions.get("long").model.length, 100);
});

test("cost store: the request log for the export: range, order, names, capped with partial, pruned after 7 days, replayed from disk", () => {
  const s = mk();
  s.apply({ type: "hook", t: iso(NOW - 3 * DAY), session: "a", ev: "SessionStart", cwd: "/p/shop", gitRoot: "/p/shop", host: "box", name: "Till bot" });
  for (const d of [8, 6, 1, 0]) s.apply({ type: "usage", t: iso(NOW - d * DAY - 5 * M), session: "a", cost: 0.1234567, model: "claude-sonnet-4-6", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  s.apply({ type: "usage", t: iso(NOW - 20 * M), session: "b", cost: 0.5 }); // a session no hook ever named
  const w = s.requestRows(7, NOW), today = s.requestRows(1, NOW);
  assert.deepEqual([w.from, w.to, w.rows.length, w.partial, today.rows.length], ["2026-10-18", "2026-10-24", 4, false, 2]);
  assert.deepEqual(w.rows[0], { t: iso(NOW - 6 * DAY - 5 * M), date: "2026-10-18", session: "a", name: "Till bot", project: "shop", host: "box", model: "claude-sonnet-4-6", cost: 0.1234567, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.deepEqual(w.rows.map((r) => r.session), ["a", "a", "b", "a"], "oldest first");
  assert.deepEqual([w.rows[2].name, w.rows[2].project, w.rows[2].model], ["session b", null, null]);
  assert.equal(s.requests.length, 5);
  s.prune(NOW);
  assert.equal(s.requests.length, 4, "older than 7 days is dropped at the hourly cleanup");

  // Over the cap the oldest go, and an export of a period that lost some says so.
  const big = mk(), base = NOW - 6 * DAY;
  for (let i = 0; i < 110001; i++) big.apply({ type: "usage", t: iso(base + i * 1000), session: "x", cost: 0.001 }, { live: false, persist: false });
  assert.ok(big.requests.length <= 110000 && big.requests.length >= 100000);
  assert.equal(big.requestRows(7, NOW).partial, true);
  assert.equal(big.requestRows(1, NOW).partial, false, "today lost nothing");
  assert.equal(big.cost(NOW).periods["7d"].requests, 110001, "the totals never lose a request");

  // Usage is saved with the events, so a restart rebuilds the report and the log.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-cost-"));
  try {
    const live = mk({}, dir), t = iso(Date.now() - 2 * M);
    live.apply({ type: "hook", t, session: "a", ev: "SessionStart", cwd: "/p/shop", gitRoot: "/p/shop" });
    live.apply({ type: "usage", t, session: "a", cost: 1.5, model: "claude-opus-4-7", cacheRead: 100 });
    const back = mk({}, dir);
    back.replay();
    const now = Date.now();
    assert.deepEqual(json(back.cost(now).periods["7d"]), json(live.cost(now).periods["7d"]));
    assert.equal(back.requestRows(7, now).rows.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- CSV ----------
test("csv: formula injection neutralised (= + - @ tab CR), quotes, commas and line breaks quoted, BOM and CRLF", () => {
  assert.deepEqual(["=1+1", "+1", "-2", "@SUM(A1)", "\tx", "\rx"].map(cell), ["'=1+1", "'+1", "'-2", "'@SUM(A1)", "'\tx", "\"'\rx\""]);
  assert.equal(cell('=HYPERLINK("http://evil","x")'), `"'=HYPERLINK(""http://evil"",""x"")"`);
  assert.deepEqual(['say "hi"', "a,b", "two\nlines", "plain", " =x"].map(cell), ['"say ""hi"""', '"a,b"', '"two\nlines"', "plain", " =x"]);
  assert.deepEqual([cell(null), cell(undefined), cell(0), cell(-1.5), cell(NaN), cell(Infinity)], ["", "", "0", "-1.5", "", ""], "numbers stay numbers");
  assert.equal(toCsv([["A", (r) => r.a], ["B", (r) => r.b]], [{ a: 1, b: "x" }, { a: 2, b: "=y" }]), "﻿A,B\r\n1,x\r\n2,'=y\r\n");
  const out = requestsCsv([{ t: "2026-10-24T10:00:00.000Z", date: "2026-10-24", session: "s1", name: "=cmd|' /C calc'!A0", project: "-shop", host: "@box", model: "+m", cost: 0.12345678, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }]);
  assert.equal(out, "﻿Time (UTC),Day,Agent,Project,Machine,Model,Input tokens,Output tokens,Cache read tokens,Cache write tokens,Cost (USD),Session id\r\n" +
    "2026-10-24T10:00:00.000Z,2026-10-24,'=cmd|' /C calc'!A0,'-shop,'@box,'+m,1,2,3,4,0.123457,s1\r\n");
});

// ---------- endpoints ----------
const quiet = { log() {}, warn() {}, error() {} };
async function boot(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-cost-srv-"));
  Object.assign(process.env, env);
  const app = createServer({ dir, log: quiet });
  for (const k of Object.keys(env)) delete process.env[k];
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  return { app, dir, base: `http://127.0.0.1:${app.server.address().port}`, token: JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).token };
}

test("endpoints: GET /api/cost and the CSV export, behind dashboard sign-in; bad ranges refused; cells neutralised", async () => {
  const { app, dir, base, token } = await boot({ HOST: "0.0.0.0" }); // team mode: the dashboard needs signing in
  try {
    const auth = { Authorization: `Bearer ${token}` }, t = new Date(Date.now() - 30000).toISOString();
    await fetch(base + "/api/events", { method: "POST", headers: auth, body: JSON.stringify([
      { type: "hook", t, session: "s1", ev: "SessionStart", cwd: "/p/shop", gitRoot: "/p/shop", host: "box", name: '=HYPERLINK("http://evil")' },
      { type: "usage", t, session: "s1", cost: 0.25, model: "claude-sonnet-4-6", input: 5, cacheRead: 50 }]) });
    for (const p of ["/api/cost", "/api/cost/export?range=7d"]) assert.equal((await fetch(base + p)).status, 401, `${p} needs sign-in`);
    const r = await (await fetch(base + "/api/cost", { headers: auth })).json();
    assert.equal(r.date, localDate(Date.now()));
    assert.deepEqual([r.periods["7d"].cost, r.periods["7d"].sessions[0].session, r.periods["7d"].models[0].model], [0.25, "s1", "claude-sonnet-4-6"]);
    const res = await fetch(base + "/api/cost/export?range=7d", { headers: auth });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const days = [localDate(Date.now() - 6 * DAY), localDate(Date.now())];
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="virtual-office-requests-${days[0]}-to-${days[1]}.csv"`);
    assert.deepEqual([res.headers.get("x-rows"), res.headers.get("x-partial")], ["1", null]);
    const text = await res.text(), lines = text.split("\r\n");
    assert.equal(lines.length, 3, "header, one request, the final line end");
    assert.match(lines[1], new RegExp(`^${t.replace(/\./g, "\\.")},${days[1]},"'=HYPERLINK\\(""http://evil""\\)",shop,box,claude-sonnet-4-6,5,0,50,0,0\\.25,s1$`));
    const today = await fetch(base + "/api/cost/export", { headers: auth });
    assert.equal(today.headers.get("content-disposition"), `attachment; filename="virtual-office-requests-${days[1]}.csv"`, "today by default");
    for (const bad of ["30d", "constructor", "__proto__", ""]) assert.equal((await fetch(`${base}/api/cost/export?range=${bad}`, { headers: auth })).status, bad ? 400 : 200, bad || "empty = today");
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the model ----------
test("model: the demo's tiles, chart, projects, models and cache estimate (Oct 24, 15:42, $25 a day)", async () => {
  const { C } = await mods(), { cost: r } = demo(), budget = 25;
  const [today, week, month, cache] = C.kpis(r, budget);
  assert.deepEqual([round(today.spent), today.budget, today.period], [13.72, 25, "today"]);
  assert.deepEqual([round(week.spent), week.budget, week.note, week.over], [84.1, 175, "1 day over budget", true]);
  assert.deepEqual([round(month.spent), month.budget, month.period, month.note], [166.55, 775, "in October", "$25 a day × 31 days"], "Oct 1 to 24; the budget is a day's × the month's days");
  assert.equal(cache.label, "Cache saved · 7 days");
  assert.deepEqual(C.kpis(r, 0).map((k) => k.note || null), [null, null, null, null], "no budget: nothing over");

  const c = C.chart(r, budget);
  assert.deepEqual([c.bars.length, c.top, c.ticks.map((x) => x.label), c.line.label, round(c.line.y * 100)], [14, 30, ["$0", "$10", "$20", "$30"], "budget $25", 83.33], "y-axis $0 to $30");
  assert.deepEqual(c.bars.filter((b) => b.over).map((b) => [b.date, b.tag, b.text]), [["2026-10-19", "$27.40 · over", "Oct 19: $27.40, $2.40 over the $25 budget"]], "red only over budget");
  assert.deepEqual([c.bars.at(-1).today, c.bars.at(-1).tag, c.bars.at(-1).text], [true, "so far", "Oct 24, today: $13.72 so far"]);
  assert.deepEqual(c.bars.map((b) => b.label).slice(0, 3), ["Oct 11", "12", "13"]);
  assert.equal(c.summary, "$166.55 in the last 14 days. Highest: Oct 19, $27.40. 1 day over the $25 daily budget: Oct 19. Today so far: $13.72.");
  assert.equal(C.chart(r, 30).bars.some((b) => b.over), false);
  assert.equal(C.chart({ ...r, days: r.days.map((d) => ({ ...d, cost: 0 })) }, 25), null, "no spend: no chart");

  const w = r.periods["7d"], colors = new Map([["supermarket-pos", 0], ["checkout-api", 1], ["docs-site", 2]]);
  assert.deepEqual(C.projectRows(w, colors).map((p) => [p.project, round(p.cost), p.share, p.color]), [["supermarket-pos", 42.67, "51%", 0], ["checkout-api", 30.45, "36%", 1], ["docs-site", 10.98, "13%", 2]]);
  assert.deepEqual(C.modelRows(w).map((m) => [m.name, m.mono, round(m.cost), m.share]), [["claude-sonnet-4-6", true, 44.91, "53%"], ["claude-opus-4-7", true, 28.21, "34%"], ["claude-haiku-4-5", true, 10.98, "13%"]]);
  assert.deepEqual(C.modelRows({ cost: 2, models: [{ model: "unknown", cost: 1, requests: 1 }, { model: "other", cost: 1, requests: 1 }] }).map((m) => [m.name, m.mono]), [["Model not reported", false], ["Other models", false]]);

  // The estimate is list prices × each model's cache tokens; the rest are facts from telemetry.
  const { cacheSavings } = await pub("lib/prices.js"), cv = C.cacheView(w), tk = w.tokens;
  const expected = w.models.reduce((n, m) => n + cacheSavings(m.tokens, m.model).usd, 0);
  assert.ok(Math.abs(cv.usd - expected) < 1e-9 && cv.usd > 0);
  assert.deepEqual([cv.priced, cv.used, cv.unpriced, round(cv.without), cv.readShare], [true, true, 0, round(w.cost + expected), tk.cacheRead / (tk.input + tk.cacheRead + tk.cacheWrite)]);
  assert.deepEqual(cv.mix.map((m) => m.label), ["Cache reads", "Cache writes", "Fresh input", "Output"]);
  assert.match(cv.tokens, /^in [\d.]+[kM] · out [\d.]+[kM] · cache [\d.]+M$/);
  assert.deepEqual(C.cacheView({ cost: 1, tokens: { input: 5, output: 5, cacheRead: 9, cacheWrite: 1 }, models: [{ model: "gpt-x", tokens: { input: 5, output: 5, cacheRead: 9, cacheWrite: 1 } }] }).usd, null, "no known price: no estimate");
  const wrote = C.cacheView({ cost: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6 }, models: [{ model: "claude-sonnet-4-6", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6 } }] });
  assert.deepEqual([wrote.usd, wrote.frac], [-0.75, 0], "a cache that only wrote cost more than it saved");
  assert.deepEqual(C.priceTable(["Sonnet"]).map((p) => [p.family, p.input, p.read, p.write, p.used]).slice(2, 3), [["Sonnet", 3, 0.30000000000000004, 3.75, true]]);
  assert.deepEqual([C.share(0), C.share(0.004), C.share(0.62), C.share(0.9995), C.share(1)], ["0%", "<1%", "62%", "99.9%", "100%"]);
  assert.deepEqual([C.axis(13.72).top, C.axis(0).top, C.axis(0.05).ticks.length, C.axis(250).top], [15, 0.04, 4, 300]);
});

test("model: by agent and the top 5, today and 7 days, with live states and × vs avg", async () => {
  const { C, O } = await mods(), { cost: r, snap } = demo(), colors = O.projectColors(snap.agents);
  const t = C.report(r, { range: "today", budget: 25, colors, live: snap.agents });
  assert.deepEqual([t.range, t.period, t.phrase, t.requests > 0, Math.round(t.avgCost * 1000)], ["today", "Today", "today", true, 1715], "$13.72 over 8 sessions");
  assert.deepEqual(t.top.map((x) => [x.name, x.project, x.host, x.model, x.vsAvg, round(x.cost)]), [
    ["basket bill", "supermarket-pos", "thinkpad-x1", "claude-sonnet-4-6", "2.2×", 3.84], ["inventory sync", "supermarket-pos", "thinkpad-x1", "claude-sonnet-4-6", "1.2×", 2.1],
    ["refund flow", "checkout-api", "thinkpad-x1", "claude-opus-4-7", "1.2×", 2.05], ["login fix", "supermarket-pos", "thinkpad-x1", "claude-sonnet-4-6", "0.9×", 1.46],
    ["rate limiter", "checkout-api", "thinkpad-x1", "claude-sonnet-4-6", "0.8×", 1.38]]);
  assert.deepEqual(t.top.map((x) => x.state), ["working", "working", "needs", "idle", "working"], "states from the live data, in the design's names");
  assert.match(t.top[0].duration, /^\dh \d+m$/);
  assert.match(t.top[0].tokens, /^in [\d.]+k · out [\d.]+[kM] · cache [\d.]+M$/);
  assert.deepEqual([t.agents.rows.length, t.agents.more, t.agents.rows[0].frac, t.agents.rows.at(-1).name], [8, 0, 1, "webhook retries"]);
  assert.equal(t.agents.rows[0].color, colors.get("supermarket-pos"));
  const w = C.report(r, { range: "7d", budget: 25, colors, live: snap.agents });
  assert.equal(w.period, "Last 7 days · Oct 18 to today");
  assert.deepEqual([w.agents.rows.length, w.agents.more, round(w.agents.moreCost)], [10, 16, round(r.periods["7d"].cost - w.agents.rows.reduce((n, x) => n + x.cost, 0))]);
  assert.deepEqual(w.agents.rows.slice(0, 2).map((x) => [x.name, x.project, x.state, round(x.cost)]), [["checkout requests", "checkout-api", "offline", 12.33], ["product search", "supermarket-pos", "offline", 12.33]], "earlier days' sessions, offline");
  const few = { ...r.periods.today, sessions: r.periods.today.sessions.slice(0, 2), sessionCount: 2, avgCost: null };
  assert.deepEqual(C.topRows(few).map((x) => x.vsAvg), [null, null], "under 3 sessions: no comparison");
  assert.equal(C.report({ ...r, days: r.days.map((d) => ({ ...d, cost: 0, requests: 0 })) }).empty, true);
  assert.equal(C.rangeOf("bogus"), "today");
});

// ---------- the markup ----------
test("view: every panel's loading, error, empty and stale states; colour rules; estimates labelled; real buttons; escaped", async () => {
  const { C, V, O } = await mods(), { cost: r, snap } = demo(), colors = O.projectColors(snap.agents);
  const v = C.report(r, { range: "7d", budget: 25, colors, live: snap.agents });
  const panels = [V.kpiPanel, V.daysPanel, V.projectsPanel, V.modelsPanel, V.cachePanel, V.agentsPanel, V.topPanel];
  for (const p of panels) {
    assert.match(p({ status: "loading" }), /aria-busy="true"[^]*ao-loading/, `${p.name} loading`);
    assert.match(p({ status: "error" }), /role="alert"[^]*Couldn&#39;t load the cost report\. The server didn&#39;t answer\.[^]*data-cr-retry/, `${p.name} error`);
    assert.match(p({ v, status: "stale", asOf: r.t }), /ao-stale-note[^]*As of 15:42[^]*ao-panel-body ao-stale/, `${p.name} stale`);
    noRaw(p({ v, status: "live" }), p.name);
    assert.ok(!/amber|--needs|ao-btn--answer/.test(p({ v, status: "live" }).replace(/ao-pill--needs[^"]*/g, "")), `${p.name}: no amber except a needs-you state pill`);
  }
  const none = { ...r.periods.today, cost: 0, requests: 0, projects: [], models: [], sessions: [], sessionCount: 0, avgCost: null, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const quiet = C.report({ ...r, days: r.days.map((d) => ({ ...d, cost: 0, requests: 0 })), periods: { today: none, "7d": { ...none, days: 7 } } }, { budget: 25 });
  assert.match(V.kpiPanel({ v: quiet }), /No cost data yet\. Cost tracking starts after agent-office install/);
  assert.match(V.daysPanel({ v: quiet }), /No spend in the last 14 days\./);
  for (const p of [V.projectsPanel, V.modelsPanel, V.cachePanel, V.agentsPanel, V.topPanel]) assert.match(p({ v: quiet }), /ao-state--empty[^]*No spend today yet\./, `${p.name} empty`);

  // KPI tiles: budget rings (red only past 100%), the over-budget note in red with an icon, the cache tile an estimate.
  const k = V.kpiPanel({ v, budget: 25 });
  assert.equal((k.match(/ao-ring is-over/g) || []).length, 0, "nothing over its budget here");
  assert.match(k, /cr-kpi-note is-over"><svg[^]*1 day over budget/);
  assert.match(k, /\$84\.10<\/b><span class="ao-ring-sub">48% of \$175 in 7 days/);
  assert.match(k, /21% of \$775 in October[^]*\$25 a day × 31 days/);
  assert.match(k, /Cache saved · 7 days[^]*<span aria-hidden="true">≈<\/span><span class="ao-sr">about <\/span>\$[\d,]+\.\d\d<\/b><span class="ao-ring-sub">estimate · \d+% less than without the cache/);
  assert.ok(!k.includes("Set a daily budget") && V.kpiPanel({ v, budget: 0 }).includes('href="#/settings?section=budgets">Set a daily budget'));

  // The chart: one list item per day with its text, red only on the over-budget bar, the dashed budget line, a summary.
  const d = V.daysPanel({ v });
  assert.equal((d.match(/<li class="cr-bar/g) || []).length, 14);
  assert.equal((d.match(/cr-bar is-over/g) || []).length, 1);
  assert.match(d, /class="cr-bar is-over" style="--h:91\.333%" title="Oct 19: \$27\.40, \$2\.40 over the \$25 budget"><span class="cr-bar-fill"><\/span><span class="cr-bar-tag" aria-hidden="true">\$27\.40 · over<\/span><span class="ao-sr">Oct 19: \$27\.40, \$2\.40 over the \$25 budget<\/span>/);
  assert.match(d, /class="cr-bar is-today"[^]*>so far</);
  assert.match(d, /class="cr-line" style="bottom:83\.333%"><span>budget \$25<\/span>/);
  assert.match(d, /<p class="ao-sr">\$166\.55 in the last 14 days\. /);
  assert.match(d, /aria-label="Spend per day, oldest first"/);

  // Cache: "estimate" twice over, the price table with every family, the token mix with a text alternative.
  const ca = V.cachePanel({ v });
  assert.match(ca, /saved by prompt caching<\/b> <span class="cr-est">estimate<\/span><\/p><p>Without the cache this would have cost <span aria-hidden="true">≈<\/span>/);
  assert.match(ca, /\d+(\.\d)?% of input tokens were cache reads, billed at about a tenth of fresh input\./);
  assert.match(ca, /<caption>List prices behind the estimate, in USD per million tokens<\/caption>/);
  assert.match(ca, /<div class="cr-table-wrap cr-prices-wrap" role="region" aria-label="List prices" tabindex="0"><table class="cr-prices">[^]*<\/table><\/div>/, "a phone scrolls the price table, not the page");
  assert.equal((ca.match(/<tr( class="is-used")?><th scope="row">/g) || []).length, 6);
  assert.match(ca, /<th scope="row">Sonnet<span class="cr-used">used<\/span><\/th><td>\$3<\/td><td>\$0\.30<\/td><td>\$3\.75<\/td>/);
  assert.match(ca, /Haiku 3<\/th><td>\$0\.25<\/td><td>\$0\.025<\/td><td>\$0\.3125<\/td>/);
  assert.match(ca, /class="cr-mix" role="img" aria-label="Token mix: cache reads [\d.]+M, cache writes [\d.]+M, fresh input [\d.]+k, output [\d.]+M"/);
  assert.match(ca, /it's an estimate/);
  assert.deepEqual(["$5", "$0.50", "$0.025", "$18.75"], [5, 0.5, 0.025, 18.75].map(V.price));

  // Agents and the top 5: real buttons that open the agent detail (View trace at its trace); dimmed by the chips.
  const ag = V.agentsPanel({ v, filter: new Set(["working"]) });
  assert.equal((ag.match(/<button type="button" class="cr-agent" data-agent="/g) || []).length, 10);
  assert.match(ag, /aria-label="checkout requests, checkout-api: \$12\.33 in the last 7 days\. Open its details"/);
  assert.match(ag, /\+16 more agents · \$/);
  assert.equal((ag.match(/<li class="is-dim">/g) || []).length, v.agents.rows.filter((x) => x.state !== "working").length);
  const top = V.topPanel({ v });
  assert.equal((top.match(/data-agent-at="trace"/g) || []).length, 5);
  assert.match(top, /<th scope="col">Session<\/th><th scope="col">Model<\/th><th scope="col">Duration<\/th><th scope="col">Tokens<\/th><th scope="col">Cost<\/th><th scope="col">× vs avg<\/th>/);
  assert.match(top, /aria-label="View the trace of checkout requests"/);
  assert.match(top, /<div class="cr-table-wrap" role="region" aria-labelledby="cr-top-title" tabindex="0">/);
  assert.match(V.topPanel({ v: { ...v, avgCost: null } }), /× vs avg shows once 3 or more sessions/);

  // Header: Updated, Export CSV (off with nothing to export), the toast with the file name.
  assert.match(V.updated("live", r.t), /Updated 15:42/);
  assert.match(V.updated("stale", r.t), /As of 15:42/);
  assert.match(V.exportButton({ ready: true, range: "7d" }), /data-cr-export data-key="cr-export" aria-describedby="cr-export-what" title="One row per API request in the last 7 days\."/);
  assert.match(V.exportButton({ ready: false }), / disabled /);
  assert.match(V.exportToast({ ok: true, name: "virtual-office-requests-2026-10-24.csv", rows: 12, range: "today" }), /Exported 12 requests today<\/p><p class="ao-toast-text" title="virtual-office-requests-2026-10-24\.csv">virtual-office-requests-2026-10-24\.csv</);
  assert.match(V.exportToast({ ok: true, name: "f.csv", rows: 1, partial: true }), /Exported 1 request today[^]*f\.csv · the oldest weren&#39;t kept/);
  assert.match(V.exportToast({ ok: false, error: "Server error." }), /Couldn&#39;t export the CSV[^]*Server error\./);

  // Escaped.
  const evil = "<img src=x onerror=alert(1)>";
  const bad = { ...r, periods: { ...r.periods, "7d": { ...r.periods["7d"], projects: [{ project: evil, cost: 1 }], models: [{ model: evil, cost: 1, requests: 1, tokens: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0 } }],
    sessions: r.periods["7d"].sessions.map((x) => ({ ...x, name: evil, label: evil, project: evil, host: evil, model: evil })) } } };
  const bv = C.report(bad, { range: "7d", budget: 25 });
  assert.ok(!panels.map((p) => p({ v: bv })).join("").includes("<img"));
});

// ---------- the report in the shell ----------
function fakeWindow(hash = "") {
  const listeners = {}, blobs = [], urls = [];
  return {
    location: { hash, href: "/" }, blobs, urls,
    addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    go(h) { this.location.hash = h; for (const fn of listeners.hashchange || []) fn(); },
    focus() {},
    Blob: class { constructor(parts, o) { this.text = parts.join(""); this.type = o.type; blobs.push(this); } },
    URL: { createObjectURL: (b) => { urls.push(b); return `blob:cost-${urls.length}`; }, revokeObjectURL() {} },
  };
}
/** A table's body rows (the fake DOM has no descendant selectors). */
const rows = (el) => el.querySelectorAll("tr").filter((r) => r.parentNode.localName === "tbody");
function server(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = routes[url.split("?")[0]];
    const out = typeof r === "function" ? r(url, opts) : r;
    if (out === undefined) return { status: 500, ok: false, json: async () => ({ error: "Server error." }) };
    if (out && out.status) return { status: out.status, ok: false, json: async () => ({ error: out.error }) };
    if (out && out.csv) return { status: 200, ok: true, text: async () => out.csv, headers: { get: (k) => out.headers[k] ?? null } };
    return { status: 200, ok: true, json: async () => json(out) };
  };
  const sources = [];
  class ES { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } }
  return { fetch, EventSource: ES, calls, sources };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settings = { offlineAfterMin: 30, dailyBudgetUsd: 25, notifyOnWaiting: false, aliases: {}, demo: true, teamMode: false, viewer: "mk" };

async function costShell(routes = () => ({}), hash = "#/cost") {
  const dom = withDom(), D = demo(), win = fakeWindow(hash);
  const details = Object.fromEntries([...D.store.sessions.keys()].map((id) => [`/api/agents/${id}`, D.detail(id)]));
  const srv = server({ "/api/state": { ...D.snap, settings }, "/api/timeline": D.timeline, "/api/cost": D.cost, ...details, ...routes(D) });
  const { createShell } = await pub("shell.js");
  const shell = createShell({ doc: dom.document, win, fetch: srv.fetch, EventSource: srv.EventSource });
  const body = dom.document.body, page = body.querySelector('[data-screen="cost"]');
  const q = (s) => page.querySelector(s), all = (s) => page.querySelectorAll(s), slot = (k) => q(`[data-cr="${k}"]`);
  await shell.ready;
  await tick(); await tick();
  return { dom, D, win, srv, shell, body, page, q, all, slot, active: () => dom.document.activeElement };
}

test("cost DOM: at #/cost every panel fills from GET /api/cost; the period switch is saved; agents open their detail and View trace its trace; chips dim", async () => {
  let t = null;
  try {
    t = await costShell();
    const { q, all, slot, srv, body, page, win, active } = t;
    assert.equal(page.hidden, false);
    assert.ok(!page.querySelector(".cc-cbars") && !srv.calls.some((c) => c.url.startsWith("/api/report")), "the interim screen is gone");
    assert.ok(srv.calls.some((c) => c.url === "/api/cost" && c.opts.headers["X-Requested-With"] === "agent-office"));
    assert.equal(slot("updated").textContent, "Updated 15:42");
    assert.equal(all(".cr-kpi").length, 4);
    assert.equal(all(".cr-bar").length, 14);
    assert.equal(all(".cr-bar.is-over").length, 1);
    assert.equal(slot("projects").querySelectorAll(".cr-row").length, 3);
    assert.equal(rows(slot("top")).length, 5);
    assert.match(slot("top").querySelector(".ao-panel-head").textContent, /Top 5 costliest sessions\s*Today/);
    assert.ok(slot("cache").textContent.includes("estimate") && slot("cache").querySelector(".cr-prices"));

    // Today / 7 days: the breakdowns follow, and the choice is saved for next time.
    const stored = new Map();
    win.localStorage = { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v) };
    q('[data-value="7d"]').click();
    assert.equal(stored.get("ao-cost-range"), "7d");
    assert.match(slot("projects").textContent, /Last 7 days · Oct 18 to today/);
    assert.equal(slot("agents").querySelectorAll(".cr-agent").length, 10);
    assert.match(slot("agents").textContent, /\+16 more agents/);

    // An agent opens its detail ("Back to cost report"), even one from an earlier day; closing puts focus back.
    const btn = slot("agents").querySelector(".cr-agent"), id = btn.getAttribute("data-agent");
    assert.ok(id.startsWith("demo-hist-"));
    btn.focus();
    btn.click();
    const sheet = body.querySelector('[data-dialog="agent"]');
    assert.equal(sheet.open, true);
    assert.ok(sheet.querySelector(".ad-back").textContent.includes("Back to cost report"));
    await tick(); await tick();
    sheet.querySelector("[data-close]").click();
    assert.equal(active().getAttribute("data-key"), `cr-agent:${id}`);
    // View trace: the detail at its trace.
    q("[data-agent-at=\"trace\"]").click();
    assert.equal(active().id, "ad-trace-h");
    sheet.querySelector("[data-close]").click();

    // The top bar's chips dim agents in other states here too.
    q('[data-value="today"]').click();
    const chip = body.querySelector('[data-chip="needs"]');
    chip.click();
    const lit = rows(slot("top")).filter((r) => !r.classList.contains("is-dim"));
    assert.deepEqual(lit.map((r) => r.querySelector("[data-agent]").getAttribute("data-agent")), ["demo-refund"]);
    chip.click();
    assert.equal(all(".is-dim").length, 0);
    assert.match(body.querySelector(".cc-chips").getAttribute("aria-label"), /and in the cost report\.$/);
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});

test("cost DOM: Export CSV downloads the period's requests and says which file in a toast; a failure says so", async () => {
  let t = null, fail = false;
  const name = "virtual-office-requests-2026-10-18-to-2026-10-24.csv";
  try {
    t = await costShell(() => ({ "/api/cost/export": (url) => (fail ? { status: 500, error: "Server error." }
      : { csv: "﻿Time (UTC)\r\nrow\r\n", headers: { "Content-Disposition": `attachment; filename="${name}"`, "X-Rows": url.includes("range=7d") ? "826" : "61" } }) }));
    const { q, slot, srv, win, body } = t;
    q('[data-value="7d"]').click();
    const exp = q("[data-cr-export]");
    assert.equal(exp.hasAttribute("disabled"), false);
    assert.equal(q("#cr-export-what").textContent, "One row per API request in the last 7 days.");
    let added = null;
    const append = body.append.bind(body);
    body.append = (...n) => { added = n[0]; return append(...n); };
    exp.click();
    await tick(); await tick();
    const call = srv.calls.find((c) => c.url.startsWith("/api/cost/export"));
    assert.equal(call.url, "/api/cost/export?range=7d");
    assert.equal(call.opts.headers["X-Requested-With"], "agent-office");
    assert.deepEqual([win.blobs.length, win.blobs[0].text, win.blobs[0].type], [1, "﻿Time (UTC)\r\nrow\r\n", "text/csv;charset=utf-8"]);
    assert.deepEqual([added.localName, added.getAttribute("download"), added.getAttribute("href"), added.parentNode], ["a", name, "blob:cost-1", null], "a download link, clicked and removed");
    assert.equal(slot("toasts").getAttribute("role"), "status");
    assert.equal(slot("toasts").querySelector(".ao-toast-title").textContent, "Exported 826 requests in the last 7 days");
    assert.equal(slot("toasts").querySelector(".ao-toast-text").textContent, name);
    assert.equal(q("[data-cr-export]").textContent, "Export CSV");
    fail = true;
    q("[data-cr-export]").click();
    await tick(); await tick();
    assert.equal(slot("toasts").querySelector(".ao-toast-title").textContent, "Couldn't export the CSV");
    assert.equal(win.blobs.length, 1, "nothing saved");
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});

test("cost DOM: a failed load says so with Retry and recovers; a later failure keeps the report dimmed with As of; the stream dropping too", async () => {
  let t = null, up = false;
  try {
    t = await costShell((D) => ({ "/api/cost": () => (up ? D.cost : undefined) }));
    const { slot, all, q, srv, D } = t;
    assert.equal(all('[role="alert"]').length, 7, "every panel says what failed");
    assert.match(slot("kpis").textContent, /Couldn't load the cost report\. The server didn't answer\./);
    assert.equal(slot("updated").textContent, "Not loaded");
    up = true;
    q("[data-cr-retry]").click();
    await tick(); await tick();
    assert.equal(all('[role="alert"]').length, 0);
    assert.equal(all(".cr-kpi").length, 4);
    // New spend arrives but the report can't be fetched: the last one stays, dimmed, "As of" its time.
    // (Each step moves the clock past the 3-second refetch limit.)
    up = false;
    const realNow = Date.now, later = (s, snap) => { Date.now = () => realNow() + s * 1000; srv.sources[0].onmessage({ data: JSON.stringify(snap) }); };
    const p = D.snap.totals.periods, more = { ...D.snap, totals: { ...D.snap.totals, periods: { ...p, "30d": { ...p["30d"], requests: p["30d"].requests + 1 } } } };
    try {
      later(5, more);
      await tick(); await tick();
      assert.match(slot("updated").textContent, /^As of 15:42$/);
      assert.ok(slot("days").querySelector(".ao-panel-body.ao-stale") && slot("kpis").querySelector(".ao-stale-note"));
      // Back again, then the live stream drops: dimmed too.
      up = true;
      later(10, D.snap);
      await tick(); await tick();
    } finally { Date.now = realNow; }
    assert.equal(slot("updated").textContent, "Updated 15:42");
    srv.sources[0].onerror();
    assert.ok(slot("top").querySelector(".ao-panel-body.ao-stale"));
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});
