"use strict";
// The Meeting Hall (public/hall*.js): the standup built from the real demo day, delivery lines per agent state, the
// decisions, overlaps and scorecard, the replay, the colour and text rules, and the hall in the shell on a fake DOM.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { pathToFileURL } = require("url");
const { Store, localDate } = require("../src/store");
const { loadScenario } = require("../src/demo");
const { withDom } = require("./helpers/dom");

const pub = (f) => import(pathToFileURL(path.join(__dirname, "..", "public", f)).href);
const M = 60000;
const at1542 = () => { const d = new Date(); d.setHours(15, 42, 0, 0); return d.getTime(); };
const json = (x) => JSON.parse(JSON.stringify(x));
/** The demo day at 15:42 today as the browser gets it: the snapshot, GET /api/rooms, the board, today's timeline and an
 *  agent's detail, through JSON. Pinned to 15:42 so the whole day is today whenever the tests run (the hall draws with
 *  the real clock, and only asks "same day?"). Built once (the tests only read it), so this file doesn't crowd the
 *  hook's timing tests. */
let day = null;
function demo() {
  if (day) return day;
  const now = at1542(), store = new Store({ getConfig: () => ({ offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 25 }) });
  loadScenario(store, now);
  return (day = { now, snap: json(store.snapshot(now)), rooms: json(store.rooms(now)), board: json(store.board(now)), timeline: json(store.timeline(localDate(now), now)),
    detail: (id) => json(store.detail(id, now)) });
}
async function mods() {
  const [H, V, O] = await Promise.all([pub("hall-model.js"), pub("hall-view.js"), pub("office3d-model.js")]);
  return { H, V, O };
}
// Never in the UI: raw hook or tool names, IDE and system tags, absolute paths, broken values.
const RAW = ["PreToolUse", "PostToolUse", "PermissionRequest", "UserPromptSubmit", "SubagentStart", "SubagentStop", "TodoWrite", "TaskCreate", "<ide_", "<system-reminder",
  "/Users/", "/srv/", "undefined", "NaN", "[object"];
const noRaw = (html, what) => { for (const r of RAW) assert.ok(!html.includes(r), `${what}: no ${r}`); };

// ---------- the standup ----------
test("standup: the host opens with the room's numbers, a bubble per agent from its plan and activity, and closes with decisions and shared files", async () => {
  const { H, O } = await mods();
  const { snap, rooms, now } = demo(), colors = O.projectColors(snap.agents);
  const v = H.hall(snap, rooms, { room: "checkout-api", now, colors });
  assert.equal(v.bubbles[0].text, "Standup for checkout-api · 3 agents. 9 of 20 planned tasks are done, $4.29 spent, and agents have waited on you 21m today.");
  assert.deepEqual(v.bubbles.slice(1, -1).map((b) => [b.name, b.state, b.facts, b.blocked]), [
    ["refund flow", "needs", "3 of 9 tasks · $2.05", true], ["rate limiter", "working", "4 of 6 tasks · $1.38", false], ["webhook retries", "offline", "2 of 5 tasks · $0.86", false]],
  "who needs you first, then working, then offline");
  const [, refund, rate, hook] = v.bubbles, rows = (b) => Object.fromEntries(b.rows.map((r) => [r.k, r]));
  assert.deepEqual(refund.rows.map((r) => r.k), ["done", "now", "blocked", "next"]);
  assert.deepEqual([rows(refund).done.items, rows(refund).done.more], [["Add refund webhook events", "Send partial refunds to the original card"], 1], "the last 2 done today, +N more");
  assert.deepEqual([rows(refund).now.text, rows(refund).next.text], ["Add the refund webhook secret", "Sign webhook payloads"]);
  assert.deepEqual([rows(refund).blocked.text, rows(refund).blocked.code, rows(refund).blocked.tone, Math.round(rows(refund).blocked.wait / M)],
    ["Wants permission to edit a file", ".env.production", "needs", 9], "the question, its target relative to the root, the wait");
  assert.deepEqual(rate.rows.map((r) => r.k), ["done", "now", "next"]);
  assert.equal(rows(hook).offline.text, "build-server went offline · last seen 12:05");
  assert.equal(v.bubbles.at(-1).text, "One decision is waiting on you: refund flow wants permission to edit a file (.env.production), waiting 9m. " +
    "src/webhooks/retry.ts was edited today by refund flow and webhook retries.");
  assert.equal(v.project, "checkout-api", "what a room message goes to");

  // supermarket-pos: an idle agent says what it said last; a sub-agent team.
  const sp = H.hall(snap, rooms, { room: "supermarket-pos", now, colors }), by = (n) => sp.bubbles.find((b) => b.name === n);
  const login = rows(by("login fix"));
  assert.equal(login.idle.text, "Finished its turn at 15:25, idle until it gets a new prompt");
  assert.match(login.idle.said, /^Overnight shifts now keep one session across midnight\. .*Tell me and I'll finish\.$/);
  assert.equal(rows(by("basket bill")).team.text, "1 sub-agent running: Write bill tests · 1 finished");
  assert.match(sp.bubbles.at(-1).text, /src\/money\/round\.ts was edited today by basket bill, inventory sync, and receipt printer\.$/);

  // All rooms: every agent, the project on each bubble, every room's numbers.
  const all = H.hall(snap, rooms, { room: H.ALL, now, colors });
  assert.equal(all.bubbles[0].text, "Standup for all rooms · 8 agents in 3 rooms. 26 of 50 planned tasks are done, $13.72 spent, and agents have waited on you 52m today.");
  assert.deepEqual([...new Set(all.bubbles.slice(1, -1).map((b) => b.project))], ["supermarket-pos", "checkout-api", "docs-site"], "room by room, in the office's order");
  assert.ok(all.bubbles.slice(1, -1).every((b) => b.showProject));
  assert.match(all.bubbles.at(-1).text, /^2 decisions are waiting on you: refund flow .*waiting 9m; and receipt printer wants permission to run a command \(sudo apt install cups-filters\), waiting 4m\. 2 files were edited by more than one agent today: /);
  assert.equal(all.project, null, "All rooms can't be messaged as one room");

  // Copy summary: the whole standup as text.
  assert.ok(v.text.startsWith(`${v.bubbles[0].text}\n\nrefund flow · Needs you · 3 of 9 tasks · $2.05\n  Done: Add refund webhook events; Send partial refunds to the original card (+1 more)\n  Now: Add the refund webhook secret\n  Blocked: Wants permission to edit a file: .env.production (waiting 9m)\n  Next: Sign webhook payloads\n\n`));
  assert.ok(v.text.endsWith(v.bubbles.at(-1).text));

  // Tabs: All rooms, then each project with its colour and head count.
  assert.deepEqual(H.roomTabs(snap.agents, { now, colors }).map((t) => [t.value, t.label, t.count, t.dot]),
    [["", "All rooms", 8, undefined], ["supermarket-pos", "supermarket-pos", 4, colors.get("supermarket-pos")], ["checkout-api", "checkout-api", 3, colors.get("checkout-api")], ["docs-site", "docs-site", 1, colors.get("docs-site")]]);
});

test("standup: plans, paths and edge cases: no plan, nothing done today, a working agent's current action, a failed turn, no telemetry", async () => {
  const { H } = await mods();
  const now = at1542(), iso = (min) => new Date(now - min * M).toISOString();
  const base = { project: "shop", root: "/p/shop", gitRoot: "/p/shop", host: "box", started: iso(60), updated: iso(1), today: { waitedMs: 0 }, plan: {}, subagents: {}, requests: 0, cost: 0, queued: 0 };
  const agent = (session, label, state, extra = {}) => ({ ...base, session, label, name: `shop · ${label}`, state, ...extra });
  const snap = { agents: [
    agent("w", "till", "working", { recent: [{ kind: "tool", tool: "Edit", status: "running", target: "/p/shop/src/Till.tsx", detail: { path: "/p/shop/src/Till.tsx" }, t: iso(1) }] }),
    agent("i", "api", "idle", { recent: [{ kind: "stop", status: "error", failure: "rate_limit", t: iso(2) }] }),
    agent("e", "old", "offline", { ended: true, updated: iso(20) })],
  totals: { tasksDone: 0, tasksInProgress: 0, tasksPending: 0, projects: [], todayByProject: {}, periods: { today: { days: 1, cost: 0, requests: 0, tokensByType: {} } } } };
  const rooms = { plans: [{ session: "w", of: 2, open: [{ text: "Fix /p/shop/src/Till.tsx", status: "pending", step: 2 }], done: [] }], files: [], messages: [] };
  const v = H.hall(snap, rooms, { room: "shop", now }), by = (s) => v.bubbles.find((b) => b.session === s);
  assert.equal(v.bubbles[0].text, "Standup for shop · 3 agents. No to-do list yet today and nobody has waited on you today.", "no plan and no telemetry: said, never $0.00");
  assert.deepEqual(by("w").rows.map((r) => [r.label, r.text, r.mono || null]), [["Now", "Editing ", "Till.tsx"], ["Next", "Fix src/Till.tsx", null]], "what it does now, paths relative to the root");
  assert.deepEqual([by("w").facts, by("i").facts], ["0 of 1 task · No cost data", "No plan · No cost data"]);
  assert.deepEqual(by("i").rows.map((r) => [r.k, r.tone, r.text]), [["idle", "error", `Stopped: hit the rate limit at ${new Date(Date.parse(iso(2))).toTimeString().slice(0, 5)}`]], "a turn that ended on an API error: red");
  assert.match(by("e").rows[0].text, /^The session ended at \d\d:\d\d$/);
  assert.equal(v.bubbles.at(-1).text, "Nothing is waiting on you. No two agents edited the same file today.");
  assert.deepEqual(v.score.map((k) => [k.label, k.value]), [["Tasks done", "0"], ["Spend", "No data"], ["Waited on you", "0m"], ["Blocked now", "0"]], "an ended session isn't blocked");
  // Not loaded yet: the parts that need GET /api/rooms are null; an empty room is empty.
  assert.deepEqual([H.hall(snap, null, { room: "shop", now }).bubbles, H.hall(snap, null, { room: "shop", now }).seats.length], [null, 3]);
  assert.equal(H.hall({ agents: [], totals: {} }, rooms, { now }).empty, true);
  // Agents with no project folder share the "Other" room, which can't be messaged as one.
  assert.equal(H.hall({ ...snap, agents: [{ ...agent("n", "x", "working"), project: null, name: "session n" }] }, rooms, { room: "Other", now }).project, null);
});

// ---------- messages to the room ----------
test("delivery lines: by each agent's state now, delivered, not delivered, couldn't reach; and who a message reaches before you send", async () => {
  const { H } = await mods();
  const { snap, rooms, now } = demo();
  const lines = (room) => H.hall(snap, rooms, { room, now }).messages.map((m) => [m.meta, m.text, m.lines.map((l) => `${l.name} ${l.text}`)]);
  assert.deepEqual(lines("checkout-api"), [["You · 15:36 · to 2 of 3 agents", "Keep the refund and webhook retry changes in separate commits.",
    ["refund flow gets it after you answer it and its turn ends", "rate limiter gets it when this turn ends", "webhook retries couldn't get it: build-server was offline"]]]);
  assert.deepEqual(lines("supermarket-pos")[0][2], ["receipt printer gets it after you answer it and its turn ends", "inventory sync gets it when this turn ends",
    "basket bill gets it when this turn ends", "login fix gets it after its next turn"], "waiting on you, working, idle: in the table's order");
  assert.deepEqual(lines(H.ALL).map((m) => m[0]), ["You · 15:30 · to supermarket-pos: 4 agents", "You · 15:36 · to checkout-api: 2 of 3 agents"]);
  const a = snap.agents.find((x) => x.label === "rate limiter");
  const line = (r, ag) => { const l = H.deliveryLine({ session: "demo-rate", ...r }, ag); return [l.tone, l.icon, l.text]; };
  assert.deepEqual(line({ status: "delivered", deliveredAt: new Date(now).toISOString() }, a), ["ok", "check", "got it at 15:42"]);
  assert.deepEqual(line({ status: "undelivered" }, a), ["off", "power", "didn't get it: the session ended"]);
  assert.deepEqual(line({ status: "queued" }, { ...a, takesMessages: false }), ["wait", "clock", "may never get it: its last stop didn't ask for messages"]);
  assert.deepEqual(line({ status: "queued" }, { ...a, state: "offline" }), ["off", "power", "hasn't got it: thinkpad-x1 went offline"]);
  assert.equal(H.deliveryLine({ session: "gone-123456", status: "queued" }, undefined).name, "session gone-1", "an agent no longer in the live data");
  assert.deepEqual(["offline", "ended", "full"].map((why) => H.skippedLine({ session: "demo-rate", why }, a).text),
    ["couldn't get it: thinkpad-x1 was offline", "couldn't get it: the session had ended", "couldn't get it: 10 messages were already waiting"]);
  const reach = H.reach([a, { ...a, session: "o", state: "offline", host: "build-server" }, { ...a, session: "e", state: "offline", ended: true }, { ...a, session: "f", queued: 10 }]);
  assert.deepEqual(reach.map((r) => [r.can, r.text]), [[true, "gets it when this turn ends"], [false, "can't get it: build-server is offline"],
    [false, "can't get it: the session ended"], [false, "can't get it: 10 messages are already waiting"]]);
  // Carrying on with messages it just got: the Stop that ends this turn hands over nothing, so the next one waits a turn.
  assert.deepEqual(line({ status: "queued" }, { ...a, carryingOn: true }), ["wait", "clock", "gets it after its next turn"]);
  assert.equal(H.reach([{ ...a, carryingOn: true }])[0].text, "gets it after its next turn");
  assert.deepEqual(line({ status: "queued" }, { ...a, state: "idle", carryingOn: false }), ["wait", "clock", "gets it after its next turn"]);
  // One message reaches at most 50 agents: the first 50 at the table that can take it; the rest are told why.
  const crowd = [{ ...a, session: "off", state: "offline" }, ...Array.from({ length: 52 }, (_, i) => ({ ...a, session: `s${i}`, name: `shop · agent ${i}`, label: `agent ${i}` }))];
  const crowded = H.reach(crowd);
  assert.deepEqual([crowded.filter((r) => r.can).length, crowded.at(-1).can, crowded.at(-1).text], [50, false, "won't get it: one message reaches at most 50 agents"]);
  const to = H.recipients(crowded);
  assert.deepEqual([to.length, to.slice(0, 2), to.includes("off"), to.includes("s50")], [50, ["s0", "s1"], false, false], "the 50 that can take it; no room left to record the offline one");
  assert.deepEqual(H.recipients(H.reach(crowd.slice(0, 3))), ["s0", "s1", "off"], "with room to spare, the ones that can't take it go too, so the server says why");
});

// ---------- the rail ----------
test("decisions, overlaps and scorecard: who waits on you, what you answered here today, shared files and machines, the room's numbers", async () => {
  const { H, O } = await mods();
  const { snap, rooms, now } = demo(), colors = O.projectColors(snap.agents);
  const v = H.hall(snap, rooms, { room: H.ALL, now, colors });
  assert.deepEqual(v.decisions.map((d) => [d.name, d.open, d.text, d.target, Math.round(d.waitMs / M)]),
    [["refund flow", true, "Wants permission to edit a file", ".env.production", 9], ["receipt printer", true, "Wants permission to run a command", "sudo apt install cups-filters", 4]], "longest wait first");
  // You approved receipt printer in its detail: once its hook got the answer, the row turns to what you decided.
  const answered = { ...snap, agents: snap.agents.map((a) => (a.label === "receipt printer" ? { ...a, state: "working", question: null, waitingSince: null,
    answer: { choice: "approve", t: new Date(now - M).toISOString(), delivered: new Date(now - M).toISOString() } } : a)) };
  const d = H.decisions(H.roomAgents(answered.agents, "supermarket-pos", now), { now, colors });
  assert.deepEqual(d.map((x) => [x.name, x.open, x.text, x.at]), [["receipt printer", false, "Approved once", "15:41"]]);
  const yesterday = { ...answered.agents.find((a) => a.label === "receipt printer"), answer: { choice: "deny", t: new Date(now - 24 * 60 * M).toISOString(), delivered: true } };
  assert.deepEqual(H.decisions([yesterday], { now }), [], "only today's answers");
  assert.deepEqual(H.decisions([{ ...yesterday, answer: { choice: "reply", text: "Use the package", t: new Date(now).toISOString(), delivered: null } }], { now }), [], "not until its hook got it");
  // Overlaps: files from GET /api/rooms, machines from the snapshot (offline agents aside).
  assert.deepEqual(v.files.map((f) => [f.project, f.path, f.who.map((w) => w.name)]), [["supermarket-pos", "src/money/round.ts", ["basket bill", "inventory sync", "receipt printer"]],
    ["checkout-api", "src/webhooks/retry.ts", ["refund flow", "webhook retries"]]]);
  assert.deepEqual(v.machines.map((m) => [m.project, m.host, m.names, m.sameFolder]), [["supermarket-pos", "thinkpad-x1", "login fix, inventory sync, and basket bill", true],
    ["checkout-api", "thinkpad-x1", "refund flow and rate limiter", true]]);
  assert.deepEqual(H.machines([{ ...snap.agents[0], host: "a", root: "/x" }, { ...snap.agents[1], project: snap.agents[0].project, host: "a", root: "/y" }]).map((m) => m.sameFolder), [false], "two clones on one machine");
  assert.deepEqual(H.hall(snap, rooms, { room: "docs-site", now }).files, [], "per room");
  assert.deepEqual(H.hall(snap, rooms, { room: "checkout-api", now }).score.map((k) => [k.label, k.value, k.sub]), [
    ["Tasks done", "9/20", "45% of today's plan"], ["Spend", "$4.29", "today"], ["Waited on you", "21m", "today"],
    ["Blocked now", "2", [{ text: "1 waiting on you", tone: "needs" }, { text: "1 offline" }]]], "only the agents waiting on you are amber, not the offline one");
  // A room whose agents never reported a cost (telemetry off on their machines) says so, like each agent does: never $0.00.
  const noTelemetry = { ...snap, agents: snap.agents.map((a) => (a.project === "docs-site" ? { ...a, requests: 0, cost: 0 } : a)) };
  const docs = H.hall(noTelemetry, rooms, { room: "docs-site", now });
  assert.equal(docs.bubbles[0].text, "Standup for docs-site · 1 agent. 3 of 5 planned tasks are done and nobody has waited on you today.");
  assert.deepEqual([docs.bubbles[1].facts, docs.score[1].value, docs.score[1].sub], ["3 of 5 tasks · No cost data", "No data", "Cost needs telemetry"]);
  assert.match(H.hall(noTelemetry, rooms, { room: H.ALL, now }).bubbles[0].text, /, \$13\.72 spent,/, "every room together still has its spend");
});

// ---------- replay ----------
test("replay: one bubble at a time, in the order it started with; who is up next and who is speaking; each bubble in words for the log", async () => {
  const { H } = await mods();
  const { snap, rooms, now } = demo(), v = H.hall(snap, rooms, { room: "checkout-api", now }), order = v.bubbles.map((b) => b.key);
  assert.equal(H.STEP_MS, 1100);
  const f = (n, bubbles = v.bubbles) => { const x = H.replayFrame(bubbles, order, n); return [x.shown.map((b) => b.key), x.next, x.speaking]; };
  assert.deepEqual(f(0), [[], "Virtual Office", null]);
  assert.deepEqual(f(1), [["host:open"], "refund flow", null]);
  assert.deepEqual(f(2), [["host:open", "a:demo-refund"], "rate limiter", "demo-refund"]);
  assert.deepEqual(f(order.length), [order, null, null], "the host speaks last");
  assert.deepEqual(f(2, v.bubbles.filter((b) => b.session !== "demo-rate")), [["host:open", "a:demo-refund"], "webhook retries", "demo-refund"], "an agent that left is skipped");
  assert.equal(H.spoken(v.bubbles[1]), "refund flow, Needs you, 3 of 9 tasks · $2.05. Done: Add refund webhook events; Send partial refunds to the original card (+1 more). " +
    "Now: Add the refund webhook secret. Blocked: Wants permission to edit a file: .env.production (waiting 9m). Next: Sign webhook payloads.");
  assert.equal(H.spoken(v.bubbles[0]), `Virtual Office: ${v.bubbles[0].text}`);
});

// ---------- markup ----------
test("hall markup: every panel's loading, error, empty and stale states; amber only for what waits on you, red only for errors; real buttons; escaped", async () => {
  const { H, V, O } = await mods();
  const { snap, rooms, now } = demo(), colors = O.projectColors(snap.agents), asOf = new Date(new Date(now).setHours(15, 40, 0, 0));
  const v = H.hall(snap, rooms, { room: H.ALL, now, colors }), empty = H.hall({ agents: [], totals: {} }, rooms, { now }), unloaded = H.hall(snap, null, { now });
  const panels = { table: V.tablePanel, transcript: V.transcriptPanel, decisions: V.decisionsPanel, overlaps: V.overlapsPanel, score: V.scorePanel };
  for (const [name, fn] of Object.entries(panels)) {
    assert.match(fn({ status: "loading" }), /aria-busy="true"[\s\S]*ao-loading/, `${name} loading`);
    assert.match(fn({ status: "error" }), /role="alert"[\s\S]*data-retry/, `${name} error with Retry`);
    assert.match(fn({ v: empty, status: "live" }), /ao-state--empty/, `${name} empty`);
    assert.match(fn({ v, status: "stale", asOf }), /As of 15:40[\s\S]*ao-stale/, `${name} stale: last data kept, dimmed`);
  }
  assert.match(V.decisionsPanel({ v: empty }), /is-ok[\s\S]*Nothing is waiting on you in this room\./, "nobody waiting is the good kind of empty");
  for (const fn of [V.transcriptPanel, V.overlapsPanel]) {
    assert.match(fn({ v: unloaded, rooms: "loading" }), /aria-busy="true"/, "loading while GET /api/rooms is on its way");
    assert.match(fn({ v: unloaded, rooms: "error" }), /role="alert"[\s\S]*data-mh-retry/, "its own Retry when it failed");
  }
  for (const [mode, text] of [["loading", 'aria-busy="true"'], ["error", "data-retry"], ["all", "Pick a room above to message its agents."], ["empty", "Nobody to message in this room today."],
    ["noproject", "no project folder"], ["form", 'for="mh-msg"']]) assert.ok(V.composePanel({ mode, room: "shop" }).includes(text), mode);

  const frame = H.replayFrame(v.bubbles, v.bubbles.map((b) => b.key), 3);
  const html = [V.tablePanel({ v }), V.transcriptPanel({ v }), V.transcriptPanel({ v, frame }), V.decisionsPanel({ v }), V.overlapsPanel({ v }), V.scorePanel({ v }),
    V.composePanel({ mode: "form", room: "checkout-api" }), V.reachList(v.reach), V.tools({ text: v.text, ready: true }), V.roomTabs(H.roomTabs(snap.agents, { now, colors }), H.ALL)].join("");
  noRaw(html, "hall");
  // Amber: the Answer button only on an agent waiting on you (its bubble and its decision); amber classes only on what waits.
  const blocked = v.bubbles.filter((b) => b.blocked).length;
  assert.equal(V.transcriptPanel({ v }).match(/ao-btn--answer/g).length, blocked);
  assert.equal(V.decisionsPanel({ v }).match(/ao-btn--answer/g).length, v.decisions.filter((d) => d.open).length);
  assert.equal(V.transcriptPanel({ v }).match(/mh-row--blocked is-needs/g).length, blocked, "an offline machine's Blocked row isn't amber");
  assert.match(V.scorePanel({ v }), /<dd class="ao-meta"><span class="mh-needs"><svg[^]*?<\/svg>2 waiting on you<\/span> · 1 offline<\/dd>/, "on the scorecard only \"waiting on you\" is amber");
  assert.ok(!/is-needs/.test(V.scorePanel({ v })), "not the whole Blocked now tile");
  assert.ok(!/is-error|ao-state--error|--red/.test(html), "no red without an error");
  assert.ok(!/ao-btn--answer/.test(V.overlapsPanel({ v }) + V.scorePanel({ v }) + V.tablePanel({ v })));
  // Real buttons that open the agent's detail, at its conversation for Answer and its trace for Trace; unique keys.
  assert.ok([...html.matchAll(/<(\w+)[^>]*data-agent="/g)].every((m) => m[1] === "button"), "every agent link is a button");
  assert.match(V.transcriptPanel({ v }), /class="ao-btn ao-btn--answer" aria-label="Answer refund flow" data-agent="demo-refund" data-agent-at="convo"/);
  assert.match(V.transcriptPanel({ v }), /data-agent="demo-refund" data-agent-at="trace" data-key="mh-trace:demo-refund" aria-label="Trace of refund flow"/);
  const keys = [...(V.tablePanel({ v }) + V.transcriptPanel({ v }) + V.decisionsPanel({ v })).matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(keys).size, keys.length, "keys are unique, so focus survives re-renders");
  assert.ok(keys.every((k) => k.startsWith("mh-")), "and apart from the office's");
  // States in words, not colour alone; offline seats faded; the speaker marked during replay.
  assert.match(V.tablePanel({ v }), /<span class="mh-seat-state ao-tone-needs"><svg[^]*?<\/svg><span class="ao-sr">, Needs you<\/span>/);
  assert.equal(V.tablePanel({ v }).match(/mh-seat is-off/g).length, 1);
  assert.match(V.tablePanel({ v, speaking: "demo-receipt" }), /mh-seat is-speaking"[^>]*data-agent="demo-receipt"[^]*?speaking<\/span>/);
  assert.ok(V.transcriptPanel({ v, frame }).endsWith(`<p class="mh-typing" aria-hidden="true"><span class="mh-dots"><i></i><i></i><i></i></span>${v.bubbles[3].name} is up next</p></div></section>`));
  assert.equal(V.transcriptPanel({ v, frame }).match(/class="mh-b /g).length, 3);
  // Filter chips: agents in other states dim.
  assert.equal(V.transcriptPanel({ v, filter: new Set(["needs"]) }).match(/mh-b--agent is-dim/g).length, v.bubbles.filter((b) => b.kind === "agent" && b.state !== "needs").length);
  // Tabs: a radio group with colour dots; tools.
  assert.match(V.roomTabs(H.roomTabs(snap.agents, { now, colors }), "checkout-api"), /role="radiogroup" aria-label="Room"[^]*aria-checked="true" tabindex="0" data-value="checkout-api"><span class="ao-seg-dot" style="--av:var\(--proj-\d\)" aria-hidden="true"><\/span>checkout-api<span class="ao-seg-count">3<\/span>/);
  assert.match(V.tools({ replaying: true }), /data-mh-replay data-key="mh-replay"><svg[^]*<span>Stop replay<\/span>/);
  assert.match(V.tools({}), /<button type="button" class="ao-btn ao-btn--secondary" data-mh-replay data-key="mh-replay" disabled>[^]*Replay standup[^]*data-mh-copy data-key="mh-copy" disabled>/, "nothing to replay or copy yet");
  assert.equal(V.sendLabel(3), "Send to 3 agents");
  // Escaped.
  const evil = "<img src=x onerror=alert(1)>";
  const bad = { ...snap, agents: snap.agents.map((a) => ({ ...a, name: evil, label: evil, project: evil, host: evil })) };
  const badRooms = { ...rooms, plans: rooms.plans.map((p) => ({ ...p, open: p.open.map((x) => ({ ...x, text: evil })) })), messages: rooms.messages.map((m) => ({ ...m, text: evil })) };
  const bv = H.hall(bad, badRooms, { room: H.ALL, now });
  const all = [V.tablePanel({ v: bv }), V.transcriptPanel({ v: bv }), V.decisionsPanel({ v: bv }), V.overlapsPanel({ v: bv }), V.reachList(bv.reach), V.tools({ text: bv.text })].join("");
  assert.ok(!all.includes("<img"), "escaped");
});

// ---------- the hall in the shell ----------
function fakeWindow(hash = "") {
  const listeners = {};
  return {
    location: { hash, href: "/" },
    addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    go(h) { this.location.hash = h; for (const fn of listeners.hashchange || []) fn(); },
    focus() {},
  };
}
function server(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = routes[url.split("?")[0]];
    const out = typeof r === "function" ? r(opts) : r;
    if (out === undefined) return { status: 500, ok: false, json: async () => ({ error: "Server error." }) };
    if (out && out.status) return { status: out.status, ok: false, json: async () => ({ error: out.error }) };
    return { status: 200, ok: true, json: async () => json(out) };
  };
  const sources = [];
  class ES { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } }
  return { fetch, EventSource: ES, calls, sources };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settings = { offlineAfterMin: 30, dailyBudgetUsd: 25, notifyOnWaiting: false, aliases: {}, demo: true, teamMode: false, viewer: "mk" };

/** The shell at #/hall on the demo day (15:42 today); the shell runs on the real clock, so these tests count from the
 *  fixture with the hall's own model rather than the 15:42 wait times. */
async function hallShell(routes = () => ({}), hash = "#/hall") {
  const dom = withDom(), D = demo(), win = fakeWindow(hash);
  const srv = server({ "/api/state": { ...D.snap, settings }, "/api/timeline": D.timeline, "/api/board": D.board, "/api/rooms": D.rooms, ...routes(D) });
  const { createShell } = await pub("shell.js");
  const shell = createShell({ doc: dom.document, win, fetch: srv.fetch, EventSource: srv.EventSource });
  const body = dom.document.body, page = body.querySelector('[data-screen="hall"]');
  const q = (s) => page.querySelector(s), all = (s) => page.querySelectorAll(s), slot = (k) => q(`[data-mh="${k}"]`);
  return { dom, D, win, srv, shell, body, page, q, all, slot, active: () => dom.document.activeElement };
}

test("hall DOM: in the shell at #/hall: room tabs, the table, the standup, Answer opens the agent's conversation and focus comes back, chips dim, stale", async () => {
  let t = null;
  try {
    t = await hallShell((D) => Object.fromEntries(D.snap.agents.map((a) => [`/api/agents/${a.session}`, D.detail(a.session)])));
    const { q, all, slot, srv, shell, body, page, D, active } = t, { H } = await mods();
    assert.equal(page.hidden, false);
    assert.ok(!page.textContent.includes("isn't built yet"), "the interim screen is gone");
    await shell.ready;
    await tick(); await tick();
    assert.ok(srv.calls.some((c) => c.url === "/api/rooms" && c.opts.headers["X-Requested-With"] === "agent-office"));
    const now = Date.now(), tabs = H.roomTabs(D.snap.agents, { now });
    assert.deepEqual(all(".ao-seg-opt").map((o) => o.getAttribute("data-value")), tabs.map((x) => x.value));
    assert.equal(all(".mh-seat").length, tabs[0].count, "everyone at the table in All rooms");
    assert.equal(all(".mh-b--agent").length, tabs[0].count);
    assert.match(q(".mh-b--host").querySelector(".mh-b-text").textContent, /^Standup for all rooms · \d+ agents? in \d rooms?\. /);
    assert.equal(q("[data-mh-copy]").getAttribute("data-copy"), H.hall(D.snap, D.rooms, { now }).text, "Copy summary copies the standup");
    assert.match(slot("compose").textContent, /Pick a room above to message its agents\./);

    // A room tab: only its agents, and its own standup.
    const room = tabs[1].value;
    q(`[data-value="${room}"]`).click();
    assert.equal(all(".mh-seat").length, tabs[1].count);
    assert.ok(q(".mh-b--host").querySelector(".mh-b-text").textContent.startsWith(`Standup for ${room} · `));
    assert.ok(q("#mh-msg"), "and its message box");

    // Answer in Decisions for you: the agent's detail opens at its conversation; closing it puts focus back.
    q('[data-value=""]').click();
    const answer = slot("decisions").querySelector(".ao-btn--answer"), id = answer.getAttribute("data-agent");
    answer.focus();
    answer.click();
    const sheet = body.querySelector('[data-dialog="agent"]');
    assert.equal(sheet.open, true);
    assert.equal(active().id, "ad-convo-h", "focus on the Conversation heading");
    assert.ok(sheet.querySelector(".ad-back").textContent.includes("Back to meeting hall"));
    await tick(); await tick();
    assert.ok(sheet.querySelector(`[data-answer-form]`) || sheet.querySelector(".cc-terminal"), "the answer box is right there");
    sheet.querySelector("[data-close]").click();
    assert.equal(active().getAttribute("data-key"), `mh-decide:${id}`);
    // Trace opens it at the trace.
    q(`[data-agent-at="trace"]`).click();
    assert.equal(active().id, "ad-trace-h");
    sheet.querySelector("[data-close]").click();

    // The answer reached it: the row says what you decided, and the log says so too.
    const es = srv.sources[0], answered = { ...D.snap, agents: D.snap.agents.map((a) => (a.session === id ? { ...a, state: "working", question: null, waitingSince: null, updated: new Date().toISOString(),
      answer: { choice: "approve", t: new Date().toISOString(), delivered: new Date().toISOString() } } : a)) };
    es.onmessage({ data: JSON.stringify(answered) });
    const row = all(".mh-dec").find((d) => d.querySelector('[data-key="mh-decide:' + id + '"]'));
    assert.match(row.textContent, /Approved once · \d\d:\d\d/);
    assert.match(slot("log").textContent, /: Approved once$/);
    es.onmessage({ data: JSON.stringify(D.snap) });

    // The top bar's chips dim agents in other states here too.
    const chip = body.querySelector('[data-chip="needs"]');
    chip.click();
    const lit = all(".mh-seat").filter((s) => !s.classList.contains("is-dim")).map((s) => s.getAttribute("data-agent")).sort();
    assert.deepEqual(lit, D.snap.agents.filter((a) => a.state === "waiting").map((a) => a.session).sort());
    chip.click();
    assert.equal(all(".is-dim").length, 0);

    // Stale: the stream drops; the hall keeps its data, dimmed, with "As of".
    es.onerror();
    assert.match(slot("table").textContent, /As of \d\d:\d\d/);
    assert.ok(slot("transcript").querySelector(".ao-stale"));
    es.onmessage({ data: JSON.stringify(D.snap) });
    assert.ok(!slot("transcript").querySelector(".ao-stale"));
    shell.destroy();
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});


test("hall DOM: message the room: a same-origin POST with the table's agents, then your bubble with a line per agent; a refusal keeps your text", async () => {
  const { H } = await mods();
  let t = null, posted = null, fail = false, room = null;
  // The skipped reason a reach line stands for, as the server would record it.
  const why = (r) => (/ended/.test(r.text) ? "ended" : /messages/.test(r.text) ? "full" : "offline");
  try {
    t = await hallShell((D) => {
      const now = Date.now(), v = H.hall(D.snap, D.rooms, { room: (room = H.roomTabs(D.snap.agents, { now })[1].value), now });
      return { [`/api/rooms/${encodeURIComponent(v.project)}/message`]: (o) => {
        posted = o;
        if (fail) return { status: 409, error: "None of these agents can get messages right now." };
        const { text, sessions } = JSON.parse(o.body), reach = v.reach.filter((r) => sessions.includes(r.session));
        return { ok: true, message: { id: "room-msg-0001", project: v.project, t: new Date().toISOString(), text,
          to: reach.filter((r) => r.can).map((r) => ({ session: r.session, status: "queued", deliveredAt: null })), skipped: reach.filter((r) => !r.can).map((r) => ({ session: r.session, why: why(r) })) } };
      } };
    });
    const { q, all, slot, srv, shell, D, dom } = t;
    await shell.ready;
    await tick(); await tick();
    q(`[data-value="${room}"]`).click();
    const v = H.hall(D.snap, D.rooms, { room, now: Date.now() }), n = v.reach.filter((r) => r.can).length;
    const send = q("[data-mh-send]"), area = q("#mh-msg"), form = q("[data-mh-form]");
    assert.equal(send.hasAttribute("disabled"), true, "nothing to send yet");
    assert.equal(slot("send-label").textContent, `Send to ${n} ${n === 1 ? "agent" : "agents"}`);
    assert.deepEqual(slot("reach").querySelectorAll(".mh-line").map((l) => l.textContent), v.reach.map((r) => `${r.name} ${r.text}`), "who gets it, before you send");
    area.value = "  Push your branch.  ";
    dom.fire(area, "input");
    assert.equal(send.hasAttribute("disabled"), false);
    // Live data doesn't touch what you type.
    srv.sources[0].onmessage({ data: JSON.stringify(D.snap) });
    assert.ok(q("#mh-msg") === area && area.value === "  Push your branch.  ", "the same box, the same text");
    // The stream drops: who gets it is as of the last data; the box stays as it is.
    srv.sources[0].onerror();
    assert.match(slot("reach-asof").textContent, /^As of \d\d:\d\d$/);
    assert.ok(slot("reach").classList.contains("ao-stale") && q("#mh-msg") === area && area.value === "  Push your branch.  ");
    srv.sources[0].onmessage({ data: JSON.stringify(D.snap) });
    assert.deepEqual([slot("reach-asof").textContent, slot("reach").classList.contains("ao-stale")], ["", false]);

    dom.fire(form, "submit");
    await tick(); await tick();
    assert.equal(posted.method, "POST");
    assert.equal(posted.headers["X-Requested-With"], "agent-office", "same-origin header");
    assert.deepEqual(JSON.parse(posted.body), { text: "Push your branch.", sessions: v.reach.map((r) => r.session) }, "everyone at the table; the server sorts out who can take it");
    assert.equal(area.value, "", "cleared once sent");
    const mine = all(".mh-b--you").at(-1);
    assert.match(mine.querySelector(".mh-b-meta").textContent, /^You · \d\d:\d\d · to /);
    assert.equal(mine.querySelector(".mh-b-text").textContent, "Push your branch.");
    assert.equal(mine.querySelectorAll(".mh-line").length, v.reach.length, "a line for every agent at the table");
    assert.match(slot("log").textContent, /Sent to \d+ agents?\. Each gets it the next time it stops\./);
    assert.match(slot("toasts").textContent, /^Sent to \d+ agents?/);
    srv.sources[0].onmessage({ data: JSON.stringify(D.snap) });
    assert.ok(all(".mh-b--you").some((b) => b.querySelector(".mh-b-text").textContent === "Push your branch."), "the bubble stays until GET /api/rooms has it");

    // A refusal: what went wrong, and your text stays. Ctrl+Enter sends too.
    fail = true;
    area.value = "Again, please.";
    dom.fire(area, "input");
    dom.fire(area, "keydown", { key: "Enter", ctrlKey: true });
    await tick(); await tick();
    assert.equal(JSON.parse(posted.body).text, "Again, please.");
    assert.equal(form.querySelector("[data-mh-error]").textContent, "Couldn't send your message. None of these agents can get messages right now.");
    assert.equal(area.value, "Again, please.");
    shell.destroy();
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});

test("hall DOM: a failed rooms load says so with Retry, the snapshot's panels still show; an empty day says nobody is at the table", async () => {
  let t = null, up = false;
  try {
    t = await hallShell((D) => ({ "/api/rooms": () => (up ? D.rooms : undefined) }));
    const { q, slot, shell, all } = t;
    await shell.ready;
    await tick(); await tick();
    assert.match(slot("transcript").textContent, /Couldn't load today's plans and messages\. The server didn't answer\./);
    assert.ok(slot("transcript").querySelector('[role="alert"]') && slot("overlaps").querySelector("[data-mh-retry]"));
    assert.ok(all(".mh-seat").length && slot("decisions").querySelector(".mh-dec") && slot("score").querySelector(".mh-kpi"), "the table, decisions and scorecard come from the live data");
    up = true;
    slot("transcript").querySelector("[data-mh-retry]").click();
    await tick(); await tick();
    assert.ok(q(".mh-b--host") && slot("overlaps").querySelector(".mh-ov"));
    // Then it stops answering: the standup and overlaps stay, dimmed, "As of" their last load; the table stays live.
    up = false;
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5000;
      t.srv.sources[0].onmessage({ data: JSON.stringify({ ...t.D.snap, agents: t.D.snap.agents.map((a, i) => (i ? a : { ...a, toolCount: a.toolCount + 1 })) }) });
      await tick(); await tick();
      assert.match(slot("transcript").textContent, /As of \d\d:\d\d/);
      assert.ok(slot("transcript").querySelector(".ao-stale") && slot("overlaps").querySelector(".ao-stale") && q(".mh-b--host"));
      assert.ok(!slot("table").querySelector(".ao-stale"), "the table comes from the live data");
    } finally { Date.now = realNow; }
    shell.destroy();
    t.dom.restore();
    t = await hallShell(() => ({ "/api/state": { t: new Date().toISOString(), lastEvent: null, agents: [], totals: { periods: {} }, settings }, "/api/rooms": { plans: [], files: [], messages: [] } }));
    await t.shell.ready;
    await tick(); await tick();
    assert.match(t.slot("table").textContent, /Nobody is at the table yet today\./);
    assert.match(t.slot("transcript").textContent, /No standup yet: nobody worked in this room today\./);
    assert.match(t.slot("compose").textContent, /Nobody to message in this room today\./);
    assert.ok(t.q("[data-mh-replay]").hasAttribute("disabled") && t.q("[data-mh-copy]").hasAttribute("disabled"), "nothing to replay or copy");
    t.shell.destroy();
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});

test("hall DOM: replay shows one bubble per step with who is up next and the speaker marked; Esc stops it; leaving stops it; the log reads each bubble", async () => {
  const dom = withDom(), realNow = Date.now, now = realNow();
  const until = async (ok) => { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(ok(), "in time"); };
  Date.now = () => now; // waits are said to the minute: one mustn't turn between the expected lines and the replay's
  try {
    const { H } = await mods(), { createHall } = await pub("hall.js"), { bind } = await pub("ui/components.js");
    const D = demo(), ctx = { snap: D.snap, status: "live", asOf: null, colors: new Map(), settings };
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const unbind = bind(root);
    const hall = createHall({ root, doc: dom.document, win: fakeWindow(), api: async (p) => json(p === "/api/rooms" ? D.rooms : {}), context: () => ctx, stepMs: 80 });
    hall.show(true);
    await tick(); await tick();
    const room = H.roomTabs(D.snap.agents, { now })[1].value;
    root.querySelector(`[data-value="${room}"]`).click();
    const v = H.hall(D.snap, D.rooms, { room, now }), count = () => root.querySelector(".mh-thread").children.length;
    const typing = () => root.querySelector(".mh-typing")?.textContent || null, btn = () => root.querySelector("[data-mh-replay]"), log = () => root.querySelector('[data-mh="log"]');
    assert.equal(count(), v.bubbles.length + v.messages.length);
    btn().focus();
    btn().click();
    assert.deepEqual([count(), typing(), btn().textContent, dom.document.activeElement.getAttribute("data-key")], [0, "Virtual Office is up next", "Stop replay", "mh-replay"]);
    await until(() => count() === 1);
    assert.equal(typing(), `${v.bubbles[1].name} is up next`);
    await until(() => count() === 2);
    assert.equal(root.querySelector(".mh-seat.is-speaking").getAttribute("data-agent"), v.bubbles[1].session, "the speaker is marked at the table");
    assert.ok(log().textContent.includes(H.spoken(v.bubbles[1])));
    // Esc stops it: the whole standup again.
    dom.fire(btn(), "keydown", { key: "Escape" });
    assert.deepEqual([count(), typing(), btn().textContent], [v.bubbles.length + v.messages.length, null, "Replay standup"]);
    assert.match(log().lastElementChild.textContent, /^Replay stopped\./);
    // Run to the end on its own: every bubble once, in order, then your messages again.
    btn().click();
    await until(() => count() === v.bubbles.length + v.messages.length && !typing());
    const said = log().querySelectorAll("p").map((p) => p.textContent), from = said.lastIndexOf("Replaying the standup, one speaker at a time.");
    assert.deepEqual(said.slice(from + 1), [...v.bubbles.map(H.spoken), "End of the standup."]);
    assert.equal(root.querySelector(".mh-seat.is-speaking"), null);
    // Leaving the hall stops a replay.
    btn().click();
    hall.show(false);
    hall.show(true);
    assert.equal(typing(), null);
    // The room empties mid-replay (its agents left today's table): back to All rooms, and the replay ends, saying so.
    btn().click();
    ctx.snap = { ...D.snap, agents: D.snap.agents.filter((a) => (a.project || "Other") !== room) };
    hall.render();
    assert.deepEqual([typing(), btn().textContent, root.querySelector('[aria-checked="true"]').getAttribute("data-value")], [null, "Replay standup", ""]);
    assert.equal(log().lastElementChild.textContent, "Replay stopped: nobody from that room is at the table now.");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(typing(), null, "no step comes after");
    hall.destroy();
    unbind();
  } finally { Date.now = realNow; dom.restore(); }
});
