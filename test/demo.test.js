"use strict";
// The demo scenario matches docs/redesign/reference/command-center.png and stays coherent while it ticks.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { pathToFileURL } = require("url");
const { Store, localDate } = require("../src/store");
const { startDemo, loadScenario } = require("../src/demo");

const mk = () => new Store({ getConfig: () => ({ offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 25 }) });
const at1542 = () => { const d = new Date(); d.setHours(15, 42, 0, 0); return d.getTime(); };
/** Waits for the demo's stand-in hook (it picks answers up after 400 ms), at most 5 s. */
async function until(done) {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
}

test("demo: 3 projects, 8 agents, 2 need you, 1 offline machine, plans 26 of 50", async () => {
  const now = at1542(), store = mk();
  loadScenario(store, now);
  const snap = store.snapshot(now), agents = snap.agents;
  assert.equal(agents.length, 8);
  assert.deepEqual([...new Set(agents.map((a) => a.project))].sort(), ["checkout-api", "docs-site", "supermarket-pos"]);
  const by = (label) => agents.find((a) => a.label === label);
  const t = snap.totals;
  assert.deepEqual([t.working, t.waiting, t.idle, t.offline], [4, 2, 1, 1]);
  assert.deepEqual([t.tasksDone, t.tasksInProgress, t.tasksPending], [26, 7, 17]);
  assert.equal(Math.round(t.todayCost * 100), 1372);
  assert.equal(Math.round(t.waitedMs / 60000), 52);
  assert.deepEqual(t.projects.map((r) => `${r.project} ${r.done}/${r.done + r.inProgress + r.pending}`), ["supermarket-pos 14/25", "checkout-api 9/20", "docs-site 3/5"], "Today's progress rows");
  assert.equal(Math.round(t.periods.today.cost * 100), 1372);
  const { tokensLine } = await import(pathToFileURL(path.join(__dirname, "..", "public", "ui", "format.js")).href);
  assert.equal(tokensLine(t.todayTokensByType), "in 48.2k · out 1.21M · cache 92.4M");

  const refund = by("refund flow"), receipt = by("receipt printer");
  assert.equal(refund.state, "waiting"); assert.equal(Math.floor((now - Date.parse(refund.waitingSince)) / 60000), 9);
  assert.equal(refund.question.target, "/Users/mk/code/checkout-api/.env.production");
  assert.deepEqual([refund.plan.now.step, refund.plan.now.of, refund.plan.now.text], [4, 9, "Add the refund webhook secret"]);
  assert.equal(receipt.state, "waiting"); assert.equal(Math.floor((now - Date.parse(receipt.waitingSince)) / 60000), 4);
  assert.equal(receipt.question.target, "sudo apt install cups-filters"); assert.equal(receipt.host, "studio-mac");
  assert.deepEqual([receipt.plan.now.step, receipt.plan.now.of], [3, 6]);
  assert.equal(by("login fix").state, "idle");
  assert.equal(by("webhook retries").state, "offline"); assert.equal(by("webhook retries").host, "build-server");
  assert.deepEqual(agents.filter((a) => a.state !== "offline").every((a) => a.host !== "build-server"), true, "the offline agent is alone on its machine");
  const sub = by("basket bill").subagents;
  assert.deepEqual([sub.running, sub.finished, sub.list.map((x) => [x.description, x.status])],
    [1, 1, [["Write bill tests", "running"], ["Explore loyalty rules", "finished"]]], "interns get the reference image tags");
  assert.equal(by("basket bill").name, "supermarket-pos · basket bill");
  assert.deepEqual(Object.fromEntries(["supermarket-pos", "checkout-api", "docs-site"].map((p) => {
    const list = agents.filter((a) => a.project === p);
    return [p, `${list.reduce((n, a) => n + a.plan.doneToday, 0)}/${list.reduce((n, a) => n + a.plan.doneToday + a.plan.inProgress + a.plan.pending, 0)}`];
  })), { "supermarket-pos": "14/25", "checkout-api": "9/20", "docs-site": "3/5" });

  const failed = (today) => [...store.sessions.values()].filter((s) => s.session.startsWith("demo-hist") !== today).flatMap((s) => s.trace.filter((x) => x.status === "error"));
  assert.equal(failed(true).length, 1); assert.equal(failed(true)[0].target, "npm test -- basket");
  assert.deepEqual(failed(false).map((x) => x.target), Array(3).fill("npm test -- captures"), "two days ago, three in a row: the Alerts Center's Errors alert");
  const basket = store.detail("demo-basket", now);
  assert.equal(basket.conversation[0].openedFile, "Basket.tsx");
  assert.equal(basket.files.find((f) => f.createdBy === "agent-tests-1").rel, "src/basket/__tests__/BasketTotals.test.tsx");
  assert.equal(basket.trace.at(-1).status, "running", "Editing BasketTotals.tsx right now");
  assert.ok(![...store.sessions.values()].some((s) => Date.parse(s.updated) > now), "nothing in the future");
});

test("demo: 14 days of cost history with one day over budget, and a timeline from about 08:00", () => {
  const now = at1542(), store = mk();
  loadScenario(store, now);
  const days = store.report(14, now);
  assert.equal(days.filter((d) => d.cost > 0).length, 14);
  assert.equal(days.filter((d) => d.cost > 25).length, 1);
  assert.equal(Math.round(days.slice(-7).reduce((n, d) => n + d.cost, 0) * 100), 8410);
  const tl = store.timeline(localDate(now), now);
  assert.equal(tl.sessions.length, 8);
  const first = Math.min(...tl.sessions.map((s) => Date.parse(s.segments[0].from)));
  assert.equal(new Date(first).getHours(), 8);
  assert.ok(tl.buckets.some((b) => b.waiting > 0) && tl.buckets.some((b) => b.idle > 0));
  const webhook = tl.sessions.find((s) => s.session === "demo-webhook").segments.at(-1);
  assert.equal(webhook.state, "offline"); assert.equal(new Date(webhook.lastContact).getHours(), 12);
});

test("demo: the work board's items add up to the snapshot's totals, and its spend per project to today's spend", () => {
  const now = at1542(), store = mk();
  loadScenario(store, now);
  const b = store.board(now), t = store.snapshot(now).totals, open = b.plans.flatMap((p) => p.open);
  assert.deepEqual([b.plans.reduce((n, p) => n + p.done.length, 0), open.filter((x) => x.status === "in_progress").length, open.filter((x) => x.status === "pending").length],
    [t.tasksDone, t.tasksInProgress, t.tasksPending]);
  assert.equal(b.plans.length, 8, "every agent has a plan");
  assert.deepEqual(Object.fromEntries(Object.entries(t.todayByProject).map(([k, v]) => [k, Math.round(v * 100)])), { "supermarket-pos": 852, "checkout-api": 429, "docs-site": 91 });
  assert.equal(Math.round(Object.values(t.todayByProject).reduce((n, v) => n + v, 0) * 100), 1372);
});

test("demo: started early in the morning, the whole day stays in today and the waits keep their length", () => {
  for (const [h, m] of [[3, 0], [7, 0], [1, 35]]) {
    const d = new Date(); d.setHours(h, m, 0, 0);
    const now = d.getTime(), store = mk();
    loadScenario(store, now);
    const sessions = [...store.sessions.values()].filter((s) => !s.session.startsWith("demo-hist"));
    assert.ok(sessions.every((s) => localDate(s.started) === localDate(now)), `${h}:${m} starts today`);
    const snap = store.snapshot(now), t = snap.totals;
    assert.deepEqual([snap.agents.length, t.working, t.waiting, t.idle, t.offline, t.tasksDone], [8, 4, 2, 1, 1, 26], `${h}:00`);
    const waits = snap.agents.filter((a) => a.state === "waiting").map((a) => Math.floor((now - Date.parse(a.waitingSince)) / 60000)).sort();
    assert.deepEqual(waits, [4, 9]);
    assert.equal(store.report(14, now).filter((x) => x.cost > 0).length, 14);
  }
});

// Before 01:30 the scenario isn't squeezed into the few minutes since midnight: times stay relative to now and the
// start of the day falls in yesterday evening. Today's totals (cost, tasks done, waited time) are then only the part
// after midnight. That's an accepted trade-off, so only the things that hold at any time are asserted here.
test("demo: just after midnight the story still holds; the start of the day falls in yesterday, never the future", () => {
  for (const [h, m] of [[0, 0], [0, 5], [0, 30], [1, 0]]) {
    const d = new Date(); d.setHours(h, m, 0, 0);
    const now = d.getTime(), store = mk();
    loadScenario(store, now);
    const snap = store.snapshot(now), t = snap.totals, label = `${h}:${m}`;
    assert.deepEqual([snap.agents.length, t.working, t.waiting, t.idle, t.offline], [8, 4, 2, 1, 1], label);
    const waits = snap.agents.filter((a) => a.state === "waiting").map((a) => Math.floor((now - Date.parse(a.waitingSince)) / 60000)).sort();
    assert.deepEqual(waits, [4, 9], label);
    const webhook = snap.agents.find((a) => a.label === "webhook retries");
    assert.ok(now - Date.parse(webhook.updated) > 30 * 60000, `${label}: the offline machine has been silent for over 30 min`);
    for (const s of store.sessions.values()) {
      assert.ok(Date.parse(s.updated) <= now, `${label}: ${s.session} has no future events`);
      for (const x of s.trace) assert.ok(Date.parse(x.t) <= now && (!x.end || Date.parse(x.end) <= now), `${label}: ${s.session} step ${x.id}`);
    }
  }
});

test("demo: the scenario is the same every run", () => {
  const now = at1542(), a = mk(), b = mk();
  loadScenario(a, now); loadScenario(b, now);
  // Ask ids are random on purpose: they're what a hook long-polls.
  const same = (s) => JSON.parse(JSON.stringify(s.snapshot(now), (k, v) => (k === "ask" && v ? { ...v, id: "<random>" } : v)));
  assert.deepEqual(same(a), same(b));
});

test("demo: receipt printer can be answered here for 6 more minutes; refund flow's window passed, so it's the terminal", () => {
  const now = at1542(), store = mk();
  loadScenario(store, now);
  const by = (label) => store.snapshot(now).agents.find((a) => a.label === label);
  const receipt = by("receipt printer").question, refund = by("refund flow").question;
  assert.match(receipt.ask.id, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(Math.round((Date.parse(receipt.ask.until) - now) / 60000), 6);
  assert.deepEqual([refund.ask, refund.windowClosed], [null, true]);
  const asked = new Date(by("receipt printer").taskAt);
  assert.deepEqual([asked.getHours(), asked.getMinutes()], [12, 50], "the time of its last prompt");
});

test("demo: an answer from the dashboard reaches the stand-in hook; approved, the call runs and the agent works again", async () => {
  const store = mk(), stop = startDemo(store, 60000);
  try {
    const receipt = () => store.snapshot().agents.find((a) => a.label === "receipt printer");
    const r = store.answerAsk(receipt().question.ask.id, { kind: "approve" });
    assert.equal(r.questionId, receipt().question.id);
    assert.equal(receipt().state, "waiting", "it takes effect when the hook picks it up");
    await until(() => receipt().answer);
    const a = receipt();
    assert.equal(a.state, "working", "out of the queue");
    assert.ok(a.answer.delivered, "delivered to studio-mac");
    assert.equal(a.recent.findLast((x) => x.kind === "tool" && x.tool === "Bash").status, "ok", "the command ran");
    assert.equal(a.recent.find((x) => x.kind === "answer").choice, "approve", "the feed logs it");
  } finally { stop(); }
});

test("demo: denied from the dashboard, the call never runs and the agent carries on", async () => {
  const store = mk(), stop = startDemo(store, 60000);
  try {
    const receipt = () => store.snapshot().agents.find((a) => a.label === "receipt printer");
    store.answerAsk(receipt().question.ask.id, { kind: "reply", text: "Use the package without sudo" });
    await until(() => receipt().answer);
    const a = receipt(), step = a.recent.findLast((x) => x.kind === "tool" && x.tool === "Bash");
    assert.deepEqual([a.state, a.answer.choice, a.answer.text, !!a.answer.delivered, step.status], ["working", "reply", "Use the package without sudo", true, "denied"]);
  } finally { stop(); }
});

test("demo: live ticks move working agents forward without flipping states at random", async () => {
  const store = mk();
  const stop = startDemo(store, 5);
  const before = store.snapshot();
  await new Promise((r) => setTimeout(r, 200));
  stop();
  const after = store.snapshot();
  const steps = (s) => s.agents.reduce((n, a) => n + a.toolCount, 0);
  assert.ok(steps(after) > steps(before), "agents keep working");
  const state = (s, label) => s.agents.find((a) => a.label === label).state;
  for (const label of ["refund flow", "receipt printer"]) assert.equal(state(after, label), "waiting", label);
  assert.equal(state(after, "webhook retries"), "offline");
  assert.ok(after.totals.todayCost > before.totals.todayCost);
});

test("demo: rate limiter keeps asking for permission now and then, so the Command Center shows a toast", async () => {
  const store = mk(), seen = [];
  const stop = startDemo(store, 1);
  try {
    const state = () => store.snapshot().agents.find((a) => a.label === "rate limiter").state;
    for (let i = 0; i < 3000 && seen.filter((x) => x === "waiting").length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (state() !== seen.at(-1)) seen.push(state());
    }
  } finally { stop(); }
  const first = seen.indexOf("waiting"), second = seen.indexOf("waiting", first + 1);
  assert.ok(first > 0 && second > first + 1, `asks, gets its answer, and asks again later: ${seen.join(" → ")}`);
});

test("demo: messages from the dashboard: inventory sync got one at its 12:10 stop and carried on; basket bill's waits for its next stop", () => {
  const now = at1542(), store = mk();
  loadScenario(store, now);
  const msgs = (id) => store.detail(id, now).conversation.filter((x) => x.kind === "message" && !x.room);
  const inv = msgs("demo-inventory"), basket = msgs("demo-basket");
  assert.deepEqual(inv.map((m) => [m.status, new Date(m.deliveredAt).getHours(), new Date(m.deliveredAt).getMinutes()]), [["delivered", 12, 10]]);
  const trace = store.detail("demo-inventory", now).trace, i = trace.findIndex((x) => x.kind === "inbox");
  assert.deepEqual(trace.slice(i - 1, i + 3).map((x) => x.kind === "tool" ? x.tool : x.kind), ["stop", "inbox", "Edit", "stop"], "the turn ends, it gets your message, works on it, stops again");
  assert.deepEqual(basket.map((m) => m.status), ["queued"]);
  assert.equal(store.snapshot(now).agents.find((a) => a.label === "basket bill").queued, 2, "its own message and the room's");
});

test("demo: two room messages still waiting at 15:42, one that couldn't reach the offline machine, and two shared files", () => {
  const now = at1542(), store = mk();
  loadScenario(store, now);
  const r = store.rooms(now), name = (id) => store.snapshot(now).agents.find((a) => a.session === id).label;
  assert.deepEqual(r.messages.map((m) => [m.project, new Date(m.t).getHours(), new Date(m.t).getMinutes(), m.to.map((x) => name(x.session)).sort(), m.to.every((x) => x.status === "queued"), m.skipped]), [
    ["supermarket-pos", 15, 30, ["basket bill", "inventory sync", "login fix", "receipt printer"], true, []],
    ["checkout-api", 15, 36, ["rate limiter", "refund flow"], true, [{ session: "demo-webhook", why: "offline" }]]]);
  assert.deepEqual(r.files.map((f) => [f.project, f.path, f.by.map((b) => name(b.session)).sort()]), [
    ["supermarket-pos", "src/money/round.ts", ["basket bill", "inventory sync", "receipt printer"]], ["checkout-api", "src/webhooks/retry.ts", ["refund flow", "webhook retries"]]]);
  assert.equal(r.plans.length, 8, "the work board's plan items too");
});

test("demo scenes: quiet is one working agent, busy is 24 agents in 9 projects, empty is a fresh install", () => {
  const now = at1542();
  const snap = (scene) => { const s = mk(); loadScenario(s, now, { scene }); return { store: s, snap: s.snapshot(now) }; };
  const quiet = snap("quiet").snap;
  assert.deepEqual(quiet.agents.map((a) => [a.label, a.state]), [["tokens page", "working"]]);
  const busy = snap("busy").snap, t = busy.totals;
  assert.equal(busy.agents.length, 24);
  assert.equal(new Set(busy.agents.map((a) => a.project)).size, 9);
  assert.deepEqual([t.working, t.waiting, t.idle, t.offline], [12, 6, 3, 3]);
  const empty = snap("empty");
  assert.deepEqual([empty.snap.agents.length, empty.store.report(14, now).filter((d) => d.cost > 0).length], [0, 0]);
  assert.equal(snap("nope").snap.agents.length, 8, "an unknown scene is the normal day");
});
