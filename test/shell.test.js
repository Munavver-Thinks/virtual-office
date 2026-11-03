"use strict";
// The Command Center shell (public/shell*.js): routes, top bar numbers, the rail, the day timeline and replay, toasts,
// onboarding, and the controller on a fake DOM fed with the real demo scenario.
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
/** The demo day as the browser gets it: a snapshot (with settings) and today's timeline, through JSON. */
function demo(now = at1542()) {
  const store = new Store({ getConfig: () => ({ offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 25 }) });
  loadScenario(store, now);
  const json = (x) => JSON.parse(JSON.stringify(x));
  return { snap: json(store.snapshot(now)), timeline: json(store.timeline(localDate(now), now)), now };
}
const RAW = ["PreToolUse", "PostToolUse", "PermissionRequest", "UserPromptSubmit", "SubagentStart", "SubagentStop", "TodoWrite", "<ide_", "<system-reminder"];

// ---------- routes and the top bar ----------
test("routes: every screen has a hash, anything else is the office; titles lead with the waiting count", async () => {
  const S = await pub("shell-model.js");
  const cases = [["", "office"], ["#", "office"], ["#/", "office"], ["#/board", "board"], ["#/BOARD", "board"], ["#/hall/standup", "hall"],
    ["#/cost?days=7", "cost"], ["#/alerts", "alerts"], ["#settings", "settings"], ["#/nope", "office"], [null, "office"]];
  for (const [hash, want] of cases) assert.equal(S.parseRoute(hash), want, String(hash));
  assert.deepEqual(S.SCREENS.map((s) => s.id), ["office", "board", "hall", "cost", "alerts", "settings"]);
  assert.equal(S.pageTitle("office", 2), "(2) Virtual Office");
  assert.equal(S.pageTitle("board", 0), "Work board · Virtual Office");
});

test("top bar: spend and tokens per period, the budget scaled by days, and no $0.00 without telemetry", async () => {
  const S = await pub("shell-model.js");
  const { snap } = demo();
  const today = S.costView(snap.totals, "today", 25);
  assert.equal(Math.round(today.spent * 100), 1372);
  assert.deepEqual([today.budget, today.period, today.noData], [25, "today", false]);
  const { tokensLine } = await pub("ui/format.js");
  assert.equal(tokensLine(today.tokens), "in 48.2k · out 1.21M · cache 92.4M");
  const week = S.costView(snap.totals, "7d", 25);
  assert.deepEqual([week.budget, week.period, Math.round(week.spent * 100)], [175, "in 7 days", 8410]);
  assert.equal(S.costView(snap.totals, "30d", 25).budget, 750);
  assert.equal(S.costView(snap.totals, "bogus", 25).period, "today", "unknown periods fall back to today");
  assert.equal(S.costView({ periods: { today: { days: 1, cost: 0, requests: 0, tokensByType: {} } } }, "today", 25).noData, true);
  assert.deepEqual(S.stateCounts(snap.totals), { working: 4, needs: 2, idle: 1, offline: 1 });
  const V = await pub("shell-view.js");
  assert.match(V.costBlock(S.costView({ periods: {} }, "7d", 25)), /No cost data in 7 days/);
  assert.match(V.costBlock(week), /\$84\.10.*48% of \$175 in 7 days/);
  assert.match(V.alertsBadge(2), /^2<span class="ao-sr"> agents need you<\/span>$/);
});

// ---------- right rail ----------
test("needs you now: longest wait first, the question in plain English, a relative target, the plan step", async () => {
  const S = await pub("shell-model.js");
  const { snap, now } = demo();
  const items = S.needsItems(snap.agents, { now });
  assert.deepEqual(items.map((i) => [i.name, i.project, i.host, Math.floor(i.waitMs / M)]),
    [["refund flow", "checkout-api", "thinkpad-x1", 9], ["receipt printer", "supermarket-pos", "studio-mac", 4]]);
  assert.deepEqual(items.map((i) => [i.text, i.target, i.what]),
    [["Wants permission to edit a file", ".env.production", "file"], ["Wants permission to run a command", "sudo apt install cups-filters", "command"]]);
  assert.deepEqual(items.map((i) => i.step), ["Plan step 4 of 9 · Add the refund webhook secret", "Plan step 3 of 6 · Install the printer filter package"]);
  const V = await pub("shell-view.js");
  const html = V.needsPanel({ items, status: "live" });
  assert.ok(html.includes("2 waiting") && html.includes("Longest wait first") && html.includes("waiting 9m"));
  assert.equal(html.match(/ao-btn--answer/g).length, 2, "one amber Answer per waiting agent, nothing else amber-buttoned");
  assert.ok(html.includes('data-jump="demo-refund"') && html.includes('aria-label="Jump to refund flow in the office"'));
  assert.ok(!html.includes("/Users/"), "no absolute paths");
  assert.match(V.needsPanel({ items: [], status: "live" }), /is-ok[\s\S]*Nobody is waiting on you\./);
  const stale = V.needsPanel({ items: [{ ...items[0], stale: true }], status: "live", offlineMin: 30 });
  assert.match(stale, /No news for over 30 min/);
  const evil = V.needsPanel({ items: [{ ...items[0], name: "<img src=x onerror=alert(1)>", target: "<script>x</script>" }] });
  assert.ok(!evil.includes("<img") && !evil.includes("<script>"), "escaped");
  // Project · machine stays on one line, cut with an ellipsis, the whole of it in a tooltip (like the name above it).
  assert.match(html, /<div class="ao-meta cc-oneline" title="checkout-api · thinkpad-x1">checkout-api · thinkpad-x1<\/div>/);
  assert.match(V.needsPanel({ items: [{ ...items[0], host: null, project: "a&b" }] }), /<div class="ao-meta cc-oneline" title="a&amp;b">a&amp;b<\/div>/, "no host: just the project, escaped");
});

test("today's progress: 26 of 50 done, one row per project in project colours, waited on you", async () => {
  const S = await pub("shell-model.js"), V = await pub("shell-view.js"), O = await pub("office3d-model.js");
  const { snap } = demo();
  const colors = O.projectColors(snap.agents), v = S.progressView(snap.totals, colors);
  assert.deepEqual([v.done, v.doing, v.planned, v.total, v.pct], [26, 7, 17, 50, 52]);
  assert.deepEqual(v.rows.map((r) => `${r.project} ${r.done}/${r.total}`), ["supermarket-pos 14/25", "checkout-api 9/20", "docs-site 3/5"]);
  assert.deepEqual(v.rows.map((r) => r.color), ["supermarket-pos", "checkout-api", "docs-site"].map((p) => colors.get(p)), "the same colours as the rooms");
  const html = V.progressPanel({ view: v });
  for (const s of ["of 50 planned tasks done", "52%", "26 done", "7 in progress", "17 planned", "14/25", "Waited on you <b>52m</b> today", 'href="#/board"']) assert.ok(html.includes(s), s);
  assert.match(html, /aria-label="supermarket-pos: 14 of 25 done, 3 in progress"/, "each bar has a text alternative");
  const empty = V.progressPanel({ view: S.progressView({}, colors) });
  assert.ok(empty.includes("No planned tasks today yet") && empty.includes("Nobody waited on you today"));
});

test("live activity: grouped by agent, newest first, last 3 actions in plain English with the file in mono", async () => {
  const S = await pub("shell-model.js"), V = await pub("shell-view.js");
  const { snap } = demo();
  const groups = S.activityGroups(snap.agents);
  assert.ok(groups.length >= 6);
  for (let i = 1; i < groups.length; i++) assert.ok(groups[i - 1].latest >= groups[i].latest, "newest first");
  assert.ok(groups.every((g) => g.actions.length >= 1 && g.actions.length <= 3));
  const basket = groups.find((g) => g.name === "basket bill");
  assert.deepEqual([basket.actions[0].lead, basket.actions[0].mono], ["Editing ", "BasketTotals.tsx"], "the open edit, present tense");
  assert.equal(basket.actions[0].full, "src/basket/BasketTotals.tsx", "relative to the git root");
  assert.deepEqual(S.actionParts({ text: "Ran tests", target: "npm test", icon: "terminal" }), { lead: "Ran tests ", mono: "npm test", full: "npm test" });
  assert.deepEqual(S.actionParts({ text: "Searched code for “x”", target: "x", icon: "search" }), { lead: "Searched code for “x”", mono: null, full: null });
  assert.deepEqual(S.actionParts({ text: "Started a sub-agent: Explore", target: "Explore", icon: "sub-agent" }).mono, null);
  const html = V.activityPanel({ groups });
  for (const raw of RAW) assert.ok(!html.includes(raw), `no ${raw}`);
  assert.ok(!html.includes("/Users/mk"), "no absolute paths");
  assert.match(html, /<button type="button" class="cc-feed-name" data-agent="demo-/, "names open the agent");
  // The screen-reader log: nothing on the first render, then only new actions.
  const seen = new Set();
  assert.deepEqual(S.freshLines(groups, seen, { first: true }), []);
  const next = [{ ...basket, actions: [{ key: "demo-basket:9999", lead: "Ran tests ", mono: "npm test", t: new Date().toISOString(), failed: true }, ...basket.actions] }];
  assert.deepEqual(S.freshLines(next, seen), ["basket bill: Ran tests npm test (failed)"]);
  assert.deepEqual(S.freshLines(next, seen), [], "announced once");
  assert.match(V.activityPanel({ groups: [] }), /No activity yet/);
});

test("panels: loading, error with Retry, and stale with the time of the last data", async () => {
  const V = await pub("shell-view.js"), S = await pub("shell-model.js");
  const asOf = new Date(new Date().setHours(15, 40, 0, 0));
  for (const [name, html] of [["needs", (o) => V.needsPanel({ items: [], ...o })], ["progress", (o) => V.progressPanel({ view: S.progressView({}, new Map()), ...o })], ["activity", (o) => V.activityPanel({ groups: [], ...o })]]) {
    assert.match(html({ status: "loading" }), /aria-busy="true"[\s\S]*ao-loading/, `${name} loading`);
    assert.match(html({ status: "error" }), /role="alert"[\s\S]*data-retry/, `${name} error`);
    assert.match(html({ status: "stale", asOf }), /As of 15:40/, `${name} stale`);
  }
  assert.ok(!V.activityPanel({ groups: [], status: "stale", asOf }).includes("cc-live-dot"), "no live dot while stale");
});

// ---------- day timeline and replay ----------
test("day ribbon: 08:00 to the end of this hour, 10-minute bars stacked by state, ending at now", async () => {
  const S = await pub("shell-model.js"), V = await pub("shell-view.js");
  const { timeline, now } = demo();
  const r = S.dayRange(timeline, now);
  assert.deepEqual([r.start, r.end], [hhmm(8, 0), hhmm(16, 0)]);
  const rb = S.ribbon(timeline, r);
  assert.ok(rb.bars.length > 40 && rb.bars.every((b) => b.x >= 0 && b.x + b.w <= (now - r.start) / (r.end - r.start) + 1e-9), "no bar past now");
  assert.ok(rb.bars.some((b) => b.waiting > 0) && rb.bars.some((b) => b.idle > 0));
  assert.ok(rb.bars.every((b) => b.working + b.waiting + b.idle <= 1 + 1e-9), "sized against the busiest bucket");
  assert.deepEqual(S.hourTicks(r).map((t) => t.label), ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]);
  assert.equal(S.hourTicks({ start: hhmm(0, 0), end: hhmm(16, 0) }).length, 9, "every second hour past 10 hours");
  assert.match(S.ribbonSummary(timeline, r), /^Today from 08:00 to 15:42\. At most \d agents? working at once, first at \d\d:\d\d\. Someone waited on you in \d+ of \d+ ten-minute periods\.$/);
  const html = V.dayBars(rb, r);
  assert.ok(html.includes("cc-seg--needs") && html.includes("cc-now"));
  assert.equal(S.dayRange({ buckets: [{ t: new Date().toISOString(), working: 0, waiting: 0, idle: 0 }] }, now), null, "no activity, no range");
  assert.match(V.dayState("error", false), /role="alert"[\s\S]*data-day-retry/);
  assert.match(V.dayState("live", false), /No activity today yet/);
  assert.match(V.dayMode({ replayAt: now - 60 * M }), /Replaying[\s\S]*Back to live/);
  assert.match(V.dayMode({ status: "error" }), /Not connected/);
});

test("replay: who was where at a past moment, from the state log; later sessions aren't there yet", async () => {
  const S = await pub("shell-model.js");
  const { snap, timeline } = demo();
  const at = (h, m) => Object.fromEntries(S.replayAgents(timeline, snap.agents, hhmm(h, m)).map((a) => [a.label, a.state]));
  const morning = at(9, 30);
  assert.deepEqual(Object.keys(morning).sort(), ["inventory sync", "login fix", "webhook retries"], "only sessions started by 09:30");
  assert.deepEqual([morning["login fix"], morning["webhook retries"]], ["working", "working"]);
  assert.equal(at(9, 15)["login fix"], "waiting", "waiting on the migration at 09:15");
  assert.equal(at(13, 0)["webhook retries"], "offline", "the build server went quiet after 12:05");
  const basket = S.replayAgents(timeline, snap.agents, hhmm(13, 42)).find((a) => a.label === "basket bill");
  assert.deepEqual([basket.state, new Date(basket.waitingSince).getHours(), new Date(basket.waitingSince).getMinutes()], ["waiting", 13, 40]);
  assert.equal(basket.gitRoot, "/Users/mk/code/supermarket-pos", "identity comes from the live agent");
  assert.equal(at(15, 41)["tokens page"], "working");
  assert.deepEqual(S.replayAgents(timeline, snap.agents, hhmm(7, 0)), [], "nobody before the first event");
});

// ---------- toasts ----------
test("toasts: an agent that starts waiting, once per question; on load only waits from the last 5 minutes", async () => {
  const S = await pub("shell-model.js"), V = await pub("shell-view.js");
  const { snap, now } = demo();
  assert.deepEqual(S.newWaiters(null, snap.agents, { now }).map((a) => a.label), ["receipt printer"], "9m is old news, 4m is fresh");
  const prev = new Map(snap.agents.map((a) => [a.session, S.waitKey(a)]));
  assert.deepEqual(S.newWaiters(prev, snap.agents, { now }), [], "nothing new");
  const asks = snap.agents.map((a) => (a.label === "rate limiter" ? { ...a, state: "waiting", waitingSince: new Date(now).toISOString() } : a));
  assert.deepEqual(S.newWaiters(prev, asks, { now }).map((a) => a.label), ["rate limiter"]);
  const again = snap.agents.map((a) => (a.label === "refund flow" ? { ...a, waitingSince: new Date(now).toISOString() } : a));
  assert.deepEqual(S.newWaiters(prev, again, { now }).map((a) => a.label), ["refund flow"], "a new question is a new wait");
  const receipt = snap.agents.find((a) => a.label === "receipt printer");
  const html = V.needsToast(receipt, S.waitKey(receipt));
  assert.ok(html.includes("receipt printer needs you") && html.includes("Wants permission to run a command · sudo apt install cups-filters"));
  assert.ok(html.includes("ao-toast--needs") && html.includes("ao-btn--answer") && html.includes(">Dismiss<"));
});

// ---------- onboarding and dialogs ----------
test("onboarding: masked token with copy, the settings.json snippet, listening; and a fallback when the token can't load", async () => {
  const V = await pub("shell-view.js");
  const setup = { token: "abcd1234efgh5678ijkl", url: "http://127.0.0.1:4380", snippet: '{\n  "hooks": {}\n}', teamMode: false };
  const html = V.onboarding(setup);
  assert.ok(html.includes("abcd••••••••ijkl") && html.includes('data-copy="abcd1234efgh5678ijkl"'));
  assert.ok(html.includes("~/.claude/settings.json") && html.includes("agent-office install") && html.includes("&quot;hooks&quot;"));
  assert.ok(html.includes("Listening for the first event…") && html.includes("cc-pulse"));
  assert.ok(!html.includes("--url"), "the team command only in team mode");
  const team = V.onboarding({ ...setup, teamMode: true, url: "https://office.example" });
  assert.ok(team.includes("agent-office install --url https://office.example --token abcd••••••••ijkl"));
  assert.ok(V.onboarding(null, { failed: true }).includes("Run <code>agent-office token</code> on the server"));
});

/** Every part of the answer dialog for agent a, as the shell would show it. */
function answerHTML(V, S, a, { q = a.question, now, sent = null } = {}) {
  const v = S.answerView(a, { q, sent, now });
  return { v, html: V.answerHead(a, { now, mode: v.mode }) + V.answerConvo(a, { q, now, sent, mode: v.mode }) + V.answerBox(v, a, q) + V.resumeBox(a) + V.answerFoot(v.mode, a) };
}

test("answer dialog: the conversation, the amber answer box while the hook waits, the terminal otherwise", async () => {
  const V = await pub("shell-view.js"), S = await pub("shell-model.js");
  const { snap, now } = demo();
  const receipt = snap.agents.find((a) => a.label === "receipt printer");
  const { v, html } = answerHTML(V, S, receipt, { now });
  assert.equal(v.mode, "form");
  for (const s of ["receipt printer needs you", "supermarket-pos · studio-mac · waiting 4m", "You · 12:50", "Try the CUPS filter route instead of raw ESC/POS.", "receipt printer · 15:38",
    "Wants permission to run a command", "sudo apt install cups-filters", "Working on step 3 of 6: Install the printer filter package",
    ">Approve once<", ">Allow for this session<", ">Deny<", "Or reply in your own words. Your text is sent with a “no” and the agent adjusts.", "Ctrl+Enter or ⌘+Enter sends it", ">Send reply<",
    "every later request to run a command in this session", "Prefer the terminal?", "claude --resume demo-receipt"]) assert.ok(html.includes(s), s);
  assert.match(html, new RegExp(`data-answer-form="${receipt.question.ask.id}"`));
  assert.match(html, /<button type="button" class="ao-btn ao-btn--primary" data-choice="approve">/, "Approve once is the teal primary");
  assert.match(html, /<button type="submit" class="ao-btn ao-btn--secondary" data-choice="reply" disabled>/, "Send reply waits for text");
  assert.match(html, /<label class="cc-reply-label" for="cc-reply">[\s\S]*<textarea class="cc-reply" id="cc-reply"/, "the reply has a real label");
  assert.ok(html.includes("cc-bubble--you") && html.includes("cc-bubble--agent") && html.includes('class="ao-code is-open"'), "teal you, amber agent, the whole command");
  assert.ok(!html.includes("ao-btn--answer"), "no amber buttons: amber is the Answer button that opened it");
  assert.ok(!html.includes("/Users/mk"), "no absolute paths");
  for (const raw of RAW) assert.ok(!html.includes(raw), `no ${raw}`);
  assert.ok(!answerHTML(V, S, { ...receipt, name: "<img src=x onerror=alert(1)>", label: null, task: "<script>x</script>" }, { now }).html.match(/<img|<script>/), "escaped");

  // refund flow: its hook waited and stopped, so the terminal; the file relative to the root and the size of the change.
  const refund = snap.agents.find((a) => a.label === "refund flow"), r = answerHTML(V, S, refund, { now });
  assert.deepEqual([r.v.mode, r.v.windowClosed], ["terminal", true]);
  for (const s of ["The in-app answer window has passed.", "Answer in the Claude Code terminal on <b>thinkpad-x1</b>.", ".env.production", "1 line added, 0 removed", "Prefer the terminal?"]) assert.ok(r.html.includes(s), s);
  assert.ok(!r.html.includes("data-choice") && !r.html.includes("/Users/mk"));
  // A question that came only from a notification: the terminal, and no window to speak of.
  const note = { ...receipt, question: { qkind: "notification", t: receipt.question.t, message: "Enter the production DB password" } }, n = answerHTML(V, S, note, { now });
  assert.deepEqual([n.v.mode, n.v.windowClosed], ["terminal", false]);
  assert.ok(n.html.includes("Enter the production DB password") && !n.html.includes("has passed") && !n.html.includes("data-choice"));
  // The last 2 seconds of the window take no answers, so the box goes before the server would refuse.
  assert.equal(S.answerView(receipt, { q: receipt.question, now: Date.parse(receipt.question.ask.until) - 1500 }).mode, "terminal");
  // Another answer box (the agent detail's) keeps its own ids.
  const ad = V.answerBox(v, receipt, receipt.question, { prefix: "ad-" });
  assert.ok(ad.includes('id="ad-reply"') && ad.includes('for="ad-reply"') && ad.includes('aria-describedby="ad-answer-session"') && !ad.includes('id="cc-reply"'));
});

// ---------- the controller on a fake DOM ----------
function fakeWindow() {
  const listeners = {};
  return {
    location: { hash: "", href: "/" },
    addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    go(hash) { this.location.hash = hash; for (const fn of listeners.hashchange || []) fn(); },
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
    return { status: 200, ok: true, json: async () => JSON.parse(JSON.stringify(out)) };
  };
  const sources = [];
  class ES { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } }
  return { fetch, EventSource: ES, calls, sources };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("shell DOM: loading, live data in the top bar and rail, filter chips, Jump, Answer, toasts, router, stale, replay", async () => {
  const dom = withDom();
  let shell = null;
  const settings = { offlineAfterMin: 30, dailyBudgetUsd: 25, notifyOnWaiting: true, aliases: {}, demo: true, teamMode: false, viewer: "mk" };
  const { snap, timeline } = demo(Date.now());
  const srv = server({ "/api/state": { ...snap, settings }, "/api/timeline": timeline, "/api/settings": (o) => ({ ...settings, body: JSON.parse(o.body) }) });
  const win = fakeWindow();
  try {
    const { createShell } = await pub("shell.js");
    shell = createShell({ doc: dom.document, win, fetch: srv.fetch, EventSource: srv.EventSource });
    const body = dom.document.body, q = (s) => body.querySelector(s), all = (s) => body.querySelectorAll(s);
    const text = (s) => q(s).textContent;
    const counts = () => all("[data-chip]").map((c) => `${c.getAttribute("data-chip")} ${c.querySelector(".ao-chip-count").textContent}`);

    assert.deepEqual(counts(), ["working ", "needs ", "idle ", "offline "], "no counts before data: zero would be a guess");
    assert.equal(q('[data-slot="needs"]').querySelector("section").getAttribute("aria-busy"), "true");
    assert.equal(text(".o3-hud-mode"), "Loading…");

    await shell.ready;
    await tick();
    assert.deepEqual(counts(), ["working 4", "needs 2", "idle 1", "offline 1"]);
    assert.equal(q(".cc-badge").hidden, false);
    assert.equal(text(".cc-badge"), "2 agents need you");
    // From the fixture: just after midnight "today" is only the part of the demo day since 00:00.
    const { tokensLine, money } = await pub("ui/format.js"), today = snap.totals.periods.today, tt = snap.totals;
    assert.equal(text(".cc-tokens"), `Tokens today: ${tokensLine(today.tokensByType)}`);
    assert.ok(text(".cc-cost").startsWith(money(today.cost)) && text(".cc-cost").includes("of $25 today"));
    assert.equal(q(".cc-avatar").getAttribute("aria-label"), "You: mk");
    assert.equal(text(".cc-demo"), "Demo data");
    assert.equal(dom.document.title, "(2) Virtual Office");
    assert.deepEqual(all(".cc-needs-name").map((n) => n.textContent), ["refund flow", "receipt printer"]);
    assert.ok(text('[data-slot="progress"]').includes(`of ${tt.tasksDone + tt.tasksInProgress + tt.tasksPending} planned tasks done`));
    assert.ok(all(".cc-feed-group").length >= 6);
    assert.equal(text(".o3-hud-mode"), "Live");
    assert.equal(srv.sources.length, 1, "the event stream is open");
    assert.ok(srv.calls.every((c) => c.opts.headers["X-Requested-With"] === "agent-office"), "every call sends the same-origin header");

    // The toast for the agent that just started waiting (receipt printer, 4m); refund flow (9m) is old news.
    assert.deepEqual(all("[data-toast]").map((t) => t.querySelector(".ao-toast-title").textContent), ["receipt printer needs you"]);
    assert.equal(q(".cc-toasts").getAttribute("aria-live"), "polite");

    // Filter chips: aria-pressed, and the others dim to 16% in the office.
    const needsChip = q('[data-chip="needs"]');
    needsChip.click();
    assert.equal(needsChip.getAttribute("aria-pressed"), "true");
    const opacity = () => Object.fromEntries(all(".o3-a").map((li) => [li.querySelector(".o3-agent").getAttribute("data-session"), li.style.opacity || "1"]));
    assert.deepEqual(Object.entries(opacity()).filter(([, o]) => o === "1").map(([s]) => s).sort(), ["demo-receipt", "demo-refund"]);
    assert.ok(Object.values(opacity()).filter((o) => o === "0.16").length === 6);
    needsChip.click();
    assert.ok(Object.values(opacity()).every((o) => o === "1"));

    // Period switch: 7 days scales the budget.
    q('[data-value="7d"]').click();
    assert.match(text(".cc-cost"), /of \$175 in 7 days/);
    assert.match(text(".cc-tokens"), /^Tokens in 7 days: /);
    q('[data-value="today"]').click();

    // Jump: zooms to the agent, pulses its tag and moves focus to it.
    q('[data-jump="demo-refund"]').click();
    const refundBtn = all(".o3-agent").find((b) => b.getAttribute("data-session") === "demo-refund");
    assert.ok(refundBtn.parentNode.classList.contains("is-pulse"));
    assert.equal(dom.document.activeElement, refundBtn);

    // Answer: the dialog, then Close returns focus to the button that opened it.
    const answer = q('[data-answer="demo-refund"]');
    answer.focus();
    answer.click();
    const dlg = q('[data-dialog="answer"]');
    assert.equal(dlg.open, true);
    assert.equal(text("#cc-answer-h"), "refund flow needs you");
    assert.ok(dlg.textContent.includes("Answer in the Claude Code terminal on thinkpad-x1."));
    dlg.querySelector("[data-close]").click();
    assert.equal(dlg.open, false);
    assert.equal(dom.document.activeElement.getAttribute("data-answer"), "demo-refund");

    // The agent detail from the activity feed (its own tests are in test/agent-detail.test.js).
    const feedName = q(".cc-feed-name");
    feedName.focus();
    feedName.click();
    const sheet = q('[data-dialog="agent"]');
    assert.equal(sheet.open, true);
    assert.equal(dom.document.activeElement.getAttribute("data-key"), "ad-back", "focus starts on Back to office");
    sheet.querySelector("[data-close]").click();
    assert.equal(dom.document.activeElement, feedName, "and goes back where it came from");

    // A new waiter on the stream: a second toast; Dismiss removes it; an answered agent's toast goes by itself.
    const es = srv.sources[0], now = Date.now();
    const asks = { ...snap, agents: snap.agents.map((a) => (a.label === "rate limiter" ? { ...a, state: "waiting", waitingSince: new Date(now).toISOString(), question: { qkind: "permission", tool: "Bash", target: "npm install -D autocannon" } } : a)) };
    es.onmessage({ data: JSON.stringify(asks) });
    assert.deepEqual(all("[data-toast]").map((t) => t.querySelector(".ao-toast-title").textContent), ["rate limiter needs you", "receipt printer needs you"]);
    all("[data-dismiss]")[0].click();
    assert.equal(all("[data-toast]").length, 1);
    es.onmessage({ data: JSON.stringify({ ...asks, agents: asks.agents.map((a) => (a.label === "receipt printer" ? { ...a, state: "working", waitingSince: null, question: null } : a)) }) });
    assert.equal(all("[data-toast]").length, 0, "answered: its toast goes");
    es.onmessage({ data: JSON.stringify(asks) });
    assert.equal(all("[data-toast]").length, 1, "the dismissed wait stays dismissed; the receipt printer's new wait shows");

    // New actions are announced through the log.
    const withStep = { ...asks, agents: asks.agents.map((a) => (a.label === "tokens page" ? { ...a, recent: [...a.recent, { id: 99999, kind: "tool", t: new Date().toISOString(), tool: "Read", target: "/Users/mk/code/docs-site/README.md", status: "ok" }] } : a)) };
    es.onmessage({ data: JSON.stringify(withStep) });
    assert.equal(q("[data-log]").lastElementChild.textContent, "tokens page: Read README.md");

    // Router: screens, aria-current, title and focus.
    win.go("#/board");
    assert.equal(q('[data-screen="board"]').hidden, false);
    assert.equal(q('[data-screen="office"]').hidden, true);
    assert.equal(q('[data-nav="board"]').getAttribute("aria-current"), "page");
    assert.equal(q('[data-nav="office"]').getAttribute("aria-current"), null);
    assert.equal(dom.document.title, "(2) Work board · Virtual Office");
    assert.equal(dom.document.activeElement.id, "cc-board-h");
    win.go("#/settings?section=budgets");
    assert.equal(q('[data-nav="settings"]').getAttribute("aria-current"), "page");
    assert.equal(q("#st-b-daily").getAttribute("value"), "25");
    win.go("#/nowhere");
    assert.equal(q('[data-screen="office"]').hidden, false);

    // Stale: the stream drops; everything keeps its data, dimmed, with "As of".
    es.onerror();
    assert.match(text(".o3-hud-mode"), /^As of \d\d:\d\d$/);
    assert.ok(all(".ao-stale-note").length >= 3 && q(".cc-top").classList.contains("is-stale"));
    assert.deepEqual([q(".cc-chips"), q(".cc-spend")].map((el) => el.classList.contains("ao-stale")), [true, true], "the top bar's counts and spend go gray like a stale panel, the chips keeping their focus ring");
    es.onmessage({ data: JSON.stringify(asks) });
    assert.equal(text(".o3-hud-mode"), "Live");
    assert.deepEqual([q(".cc-chips"), q(".cc-spend")].map((el) => el.classList.contains("ao-stale")), [false, false]);

    // Replay: the scrubber shows the office at a past moment; Back to live returns.
    const scrub = q(".cc-scrub");
    assert.equal(scrub.hasAttribute("disabled"), false);
    scrub.value = String(Math.floor(Number(scrub.getAttribute("max")) / 2)); // halfway through the day so far, whatever the hour
    scrub.dispatchEvent({ type: "input" });
    assert.match(text(".o3-hud-mode"), /^Replaying \d\d:\d\d$/);
    assert.match(scrub.getAttribute("aria-valuetext"), /^Replaying \d\d:\d\d$/);
    assert.ok(q(".cc-day").classList.contains("is-replay"));
    q("[data-live]").click();
    assert.equal(text(".o3-hud-mode"), "Live");
    assert.equal(scrub.value, scrub.getAttribute("max"));

    shell.destroy();
    assert.equal(body.childNodes.length, 0);
    assert.equal(es.closed, true);
  } finally { shell?.destroy(); dom.restore(); }
});

test("shell DOM: an empty office shows onboarding from /api/setup; a failed first load shows errors with Retry", async () => {
  const dom = withDom();
  let shell = null;
  const settings = { offlineAfterMin: 30, dailyBudgetUsd: 0, aliases: {}, teamMode: true, viewer: null };
  const empty = { t: new Date().toISOString(), agents: [], totals: { working: 0, waiting: 0, idle: 0, offline: 0, periods: {}, projects: [] } };
  const setup = { token: "abcd1234efgh5678ijkl", url: "https://office.example", snippet: "{}", teamMode: true };
  let up = false;
  const srv = server({ "/api/state": () => (up ? { ...empty, settings } : undefined), "/api/timeline": () => (up ? { buckets: [], sessions: [] } : undefined), "/api/setup": setup });
  try {
    const { createShell } = await pub("shell.js");
    shell = createShell({ doc: dom.document, win: fakeWindow(), fetch: srv.fetch, EventSource: srv.EventSource });
    const body = dom.document.body, q = (s) => body.querySelector(s);
    await shell.ready;
    await tick();
    assert.equal(q(".o3-hud-mode").textContent, "Can't reach the server");
    assert.equal(q(".o3-hud-meta").textContent, "", "no 0 rooms · 0 agents when nothing loaded");
    assert.equal(body.querySelectorAll("[data-retry]").length, 4, "the office and all three panels offer Retry");
    assert.match(q(".cc-day-state").textContent, /Couldn't load today's timeline/);
    assert.equal(q(".cc-day-mode").textContent, "Not connected");

    up = true;
    const retry = q('[data-slot="needs"]').querySelector("[data-retry]");
    retry.focus();
    retry.click();
    await tick(); await tick();
    assert.equal(dom.document.activeElement.id, "cc-needs-title", "the Retry button went: focus lands on its panel's heading, not the page");
    assert.equal(q(".o3-hud-mode").textContent, "Live");
    assert.equal(q(".cc-onboard").hidden, false);
    assert.ok(srv.calls.some((c) => c.url === "/api/setup" && c.opts.headers["X-Requested-With"] === "agent-office"));
    assert.ok(q(".cc-onboard").textContent.includes("abcd••••••••ijkl"), "the token is masked on screen");
    assert.ok(q(".cc-onboard").textContent.includes("agent-office install --url https://office.example"));
    assert.equal(q(".o3-empty").hidden, true, "the office's own empty card makes way for onboarding");
    assert.ok(q('[data-slot="needs"]').textContent.includes("Nobody is waiting on you."));
    assert.ok(q('[data-slot="activity"]').textContent.includes("No activity yet"));
    assert.equal(q(".cc-avatar").getAttribute("aria-label"), "Team workspace");
    assert.equal(q(".cc-badge").hidden, true);
    shell.destroy();
  } finally { shell?.destroy(); dom.restore(); }
});

// ---------- M4 fix round 1 ----------
test("onboarding: the token is masked inside the snippet too; a returning user gets 'No agents in the last 24 hours'", async () => {
  const V = await pub("shell-view.js");
  const token = "abcd1234efgh5678ijkl", snippet = JSON.stringify({ env: { OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}` } }, null, 2);
  const html = V.onboarding({ token, url: "https://office.example", snippet, teamMode: true });
  assert.ok(!html.replace(/data-copy="[^"]*"/g, "").includes(token), "the whole token only in Copy buttons");
  assert.ok(html.includes("Bearer abcd••••••••ijkl"), "masked in the snippet on screen");
  assert.match(html, /data-copy="[^"]*Bearer abcd1234efgh5678ijkl/, "Copy snippet still copies the real token");
  const back = V.onboarding({ token, url: "http://127.0.0.1:4380", snippet, teamMode: false }, { lastEvent: new Date(2026, 9, 12, 15, 40).toISOString() });
  assert.ok(back.includes("No agents in the last 24 hours") && back.includes("Oct 12 at 15:40") && !back.includes("Connect your first agent"));
  assert.match(back, /<details class="cc-more-setup"><summary>Connecting another machine\?<\/summary>[\s\S]*Copy your workspace token/);
  assert.ok(V.onboarding(null).includes("Connect your first agent"), "a first run still gets the three steps");
});

test("toasts name the project; the answer dialog says when the wait is over; dayMode states", async () => {
  const V = await pub("shell-view.js"), S = await pub("shell-model.js");
  const { snap, now } = demo();
  const receipt = snap.agents.find((a) => a.label === "receipt printer");
  const t = V.needsToast(receipt, S.waitKey(receipt));
  assert.ok(t.includes("supermarket-pos · Wants permission to run a command · sudo apt install cups-filters"));
  assert.ok(t.includes(`data-key="toast-answer:${S.waitKey(receipt)}"`) && t.includes(`data-key="toast-dismiss:${S.waitKey(receipt)}"`));
  const moved = { ...receipt, state: "working", waitingSince: null, question: null }, mv = S.answerView(moved, { q: receipt.question, now });
  const done = V.answerHead(moved, { now, mode: mv.mode }) + V.answerConvo(moved, { q: receipt.question, now, mode: mv.mode }) + V.answerFoot(mv.mode, moved);
  assert.ok(done.includes("receipt printer is no longer waiting") && done.includes(">Working<") && done.includes('data-jump="demo-receipt"'));
  assert.equal(S.answerView(null, { q: receipt.question, now }).mode, "over");
  const gone = V.answerConvo(receipt, { q: receipt.question, now, mode: "over", gone: true }) + V.answerFoot("over", receipt, { gone: true });
  assert.ok(gone.includes("nothing to answer now") && !gone.includes("data-jump") && !gone.includes(">Needs you<"), "gone: nothing to jump to");
  const asOf = new Date(new Date().setHours(15, 40, 0, 0));
  assert.match(V.dayMode({ status: "live", day: "stale", dayAsOf: asOf }), /As of 15:40/, "the timeline is behind while the stream is live");
  assert.match(V.dayMode({ status: "stale", asOf, day: "stale", dayAsOf: new Date(0) }), /As of 15:40/, "the stream's time wins");
  assert.match(V.dayMode({ status: "live", day: "error" }), /Not loaded/);
  assert.match(V.dayMode({ status: "live", day: "live" }), /Live · today/);
});

test("scrubber width puts the thumb's centre exactly on its minute; seen keys stay while on screen", async () => {
  const S = await pub("shell-model.js");
  assert.equal(S.scrubWidth({ start: 0, end: 100, now: 25 }), "calc(25.000% + var(--cc-thumb))");
  // A browser puts a range thumb's centre at left + T/2 + v/max × (width − T). With left = −T/2 and width = P + T:
  for (const T of [12, 44]) {
    const P = 600, centre = (f) => -T / 2 + T / 2 + f * (P + T - T);
    assert.deepEqual([centre(0), centre(0.5), centre(1)], [0, 300, 600], `thumb ${T}px`);
  }
  const seen = new Set(), t = new Date().toISOString(), visible = { name: "basket bill", actions: [{ key: "a:1", lead: "Edited ", mono: "x.ts", t }] };
  S.freshLines([visible], seen, { first: true });
  for (let i = 0; i < 700; i++) S.freshLines([{ name: "other", actions: [{ key: `b:${i}`, lead: "Read ", t }] }, visible], seen);
  assert.ok(seen.has("a:1") && seen.size <= 500, "an action still on screen is never forgotten");
  assert.deepEqual(S.freshLines([visible], seen), [], "so it isn't announced again");
});

test("shell DOM: focus survives live re-renders, and closing a dialog finds a re-rendered opener", async () => {
  const dom = withDom();
  let shell = null;
  const settings = { offlineAfterMin: 30, dailyBudgetUsd: 25, notifyOnWaiting: false, aliases: {}, teamMode: false, viewer: "mk" };
  const { snap, timeline } = demo(Date.now());
  // A long command, so the receipt printer's code box has an expand button.
  const long = "sudo apt install cups-filters printer-driver-escpr && sudo systemctl restart cups";
  const base = { ...snap, settings, agents: snap.agents.map((a) => (a.label === "receipt printer" ? { ...a, question: { ...a.question, target: long, detail: { ...a.question.detail, command: long } } } : a)) };
  const srv = server({ "/api/state": base, "/api/timeline": timeline });
  try {
    const { createShell } = await pub("shell.js");
    shell = createShell({ doc: dom.document, win: fakeWindow(), fetch: srv.fetch, EventSource: srv.EventSource });
    const body = dom.document.body, q = (s) => body.querySelector(s), active = () => dom.document.activeElement;
    await shell.ready;
    await tick();
    const es = srv.sources[0], push = (change) => es.onmessage({ data: JSON.stringify(change(JSON.parse(JSON.stringify(base)))) });
    const later = (s, label, min) => { for (const a of s.agents) if (a.label === label) a.waitingSince = new Date(Date.parse(a.waitingSince) - min * M).toISOString(); return s; };

    // An unkeyed link: the Work board link in Today's progress.
    const link = q('[data-slot="progress"]').querySelector('a[href="#/board"]');
    link.focus();
    push((s) => { s.totals.tasksDone += 1; return s; });
    assert.notEqual(active(), link, "the panel was re-rendered");
    assert.equal(active().getAttribute("href"), "#/board");
    assert.ok(body.contains(active()), "focus is on the new link, not lost to the page");

    // An unkeyed expand button: it stays open and focused while the wait time ticks over.
    const expand = () => q('[data-slot="needs"]').querySelectorAll("[data-expand]")[0];
    expand().click();
    const old = expand();
    old.focus();
    push((s) => later(s, "refund flow", 3));
    assert.notEqual(expand(), old);
    assert.equal(active(), expand());
    assert.equal(expand().getAttribute("aria-expanded"), "true");
    assert.ok(expand().closest(".ao-code").classList.contains("is-open"));

    // Answer opened from a card; the card re-renders while the dialog is open; Close finds the new Answer button.
    const opener = q('[data-slot="needs"]').querySelector('[data-answer="demo-refund"]');
    opener.focus();
    opener.click();
    const dlg = q('[data-dialog="answer"]');
    assert.equal(dlg.open, true);
    push((s) => later(s, "refund flow", 5));
    assert.ok(!body.contains(opener), "the opener was replaced");
    dlg.querySelector("[data-close]").click();
    assert.equal(active().getAttribute("data-key"), "answer:demo-refund");
    assert.ok(body.contains(active()));

    // Answer opened from a toast; the wait ends while it's open: the dialog says so, and Close lands on the office heading.
    const fromToast = body.querySelectorAll("[data-toast]").map((t) => t.querySelector("[data-answer]")).find((b) => b.getAttribute("data-answer") === "demo-receipt");
    fromToast.focus();
    fromToast.click();
    push((s) => { for (const a of s.agents) if (a.label === "receipt printer") Object.assign(a, { state: "working", waitingSince: null, question: null }); return s; });
    assert.equal(q("#cc-answer-h").textContent, "receipt printer is no longer waiting");
    assert.ok(!body.contains(fromToast), "its toast went");
    dlg.querySelector("[data-close]").click();
    assert.equal(active().id, "cc-office-h");
    shell.destroy();
  } finally { shell?.destroy(); dom.restore(); }
});

test("shell DOM: a timeline that stops loading says As of; settings show loading or error, never defaults", async () => {
  const dom = withDom();
  let shell = null;
  const settings = { offlineAfterMin: 45, dailyBudgetUsd: 7, notifyOnWaiting: true, aliases: {}, teamMode: false, viewer: "mk" };
  const { snap, timeline } = demo(Date.now());
  let stateUp = false, tlUp = true;
  const srv = server({ "/api/state": () => (stateUp ? { ...snap, settings } : undefined), "/api/timeline": () => (tlUp ? timeline : undefined), "/api/settings": settings });
  const realNow = Date.now;
  const win = fakeWindow();
  try {
    const { createShell } = await pub("shell.js");
    shell = createShell({ doc: dom.document, win, fetch: srv.fetch, EventSource: srv.EventSource });
    const body = dom.document.body, q = (s) => body.querySelector(s), page = () => q('[data-screen="settings"]');
    await shell.ready;
    await tick();
    win.go("#/settings");
    assert.equal(page().querySelector("#st-offline-min"), null, "no form of defaults while the settings can't load");
    assert.ok(page().querySelector('[data-st="offline"]').querySelector(".ao-state--error").querySelector("[data-retry]"), "an error with Retry instead");

    // The stream works even though /api/state didn't: the settings are fetched on their own, then the forms show them.
    srv.sources[0].onmessage({ data: JSON.stringify(snap) });
    await tick(); await tick();
    assert.ok(srv.calls.some((c) => c.url === "/api/settings"));
    assert.equal(page().querySelector("#st-offline-min").getAttribute("value"), "45");
    win.go("#/settings?section=budgets");
    assert.equal(page().querySelector("#st-b-daily").getAttribute("value"), "7");

    // The timeline stops loading a while later: the day panel says how old its ribbon is.
    win.go("#/office");
    assert.match(q(".cc-day-mode").textContent, /Live · today/);
    tlUp = false;
    Date.now = () => realNow() + 2 * M;
    srv.sources[0].onmessage({ data: JSON.stringify(snap) });
    await tick(); await tick();
    assert.match(q(".cc-day-mode").textContent, /^As of \d\d:\d\d$/);
    assert.ok(q(".cc-day").classList.contains("is-stale"));
    assert.match(q(".cc-scrub").style.width, /^calc\([\d.]+% \+ var\(--cc-thumb\)\)$/);

    // A quiet day for someone who has used it before: not the first-run card.
    srv.sources[0].onmessage({ data: JSON.stringify({ ...snap, agents: [], lastEvent: new Date(realNow() - 3 * 86400000).toISOString() }) });
    await tick(); await tick();
    assert.equal(q("#cc-onboard-h").textContent, "No agents in the last 24 hours");
    shell.destroy();
  } finally { Date.now = realNow; shell?.destroy(); dom.restore(); }
});

// ---------- M5: answering an agent ----------
test("after you answer: your bubble, then sending, delivered (working again or got it), or not delivered; the time left to answer", async () => {
  const S = await pub("shell-model.js"), V = await pub("shell-view.js"), d = await pub("lib/describe.js");
  const { snap, now } = demo();
  const receipt = snap.agents.find((a) => a.label === "receipt printer"), until = new Date(now + 60000).toISOString();
  const sent = { questionId: receipt.question.id, choice: "reply", text: "Use the package without sudo", at: now - 5000, until, delivered: false };
  const html = V.answerConvo(receipt, { q: receipt.question, now, sent, mode: "sent" });
  assert.ok(html.includes("You · just now · from Virtual Office") && html.includes("Denied: Use the package without sudo"));
  assert.equal(V.answerHead(receipt, { now, mode: "sent" }).includes("You answered receipt printer"), true);
  assert.deepEqual(S.deliveryView(receipt, sent, now), { tone: "busy", text: "Sending your answer to studio-mac…" });
  const working = { ...receipt, state: "working", question: null, answer: { questionId: receipt.question.id, delivered: new Date(now).toISOString(), until } };
  assert.deepEqual(S.deliveryView(working, sent, now), { tone: "ok", text: "receipt printer is working again · Delivered to studio-mac" });
  assert.equal(S.deliveryView({ ...working, state: "idle" }, sent, now).text, "receipt printer got your answer · Delivered to studio-mac");
  assert.equal(S.deliveryView(receipt, { ...sent, delivered: true }, now).tone, "ok", "the POST said the hook already has it");
  const lost = { tone: "error", text: "Couldn't deliver your answer: studio-mac stopped waiting. Answer in the Claude Code terminal on studio-mac." };
  assert.deepEqual(S.deliveryView({ ...receipt, answer: { questionId: 1, delivered: "x" } }, sent, now + 64000), lost, "another question's answer doesn't count");
  assert.deepEqual(S.deliveryView({ ...receipt, question: { ...receipt.question, ask: null, windowClosed: true } }, sent, now), lost, "the hook left before it got it: still waiting, for the terminal");
  assert.match(V.answerStatus(S.deliveryView(working, sent, now)), /cc-answer-note is-ok[\s\S]*is working again/);
  assert.equal(S.answerLeft(new Date(now + 104000).toISOString(), now), "1:42 left to answer here", "the last 2 s don't count");
  assert.equal(S.answerLeft(new Date(now - 1000).toISOString(), now), "0:00 left to answer here");
  assert.equal(S.workingOn(receipt), "Working on step 3 of 6: Install the printer filter package");
  assert.equal(S.workingOn({ plan: { now: null } }), null);
  // The bubble and the feed in plain English.
  assert.deepEqual(["approve", "session", "auto", "deny"].map((choice) => d.answerText({ choice })), ["Approved once", "Allowed for this session", "Approved automatically: allowed for this session", "Denied"]);
  assert.equal(d.answerText({ choice: "reply", text: "No sudo" }), "Denied: No sudo");
  const step = (x) => d.describeStep({ kind: "answer", tool: "Edit", target: "/r/shop/.env", ...x }, { root: "/r/shop" });
  assert.deepEqual(step({ choice: "approve" }), { text: "You approved it once", target: ".env", icon: "check" });
  assert.deepEqual(step({ choice: "session" }).text, "You allowed it for this session");
  assert.deepEqual(step({ choice: "deny" }), { text: "You denied it", target: ".env", icon: "x" });
  assert.deepEqual(step({ choice: "reply", text: "Leave it" }), { text: "You said no: “Leave it”", target: null, icon: "x" });
  assert.equal(step({ choice: "auto" }).text, "Approved automatically, allowed for this session");
  assert.equal(d.describeStep({ kind: "tool", tool: "Bash", status: "denied", detail: { command: "rm -rf build" } }).text, "Not allowed to run a command");
});

test("shell DOM: answer from the dialog; it posts once, shows your answer and its delivery, keeps a typed reply through live updates", async () => {
  const dom = withDom();
  let shell = null;
  const settings = { offlineAfterMin: 30, dailyBudgetUsd: 25, notifyOnWaiting: false, aliases: {}, teamMode: false, viewer: "mk" };
  const { snap, timeline } = demo(Date.now());
  const receiptQ = snap.agents.find((a) => a.label === "receipt printer").question.id;
  let reply = (o) => ({ ok: true, questionId: receiptQ, until: new Date(Date.now() + 300000).toISOString(), delivered: false });
  const srv = server({ "/api/state": { ...snap, settings }, "/api/timeline": timeline, "/api/answer": (o) => reply(o) });
  try {
    const { createShell } = await pub("shell.js");
    shell = createShell({ doc: dom.document, win: fakeWindow(), fetch: srv.fetch, EventSource: srv.EventSource });
    const body = dom.document.body, q = (s) => body.querySelector(s), active = () => dom.document.activeElement;
    await shell.ready;
    await tick();
    const es = srv.sources[0], receipt = snap.agents.find((a) => a.label === "receipt printer"), askId = receipt.question.ask.id;
    const push = (change) => es.onmessage({ data: JSON.stringify(change(JSON.parse(JSON.stringify(snap)))) });
    const dlg = q('[data-dialog="answer"]'), part = (k) => dlg.querySelector(`[data-a="${k}"]`), posts = () => srv.calls.filter((c) => c.url === "/api/answer");

    const opener = q('[data-slot="needs"]').querySelector('[data-answer="demo-receipt"]');
    opener.focus();
    opener.click();
    assert.equal(q("#cc-answer-h").textContent, "receipt printer needs you");
    assert.match(part("box").querySelector("[data-answer-left]").textContent, /^[56]:\d\d left to answer here$/);

    // Typing enables Send reply; a live update while you type keeps the text.
    const area = part("box").querySelector("textarea"), send = () => part("box").querySelector('[data-choice="reply"]');
    assert.equal(send().hasAttribute("disabled"), true);
    area.value = "Use the package without sudo";
    area.dispatchEvent({ type: "input" });
    assert.equal(send().hasAttribute("disabled"), false);
    push((s) => { for (const a of s.agents) if (a.label === "receipt printer") a.waitingSince = new Date(Date.parse(a.waitingSince) - 2 * M).toISOString(); return s; });
    assert.match(part("head").textContent, /waiting 6m/, "the dialog follows live data");
    assert.equal(part("box").querySelector("textarea"), area, "the box wasn't redrawn");
    assert.equal(area.value, "Use the package without sudo");

    // A failed send: what went wrong, and the buttons come back.
    reply = () => undefined;
    area.dispatchEvent({ type: "keydown", key: "Enter", ctrlKey: true });
    await tick(); await tick();
    assert.match(part("box").querySelector("[data-answer-error]").textContent, /^Couldn't send your answer\. Server error\.$/);
    assert.equal(send().hasAttribute("disabled"), false);
    assert.equal(part("box").querySelector('[data-choice="approve"]').hasAttribute("disabled"), false);

    // Ctrl+Enter sends the reply: once, with the same-origin header.
    reply = (o) => ({ ok: true, questionId: receiptQ, until: new Date(Date.now() + 300000).toISOString(), delivered: false });
    area.dispatchEvent({ type: "keydown", key: "Enter", ctrlKey: true });
    area.dispatchEvent({ type: "keydown", key: "Enter", metaKey: true });
    await tick(); await tick();
    const last = posts().at(-1);
    assert.equal(posts().length, 2, "the failed one and this one; the second key press was ignored while sending");
    assert.deepEqual(JSON.parse(last.opts.body), { askId, kind: "reply", text: "Use the package without sudo" });
    assert.deepEqual([last.opts.method, last.opts.headers["X-Requested-With"]], ["POST", "agent-office"]);
    assert.equal(q("#cc-answer-h").textContent, "You answered receipt printer");
    assert.ok(part("convo").textContent.includes("You · just now · from Virtual OfficeDenied: Use the package without sudo"));
    assert.equal(part("status").getAttribute("role"), "status");
    assert.equal(part("status").textContent, "Sending your answer to studio-mac…");
    assert.equal(part("box").textContent, "", "no more buttons");
    assert.equal(active().getAttribute("data-close"), "", "focus moves to Close");

    // The hook picked it up and the agent works again: it leaves the queue.
    push((s) => { for (const a of s.agents) if (a.label === "receipt printer") Object.assign(a, { state: "working", waitingSince: null, question: null, answer: { questionId: receiptQ, choice: "reply", delivered: new Date().toISOString() } }); return s; });
    assert.equal(part("status").textContent, "receipt printer is working again · Delivered to studio-mac");
    assert.ok(!q('[data-slot="needs"]').querySelector('[data-answer="demo-receipt"]'), "out of the queue");
    dlg.querySelector("[data-close]").click();
    assert.equal(dlg.open, false);
    assert.equal(active().id, "cc-office-h", "its Answer button went with it: focus lands on the office heading");

    // Approve once from another agent with a live ask: one click, one post.
    push((s) => { for (const a of s.agents) if (a.label === "refund flow") a.question.ask = { id: "r".repeat(24), until: new Date(Date.now() + 90000).toISOString() }; return s; });
    q('[data-slot="needs"]').querySelector('[data-answer="demo-refund"]').click();
    part("box").querySelector('[data-choice="approve"]').click();
    part("box").querySelector('[data-choice="approve"]')?.click();
    await tick(); await tick();
    assert.deepEqual(posts().slice(2).map((c) => JSON.parse(c.opts.body)), [{ askId: "r".repeat(24), kind: "approve", text: "" }]);
    assert.ok(part("convo").textContent.includes("Approved once"));
    shell.destroy();
  } finally { shell?.destroy(); dom.restore(); }
});

test("shell DOM: the dialog stays on its question; a new one is offered, not swapped in; the window passing keeps focus and is announced", async () => {
  const dom = withDom();
  let shell = null;
  const settings = { offlineAfterMin: 30, dailyBudgetUsd: 25, notifyOnWaiting: false, aliases: {}, teamMode: false, viewer: "mk" };
  const { snap, timeline } = demo(Date.now());
  const srv = server({ "/api/state": { ...snap, settings }, "/api/timeline": timeline });
  try {
    const { createShell } = await pub("shell.js");
    shell = createShell({ doc: dom.document, win: fakeWindow(), fetch: srv.fetch, EventSource: srv.EventSource });
    const body = dom.document.body, q = (s) => body.querySelector(s), active = () => dom.document.activeElement;
    await shell.ready;
    await tick();
    const es = srv.sources[0], first = snap.agents.find((a) => a.label === "receipt printer").question;
    const push = (question) => es.onmessage({ data: JSON.stringify({ ...snap, agents: snap.agents.map((a) => (a.label === "receipt printer" ? { ...a, question } : a)) }) });
    const dlg = q('[data-dialog="answer"]'), part = (k) => dlg.querySelector(`[data-a="${k}"]`), form = () => part("box").querySelector("[data-answer-form]");
    q('[data-slot="needs"]').querySelector('[data-answer="demo-receipt"]').click();
    assert.equal(form().getAttribute("data-answer-form"), first.ask.id);
    part("box").querySelector('[data-choice="approve"]').focus();

    // The window passes (the hook stopped waiting) while focus is on Approve once.
    push({ ...first, ask: null, windowClosed: true });
    assert.ok(part("box").textContent.includes("The in-app answer window has passed."));
    assert.equal(active().id, "cc-answer-h", "focus stays in the dialog, on its heading");
    assert.equal(part("say").getAttribute("role"), "status");
    assert.equal(part("say").textContent, "The in-app answer window has passed. Answer in the Claude Code terminal on studio-mac.");

    // That question goes and a new one comes with another hook's ask: offered, never swapped in.
    const next = { ...first, id: first.id + 50, target: "lpstat -p", detail: { command: "lpstat -p" }, ask: { id: "n".repeat(24), until: new Date(Date.now() + 90000).toISOString() } };
    push(next);
    assert.ok(part("box").textContent.includes("That request was answered. receipt printer has a new one."));
    assert.equal(part("say").textContent, "That request was answered. receipt printer has a new one.");
    assert.equal(form(), null, "no buttons for a request you haven't seen");
    assert.ok(part("convo").textContent.includes("sudo apt install cups-filters") && !part("convo").textContent.includes("lpstat"));
    part("box").querySelector("[data-answer-next]").click();
    assert.equal(form().getAttribute("data-answer-form"), "n".repeat(24));
    assert.ok(part("convo").textContent.includes("lpstat -p"));
    assert.equal(active().id, "cc-answer-h");

    // A click on the dialog's own box (its padding) doesn't close it; one outside it, on the backdrop, does.
    dlg.dispatchEvent({ type: "click", clientX: 520, clientY: 430 });
    assert.equal(dlg.open, true);
    dlg.dispatchEvent({ type: "click", clientX: 10, clientY: 10 });
    assert.equal(dlg.open, false);
    shell.destroy();
  } finally { shell?.destroy(); dom.restore(); }
});

test("answer dialog: a file outside the project says so, with the whole path to hover and copy", async () => {
  const V = await pub("shell-view.js"), d = await pub("lib/describe.js");
  const { snap, now } = demo();
  const refund = snap.agents.find((a) => a.label === "refund flow");
  const q = { ...refund.question, target: "/etc/cups/printers.conf", detail: { path: "/etc/cups/printers.conf", added: 2, removed: 0 } };
  const html = V.answerConvo({ ...refund, question: q }, { q, now, mode: "form" });
  assert.ok(html.includes("Outside this project") && html.includes(">…/cups/printers.conf<"));
  assert.match(html, /<code class="ao-code-text" title="\/etc\/cups\/printers\.conf">/);
  assert.match(html, /data-copy="\/etc\/cups\/printers\.conf"[\s\S]*Copy full path/);
  assert.ok(!V.answerConvo(refund, { q: refund.question, now, mode: "form" }).includes("Outside this project"), "inside the project: the relative path only");
  assert.deepEqual([d.outsideRoot("/etc/x", "/r/shop"), d.outsideRoot("/r/shop/a.ts", "/r/shop"), d.outsideRoot("C:\\R\\Shop\\a.ts", "c:/r/shop"), d.outsideRoot("a.ts", "/r/shop"), d.outsideRoot("/etc/x", null)],
    [true, false, false, false, true], "with no root to compare, any absolute path is outside");
});

// ---------- M5 Minor (e): sessions without a git root ----------
test("answer dialog: a session without a git root compares with the folder it started in; with neither, every file is outside", async () => {
  const V = await pub("shell-view.js");
  const { snap, now } = demo();
  const refund = snap.agents.find((a) => a.label === "refund flow");
  const scratch = { ...refund, gitRoot: null, root: "/home/mk/scratch" };
  const html = (a, path) => { const q = { ...a.question, target: path, detail: { path, added: 1, removed: 0 } }; return V.answerConvo({ ...a, question: q }, { q, now, mode: "form" }); };
  const inside = html(scratch, "/home/mk/scratch/notes/todo.md");
  assert.ok(!inside.includes("Outside this project") && inside.includes(">notes/todo.md<"), "inside its start folder: relative");
  const outside = html(scratch, "/etc/hosts");
  assert.ok(outside.includes("Outside this project") && outside.includes('data-copy="/etc/hosts"'), "outside it: said so, with the whole path to copy");
  const none = html({ ...refund, gitRoot: null, root: null }, "/home/mk/scratch/a/b/c.txt");
  assert.ok(none.includes("Outside this project") && none.includes(">…/b/c.txt<") && none.includes('title="/home/mk/scratch/a/b/c.txt"'), "no root at all: the short form, explained");
});
