"use strict";
// The Work Board (public/board*.js): the daily summary and its KPIs, Kanban, Projects and Swimlanes built from the real
// demo day, their panel states, the colour and text rules, and the board in the shell on a fake DOM.
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
const hhmm = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const json = (x) => JSON.parse(JSON.stringify(x));
/** The demo day as the browser gets it: the snapshot, GET /api/board and today's timeline, through JSON. */
function demo(now = at1542()) {
  const store = new Store({ getConfig: () => ({ offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 25 }) });
  loadScenario(store, now);
  return { now, snap: json(store.snapshot(now)), board: json(store.board(now)), timeline: json(store.timeline(localDate(now), now)), detail: (id) => json(store.detail(id, now)) };
}
async function mods() {
  const [B, V, O] = await Promise.all([pub("board-model.js"), pub("board-view.js"), pub("office3d-model.js")]);
  return { B, V, O };
}
// Never in the UI: raw hook or tool names, IDE and system tags, absolute paths.
const RAW = ["PreToolUse", "PostToolUse", "PermissionRequest", "UserPromptSubmit", "SubagentStart", "SubagentStop", "TodoWrite", "TaskCreate", "<ide_", "<system-reminder", "/Users/", "/srv/"];
const noRaw = (html, what) => { for (const r of RAW) assert.ok(!html.includes(r), `${what}: no ${r}`); };

// ---------- daily summary ----------
test("summary: the auto-written sentence, six KPIs and Copy summary, all from the snapshot", async () => {
  const { B, V } = await mods();
  const { snap, now } = demo();
  const s = B.summary(snap, { now, budget: 25 });
  assert.equal(s.text, "8 agents across 3 projects completed 26 of 50 planned tasks, spent $13.72 (55% of the $25 budget) and waited on you 52 min. " +
    "Right now 2 are waiting for you, and webhook retries is offline, last seen at 12:05.", "last seen: the swimlane's word too");
  assert.deepEqual(s.kpis.map((k) => [k.label, k.value, k.sub]), [
    ["Done", "26", "of 50 planned"], ["In progress", "7", "2 waiting on you · 1 stalled"], ["Needs you", "2", "agents waiting now"],
    ["Planned", "17", "not started yet"], ["Waited on you", "52m", "today, all agents"], ["Spend", "$13.72", "55% of $25"]]);
  const html = V.summaryPanel({ s, status: "live" });
  assert.ok(html.includes(`data-copy="${s.text}"`) && html.includes(">Copy summary<") && html.includes("data-wb-copy"), "Copy summary copies the sentence");
  assert.equal(html.match(/<div class="wb-kpi /g).length, 6);
  assert.equal(html.match(/is-needs/g).length, 1, "amber only on Needs you");
  assert.ok(!html.includes("is-over") && !html.includes("ao-btn--answer"), "no red under budget; no amber buttons");
  noRaw(html, "summary");

  // Over budget: the sentence and the tile say so; the tile is the only red.
  const over = B.summary(snap, { now, budget: 10 });
  assert.match(over.text, /spent \$13\.72 \(over the \$10 budget, at 137%\)/);
  const spend = over.kpis.find((k) => k.key === "spend");
  assert.deepEqual([spend.sub, spend.tone], ["Over budget · 137% of $10", "over"]);
  assert.equal(V.summaryPanel({ s: over }).match(/is-over/g).length, 1);
  assert.equal(B.summary(snap, { now, budget: 0 }).kpis.at(-1).sub, "No budget set");
});

test("summary: one agent, no telemetry, nobody waiting, several offline, nothing today, waiting since yesterday", async () => {
  const { B, V } = await mods();
  const now = hhmm(15, 42), iso = (min) => new Date(now - min * M).toISOString();
  const agent = (session, label, state, min, extra = {}) => ({ session, name: `shop · ${label}`, project: "shop", label, state, updated: iso(min), started: iso(min + 60), plan: { inProgress: 0 }, ...extra });
  const totals = { tasksDone: 0, tasksInProgress: 0, tasksPending: 0, waiting: 0, waitedMs: 0, periods: { today: { days: 1, cost: 0, requests: 0, tokensByType: {} } } };
  const one = B.summary({ agents: [agent("a", "till fix", "working", 1)], totals }, { now, budget: 25 });
  assert.equal(one.text, "1 agent in 1 project wrote no to-do list yet and didn't wait on you. Nobody is waiting for you right now.");
  assert.deepEqual(one.kpis.map((k) => k.value), ["0", "0", "0", "0", "0m", "No data"]);
  assert.deepEqual([one.kpis[1].sub, one.kpis.at(-1).sub], ["nothing under way", "Cost needs telemetry"]);
  const busy = B.summary({ agents: [agent("a", "till fix", "working", 1, { plan: { inProgress: 2 } })], totals: { ...totals, tasksInProgress: 2 } }, { now });
  assert.equal(busy.kpis[1].sub, "all being worked on");
  const paused = B.summary({ agents: [agent("a", "till fix", "idle", 1, { plan: { inProgress: 1 } })], totals: { ...totals, tasksInProgress: 1 } }, { now });
  assert.equal(paused.kpis[1].sub, "1 paused", "never 'being worked on' for an idle agent's step");
  const quiet = ["b", "c", "d", "e"].map((id, i) => agent(id, `job ${id}`, "offline", 200 - i * 10));
  const many = B.summary({ agents: [...quiet, agent("x", "ended", "offline", 5, { ended: true })], totals: { ...totals, waitedMs: 30000 } }, { now });
  assert.match(many.text, /waited on you under a minute\. Nobody is waiting for you right now, and 4 are offline: job b \(last seen 12:22\), job c \(last seen 12:32\), job d \(last seen 12:42\) and 1 more\.$/, "an ended session isn't 'offline'");
  const yesterday = B.summary({ agents: [agent("y", "old", "offline", 26 * 60)], totals }, { now });
  assert.equal(yesterday.empty, true, "agents from yesterday aren't today's");
  assert.match(V.summaryPanel({ s: yesterday }), /ao-state--empty[\s\S]*No agents worked today yet/);
  // Still waiting on you from before midnight: on the board (summary and Projects alike), not "no agents".
  const waits = { agents: [agent("w", "night job", "waiting", 17 * 60, { waitingSince: iso(17 * 60) })], totals: { ...totals, waiting: 1 } };
  const w = B.summary(waits, { now });
  assert.equal(w.empty, false);
  assert.match(w.text, /^1 agent in 1 project .*Right now 1 is waiting for you\.$/);
  assert.deepEqual(B.projects(waits, { now }).map((p) => [p.project, p.agents.map((a) => a.name)]), [["shop", ["night job"]]]);
  assert.deepEqual(B.projects({ agents: [agent("y", "old", "offline", 26 * 60)], totals }, { now }), [], "the same agents as the summary");
  assert.equal(B.spokenTime(65 * M), "1 h 5 min");
  assert.equal(B.spokenTime(120 * M), "2 h");
});

// ---------- kanban ----------
test("kanban: Planned, In progress, Needs you (longest wait first), Done today (newest first), from every agent's to-do list", async () => {
  const { B, V, O } = await mods();
  const { snap, board, now } = demo();
  const colors = O.projectColors(snap.agents), k = B.kanban(snap, board, { now, colors });
  assert.deepEqual(Object.values(k.cols).map((c) => c.length), [17, 5, 2, 26]);
  assert.deepEqual(k.cols.needs.map((c) => [c.text, `${c.project} · ${c.name}`, c.meta.text]),
    [["Add the refund webhook secret", "checkout-api · refund flow", "waiting 9m"], ["Install the printer filter package", "supermarket-pos · receipt printer", "waiting 4m"]]);
  assert.deepEqual(k.cols.doing.map((c) => [c.name, c.meta.text]), [["inventory sync", "since 12:31"], ["rate limiter", "since 15:05"],
    ["basket bill", "since 15:14"], ["tokens page", "since 15:30"], ["webhook retries", "stalled · offline"]], "working first, oldest first; stalled last");
  assert.deepEqual(k.cols.done.slice(0, 2).map((c) => [c.text, c.meta.text]), [["Add copy buttons to each token", "done 15:30"], ["Handle overnight shifts at midnight", "done 15:20"]]);
  assert.ok(k.cols.done.every((c, i, all) => !i || all[i - 1].at >= c.at));
  assert.deepEqual(k.cols.planned.filter((c) => c.session === "demo-refund").map((c) => c.meta.text), ["Step 5 of 9", "Step 6 of 9", "Step 7 of 9", "Step 8 of 9", "Step 9 of 9"]);
  assert.equal(k.cols.planned.filter((c) => c.project === "checkout-api").at(-1).name, "webhook retries", "by project; an offline agent's next steps after the active ones'");
  assert.ok(k.cols.needs.every((c) => c.color === colors.get(c.project)), "avatars in the room's colour");
  assert.equal(k.hasPlans, true);

  // Each card follows its agent live: the receipt printer got its answer, so its step is in progress again.
  const moved = { ...snap, agents: snap.agents.map((a) => (a.session === "demo-receipt" ? { ...a, state: "working", waitingSince: null, question: null } : a)) };
  const k2 = B.kanban(moved, board, { now, colors });
  assert.deepEqual([k2.cols.needs.length, k2.cols.doing.length], [1, 6]);
  assert.equal(k2.cols.doing.find((c) => c.session === "demo-receipt").meta.text, "since 12:51");
  // Waiting with nothing in progress: the question, so nobody waiting is missing; an idle agent's step is paused.
  const asks = { ...snap, agents: snap.agents.map((a) => (a.session === "demo-login" ? { ...a, state: "waiting", waitingSince: new Date(now - 3 * M).toISOString(), question: { qkind: "permission", tool: "Bash", target: "npm run db:migrate" } }
    : a.session === "demo-basket" ? { ...a, state: "idle" } : a)) };
  const k3 = B.kanban(asks, board, { now, colors });
  assert.deepEqual(k3.cols.needs.at(-1), { ...k3.cols.needs.at(-1), text: "Wants permission to run a command", meta: { icon: "hand", text: "waiting 3m · no plan step" } });
  assert.equal(k3.cols.doing.find((c) => c.session === "demo-basket").meta.text, "paused · agent idle");
  // Paths in a task read as everywhere else: relative to the agent's root, else shortened; routes stay as written.
  const task = (a, text) => B.kanban({ ...snap, agents: [a] }, { plans: [{ session: a.session, of: 1, open: [{ text, status: "pending", step: 1, since: null }], done: [] }] }, { now }).cols.planned[0].text;
  const basket = snap.agents.find((a) => a.session === "demo-basket"), root = basket.root;
  assert.equal(task(basket, `Fix ${root}/src/basket/Basket.tsx.`), "Fix src/basket/Basket.tsx.", "inside the root, punctuation kept");
  assert.equal(task(basket, `Compare with /Users/mk/code/checkout-api/src/refunds/refund.ts`), "Compare with …/refunds/refund.ts", "another project: shortened");
  assert.equal(task(basket, `Look in ${root}`), "Look in supermarket-pos", "the root itself: its folder");
  assert.equal(task(basket, "Wire up /api/board and GET /api/agents/:id"), "Wire up /api/board and GET /api/agents/:id", "routes aren't files");
  const win = { ...basket, root: "C:\\Users\\mk\\code\\shop", gitRoot: "C:\\Users\\mk\\code\\shop" };
  assert.equal(task(win, "Edit c:/users/mk/code/shop/src/a.ts and C:\\Users\\mk\\code\\shop\\src\\b.ts"), "Edit src/a.ts and src/b.ts", "either slash, any drive case");
  assert.equal(task({ ...basket, root: null, gitRoot: null }, "Read /home/mk/notes/plan/today.md"), "Read …/plan/today.md", "no root: shortened");
  // An agent with no label of its own reads "shop", not "shop · shop".
  const bare = { ...basket, name: "shop", label: null, project: "shop" };
  assert.match(V.kanbanPane({ k: B.kanban({ ...snap, agents: [bare] }, board, { now }) }), /<span class="wb-card-name">shop<\/span>/);

  const html = V.kanbanPane({ k });
  assert.equal(html.match(/class="ao-panel wb-col /g).length, 4);
  assert.deepEqual([...html.matchAll(/<h3 class="ao-panel-title"[^>]*>([^<]+)</g)].map((m) => m[1]), ["Planned", "In progress", "Needs you", "Done today"], "h3s under the view's h2");
  assert.ok(!html.includes("<h2"));
  assert.equal(html.match(/<button type="button" class="wb-card[ "]/g).length, 50, "every card is a real button");
  assert.equal(html.match(/data-agent="/g).length, 50, "and opens its agent's detail");
  assert.equal(html.match(/wb-card--needs/g).length, 2, "amber only for the agents waiting on you");
  const keys = [...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(keys).size, keys.length, "keys are unique, so focus survives re-renders");
  assert.ok(html.includes('<span class="wb-count is-needs">2</span>'));
  noRaw(html, "kanban");
});

test("kanban: every column has its own empty state; skeletons while loading; how to get plans when nobody has one", async () => {
  const { V } = await mods();
  const empty = V.kanbanPane({ k: { cols: { planned: [], doing: [], needs: [], done: [] } }, hint: true });
  assert.equal(empty.match(/ao-state ao-state--empty/g).length, 4);
  for (const text of ["Nothing planned yet. Plans come from each agent&#39;s own to-do list.", "Nothing in progress right now.", "Nobody is waiting on you.", "Nothing finished yet today."]) assert.ok(empty.includes(text), text);
  assert.match(empty, /ao-state--empty is-ok[^]*Nobody is waiting on you/, "nobody waiting is the good kind of empty");
  assert.ok(empty.includes("agent-office install --with-plans"));
  const loading = V.kanbanPane();
  assert.equal(loading.match(/aria-busy="true"/g).length, 4);
  assert.ok(loading.includes("Loading needs you…"));
  assert.match(V.failedPanel("plans", "Tasks"), /role="alert"[\s\S]*Couldn&#39;t load today&#39;s plans[\s\S]*data-wb-retry/);
  assert.match(V.failedPanel("state", "Tasks"), /data-retry/);
  assert.match(V.failedPanel("timeline", "Agents over the day"), /data-day-retry/);
});

// ---------- projects ----------
test("projects: a card per project with its goal, progress, spend today, waited on you, and agents with state and cost", async () => {
  const { B, V, O } = await mods();
  const { snap, now } = demo();
  const colors = O.projectColors(snap.agents), cards = B.projects(snap, { now, colors });
  assert.deepEqual(cards.map((p) => [p.project, `${p.done}/${p.total}`, p.doing, p.spend, p.waited]),
    [["supermarket-pos", "14/25", 3, "$8.52", "31m"], ["checkout-api", "9/20", 3, "$4.29", "21m"], ["docs-site", "3/5", 1, "$0.91", "0m"]]);
  const sp = cards[0];
  assert.deepEqual(sp.agents.map((a) => [a.name, a.state, a.cost]), [["receipt printer", "needs", "$1.12"], ["inventory sync", "working", "$2.10"], ["basket bill", "working", "$3.84"], ["login fix", "idle", "$1.46"]]);
  assert.equal(sp.goals.length, 4);
  assert.ok(sp.goals.some((g) => g.text.startsWith("Basket bill rounding: totals are off by a cent")), "missions, IDE tags stripped");
  assert.equal(sp.color, colors.get("supermarket-pos"));
  const noTelemetry = { ...snap, totals: { ...snap.totals, periods: { today: { days: 1, cost: 0, requests: 0, tokensByType: {} } } } };
  assert.equal(B.projects(noTelemetry, { now })[0].spend, "No cost data", "never a misleading $0.00");
  // Telemetry off on one project's machines only: that card says so, like its agents, while the others keep their spend.
  const oneOff = { ...snap, agents: snap.agents.map((a) => (a.project === "docs-site" ? { ...a, requests: 0, cost: 0 } : a)) };
  assert.deepEqual(B.projects(oneOff, { now }).map((p) => [p.project, p.spend, p.agents.map((a) => a.cost)]), [["supermarket-pos", "$8.52", ["$1.12", "$2.10", "$3.84", "$1.46"]],
    ["checkout-api", "$4.29", ["$2.05", "$1.38", "$0.86"]], ["docs-site", "No cost data", ["No cost data"]]]);

  const html = V.projectsPane({ cards, now });
  assert.equal(html.match(/<section class="ao-panel wb-proj"/g).length, 3);
  for (const s of ["Last activity 15:41", ">Goal<", "<b>14 of 25</b> done today · 3 in progress", "Spent today", "$8.52", "Waited on you", 'aria-label="supermarket-pos: 14 of 25 done, 3 in progress"', "Needs you · 4m"]) assert.ok(html.includes(s), s);
  assert.equal(html.match(/class="wb-agent" data-agent=/g).length, 8, "every agent opens its detail");
  assert.match(html, /class="cc-clamp" title="basket bill: Basket bill rounding/, "goals clamp to 2 lines with the whole mission to hover");
  noRaw(html, "projects");
  assert.match(V.projectsPane({ cards: [] }), /No projects today yet/);
  assert.equal(V.projectsPane().match(/aria-busy="true"/g).length, 3);
});

// ---------- swimlanes ----------
test("swimlanes: a row per agent from the state-change log, labelled segments, wait tags, a now line, totals and an aria-label", async () => {
  const { B, V, O } = await mods();
  const { snap, timeline, now } = demo();
  const colors = O.projectColors(snap.agents), L = B.swimlanes(timeline, snap, { now, colors, px: 1400 });
  assert.deepEqual([L.range, L.nowLabel, L.ticks.length], ["08:00 to 16:00", "15:42", 9]);
  assert.ok(Math.abs(L.now - (7 * 60 + 42) / (8 * 60)) < 1e-9, "the now line at 15:42");
  assert.deepEqual(L.rows.map((r) => r.project), ["supermarket-pos", "supermarket-pos", "supermarket-pos", "supermarket-pos", "checkout-api", "checkout-api", "checkout-api", "docs-site"], "grouped by project");
  const row = (name) => L.rows.find((r) => r.name === name);
  const inv = row("inventory sync");
  assert.equal(inv.totals, "5h 51m active · 12m waited · 19m idle");
  assert.deepEqual(inv.items.filter((s) => s.tag).map((s) => s.tag.label), ["waited 12m"], "a wait too short for its label gets a tag");
  assert.equal(inv.items.find((s) => s.k === "working" && s.label).label, "1h 19m", "working spells of an hour or more show their length");
  assert.ok(inv.items.filter((s) => s.k === "working").every((s) => !s.label || s.w * 8 * 60 >= 60), "and only those");
  assert.equal(inv.aria, "inventory sync, supermarket-pos, Working now. Idle 09:20 to 09:21, 1m. Working 09:21 to 10:40, 1h 19m. Waiting on you 10:40 to 10:52, 12m. " +
    "Working 10:52 to 12:12, 1h 20m. Idle 12:12 to 12:30, 18m. Working since 12:30, 3h 12m. Today: 5h 51m active, 12m waited on you, 19m idle.");
  const hook = row("webhook retries");
  assert.deepEqual(hook.items.at(-1), { ...hook.items.at(-1), k: "offline", label: "offline · last seen 12:05", title: "Offline from 12:35, last seen 12:05" });
  assert.match(hook.aria, /, Offline now\. .*Offline from 12:35, last seen 12:05\./);
  // The wait still going runs on to now and says "waiting".
  assert.deepEqual(row("refund flow").items.at(-1).tag, { x: row("refund flow").items.at(-1).tag.x, label: "waiting 9m" });
  assert.match(row("refund flow").aria, /Waiting on you since 15:33, 9m\. Today: 4h 32m active, 9m waited on you, 21m idle\.$/);
  assert.equal(row("login fix").items.find((s) => s.k === "idle" && s.label).label, "idle 31m");
  assert.ok(L.rows.every((r) => r.items.every((s) => s.x >= 0 && s.x + s.w <= L.now + 1e-9)), "nothing past now");
  // Narrow track: fewer labels fit.
  const narrow = B.swimlanes(timeline, snap, { now, px: 300 });
  assert.ok(narrow.rows.flatMap((r) => r.items).filter((s) => s.label).length < L.rows.flatMap((r) => r.items).filter((s) => s.label).length);

  const html = V.lanesPane({ L });
  assert.equal(html.match(/class="wb-lane" role="group" aria-label="/g).length, 8, "each row has an aria-label summary");
  assert.equal(html.match(/class="wb-lane-name" data-agent=/g).length, 8, "each name opens the agent");
  for (const k of ["working", "needs", "idle", "offline"]) assert.ok(html.includes(`wb-seg wb-seg--${k}`), k);
  assert.match(html, /<ul class="wb-legend" aria-label="Legend">(<li><span class="wb-sw wb-seg--\w+"><\/span><svg[^]*?<\/svg>\w[\w ]*<\/li>){4}<li><span class="wb-sw wb-sw--now"><\/span>Now<\/li><\/ul>/, "a legend with icons");
  assert.ok(html.includes("Now 15:42") && html.includes("--now:"));
  assert.ok(html.includes('class="wb-track" aria-hidden="true"'), "the drawing is hidden; the row's label tells it");
  assert.match(html, /<h3 class="ao-panel-title" id="wb-lanes-title">Agents over the day<\/h3>/, "an h3 under the view's h2, not a second h2");
  noRaw(html, "swimlanes");
  assert.equal(B.swimlanes({ buckets: [{ t: new Date(now).toISOString(), working: 0, waiting: 0, idle: 0 }], sessions: [] }, snap, { now }), null);
  assert.match(V.lanesPane({ L: null }), /No activity today yet/);
  assert.match(V.lanesPane({ loading: true }), /aria-busy="true"[\s\S]*Loading today&#39;s timeline/);
});

test("swimlanes: never past the data's own time; the running segment goes on only while the stream and the timeline are live", async () => {
  const { B } = await mods();
  const { snap, timeline, now } = demo();
  const later = now + 50 * M, totals = (L) => L.rows.map((r) => r.totals), row = (L, name) => L.rows.find((r) => r.name === name);
  const L0 = B.swimlanes(timeline, snap, { now, px: 1400 });
  // The browser's clock runs on but the snapshot is from 15:42: nothing grows past it, whatever the caller says.
  const L1 = B.swimlanes(timeline, snap, { now: later, px: 1400 });
  assert.deepEqual(totals(L1), totals(L0), "capped at the snapshot's own time");
  assert.ok(L1.rows.every((r) => r.items.every((s) => s.x + s.w < L1.now - 0.05)), "every bar stops 50 minutes short of the now line");
  assert.match(row(L1, "refund flow").aria, /Waiting on you since 15:33, 9m\./);
  // Live: a newer snapshot lets the running segment go on to its time (the refund flow still waits).
  const fresh = { ...snap, t: new Date(now + 5 * M).toISOString() };
  const L2 = B.swimlanes(timeline, fresh, { now: now + 5 * M, px: 1400 });
  assert.match(row(L2, "refund flow").aria, /Waiting on you since 15:33, 14m\. Today: 4h 32m active, 14m waited on you/);
  // Not live (the stream or the timeline is behind): no running on, and the rows say when their state was seen.
  const L3 = B.swimlanes(timeline, fresh, { now: now + 5 * M, live: false, px: 1400 });
  assert.deepEqual(totals(L3), totals(L0));
  assert.match(row(L3, "refund flow").aria, /^refund flow, checkout-api, Needs you at 15:47\. .*Waiting on you since 15:33, 9m\./);
  // The timeline is shown "As of" an earlier time: nothing past it, even with a live stream.
  const L4 = B.swimlanes(timeline, fresh, { now: now + 5 * M, live: false, until: hhmm(15, 0), px: 1400 });
  assert.match(row(L4, "refund flow").aria, /Working 12:20 to 15:00, 2h 40m\. Today: 3h 59m active, 0m waited on you, 21m idle\.$/);
  assert.ok(L4.rows.every((r) => r.items.every((s) => s.x + s.w <= (hhmm(15, 0) - hhmm(8, 0)) / (8 * 60 * M) + 1e-9)), "no bar past 15:00");
});

test("swimlanes: wait tags never cover each other; an ended session says so", async () => {
  const { B } = await mods();
  const now = hhmm(15, 0), t = (h, m) => new Date(hhmm(h, m)).toISOString();
  const seg = (state, a, b, extra = {}) => ({ state, from: t(...a), to: t(...b), ...extra });
  const timeline = { to: new Date(now).toISOString(), buckets: [{ t: t(8, 0), working: 1, waiting: 0, idle: 0 }], sessions: [{ session: "s", name: "shop · till", project: "shop", label: "till",
    segments: [seg("working", [8, 0], [9, 0]), seg("waiting", [9, 0], [9, 3]), seg("working", [9, 3], [9, 6]), seg("waiting", [9, 6], [9, 9]), seg("working", [9, 9], [12, 0]),
      seg("offline", [12, 0], [15, 0], { lastContact: t(12, 0) })] }] };
  const r = B.swimlanes(timeline, { agents: [] }, { now, px: 900 }).rows[0];
  assert.equal(r.items.filter((s) => s.tag).length, 1, "the second wait's tag would cover the first's");
  assert.equal(r.items.at(-1).label, "session ended");
  assert.match(r.aria, /^till, shop\. .*Session ended at 12:00\./, "no live state for a session the snapshot doesn't have");
});

// ---------- text, escaping and both themes ----------
test("board markup: escaped, no raw names; the frame has a segmented Kanban / Projects / Swimlanes switch", async () => {
  const { B, V } = await mods();
  const { snap, board, now } = demo();
  const evil = "<img src=x onerror=alert(1)>";
  const bad = { ...snap, agents: snap.agents.map((a) => ({ ...a, name: evil, label: evil, project: evil, mission: evil })) };
  const badBoard = { ...board, plans: board.plans.map((p) => ({ ...p, open: p.open.map((x) => ({ ...x, text: evil })) })) };
  const html = V.kanbanPane({ k: B.kanban(bad, badBoard, { now }) }) + V.projectsPane({ cards: B.projects(bad, { now }), now }) + V.summaryPanel({ s: B.summary(bad, { now }) });
  assert.ok(!html.includes("<img"), "escaped");
  const frame = V.frame({ view: "projects" });
  assert.match(frame, /role="radiogroup" aria-label="Board view"/);
  assert.deepEqual([...frame.matchAll(/data-value="(\w+)"/g)].map((m) => m[1]), ["kanban", "projects", "swimlanes"]);
  assert.match(frame, /aria-checked="true" tabindex="0" data-value="projects"/);
  assert.match(frame, /data-wb-pane="kanban" hidden[\s\S]*data-wb-pane="projects">[\s\S]*data-wb-pane="swimlanes" hidden/);
  assert.equal(B.viewOf("bogus"), "kanban");
  assert.match(B.dayTitle(new Date(2026, 9, 23).getTime()), /^Friday, Oct 23$/);
});

// ---------- the board in the shell ----------
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
    return { status: 200, ok: true, json: async () => json(out) };
  };
  const sources = [];
  class ES { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } }
  return { fetch, EventSource: ES, calls, sources };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settings = { offlineAfterMin: 30, dailyBudgetUsd: 25, notifyOnWaiting: false, aliases: {}, demo: true, teamMode: false, viewer: "mk" };
/** The board's agents in a fixture: active today, or still waiting on you. Just after midnight the demo's early agents
 *  fall in yesterday, so the DOM tests count from the fixture. */
const onBoard = (a) => new Date(a.updated).toDateString() === new Date().toDateString() || a.state === "waiting";

async function boardShell(routes, hash = "#/board") {
  const dom = withDom(), D = demo(Date.now()), win = fakeWindow(hash);
  const srv = server({ "/api/state": { ...D.snap, settings }, "/api/timeline": D.timeline, "/api/board": D.board, ...routes(D) });
  const { createShell } = await pub("shell.js");
  const shell = createShell({ doc: dom.document, win, fetch: srv.fetch, EventSource: srv.EventSource });
  const body = dom.document.body, page = body.querySelector('[data-screen="board"]');
  const q = (s) => page.querySelector(s), all = (s) => page.querySelectorAll(s);
  return { dom, D, win, srv, shell, body, page, q, all, active: () => dom.document.activeElement, pane: (v) => q(`[data-wb-pane="${v}"]`) };
}

test("board DOM: loads, Kanban from /api/board, cards open the agent's detail and focus comes back, chips dim, views switch", async () => {
  let t = null;
  try {
    t = await boardShell((D) => ({ "/api/agents/demo-refund": D.detail("demo-refund") }));
    const { q, all, srv, shell, page, pane, body, active } = t;
    assert.equal(page.hidden, false);
    assert.equal(q('[data-wb="summary"]').querySelector("section").getAttribute("aria-busy"), "true", "loading before any data");
    assert.equal(pane("kanban").querySelectorAll('[aria-busy="true"]').length, 4);
    await shell.ready;
    await tick(); await tick();
    assert.ok(srv.calls.some((c) => c.url === "/api/board" && c.opts.headers["X-Requested-With"] === "agent-office"));
    assert.match(q(".wb-sub").textContent, /^From every agent's own to-do list · \w+day, [A-Z][a-z]{2} \d{1,2}$/);
    assert.match(q(".wb-sum-text").textContent, /^\d agents? (in|across) \d projects? completed \d+ of \d+ planned tasks/);
    assert.equal(q("[data-wb-copy]").getAttribute("data-copy"), q(".wb-sum-text").textContent);
    assert.equal(all(".wb-kpi").length, 6);
    assert.deepEqual(all(".wb-col").map((c) => c.querySelector(".ao-panel-title").textContent), ["Planned", "In progress", "Needs you", "Done today"]);
    assert.equal(q(".wb-col--needs").querySelectorAll(".wb-card").length, 2);
    assert.equal(q("#wb-view-h").textContent, "Tasks by status");

    // A card opens its agent's detail over the board; closing it puts focus back on the card.
    const card = q(".wb-col--needs").querySelector('[data-agent="demo-refund"]');
    card.focus();
    card.click();
    const sheet = body.querySelector('[data-dialog="agent"]');
    assert.equal(sheet.open, true);
    assert.ok(sheet.querySelector(".ad-back").textContent.includes("Back to work board"));
    sheet.querySelector("[data-close]").click();
    assert.equal(active().getAttribute("data-key"), card.getAttribute("data-key"));

    // The answer reached the receipt printer: its card leaves Needs you at once, from the live data, and moves to In
    // progress (that move is checked at 15:42 in the kanban test; just after midnight today's board has no step of its).
    const es = srv.sources[0], { B } = await mods();
    const moved = { ...t.D.snap, agents: t.D.snap.agents.map((a) => (a.session === "demo-receipt" ? { ...a, state: "working", waitingSince: null, question: null, updated: new Date().toISOString() } : a)) };
    es.onmessage({ data: JSON.stringify(moved) });
    const k = B.kanban(moved, t.D.board, { now: Date.now() });
    assert.equal(q(".wb-col--needs").querySelectorAll(".wb-card").length, 1);
    assert.equal(!!q(".wb-col--doing").querySelector('[data-agent="demo-receipt"]'), k.cols.doing.some((c) => c.session === "demo-receipt"));
    es.onmessage({ data: JSON.stringify(t.D.snap) });

    // The top bar's chips dim agents in other states here too.
    const chip = body.querySelector('[data-chip="needs"]');
    chip.click();
    const lit = all(".wb-card").filter((c) => !c.classList.contains("is-dim"));
    assert.deepEqual([...new Set(lit.map((c) => c.getAttribute("data-agent")))].sort(), ["demo-receipt", "demo-refund"], "every card of the agents waiting on you, and only theirs");
    assert.equal(lit.filter((c) => c.classList.contains("wb-card--needs")).length, 2);
    chip.click();
    assert.equal(all(".wb-card.is-dim").length, 0);

    // Projects, then Swimlanes, from the segmented switch.
    q(".wb-views").querySelector('[data-value="projects"]').click();
    assert.equal(pane("kanban").hidden, true);
    assert.equal(pane("projects").hidden, false);
    assert.equal(pane("projects").querySelectorAll(".wb-proj").length, new Set(t.D.snap.agents.filter((a) => onBoard(a)).map((a) => a.project)).size);
    assert.equal(q("#wb-view-h").textContent, "Projects");
    q(".wb-views").querySelector('[data-value="swimlanes"]').click();
    const lanes = pane("swimlanes").querySelectorAll('.wb-lane[role="group"]');
    assert.equal(lanes.length, t.D.timeline.sessions.length, "a row per session with activity today");
    assert.ok(lanes.every((l) => /^[\w ]+, [\w-]+, (Working|Needs you|Idle|Offline) now\. .+ Today: .+ active, .+ waited on you, .+ idle\.$/.test(l.getAttribute("aria-label"))));
    assert.ok(pane("swimlanes").querySelector(".wb-legend"));

    // Stale: the stream drops; the board keeps its data, dimmed, with "As of".
    es.onerror();
    assert.match(q('[data-wb="note"]').textContent, /^As of \d\d:\d\d$/);
    assert.ok(pane("swimlanes").classList.contains("ao-stale"));
    assert.match(q('[data-wb="summary"]').textContent, /As of \d\d:\d\d/);
    es.onmessage({ data: JSON.stringify(t.D.snap) });
    assert.equal(q('[data-wb="note"]').textContent, "");
    assert.equal(pane("swimlanes").classList.contains("ao-stale"), false);
    q(".wb-views").querySelector('[data-value="kanban"]').click();
    shell.destroy();
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});

test("board DOM: a failed plans load says so with Retry; a failed timeline too; Copy summary shows a toast", async () => {
  let t = null, boardUp = false, tlUp = false;
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    t = await boardShell((D) => ({ "/api/board": () => (boardUp ? D.board : undefined), "/api/timeline": () => (tlUp ? D.timeline : undefined) }));
    const { q, pane, shell, active } = t;
    await shell.ready;
    await tick(); await tick();
    assert.match(pane("kanban").textContent, /Couldn't load today's plans\. The server didn't answer\./);
    assert.ok(pane("kanban").querySelector('[role="alert"]'));
    assert.ok(q(".wb-sum-text"), "the summary comes from the live data, so it still shows");
    boardUp = true;
    const retry = pane("kanban").querySelector("[data-wb-retry]");
    retry.focus();
    retry.click();
    await tick(); await tick();
    assert.equal(pane("kanban").querySelectorAll(".wb-col").length, 4);
    assert.ok(t.body.contains(active()), "focus stays on the page");

    // Swimlanes: the timeline failed, so its error, with the day panel's Retry.
    q(".wb-views").querySelector('[data-value="swimlanes"]').click();
    assert.match(pane("swimlanes").textContent, /Couldn't load today's timeline/);
    tlUp = true;
    pane("swimlanes").querySelector("[data-day-retry]").click();
    await tick(); await tick();
    assert.equal(pane("swimlanes").querySelectorAll(".wb-lane[role]").length, t.D.timeline.sessions.length);

    // Copy summary: copied (the clipboard works here), then a toast says so.
    let copied = null;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (s) => { copied = s; } } } });
    q("[data-wb-copy]").click();
    await tick(); await tick();
    assert.equal(copied, q(".wb-sum-text").textContent);
    assert.equal(q('[data-wb="toasts"]').querySelector(".ao-toast-title").textContent, "Summary copied");
    assert.equal(q('[data-wb="toasts"]').getAttribute("aria-hidden"), "true", "the copy itself is announced; the toast doesn't repeat it");
    shell.destroy();
  } finally {
    if (nav) Object.defineProperty(globalThis, "navigator", nav); else delete globalThis.navigator;
    t?.shell.destroy(); t?.dom.restore();
  }
});

test("board DOM: behind data is drawn as of then: a timeline that stops loading, and waits once the stream drops", async () => {
  let t = null, tlUp = true;
  const realNow = Date.now;
  try {
    t = await boardShell((D) => ({ "/api/timeline": () => (tlUp ? D.timeline : undefined) }));
    const { q, pane, shell, srv, D, body } = t;
    await shell.ready;
    await tick(); await tick();
    const es = srv.sources[0], view = (v) => q(".wb-views").querySelector(`[data-value="${v}"]`).click();
    const totals = () => pane("swimlanes").querySelectorAll(".wb-lane-tot").map((p) => p.textContent);
    const waits = () => q(".wb-col--needs").querySelectorAll(".wb-card-meta").map((m) => m.textContent);
    const rerender = () => { const chip = body.querySelector('[data-chip="idle"]'); chip.click(); chip.click(); };
    view("swimlanes");
    const before = totals();
    assert.equal(q('[data-wb="note"]').textContent, "");

    // Two minutes on, the stream still live but the timeline no longer loading: As of its last load, and no bar grows.
    tlUp = false;
    Date.now = () => realNow() + 2 * M;
    es.onmessage({ data: JSON.stringify({ ...D.snap, t: new Date(Date.now()).toISOString() }) });
    await tick(); await tick();
    assert.match(q('[data-wb="note"]').textContent, /^As of \d\d:\d\d$/);
    assert.ok(pane("swimlanes").classList.contains("ao-stale"));
    assert.deepEqual(totals(), before, "the running segments don't run on past the timeline's As of");
    assert.ok(pane("swimlanes").querySelectorAll('.wb-lane[role="group"]').every((l) => / at \d\d:\d\d\. /.test(l.getAttribute("aria-label"))), "'Needs you at 15:40', not 'now'");
    assert.equal(q('[data-wb="summary"]').querySelector(".ao-stale-note"), null, "the summary is live: no As of there");

    // Kanban: the stream drops; time goes on, but the waits stay as of the last data.
    view("kanban");
    es.onerror();
    const asOf = waits();
    Date.now = () => realNow() + 7 * M;
    rerender();
    assert.deepEqual(waits(), asOf, "'waiting 9m' doesn't keep counting while the data is behind");
    assert.match(q('[data-wb="note"]').textContent, /^As of \d\d:\d\d$/);
    shell.destroy();
  } finally { Date.now = realNow; t?.shell.destroy(); t?.dom.restore(); }
});

test("board DOM: a failed first load of the live data shows the error with Retry on the summary and the view", async () => {
  let t = null, up = false;
  try {
    t = await boardShell((D) => ({ "/api/state": () => (up ? { ...D.snap, settings } : undefined) }));
    const { q, pane, shell } = t;
    await shell.ready;
    await tick();
    assert.match(q('[data-wb="summary"]').textContent, /Couldn't load today's work/);
    assert.ok(q('[data-wb="summary"]').querySelector("[data-retry]") && pane("kanban").querySelector("[data-retry]"));
    up = true;
    q('[data-wb="summary"]').querySelector("[data-retry]").click();
    await tick(); await tick(); await tick();
    assert.ok(q(".wb-sum-text"));
    assert.equal(pane("kanban").querySelectorAll(".wb-col").length, 4);
    shell.destroy();
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});
