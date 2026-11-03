"use strict";
// The Agent Detail slide-over (public/agent-detail*.js): the trace model (steps, sub-agent branches, waits, idle spells,
// filters), the conversation, plan, files and usage, the markup's text and colour rules, and the controller inside the
// real shell on a fake DOM fed with the demo scenario.
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
/** The demo day as the browser gets it: the snapshot, today's timeline, and one agent's detail. */
function demo(now = at1542()) {
  const store = new Store({ getConfig: () => ({ offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 25 }) });
  loadScenario(store, now);
  return { store, now, snap: json(store.snapshot(now)), timeline: json(store.timeline(localDate(now), now)), detail: (id) => json(store.detail(id, now)) };
}
const RAW = ["PreToolUse", "PostToolUse", "PermissionRequest", "UserPromptSubmit", "SubagentStart", "SubagentStop", "TodoWrite", "<ide_", "<system-reminder", "<command-", "undefined", "NaN", "[object"];
/** Text a person sees: markup and screen-reader-only spans gone. */
const seen = (html) => html.replace(/<span class="ao-sr">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

// ---------- the trace ----------
test("trace: steps in order, sub-agents as branches with their own steps, waits for you and idle spells as gaps", async () => {
  const T = await pub("agent-detail-model.js");
  const { detail, now } = demo();
  const d = detail("demo-basket"), m = T.traceModel(d, { now });
  const branches = m.rows.filter((r) => r.type === "branch");
  assert.deepEqual(branches.map((b) => [b.label, b.status, b.children.filter((c) => c.type === "step").length]), [["Explore loyalty rules", "finished", 3], ["Write bill tests", "running", 4]]);
  assert.ok(branches[0].finishedAt && branches[0].lastMessage.startsWith("Loyalty discounts apply per line"));
  assert.ok(branches[1].step.ms > 10 * M, "a background sub-agent's branch lasts its life, not its 1 s launch");
  assert.ok(branches.every((b) => b.children.every((c) => c.sub)), "only its own steps");
  assert.ok(!m.rows.some((r) => r.type === "step" && r.sub), "no sub-agent step at the top level");
  const wait = m.rows.find((r) => r.type === "wait");
  assert.deepEqual([wait.head, wait.lead, wait.target, wait.outcome], ["Waited 4m for you", "Asked permission to run a command", "npm install decimal.js", "Approved at 13:44 in the terminal"]);
  const idle = m.rows.find((r) => r.type === "idle");
  assert.match(idle.text, /^Idle 5m · 13:05 to 13:10$/);
  assert.ok(m.rows.every((r, i, l) => !i || Date.parse(r.t) >= Date.parse(l[i - 1].t) - 60000), "in order");
  const failed = m.rows.find((r) => r.status === "error");
  assert.deepEqual([failed.title, failed.target, failed.note], ["Ran tests", "npm test -- basket", "Exit code 1 · FAIL src/basket/BasketTotals.test.tsx"]);
  assert.equal(failed.expand.kind, "command");
  assert.match(failed.expand.error, /Expected: 1999\n\s+Received: 2000/);
  const running = m.rows.at(-1);
  assert.deepEqual([running.title, running.status, running.file], ["Editing BasketTotals.tsx", "running", "src/basket/BasketTotals.tsx"]);
  assert.ok(running.ms > 0);
  assert.deepEqual(m.counts, { all: m.counts.all, commands: 15, edits: 24, reads: 29, web: 0, subagents: 2 });
  assert.equal(m.errors, 1);
  assert.ok(m.files.includes("src/basket/BasketTotals.tsx") && m.files.every((f) => !f.startsWith("/")), "relative paths");
  const plan = m.rows.find((r) => r.tool === "TodoWrite");
  assert.equal(plan.title, "Updated the plan");
  assert.equal(plan.expand.kind, "plan");
  assert.ok(m.rows.find((r) => r.kind === "tool" && r.cost > 0), "per-step cost, from telemetry");

  // The inventory agent got your message at a Stop and carried on: a row for that, and its idle spells.
  const inv = T.traceModel(detail("demo-inventory"), { now });
  const got = inv.rows.find((r) => r.kind === "inbox");
  assert.deepEqual([got.title, got.note], ["Got your message", "Also log every return the job skips, so we can audit them later."]);
  assert.ok(inv.rows.some((r) => r.type === "idle" && /^Idle 1[78]m · 12:1[23] to 12:30$/.test(r.text)));
});

test("trace filters: a category with counts, failed only, one file; sub-agents as whole branches; nothing left says so", async () => {
  const T = await pub("agent-detail-model.js");
  const { detail, now } = demo();
  const m = T.traceModel(detail("demo-basket"), { now }), only = (f) => T.filterRows(m.rows, f);
  assert.equal(only({}), m.rows, "no filters: everything, gaps included");
  const edits = only({ cat: "edits" });
  assert.ok(edits.length && edits.every((r) => (r.type === "branch" ? r.children.every((c) => c.cat === "edits") : r.cat === "edits")));
  assert.ok(edits.some((r) => r.type === "branch"), "a sub-agent's edits show inside its branch");
  assert.ok(!edits.some((r) => r.type === "wait" || r.type === "idle" || r.kind === "prompt"));
  assert.deepEqual(only({ errors: true }).map((r) => r.title), ["Ran tests"]);
  assert.deepEqual(only({ cat: "subagents" }).map((r) => [r.type, r.children.length]), [["branch", 3], ["branch", 4]]);
  const file = only({ file: "src/basket/__tests__/BasketTotals.test.tsx" });
  assert.deepEqual(file.map((r) => [r.type, r.children.map((c) => c.title)]), [["branch", ["Created BasketTotals.test.tsx", "Edited BasketTotals.test.tsx"]]]);
  assert.deepEqual(only({ cat: "web" }), []);
  assert.deepEqual(only({ cat: "edits", errors: true }), []);
});

test("trace pieces: diff lines, duration text and the square-root bar", async () => {
  const T = await pub("agent-detail-model.js");
  assert.deepEqual(T.diffLines([{ old: "a\nb\nc", new: "a\nB\nc" }, { new: "x" }]).map((l) => `${l.type}:${l.text}`),
    ["same:a", "del:b", "add:B", "same:c", "gap:", "add:x"]);
  assert.equal(T.diffLines([{ old: Array(500).fill("o").join("\n"), new: "" }]).length, 400, "bounded");
  assert.deepEqual([T.durText(400), T.durText(38000), T.durText(125000), T.durText(3 * 3600000), T.durText(null)], ["<1s", "38s", "2m 5s", "3h", ""]);
  assert.deepEqual([T.durWidth(100, 10000), T.durWidth(2500, 10000), T.durWidth(10000, 10000), T.durWidth(0, 10000)], [10, 50, 100, 0]);
});

// ---------- conversation, plan, files and usage ----------
test("conversation: prompts and messages are yours; questions, turns and errors the agent's; answers say where they came from", async () => {
  const T = await pub("agent-detail-model.js");
  const { detail } = demo();
  const d = detail("demo-basket"), items = T.conversation(d, d.agent);
  assert.deepEqual(items.map((x) => [x.side, x.lead || x.text]), [
    ["you", "Basket bill rounding: totals are off by a cent when loyalty discounts stack. Fix the totals and add tests."],
    ["agent", "Wants permission to run a command"], ["you", "Approved · in the terminal"],
    ["you", "Commit what you have before you start anything new."],
    ["you", "Keep the old rounding helper exported until the next release."]]);
  assert.equal(items[0].file, "Basket.tsx");
  assert.deepEqual([items[1].code, items[1].tone], ["npm install decimal.js", null], "amber only while it waits");
  assert.deepEqual([items[4].meta, items[4].status], ["You · 15:39 · from Virtual Office", "Waiting for its next stop"]);
  assert.deepEqual([items[3].meta, items[3].status], ["You · 15:30 · to the room, from Virtual Office", "Waiting for its next stop"], "a message to its room says so");
  const receipt = detail("demo-receipt"), q = T.conversation(receipt, receipt.agent).filter((x) => x.side === "agent" && x.lead.startsWith("Wants"));
  assert.deepEqual(q.map((x) => x.tone), [null, "needs"], "the answered one is plain; the open one is amber");
  const inv = detail("demo-inventory"), msg = T.conversation(inv, inv.agent).find((x) => x.status);
  assert.match(msg.status, /^Delivered 12:1\d$/);
  // Answers from here, the automatic one, how a question ended otherwise, a failed turn.
  const fake = { agent: { name: "shop · till", label: "till", project: "shop", root: "/p/shop" }, conversation: [
    { kind: "question", id: 1, t: "2026-10-20T10:00:00Z", qkind: "permission", tool: "Edit", target: "/p/shop/.env", detail: { path: "/p/shop/.env" }, status: "answered", resolvedBy: "dashboard", answeredAt: "2026-10-20T10:01:00Z" },
    { kind: "answer", id: 2, t: "2026-10-20T10:01:00Z", choice: "reply", text: "Leave .env alone", tool: "Edit", questionId: 1 },
    { kind: "answer", id: 3, t: "2026-10-20T10:02:00Z", choice: "auto", tool: "Bash" },
    { kind: "question", id: 4, t: "2026-10-20T10:03:00Z", qkind: "permission", tool: "Bash", target: "ls", status: "answered", resolvedBy: "turn-ended", answeredAt: "2026-10-20T10:04:00Z" },
    { kind: "stop", id: 5, t: "2026-10-20T10:05:00Z", status: "error", failure: "rate_limit", text: "API Error: Rate limit reached" },
    { kind: "message", id: 6, t: "2026-10-20T10:06:00Z", text: "hi", status: "undelivered" }] };
  const out = T.conversation(fake, fake.agent);
  assert.deepEqual(out.map((x) => x.text || x.lead), [null, "Denied: Leave .env alone", "Approved automatically: allowed for this session (run a command)",
    null, "No longer waiting: its turn ended", "API Error: Rate limit reached", "hi"].map((x, i) => x ?? out[i].lead));
  assert.equal(out[0].code, ".env", "relative to the root");
  assert.deepEqual([out[1].side, out[1].meta.endsWith("from Virtual Office"), out[2].side, out[4].side, out[5].tone, out[6].status],
    ["you", true, "note", "note", "error", "Not delivered: the session ended"]);
  assert.equal(out[5].lead, "Stopped: hit the rate limit");
});

test("composer: answer while it needs you, message it otherwise, and say when a message reaches it or why it can't", async () => {
  const T = await pub("agent-detail-model.js");
  const { snap } = demo(), by = (l) => snap.agents.find((a) => a.label === l);
  assert.deepEqual(["receipt printer", "basket bill", "login fix", "webhook retries"].map((l) => T.composerMode(by(l))), ["answer", "message", "message", "offline"]);
  assert.equal(T.composerMode({ ...by("login fix"), state: "offline", ended: true }), "ended");
  assert.equal(T.deliveryHint(by("login fix")), "It's idle now, so that's after its next turn ends.");
  assert.equal(T.deliveryHint(by("basket bill")), "It's working now, so that's when this turn ends.");
  assert.equal(T.deliveryHint({ ...by("basket bill"), takesMessages: false }), "Its last stop didn't ask for messages (AGENT_OFFICE_INBOX=0 on its machine, or an older hook), so it may never get this.");
  assert.equal(T.deliveryHint({ ...by("basket bill"), takesMessages: null }), "It's working now, so that's when this turn ends.", "no Stop seen yet: no warning");
  assert.equal(T.deliveryHint({ ...by("basket bill"), carryingOn: true }), "It's carrying on with your last message, so that's after its next turn ends.",
    "the Stop that ends a turn begun by your messages hands over nothing");
});

test("plan, header facts, files and usage: done with times, in progress since, your average, the sparkline, cache savings as an estimate", async () => {
  const T = await pub("agent-detail-model.js"), P = await pub("lib/prices.js");
  const { detail, now } = demo(), d = detail("demo-basket"), a = d.agent;
  const p = T.planView(d.plan);
  assert.deepEqual([p.done, p.doing, p.total], [5, 1, 8]);
  assert.deepEqual(p.rows.map((r) => r.status), ["completed", "completed", "completed", "completed", "completed", "in_progress", "pending", "pending"]);
  assert.ok(p.rows[0].at && p.rows[5].at && p.rows[6].at === null);
  assert.equal(T.durationText(a, now), "2h 37m since 13:05");
  assert.match(T.durationText({ ...a, state: "offline", updated: new Date(now - 30 * M).toISOString() }, now), /^2h 7m · 13:05 to 15:12$/);
  const c = T.costFact(a, d.avgCost);
  assert.match(c.text, /^\$3\.84 · \d\.\d× your avg$/);
  assert.match(c.title, /^Your other sessions cost \$\d+\.\d\d on average$/);
  assert.deepEqual(T.costFact({ cost: 0, requests: 0 }, 2), { text: "No cost data", title: null });
  assert.deepEqual(T.fileRows(d.files).find((f) => f.created).created, "Created by a sub-agent");
  assert.match(T.fileRows(d.files)[0].meta, /^\d+ edits? · \+\d+ −\d+ · last \d\d:\d\d$/);
  const u = T.usageView(d, a, { now });
  assert.ok(u.points.length >= 15 && u.points.every((x, i, l) => !i || x.t - l[i - 1].t === 600000), "every 10 minutes, gaps filled");
  assert.ok(u.peak && u.peak.cost === Math.max(...u.points.map((x) => x.cost)));
  assert.ok(u.until <= now);
  assert.deepEqual([u.cache.family, u.cache.input], ["Sonnet", 3]);
  assert.deepEqual(T.usageView({ usage: { buckets: [] } }, a, { now }).points, []);
  // The price table: only models we know; reads at 10%, writes at 125% of the input price.
  assert.deepEqual(["claude-opus-4-7", "claude-opus-4-1-20250805", "claude-opus-4-20250514", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307", "gpt-4o", ""].map((x) => P.priceOf(x)?.input ?? null),
    [5, 15, 15, 3, 1, 0.8, 0.25, null, null]);
  assert.equal(P.cacheSavings({ cacheRead: 1e6, cacheWrite: 0 }, "claude-sonnet-4-6").usd, 2.7);
  assert.equal(P.cacheSavings({ cacheRead: 0, cacheWrite: 1e6 }, "claude-sonnet-4-6").usd, -0.75);
  assert.equal(P.cacheSavings({ cacheRead: 5 }, "mystery-model"), null);
  assert.equal(T.backLabel("board"), "Back to work board");
  assert.equal(T.backLabel(undefined), "Back to office");
});

// ---------- markup rules ----------
test("markup: plain English with relative paths, amber only on what waits for you, red only on failures, deletions gray", async () => {
  const T = await pub("agent-detail-model.js"), V = await pub("agent-detail-view.js");
  const { detail, now } = demo();
  for (const id of ["demo-basket", "demo-receipt", "demo-inventory", "demo-webhook", "demo-refund"]) {
    const d = detail(id), a = d.agent, m = T.traceModel(d, { now }), open = new Map();
    for (const r of m.rows) { open.set(r.key, true); for (const c of r.children || []) open.set(c.key, true); }
    const html = [V.frame(), V.avatarBadge(a, 0), V.nameForm(a), V.subLine(a, { now }), V.facts(a, { now, avgCost: d.avgCost }), V.missionSection(d.mission),
      V.convoSection(T.conversation(d, a), { open }), V.planSection(T.planView(d.plan)), V.traceFilters(m, { cat: "all", errors: false, file: null }),
      V.traceList(m.rows, m, { open, limit: 999 }), V.filesSection(T.fileRows(d.files), T.usageView(d, a, { now }))].join("");
    for (const raw of RAW) assert.ok(!html.includes(raw), `${id}: no ${raw}`);
    const shown = seen(html.replace(/(data-copy|title)="[^"]*"/g, ""));
    assert.ok(!/\/(Users|srv)\/[^ ]*\/[^ ]*\//.test(shown.replace(/\/(Users|srv)\/[\w/-]*-(pos|api|site)\b/g, "")), `${id}: no absolute paths but the root chip: ${(shown.match(/\/(Users|srv)\/\S+/g) || []).join(", ")}`);
    assert.ok(!html.includes("ao-btn--answer"), `${id}: no amber buttons; Approve once is teal`);
    // Amber classes only where the agent waits on you; red ones only on failed steps and errors.
    const amber = html.match(/class="[^"]*(ad-b--needs|ad-gap--wait|ad-badge--needs|ao-pill--needs|cc-answer)\b/g) || [];
    if (a.state !== "waiting") assert.ok(amber.every((c) => /ad-gap--wait/.test(c)), `${id}: amber only for its waits`);
    const red = (html.match(/class="[^"]*\b(is-error|ad-b--error|ad-pre--error|ao-state--error)\b[^"]*"/g) || []);
    assert.equal(red.length, m.rows.flatMap((r) => [r, ...(r.children || [])]).filter((r) => r.status === "error").length * 3, `${id}: red only around failed steps (row, status, error text)`);
  }
  const d = detail("demo-basket"), m = T.traceModel(d, { now }), edit = m.rows.findLast((r) => r.tool === "Edit" && r.expand.lines.length);
  const more = V.moreOf(edit.expand);
  assert.match(more, /<div class="ad-d ad-d--del"><span class="ad-d-sign" aria-hidden="true">−<\/span><del><span class="ao-sr">Removed: <\/span>/);
  assert.match(more, /<div class="ad-d ad-d--add"><span class="ad-d-sign" aria-hidden="true">\+<\/span><ins><span class="ao-sr">Added: <\/span>/);
  assert.ok(!/class="[^"]*(red|error)/.test(more), "deletions are never red");
  const failed = m.rows.find((r) => r.status === "error");
  assert.match(V.moreOf(failed.expand), /Command[\s\S]*npm test -- basket[\s\S]*What failed[\s\S]*ad-pre--error/);
  assert.match(V.moreOf({ kind: "command", command: "ls", tail: null, error: null, exitCode: 0 }), /Exit code 0[\s\S]*No output was kept for this step\./);
  assert.match(V.moreOf({ kind: "diff", path: "a.ts", lines: [], more: 0, added: 3, removed: 1 }), /The change itself wasn't kept for this step \(3 lines added, 1 removed\)\./);
});

test("markup: every control is a real control with its state in words: chevrons, filters, the file picker, statuses, the sparkline", async () => {
  const T = await pub("agent-detail-model.js"), V = await pub("agent-detail-view.js");
  const { detail, now } = demo(), d = detail("demo-basket"), a = d.agent, m = T.traceModel(d, { now });
  const list = V.traceList(m.rows, m, { open: new Map(), limit: 999 });
  assert.match(list, /<button type="button" class="ao-btn ao-btn--ghost ao-btn--icon ao-btn--sm ad-chev" data-ad-toggle="s\d+" aria-expanded="false" aria-label="Details: Ran tests">/);
  assert.match(list, /aria-expanded="true" aria-controls="ad-x-b[\w-]+" aria-label="Steps of the sub-agent: Write bill tests"/, "a running sub-agent starts open");
  assert.match(list, /<span class="ad-st is-error" title="Failed">[\s\S]*?<span class="ao-sr">Failed<\/span>/);
  assert.match(list, /<span class="cc-live-dot" aria-hidden="true"><\/span><span class="ao-sr">Running<\/span>/);
  assert.match(list, /<span aria-hidden="true">≈\$0\.\d\d · [\d.]+k<\/span><span class="ao-sr">about \$0\.\d\d and [\d.]+k tokens, an estimate<\/span>/, "per-step cost labelled ≈ / estimate");
  assert.ok(seen(list).includes("Waited 4m for you · Asked permission to run a command npm install decimal.js · Approved at 13:44 in the terminal"));
  const explore = m.rows.find((r) => r.type === "branch" && r.status === "finished");
  assert.ok(seen(V.traceList(m.rows, m, { open: new Map([[explore.key, true]]), limit: 999 })).includes("Finished 15:36: Loyalty discounts apply per line"), "a finished sub-agent ends with its last message");
  const f = V.traceFilters(m, { cat: "edits", errors: true, file: "src/money/round.ts" });
  assert.match(f, /role="radiogroup" aria-label="Show steps"/);
  assert.match(f, /role="radio" class="ao-seg-opt" aria-checked="true" tabindex="0" data-value="edits">Edits<span class="ao-seg-count">24<\/span>/);
  assert.match(f, /class="ao-chip" aria-pressed="true" data-chip="errors"/);
  assert.match(f, /<label for="ad-file">File<\/label><select id="ad-file" data-ad-files><option value="">All files<\/option>[\s\S]*<option value="src\/money\/round.ts" selected>/);
  const none = V.traceList([], m, {});
  assert.ok(seen(none).includes("No steps match these filters Clear filters") && none.includes("data-ad-clear"));
  assert.ok(seen(V.traceList([], { rows: [] }, {})).startsWith("No steps yet"));
  const files = V.filesSection(T.fileRows(d.files), T.usageView(d, a, { now }), { file: "src/money/round.ts" });
  assert.match(files, /<svg viewBox="0 0 300 56" preserveAspectRatio="none" role="img" aria-label="Cost per 10 minutes from \d\d:\d\d to \d\d:\d\d\. Peak \$\d\.\d\d at \d\d:\d\d\."/);
  assert.ok(seen(files).includes("Cache saved about $") && seen(files).includes("(estimate)") && files.includes("How this is estimated"));
  assert.match(files, /data-ad-file="src\/money\/round.ts" aria-pressed="true" aria-label="Show the steps that touched src\/money\/round.ts"/);
  assert.match(files, /<span class="ao-sr">Tokens: <\/span>in [\d.]+k · out [\d.]+k · cache [\d.]+M/);
  assert.match(V.nameForm(a), /<label class="ao-sr" for="ad-name-in">Agent name<\/label>\s*<input id="ad-name-in" class="ad-name-in" value="supermarket-pos · basket bill" maxlength="60"/);
  assert.match(V.messageForm(), /<label class="ad-compose-label" for="ad-msg">Message this agent\. It gets it the next time it stops\.<\/label>[\s\S]*<textarea class="ad-msg" id="ad-msg"[\s\S]*data-ad-send disabled/);
  assert.equal(seen(V.offlineNote({ host: "build-server" })), "build-server is offline, so messages can't reach this session right now.");
  const frame = V.frame({ back: "Back to work board" });
  assert.match(frame, /<button type="button" class="ao-btn ao-btn--ghost ad-back" data-close data-key="ad-back">[\s\S]*Back to work board/);
  assert.match(frame, /<nav class="ad-nav" aria-label="Sections"><a href="#ad-sec-mission" data-ad-section="mission">Mission<\/a><a href="#ad-sec-convo" data-ad-section="convo">Conversation<\/a><a href="#ad-sec-plan" data-ad-section="plan">Plan<\/a><a href="#ad-sec-trace" data-ad-section="trace">Trace<\/a><a href="#ad-sec-files" data-ad-section="files">Files &amp; usage<\/a><\/nav>/);
  assert.ok(seen(V.facts(a, { now, avgCost: d.avgCost })).match(/^Project supermarket-pos Machine thinkpad-x1 Model claude-sonnet-4-6 Duration 2h 37m since 13:05 Cost \$3\.84 · \d\.\d× your avg$/));
  const sub = V.subLine(a, { now });
  assert.ok(sub.includes('data-copy="/Users/mk/code/supermarket-pos"') && sub.includes('data-copy="demo-basket"') && seen(sub).includes("Copy session ID"));
  assert.ok(!V.avatarBadge(a, 0).includes("role=") && V.avatarBadge(a, 0).includes('aria-hidden="true"'), "the badge is decoration; the pill says the state");
  assert.ok(!V.missionSection({ text: "<script>x</script>", at: null, followUps: [], followUpCount: 0 }).includes("<script>"), "escaped");
});

// ---------- the controller, inside the shell ----------
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
    return { status: 200, ok: true, json: async () => JSON.parse(JSON.stringify(out)) };
  };
  const sources = [];
  class ES { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } }
  return { fetch, EventSource: ES, calls, sources };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settings = { offlineAfterMin: 30, dailyBudgetUsd: 25, notifyOnWaiting: false, aliases: {}, demo: true, teamMode: false, viewer: "mk" };

async function shellWith(routes, { hash = "" } = {}) {
  const dom = withDom(), D = demo(Date.now()), win = fakeWindow(hash);
  const srv = server({ "/api/state": { ...D.snap, settings }, "/api/timeline": D.timeline, ...routes(D) });
  const { createShell } = await pub("shell.js");
  const shell = createShell({ doc: dom.document, win, fetch: srv.fetch, EventSource: srv.EventSource });
  await shell.ready;
  await tick();
  const body = dom.document.body, q = (s) => body.querySelector(s);
  return { dom, D, win, srv, shell, body, q, sheet: q('[data-dialog="agent"]'), active: () => dom.document.activeElement, slot: (k) => q('[data-dialog="agent"]').querySelector(`[data-ad="${k}"]`) };
}

test("detail DOM: opens from the office, loads, filters, expands, filters by a file, jumps to sections; Esc closes and focus goes back", async () => {
  let t = null;
  try {
    t = await shellWith((D) => ({ "/api/agents/demo-basket": D.detail("demo-basket") }));
    const { q, sheet, slot, active, srv, body } = t;
    const character = body.querySelectorAll(".o3-agent").find((b) => b.getAttribute("data-session") === "demo-basket");
    character.focus();
    character.click();
    assert.equal(sheet.open, true);
    assert.equal(sheet.getAttribute("aria-labelledby"), "ad-title");
    assert.equal(active().getAttribute("data-key"), "ad-back");
    assert.equal(slot("title").textContent, "Agent details: supermarket-pos · basket bill");
    assert.equal(sheet.querySelector("#ad-name-in").value, "supermarket-pos · basket bill", "the header shows at once, from the live data");
    assert.equal(slot("trace").querySelector(".ao-loading") ? "loading" : "?", "loading", "skeletons while the detail loads");
    await tick(); await tick();
    assert.ok(srv.calls.some((c) => c.url === "/api/agents/demo-basket" && c.opts.headers["X-Requested-With"] === "agent-office"));
    assert.match(slot("mission").textContent, /You asked at ([A-Z][a-z]{2} \d{1,2}, )?\d\d:\d\dOpen in your editor: Basket\.tsx/, "with the date when it was yesterday (just after midnight)");
    assert.ok(slot("plan").textContent.includes("5 of 8 done"));
    const rows = () => slot("trace").querySelectorAll(".ad-row, .ad-branch, .ad-gap");
    const all = rows().length;
    assert.ok(all > 15, "a long trace (shorter early in the morning, when the demo day is squeezed into the hours since midnight)");

    // Edits only, then failed only too: nothing; Clear filters brings everything back.
    slot("filters").querySelector('[data-value="edits"]').click();
    assert.ok(rows().length < all && slot("trace").querySelectorAll(".ad-row").every((r) => /Edit|Creat/.test(r.textContent)));
    slot("filters").querySelector('[data-chip="errors"]').click();
    assert.ok(slot("trace").textContent.includes("No steps match these filters"));
    slot("trace").querySelector("[data-ad-clear]").click();
    assert.equal(rows().length, all);
    assert.equal(active().id, "ad-trace-h");
    assert.equal(slot("filters").querySelector('[data-chip="errors"]').getAttribute("aria-pressed"), "false");

    // Expand the failed step: its command, output and what failed.
    const chev = () => slot("trace").querySelector(".ad-row.is-error").querySelector("[data-ad-toggle]");
    chev().focus();
    chev().click();
    assert.equal(chev().getAttribute("aria-expanded"), "true");
    assert.equal(active(), chev(), "focus stays on it through the re-render");
    const more = slot("trace").querySelector(".ad-row.is-error").querySelector(".ad-more");
    assert.ok(more.textContent.includes("npm test -- basket") && more.textContent.includes("Received: 2000"));
    assert.equal(chev().getAttribute("aria-controls"), more.getAttribute("id"));

    // Steps on a file filters the trace to it and moves to the trace.
    const steps = slot("files").querySelectorAll("[data-ad-file]").find((b) => b.getAttribute("data-ad-file") === "src/money/round.ts");
    steps.click();
    assert.equal(slot("filters").querySelector("select").querySelector("[selected]").getAttribute("value"), "src/money/round.ts");
    assert.ok(slot("trace").querySelectorAll(".ad-row").every((r) => r.textContent.includes("round.ts")));
    assert.equal(active().id, "ad-trace-h");
    assert.equal(slot("files").querySelectorAll("[data-ad-file]").find((b) => b.getAttribute("data-ad-file") === "src/money/round.ts").getAttribute("aria-pressed"), "true");
    const pick = slot("filters").querySelector("select");
    pick.value = "";
    pick.dispatchEvent({ type: "change" });
    assert.equal(rows().length, all);

    // Section links move focus to the section, without touching the address (the router would switch screens).
    const link = sheet.querySelector('[data-ad-section="plan"]'), ev = { type: "click" };
    link.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(active().id, "ad-plan-h");

    // Esc closes it from anywhere inside, and focus goes back to the character.
    active().dispatchEvent({ type: "keydown", key: "Escape" });
    assert.equal(sheet.open, false);
    assert.equal(active(), character);
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});

test("detail DOM: message a working agent (same-origin POST), rename it on Enter; an offline one says messages can't reach it", async () => {
  let t = null, posted = null, named = null;
  try {
    t = await shellWith((D) => ({
      "/api/agents/demo-basket": D.detail("demo-basket"), "/api/agents/demo-webhook": D.detail("demo-webhook"),
      "/api/agents/demo-basket/message": (o) => { posted = o; return { ok: true, message: { id: 999, status: "queued" } }; },
      "/api/agents/demo-basket/name": (o) => { named = o; return { ok: true, name: JSON.parse(o.body).name }; },
    }));
    const { q, sheet, slot, active } = t;
    q('[data-agent="demo-basket"]').click();
    await tick(); await tick();
    const form = () => slot("composer").querySelector("[data-ad-message]"), area = () => form().querySelector("textarea"), send = () => form().querySelector("[data-ad-send]");
    assert.equal(send().hasAttribute("disabled"), true);
    assert.equal(slot("composer-note").textContent, "It's working now, so that's when this turn ends.");
    area().value = "Please also update the changelog";
    area().dispatchEvent({ type: "input" });
    assert.equal(send().hasAttribute("disabled"), false);
    // A live update while you type keeps your text.
    const typed = area();
    t.srv.sources[0].onmessage({ data: JSON.stringify(t.D.snap) });
    assert.equal(area(), typed);
    area().dispatchEvent({ type: "keydown", key: "Enter", ctrlKey: true });
    await tick(); await tick();
    assert.deepEqual([posted.method, posted.headers["X-Requested-With"], JSON.parse(posted.body)], ["POST", "agent-office", { text: "Please also update the changelog" }]);
    assert.equal(area().value, "");
    assert.equal(slot("status").getAttribute("role"), "status");
    assert.equal(slot("status").textContent, "Message sent. It gets it the next time it stops.");
    assert.ok(slot("convo").textContent.includes("Waiting for its next stop"), "your queued message is in the thread");

    // Rename: Enter in the name field saves it.
    const name = sheet.querySelector("#ad-name-in");
    name.value = "Till fixer";
    sheet.querySelector("[data-ad-name]").dispatchEvent({ type: "submit" });
    await tick(); await tick();
    assert.deepEqual([named.method, JSON.parse(named.body)], ["POST", { name: "Till fixer" }]);
    assert.equal(slot("name-status").textContent, "Name saved.");
    sheet.querySelector("[data-close]").click();

    // An offline machine: no box, and why.
    q('[data-agent="demo-webhook"]').click();
    await tick(); await tick();
    assert.equal(slot("composer").textContent.trim(), "build-server is offline, so messages can't reach this session right now.");
    assert.equal(slot("composer").querySelector("textarea"), null);
    assert.ok(slot("trace").textContent.includes("Offline"), "its offline spell in the trace");
    assert.equal(active().getAttribute("data-key"), "ad-back");
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});

test("detail DOM: answer an agent that needs you from its conversation; the answer goes through the same POST /api/answer", async () => {
  let t = null, answered = null;
  try {
    t = await shellWith((D) => ({
      "/api/agents/demo-receipt": D.detail("demo-receipt"),
      "/api/answer": (o) => { answered = JSON.parse(o.body); return { ok: true, questionId: D.snap.agents.find((a) => a.session === "demo-receipt").question.id, until: new Date(Date.now() + 300000).toISOString(), delivered: false }; },
    }), { hash: "#/board?agent=demo-receipt" });
    const { sheet, slot, active, win } = t;
    assert.equal(sheet.open, true, "the address opened it over the work board");
    assert.ok(sheet.querySelector(".ad-back").textContent.includes("Back to work board"));
    await tick(); await tick();
    const box = slot("composer");
    const receipt = t.D.snap.agents.find((a) => a.session === "demo-receipt");
    assert.equal(box.querySelector("[data-answer-form]").getAttribute("data-answer-form"), receipt.question.ask.id);
    assert.ok(box.querySelector("#ad-reply") && !t.body.querySelector("#cc-reply"), "its own ids");
    assert.match(box.querySelector("[data-answer-left]").textContent, /^\d:\d\d left to answer here$/);
    assert.ok(slot("convo").querySelector(".ad-b--needs").textContent.includes("sudo apt install cups-filters"), "the open question in amber");
    box.querySelector('[data-choice="approve"]').click();
    box.querySelector('[data-choice="approve"]')?.click();
    await tick(); await tick();
    assert.deepEqual(answered, { askId: receipt.question.ask.id, kind: "approve", text: "" });
    assert.equal(t.srv.calls.filter((c) => c.url === "/api/answer").length, 1, "one click, one answer");
    assert.equal(slot("composer").textContent, "", "no more buttons");
    assert.equal(slot("status").textContent, "Sending your answer to studio-mac…");
    assert.equal(active().id, "ad-convo-h");
    sheet.close();
    assert.equal(win.location.hash, "#/board", "closing drops ?agent= from the address");
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});

test("detail DOM: a failed load says so with Retry; an agent the server no longer has says that; a dropped stream says As of", async () => {
  let t = null, up = false;
  try {
    t = await shellWith((D) => ({ "/api/agents/demo-basket": () => (up ? D.detail("demo-basket") : undefined), "/api/agents/demo-tokens": { status: 404, error: "No agent with that id." } }));
    const { q, sheet, slot } = t;
    q('[data-agent="demo-basket"]').click();
    await tick(); await tick();
    assert.match(slot("state").textContent, /Couldn't load this agent's details\. The server didn't answer\./);
    assert.ok(slot("state").querySelector('[role="alert"]'));
    assert.equal(sheet.querySelector("#ad-sec-trace").hasAttribute("hidden"), true);
    up = true;
    slot("state").querySelector("[data-ad-retry]").click();
    await tick(); await tick();
    assert.equal(slot("state").textContent, "");
    assert.equal(sheet.querySelector("#ad-sec-trace").hasAttribute("hidden"), false);
    t.srv.sources[0].onerror();
    assert.match(slot("asof").textContent, /^As of \d\d:\d\d$/);
    assert.ok(slot("body").classList.contains("ao-stale"));
    sheet.close();
    q('[data-agent="demo-tokens"]').click();
    await tick(); await tick();
    assert.match(slot("state").textContent, /The server has no more detail for this agent/);
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});

test("detail DOM: a link to a session older than the live day opens it from its own detail; an unknown id opens and says it's gone", async () => {
  let t = null;
  try {
    t = await shellWith((D) => ({
      "/api/agents/demo-hist-3-checkout-api": D.detail("demo-hist-3-checkout-api"),
      "/api/agents/nope-not-here": { status: 404, error: "No agent with that id." },
    }), { hash: "#/cost?agent=demo-hist-3-checkout-api" });
    const { sheet, slot, win, D } = t;
    await tick(); await tick();
    assert.ok(!D.snap.agents.some((a) => a.session === "demo-hist-3-checkout-api"), "not in the live data: it ended 3 days ago");
    assert.equal(sheet.open, true);
    assert.ok(sheet.querySelector(".ad-back").textContent.includes("Back to cost report"));
    assert.equal(sheet.querySelector("#ad-name-in").value, "checkout-api · order status", "the header comes from its detail");
    assert.match(slot("sub").textContent, /Offline/);
    assert.equal(slot("composer").textContent.trim(), "This session has ended, so messages can't reach it.");
    assert.ok(slot("mission").textContent.includes("Clean up the order status emails"));
    assert.match(slot("mission").textContent, /You asked at [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d/, "another day: with the date");
    assert.match(slot("facts").textContent, /Duration\d+m · [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d to \d\d:\d\d/);
    assert.equal(slot("state").textContent, "");

    // An id the server doesn't know: the dialog opens anyway, says so, and shows which session was asked for.
    win.go("#/office?agent=nope-not-here");
    assert.equal(sheet.open, true);
    await tick(); await tick();
    assert.match(slot("state").textContent, /The server has no more detail for this agent\. It may be past the 30-day retention\./);
    assert.equal(slot("name").textContent.replace(/\s+/g, " ").trim(), "Session nope-not-here");
    assert.equal(sheet.querySelector("#ad-name-in"), null, "nothing to rename");
    assert.equal(slot("title").textContent, "Agent details");
    assert.equal(slot("composer").textContent, "");
    assert.ok(["mission", "convo", "plan", "trace", "files"].every((k) => sheet.querySelector(`#ad-sec-${k}`).hasAttribute("hidden")));
    assert.ok(sheet.querySelector('[data-key="ad-back"]'), "Back still closes it");
    sheet.querySelector("[data-close]").click();
    assert.equal(win.location.hash, "#/office");
  } finally { t?.shell.destroy(); t?.dom.restore(); }
});

test("detail DOM: before its detail arrives, an agent the live data doesn't have shows its session id and a skeleton", async () => {
  const V = await pub("agent-detail-view.js");
  const html = V.bareName("demo-hist-3-checkout-api", { loading: true });
  assert.ok(seen(html).startsWith("Session demo-hist-3-checkout-api") && html.includes("ao-loading") && html.includes("Loading this agent"));
  assert.ok(!V.bareName("<b>x</b>").includes("<b>"), "escaped");
});
