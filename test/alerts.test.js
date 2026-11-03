"use strict";
// The Alerts Center (M10): separate Slack and Discord webhooks (migrated from webhookUrl, or from the environment), the
// four rules and how they repeat, each delivery per channel with Retry and Send test, the saved history, the endpoints,
// the demo's story, the model and markup (colour and text rules, every panel state), and the screen in the shell on a
// fake DOM. Every clock is pinned, so nothing depends on the time of day.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { pathToFileURL } = require("url");
const { Store } = require("../src/store");
const { Alerts, sendWebhook, message, mask, hintOf } = require("../src/alerts");
const config = require("../src/config");
const { loadScenario, demoWebhook, DEMO_CHANNELS } = require("../src/demo");
const { createServer } = require("../src/server");
const { withDom } = require("./helpers/dom");

const pub = (f) => import(pathToFileURL(path.join(__dirname, "..", "public", f)).href);
const M = 60000, DAY = 86400000;
const NOW = new Date(2026, 9, 24, 15, 42).getTime(); // Sat Oct 24 2026, 15:42 local: the reference's "now"
const T0 = new Date(2026, 9, 24, 12, 0).getTime();
const iso = (t) => new Date(t).toISOString();
const json = (x) => JSON.parse(JSON.stringify(x));
const quiet = { log() {}, warn() {}, error() {} };
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefgh1234", DISCORD = "https://discord.com/api/webhooks/42/zyxw9876";

/** A store and an alerts engine with a stand-in transport: fail = { channel: HTTP code } makes that channel fail. */
function rig({ cfg = {}, file = null, env = {} } = {}) {
  let c = { offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 0, slackWebhookUrl: SLACK, discordWebhookUrl: DISCORD, alertRules: config.rulesOf(), ...cfg };
  const store = new Store({ getConfig: () => c }), sent = [], fail = {};
  const transport = async (x) => { sent.push(x); const code = fail[x.channel]; return code ? { ok: false, code, error: `HTTP ${code}` } : { ok: true, code: 200 }; };
  const alerts = new Alerts({ store, getConfig: () => c, transport, env, file, log: quiet });
  const set = (o) => { c = { ...c, ...o }; };
  const rules = (patch) => set({ alertRules: config.applyAlerts(c, { alertRules: patch }).cfg.alertRules });
  return { store, alerts, sent, fail, set, rules };
}
const ev = (store, t, name, extra = {}) => store.apply({ type: "hook", t: iso(t), session: "a", ev: name, cwd: "/p/shop", gitRoot: "/p/shop", host: "box", ...extra });
const use = (store, t, cost, session = "a") => store.apply({ type: "usage", t: iso(t), session, cost, model: "claude-sonnet-4-6" });
const fails = (store, t, n, id = "t", session = "a") => { for (let i = 0; i < n; i++) {
  ev(store, t + i * 1000, "PreToolUse", { session, tool: "Bash", target: "npm test", detail: { command: "npm test" }, toolUseId: `${id}${i}` });
  ev(store, t + i * 1000 + 500, "PostToolUseFailure", { session, tool: "Bash", toolUseId: `${id}${i}`, result: { ok: false } });
} };
/** An Edit waiting on its permission from `since`. */
function waits(store, since, id = "e1") {
  ev(store, since - 1000, "PreToolUse", { tool: "Edit", target: "/p/shop/.env.production", detail: { path: "/p/shop/.env.production" }, toolUseId: id });
  ev(store, since, "PermissionRequest", { tool: "Edit", target: "/p/shop/.env.production", detail: { path: "/p/shop/.env.production" } });
}

// ---------- config: two channels, migrated; the rules ----------
test("config: the old single webhook moves to Slack or Discord by its address; notifyOnWaiting off starts the waiting rule off", () => {
  assert.deepEqual(config.migrate({ webhookUrl: SLACK, notifyOnWaiting: true }), { slackWebhookUrl: SLACK, notifyOnWaiting: true });
  assert.deepEqual(config.migrate({ webhookUrl: "https://discordapp.com/api/webhooks/1/x" }), { discordWebhookUrl: "https://discordapp.com/api/webhooks/1/x" });
  assert.deepEqual(config.migrate({ webhookUrl: "https://chat.example.com/hooks/abc" }), { slackWebhookUrl: "https://chat.example.com/hooks/abc" }, "Slack-compatible services keep working");
  assert.deepEqual(config.migrate({ webhookUrl: SLACK, discordWebhookUrl: DISCORD }), { discordWebhookUrl: DISCORD }, "already split: the old key just goes");
  assert.deepEqual(config.migrate({ notifyOnWaiting: false }), { notifyOnWaiting: false, alertRules: { waiting: { on: false } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-alert-cfg-"));
  try {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ token: "t", webhookUrl: DISCORD, notifyOnWaiting: false, dailyBudgetUsd: 25 }));
    const cfg = config.load(dir);
    assert.deepEqual([cfg.discordWebhookUrl, cfg.slackWebhookUrl, cfg.webhookUrl, cfg.dailyBudgetUsd], [DISCORD, "", undefined, 25]);
    assert.deepEqual(cfg.alertRules, { waiting: { on: false, minutes: 3, slack: true, discord: true }, session: { on: true, usd: 3.5, slack: true, discord: true },
      budget: { on: true, percent: 80, slack: true, discord: true }, failures: { on: true, count: 3, slack: true, discord: true } });
    config.save(cfg, dir);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.ok(!("webhookUrl" in saved) && saved.discordWebhookUrl === DISCORD && saved.alertRules.waiting.on === false, "saved in the new shape");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(config.rulesOf({ waiting: { minutes: 9999 }, budget: "x", failures: { count: 5, slack: false } }).failures, { on: true, count: 5, slack: false, discord: true });
  assert.equal(config.rulesOf({ waiting: { minutes: 9999 } }).waiting.minutes, 3, "out of range: the default");
});

test("config: webhook URLs and channel names are checked; rules are changed a part at a time and checked; only the Alerts Center changes them", () => {
  const { applyAlerts: applySettings, DEFAULTS } = config, err = (body) => applySettings(DEFAULTS, body).error;
  const other = config.applySettings(DEFAULTS, { slackWebhookUrl: SLACK, discordWebhookUrl: DISCORD, slackChannel: "#x", alertRules: { waiting: { on: false } }, dailyBudgetUsd: 5 }).cfg;
  assert.deepEqual([other.slackWebhookUrl, other.discordWebhookUrl, other.slackChannel, other.alertRules, other.dailyBudgetUsd], ["", "", "", DEFAULTS.alertRules, 5], "settings leave them alone");
  assert.equal(err({ slackWebhookUrl: "http://hooks.slack.com/x" }), "The Slack webhook URL must start with https://");
  assert.equal(err({ slackWebhookUrl: DISCORD }), "That's a Discord webhook. Add it under Discord.");
  assert.equal(err({ discordWebhookUrl: SLACK }), "A Discord webhook URL starts with https://discord.com/api/webhooks/");
  assert.equal(err({ discordWebhookUrl: `https://discord.com/api/webhooks/${"x".repeat(600)}` }), "The Discord webhook URL must start with https://");
  assert.equal(err({ slackChannel: "x".repeat(41) }), "Keep the Slack channel name under 40 characters.");
  assert.equal(err({ discordChannel: "#ops\u0007" }), "Keep the Discord channel name under 40 characters.");
  const ok = applySettings(DEFAULTS, { slackWebhookUrl: ` ${SLACK} `, discordWebhookUrl: DISCORD, slackChannel: " #agent-office ", discordChannel: null }).cfg;
  assert.deepEqual([ok.slackWebhookUrl, ok.discordWebhookUrl, ok.slackChannel, ok.discordChannel], [SLACK, DISCORD, "#agent-office", ""]);
  assert.equal(applySettings(ok, { slackWebhookUrl: "" }).cfg.slackWebhookUrl, "", "empty removes it");

  const r = applySettings(DEFAULTS, { alertRules: { waiting: { minutes: "5", discord: false }, session: { usd: 2.499 } } }).cfg.alertRules;
  assert.deepEqual([r.waiting, r.session.usd, r.budget], [{ on: true, minutes: 5, slack: true, discord: false }, 2.5, DEFAULTS.alertRules.budget]);
  assert.equal(applySettings(DEFAULTS, { alertRules: { budget: { percent: 100 } } }).error, "The budget warning must be 1 to 99% (the alert at 100% always comes too).");
  assert.equal(applySettings(DEFAULTS, { alertRules: { waiting: { minutes: "" } } }).error, "The wait must be 1 to 240 minutes.");
  assert.equal(applySettings(DEFAULTS, { alertRules: { failures: { count: 0 } } }).error, "Failed calls in a row must be 1 to 50.");
  assert.equal(applySettings(DEFAULTS, { alertRules: { session: { usd: 0 } } }).error, "The session cost must be $0.01 to $10,000.");
  for (const bad of [{ nope: {} }, { __proto__: {} }, { constructor: {} }]) assert.match(applySettings(DEFAULTS, { alertRules: JSON.parse(JSON.stringify(bad).replace("{}", '{"on":false}')) }).error || "", /There's no alert rule called|must be an object/);
  assert.equal(applySettings(DEFAULTS, { alertRules: [] }).error, "alertRules must be an object.");
  assert.equal(applySettings(DEFAULTS, { alertRules: { waiting: 3 } }).error, "The waiting rule must be an object.");
});

// ---------- sending ----------
test("sendWebhook: Slack gets { text } with & < > escaped, Discord { content } with no mentions; a status, a timeout or a network error comes back as words", async () => {
  const calls = [];
  const fetchOk = async (url, o) => { calls.push({ url, ...o, body: JSON.parse(o.body) }); return { ok: true, status: 204 }; };
  const evil = "fix <!channel> & <https://evil.example|click> @everyone <@U123>";
  assert.deepEqual(await sendWebhook(SLACK, evil, { fetch: fetchOk }), { ok: true, code: 204, error: null });
  assert.deepEqual(await sendWebhook(DISCORD, evil, { channel: "discord", fetch: fetchOk }), { ok: true, code: 204, error: null });
  assert.deepEqual(calls[0].body, { text: "fix &lt;!channel&gt; &amp; &lt;https://evil.example|click&gt; @everyone &lt;@U123&gt;" }, "no Slack mention, link or channel from an agent's text");
  assert.deepEqual(calls[1].body, { content: evil, allowed_mentions: { parse: [] } }, "Discord shows the text and pings nobody");
  await sendWebhook(DISCORD, "x".repeat(3000), { channel: "discord", fetch: fetchOk });
  assert.equal(calls[2].body.content.length, 2000, "Discord's limit");
  assert.deepEqual([calls[0].method, calls[0].redirect, calls[0].headers["Content-Type"]], ["POST", "manual", "application/json"]);
  // A redirect is reported, never followed.
  const hits = [], srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(req.url === "/hook" ? 302 : 200, { Location: "/elsewhere" }); res.end(); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    assert.deepEqual(await sendWebhook(`http://127.0.0.1:${srv.address().port}/hook`, "hi"), { ok: false, code: 302, error: "HTTP 302" });
    assert.deepEqual(hits, ["/hook"], "the redirect's target was never asked");
  } finally { await new Promise((r) => srv.close(r)); }
  assert.deepEqual(await sendWebhook(SLACK, "hi", { fetch: async () => ({ ok: false, status: 0, type: "opaqueredirect" }) }), { ok: false, code: 302, error: "HTTP 302" }, "as a browser-style fetch reports it");
  assert.deepEqual(await sendWebhook(SLACK, "hi", { fetch: async () => ({ ok: false, status: 404 }) }), { ok: false, code: 404, error: "HTTP 404" });
  assert.deepEqual(await sendWebhook(SLACK, "hi", { fetch: async () => { throw new Error("ENOTFOUND"); } }), { ok: false, code: null, error: "Couldn't reach hooks.slack.com" });
  assert.deepEqual(await sendWebhook("", "hi"), { ok: false, code: null, error: "No webhook URL" });
  const hang = (url, o) => new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const t = Date.now(), r = await sendWebhook(SLACK, "hi", { fetch: hang });
  assert.deepEqual([r.ok, r.error], [false, "No answer within 4 s"]);
  assert.ok(Date.now() - t < 6000);
  assert.deepEqual([404, 410, 401, 429, 503, 400, 301, null].map(hintOf), ["the webhook may have been deleted", "the webhook may have been deleted", "the webhook refused it, so check the URL",
    "too many messages for now, so try again in a minute", "the service had a problem, so try again later", "the webhook didn't accept the message",
    "the webhook redirected, and the server doesn't follow redirects, so check the URL", "check the URL and this server's network"]);
  assert.deepEqual([mask(SLACK), mask(DISCORD), mask("nope")], ["hooks.slack.com/…1234", "discord.com/…9876", "…"], "enough to tell them apart, not to post");
});

// ---------- the rules ----------
test("waiting: after the rule's minutes (not at), then every 15 minutes until it's answered; each delivery logged per channel", async () => {
  const { store, alerts, sent } = rig();
  ev(store, T0, "UserPromptSubmit", { prompt: "Refund flow for partial refunds" });
  const since = T0 + M;
  waits(store, since);
  alerts.check(since + 3 * M);
  assert.equal(alerts.list.length, 0, "3 minutes is not longer than 3 minutes");
  alerts.check(since + 3 * M + 15000);
  await alerts.idle();
  let [a] = alerts.view(NOW).alerts;
  assert.deepEqual([a.kind, a.name, a.label, a.project, a.host, a.waited, a.repeat, a.what, a.target, a.since, a.end], ["waiting", "shop · refund flow", "refund flow", "shop", "box", 3, 0, "to edit a file", ".env.production", iso(since), null]);
  assert.deepEqual([a.sent.slack.status, a.sent.slack.tries, a.sent.slack.at, a.sent.discord.status], ["sent", 1, iso(since + 3 * M + 15000), "sent"]);
  assert.deepEqual(sent.map((x) => [x.channel, x.url]), [["slack", SLACK], ["discord", DISCORD]]);
  assert.equal(sent[0].text, "🟠 refund flow · shop on box has waited 3 min to edit a file: .env.production");
  alerts.check(since + 18 * M);
  assert.equal(alerts.list.length, 1, "not before 15 minutes");
  alerts.check(since + 18 * M + 15000);
  await alerts.idle();
  [a] = alerts.view(NOW).alerts;
  assert.deepEqual([alerts.list.length, a.waited, a.repeat], [2, 18, 1], "a reminder");
  // Answered: both of its alerts get the time and how; no more reminders.
  ev(store, since + 20 * M, "PostToolUse", { tool: "Edit", toolUseId: "e1", result: { ok: true } });
  alerts.check(since + 40 * M);
  assert.equal(alerts.list.length, 2);
  assert.deepEqual(alerts.list.map((x) => x.end), [{ t: iso(since + 20 * M), how: "answered" }, { t: iso(since + 20 * M), how: "answered" }]);
});

test("waiting: a reopened question doesn't alert twice; a new question does; the rule off sends nothing; ended and offline waits", async () => {
  const { store, alerts, rules } = rig();
  ev(store, T0, "PreToolUse", { tool: "Bash", target: "rm -rf dist", detail: { command: "rm -rf dist" }, toolUseId: "t1" });
  ev(store, T0 + 1000, "PermissionRequest", { tool: "Bash", target: "rm -rf dist", detail: { command: "rm -rf dist" } });
  alerts.check(T0 + 4 * M);
  ev(store, T0 + 4 * M + 1000, "PreToolUse", { tool: "Read", target: "a.ts", toolUseId: "t2" }); // a parallel call clears it
  ev(store, T0 + 4 * M + 2000, "Notification", { notificationType: "permission_prompt", message: "Claude needs your permission to use Bash" }); // its dialog is still up
  alerts.check(T0 + 5 * M);
  assert.equal(alerts.list.length, 1, "the same question, reopened: no second alert");
  assert.equal(alerts.list[0].what, "to run a command");
  ev(store, T0 + 6 * M, "PostToolUse", { tool: "Bash", toolUseId: "t1", result: { ok: true } });
  waits(store, T0 + 7 * M, "e2");
  alerts.check(T0 + 11 * M);
  assert.equal(alerts.list.length, 2, "a new question is a new alert");
  ev(store, T0 + 12 * M, "SessionEnd", {});
  alerts.check(T0 + 13 * M);
  assert.deepEqual(alerts.list[1].end, { t: iso(T0 + 12 * M), how: "ended" });
  rules({ waiting: { on: false } });
  ev(store, T0 + 14 * M, "SessionStart", {});
  waits(store, T0 + 15 * M, "e3");
  alerts.check(T0 + 30 * M);
  assert.equal(alerts.list.length, 2, "off: no alert");
  // Silent past 8 hours while waiting: offline, and its wait alert ends.
  const b = rig();
  waits(b.store, T0);
  b.alerts.check(T0 + 4 * M);
  b.alerts.check(T0 + 9 * 3600000);
  assert.deepEqual(b.alerts.list[0].end, { t: iso(T0 + 9 * 3600000), how: "offline" });
  await Promise.all([b.alerts.idle(), alerts.idle()]);
});

test("session cost: once per session, again only past a higher limit; a rule turned on starts from now", async () => {
  const { store, alerts, rules, sent } = rig();
  ev(store, T0, "UserPromptSubmit", { prompt: "Basket bill rounding" });
  use(store, T0 + M, 3);
  alerts.check(T0 + 2 * M);
  use(store, T0 + 3 * M, 0.6);
  alerts.check(T0 + 4 * M);
  use(store, T0 + 5 * M, 1);
  alerts.check(T0 + 6 * M);
  await alerts.idle();
  assert.deepEqual(alerts.list.map((a) => [a.kind, Math.round(a.cost * 100), a.limit, a.model]), [["session", 360, 3.5, "claude-sonnet-4-6"]]);
  assert.equal(sent[0].text, "💸 basket bill · shop on box has cost $3.60, more than your $3.50 limit for one session.");
  rules({ session: { usd: 4 } }); // already past $4: that's now, not news
  alerts.check(T0 + 7 * M);
  use(store, T0 + 8 * M, 1);
  alerts.check(T0 + 9 * M);
  assert.equal(alerts.list.length, 1);
  rules({ session: { usd: 10 } });
  alerts.check(T0 + 10 * M);
  use(store, T0 + 11 * M, 5);
  alerts.check(T0 + 12 * M);
  assert.deepEqual(alerts.list.map((a) => a.limit), [3.5, 10], "past the higher limit");
  rules({ session: { usd: 2 } });
  use(store, T0 + 13 * M, 1);
  alerts.check(T0 + 14 * M);
  assert.equal(alerts.list.length, 2, "a lower limit never alerts an alerted session again");
  // Already over the limit when the rules first run (an upgrade, a restart without history): no burst of alerts.
  const b = rig();
  use(b.store, T0, 9, "x");
  b.alerts.check(T0 + M);
  use(b.store, T0 + 2 * M, 1, "x");
  b.alerts.check(T0 + 3 * M);
  assert.equal(b.alerts.list.length, 0);
  await alerts.idle();
});

test("budget: a warning at the rule's share, an alert at 100%, once each a day; straight past both, only the second; none without a budget", async () => {
  const { store, alerts, set, sent, rules } = rig({ cfg: { dailyBudgetUsd: 10 } });
  rules({ session: { on: false } });
  alerts.check(T0);
  for (const [m, cost] of [[1, 7], [2, 1.5], [3, 0.1], [4, 2], [5, 3]]) { use(store, T0 + m * M, cost); alerts.check(T0 + m * M + 1000); }
  await alerts.idle();
  assert.deepEqual(alerts.list.map((a) => [a.kind, a.level, Math.round(a.spent * 100), a.budget, a.percent, a.date]), [["budget", "warn", 850, 10, 80, "2026-10-24"], ["budget", "over", 1060, 10, 80, "2026-10-24"]]);
  assert.deepEqual([message(alerts.list[0], T0), message(alerts.list[1], T0 + DAY)], ["💸 Claude spend today passed 80% of your $10.00 daily budget: $8.50 so far.",
    "🔴 Claude spend on 2026-10-24 passed your $10.00 daily budget: $10.60 so far."]);
  assert.equal(sent.length, 4);
  use(store, T0 + DAY, 12); // the next day, past both at once
  alerts.check(T0 + DAY + 1000);
  assert.deepEqual(alerts.list.slice(2).map((a) => [a.level, a.date]), [["over", "2026-10-25"]]);
  // A higher budget mid-day starts from now: the new levels alert when they're reached.
  set({ dailyBudgetUsd: 20 });
  alerts.check(T0 + DAY + 2000);
  use(store, T0 + DAY + 3000, 5);
  alerts.check(T0 + DAY + 4000);
  assert.deepEqual(alerts.list.slice(3).map((a) => [a.level, Math.round(a.spent)]), [["warn", 17]]);
  const none = rig();
  use(none.store, T0, 100);
  none.alerts.check(T0 + 1000);
  assert.equal(none.alerts.list.length, 0, "no daily budget, nothing to pass");
  await alerts.idle();
});

test("failures: once per run of failed calls in a row; a call that works ends it (working again); the next run alerts again", async () => {
  const { store, alerts, sent } = rig();
  ev(store, T0, "UserPromptSubmit", { prompt: "Card captures should retry" });
  fails(store, T0 + M, 2);
  alerts.check(T0 + 2 * M);
  assert.equal(alerts.list.length, 0);
  fails(store, T0 + 2 * M + 1000, 2, "u");
  alerts.check(T0 + 3 * M);
  alerts.check(T0 + 4 * M);
  await alerts.idle();
  let [a] = alerts.list;
  assert.deepEqual([alerts.list.length, a.kind, a.count, a.since, a.tool, a.target, a.end], [1, "failures", 4, iso(T0 + M + 500), "Bash", "npm test", null]);
  assert.equal(sent[0].text, "⚠️ card captures · shop on box failed 4 tool calls in a row. The last one: npm test");
  // Two calls work before the next check: the run ended at the first.
  for (const [i, m] of [[1, 5], [2, 5.5]]) {
    ev(store, T0 + m * M, "PreToolUse", { tool: "Read", target: "/p/shop/a.ts", toolUseId: `ok${i}` });
    ev(store, T0 + m * M + 500, "PostToolUse", { tool: "Read", toolUseId: `ok${i}`, result: { ok: true } });
  }
  alerts.check(T0 + 6 * M);
  assert.deepEqual(a.end, { t: iso(T0 + 5 * M + 500), how: "recovered" });
  fails(store, T0 + 7 * M, 3, "v");
  alerts.check(T0 + 8 * M);
  assert.equal(alerts.list.length, 2, "a new run");
  [, a] = alerts.list;
  assert.equal(a.count, 3);
  // A sub-agent's run is its own: the main agent's working calls in between don't end it, and calls you interrupted
  // don't count.
  for (const [i, agentId, ok, interrupted] of [[1, "sub-1", false], [2, null, true], [3, "sub-1", false, true], [4, "sub-1", false], [5, null, true], [6, "sub-1", false]]) {
    ev(store, T0 + 9 * M + i * 1000, "PreToolUse", { tool: "Bash", target: "npm run e2e", detail: { command: "npm run e2e" }, toolUseId: `w${i}`, agentId });
    ev(store, T0 + 9 * M + i * 1000 + 500, "PostToolUse", { tool: "Bash", toolUseId: `w${i}`, agentId, result: { ok, ...(interrupted ? { interrupted } : {}) } });
  }
  alerts.check(T0 + 10 * M);
  await alerts.idle();
  a = alerts.list.at(-1);
  assert.deepEqual([alerts.list.length, a.agent, a.count, a.target, alerts.list[1].end], [3, "sub-1", 3, "npm run e2e", { t: iso(T0 + 9 * M + 2500), how: "recovered" }]);
  assert.equal(sent.at(-1).text, "⚠️ card captures · shop on box failed 3 tool calls in a row in a sub-agent. The last one: npm run e2e");
  const A = await pub("alerts-model.js");
  assert.deepEqual(A.alertText(json(a)).context, ["In a sub-agent", "shop", "box", "Last: Ran a command"]);
});

// ---------- delivery, retry, health, tests ----------
test("deliveries: off for the rule, no webhook, sent, failed; Retry turns a failure into Delivered (retried); a channel's health and its fix", async () => {
  const r = rig();
  r.rules({ session: { slack: false } });
  r.fail.discord = 404;
  r.alerts.check(T0 - 1000); // the rules start from now
  use(r.store, T0, 4);
  r.alerts.check(T0 + 1000);
  await r.alerts.idle();
  let [a] = r.alerts.list;
  assert.deepEqual([a.sent.slack, a.sent.discord], [{ status: "off" }, { status: "failed", tries: 1, at: iso(T0 + 1000), error: "HTTP 404", hint: "the webhook may have been deleted" }]);
  let d = r.alerts.view(T0 + 2000).channels.find((c) => c.id === "discord");
  assert.deepEqual([d.status, d.failSince, d.error, d.hint, d.delivered, d.url, d.source, d.channel], ["failing", iso(T0 + 1000), "HTTP 404", "the webhook may have been deleted", 0, "discord.com/…9876", "settings", null]);
  assert.equal(r.alerts.view(T0).channels[0].status, "new", "Slack: nothing sent to it yet");
  // Retry while it still fails: a second failure, failing since the first.
  assert.deepEqual(json(await r.alerts.retry(a.id, "discord", T0 + 2 * M)).alert.sent.discord, { status: "failed", tries: 2, at: iso(T0 + 2 * M), error: "HTTP 404", hint: "the webhook may have been deleted" });
  assert.equal(r.alerts.view(T0).channels[1].failSince, iso(T0 + 1000));
  // Fixed: the retry delivers, tries > 1 says it was retried, and the channel is healthy.
  delete r.fail.discord;
  const p = r.alerts.retry(a.id, "discord", T0 + 3 * M);
  assert.equal(a.sent.discord.status, "sending", "Retrying… while it's on its way");
  assert.equal((await r.alerts.retry(a.id, "discord")).code, 409, "not twice at once");
  await p;
  assert.deepEqual([a.sent.discord.status, a.sent.discord.tries, a.sent.discord.at], ["sent", 3, iso(T0 + 3 * M)]);
  d = r.alerts.view(T0 + 4 * M).channels[1];
  assert.deepEqual([d.status, d.lastOk, d.failSince, d.delivered], ["ok", iso(T0 + 3 * M), null, 1]);
  assert.deepEqual((await r.alerts.retry(a.id, "discord")), { code: 409, error: "It already reached Discord." });
  assert.deepEqual((await r.alerts.retry(a.id, "slack")), { code: 409, error: "This alert wasn't for Slack, so there's nothing to retry." });
  assert.deepEqual((await r.alerts.retry("nope", "slack")).code, 404);
  assert.deepEqual((await r.alerts.retry(a.id, "teams")).code, 400);
  // A new URL is a new webhook: its health starts over.
  r.set({ discordWebhookUrl: "https://discord.com/api/webhooks/43/new0" });
  assert.equal(r.alerts.view(T0).channels[1].status, "new");
  // No webhook set up when it fired: "none", and nothing to retry until there is one.
  r.set({ slackWebhookUrl: "" });
  r.rules({ session: { slack: true } });
  use(r.store, T0 + 5 * M, 1, "b");
  use(r.store, T0 + 5 * M, 4, "c");
  r.alerts.check(T0 + 6 * M);
  await r.alerts.idle();
  a = r.alerts.list.at(-1);
  assert.deepEqual(a.sent.slack, { status: "none" });
  assert.equal(r.alerts.view(T0).channels[0].status, "none");
});

test("Send test: delivered or why not, and it counts toward the channel's health; one at a time; none without a webhook", async () => {
  const r = rig();
  assert.deepEqual(await r.alerts.test("slack", T0), { ok: true, at: iso(T0) });
  assert.equal(r.sent[0].text, "✅ Virtual Office test alert. Alerts reach this channel.");
  assert.deepEqual([r.alerts.view(T0).channels[0].status, r.alerts.view(T0).channels[0].lastOk], ["ok", iso(T0)]);
  r.fail.discord = 403;
  assert.deepEqual(await r.alerts.test("discord", T0), { code: 502, error: "Discord didn't take the test: HTTP 403 · the webhook refused it, so check the URL." });
  assert.equal(r.alerts.view(T0).channels[1].status, "failing");
  const p = r.alerts.test("slack", T0);
  assert.equal(r.alerts.view(T0).channels[0].testing, true);
  assert.equal((await r.alerts.test("slack", T0)).code, 409);
  await p;
  r.set({ slackWebhookUrl: "" });
  assert.deepEqual(await r.alerts.test("slack"), { code: 409, error: "Set up the Slack webhook first." });
  assert.equal((await r.alerts.test("email")).code, 400);
  // A transport that throws is a failure, not a crash.
  const t = new Alerts({ store: r.store, getConfig: () => ({ slackWebhookUrl: SLACK }), transport: async () => { throw new Error("boom"); }, env: {}, log: quiet });
  assert.deepEqual(await t.test("slack", T0), { code: 502, error: "Slack didn't take the test: No answer · check the URL and this server's network." });
});

test("environment: SLACK_WEBHOOK_URL and DISCORD_WEBHOOK_URL win over the settings and can't be changed from the dashboard", async () => {
  const r = rig({ env: { SLACK_WEBHOOK_URL: " https://hooks.slack.com/services/E/N/v0001 " }, cfg: { slackWebhookUrl: "" } });
  const c = r.alerts.view(T0).channels[0];
  assert.deepEqual([c.status, c.source, c.env, c.url], ["new", "env", "SLACK_WEBHOOK_URL", "hooks.slack.com/…0001"]);
  await r.alerts.test("slack", T0);
  assert.equal(r.sent[0].url, "https://hooks.slack.com/services/E/N/v0001");
  assert.deepEqual(r.alerts.settings({ slack: { url: SLACK } }), { code: 409, error: "SLACK_WEBHOOK_URL is set on the server, so the Slack webhook is changed there." });
  assert.deepEqual(r.alerts.settings({ slack: { channel: "#alerts" }, discord: { url: "" }, rules: { waiting: { on: false } } }),
    { patch: { slackChannel: "#alerts", discordWebhookUrl: "", alertRules: { waiting: { on: false } } } }, "its channel name can still be set");
  for (const bad of [null, [], { slack: 1 }, { slack: { url: 5 } }, { discord: { channel: 5 } }]) assert.equal(r.alerts.settings(bad).code, 400, JSON.stringify(bad));
});

// ---------- saving ----------
test("history: saved to alerts.json without the URLs; a restart doesn't alert again or forget; a send cut off by it shows as failed; 7 days kept", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-alerts-")), file = path.join(dir, "alerts.json");
  try {
    const a = rig({ file, cfg: { dailyBudgetUsd: 5 } });
    a.alerts.check(T0);
    ev(a.store, T0, "UserPromptSubmit", { prompt: "Refund flow" });
    waits(a.store, T0 + M);
    use(a.store, T0 + M, 4.5);
    fails(a.store, T0 + 2 * M, 3, "f", "b"); // another session: a call of its own would answer the wait
    a.alerts.check(T0 + 5 * M);
    await a.alerts.idle();
    assert.deepEqual(a.alerts.list.map((x) => x.kind + (x.level ? `:${x.level}` : "")).sort(), ["budget:warn", "failures", "session", "waiting"]);
    a.alerts.close();
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes("hooks.slack.com") && !text.includes("discord.com"), "only fingerprints of the URLs");
    // The same store, a new engine (a restart): it remembers everything already alerted.
    const b = new Alerts({ store: a.store, getConfig: () => ({ ...a.store.getConfig() }), file, env: {}, log: quiet, transport: async () => ({ ok: true, code: 200 }) });
    b.check(T0 + 6 * M);
    assert.equal(b.list.length, 4, "nothing alerts twice");
    assert.equal(b.view(T0 + 6 * M).channels[0].status, "ok", "health kept");
    b.check(T0 + 20 * M - 1000);
    assert.equal(b.list.length, 4);
    b.check(T0 + 20 * M);
    assert.equal(b.list.length, 5, "and the wait's reminder still comes on time: 15 minutes after the first alert");
    // A delivery on its way when the server stopped.
    b.list[0].sent.slack = { status: "sending", tries: 1 };
    b.save();
    const c = new Alerts({ store: a.store, getConfig: a.store.getConfig, file, env: {}, log: quiet });
    assert.deepEqual(c.list[0].sent.slack, { status: "failed", tries: 1, error: "Stopped by a restart", hint: "retry it" });
    // Older than 7 days goes at the next check.
    c.check(T0 + 8 * DAY);
    assert.equal(c.list.length, 0);
    // A broken file: a new history, and a note in the log.
    fs.writeFileSync(file, "{nope");
    const warned = [], d = new Alerts({ store: a.store, getConfig: a.store.getConfig, file, env: {}, log: { warn: (m) => warned.push(m) } });
    assert.deepEqual([d.list.length, warned.length], [0, 1]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a check never throws: trouble is logged and the next check runs", () => {
  const warned = [], store = { watch() { throw new Error("broken"); } };
  const a = new Alerts({ store, getConfig: () => ({}), env: {}, log: { warn: (m) => warned.push(m) } });
  a.check(T0);
  assert.deepEqual(warned, ["Alert check failed: broken"]);
});

// ---------- endpoints ----------
const request = (base, method, p, headers = {}, body = null) => new Promise((resolve, reject) => {
  const req = http.request(base + p, { method, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
    let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
  });
  req.on("error", reject); req.end(body == null ? undefined : JSON.stringify(body));
});
async function boot({ env = {}, cfg = null, fail = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-alerts-srv-")), sent = [];
  if (cfg) fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ token: "tok-123", ...cfg }));
  Object.assign(process.env, env);
  const app = createServer({ dir, log: quiet, webhook: async (x) => { sent.push(x); return fail[x.channel] ? { ok: false, code: fail[x.channel] } : { ok: true, code: 200 }; } });
  for (const k of Object.keys(env)) delete process.env[k];
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  return { app, dir, sent, fail, port, base: `http://127.0.0.1:${port}`, token: JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).token };
}
const SAME = { "X-Requested-With": "agent-office" };

test("endpoints: GET /api/alerts; PUT /api/alerts saves rules and webhooks; test and retry; every write same-origin and under a local name", async () => {
  const { app, dir, base, port, sent, fail } = await boot({ cfg: { webhookUrl: SLACK } });
  try {
    let r = await request(base, "GET", "/api/alerts");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.channels.map((c) => [c.id, c.status, c.url]), [["slack", "new", "hooks.slack.com/…1234"], ["discord", "none", null]], "the old webhookUrl is Slack's now");
    assert.deepEqual([r.body.days, r.body.repeatMin, r.body.rules.waiting.minutes, r.body.alerts], [7, 15, 3, []]);
    assert.ok(!JSON.stringify(r.body).includes(SLACK), "the URL never goes to the browser");
    const writes = [["PUT", "/api/alerts", { rules: { waiting: { minutes: 5 } } }], ["POST", "/api/alerts/test", { channel: "slack" }], ["POST", "/api/alerts/abcdefgh/retry", { channel: "slack" }]];
    for (const [m, p, b] of writes) {
      assert.equal((await request(base, m, p, {}, b)).status, 403, `${m} ${p} without the same-origin header`);
      assert.equal((await request(base, m, p, { ...SAME, Host: `evil.example:${port}` }, b)).status, 403, `${m} ${p} under a rebound host name`);
    }
    r = await request(base, "PUT", "/api/alerts", SAME, { rules: { waiting: { minutes: 5, discord: false } }, discord: { url: DISCORD, channel: "#ops" }, slack: { channel: "#agent-office" } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.rules.waiting, r.body.channels.map((c) => [c.status, c.channel])], [{ on: true, minutes: 5, slack: true, discord: false }, [["new", "#agent-office"], ["new", "#ops"]]]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.deepEqual([saved.discordWebhookUrl, saved.slackWebhookUrl, saved.alertRules.waiting.minutes, "webhookUrl" in saved], [DISCORD, SLACK, 5, false]);
    for (const [body, error] of [[{ rules: { waiting: { minutes: 0 } } }, "The wait must be 1 to 240 minutes."], [{ discord: { url: SLACK } }, "A Discord webhook URL starts with https://discord.com/api/webhooks/"], [[1], "Body must be an object."]]) {
      r = await request(base, "PUT", "/api/alerts", SAME, body);
      assert.deepEqual([r.status, r.body.error], [400, error]);
    }
    // Send test, through the stand-in transport.
    r = await request(base, "POST", "/api/alerts/test", SAME, { channel: "slack" });
    assert.deepEqual([r.status, r.body.ok, sent.at(-1).channel, sent.at(-1).url], [200, true, "slack", SLACK]);
    fail.discord = 404;
    r = await request(base, "POST", "/api/alerts/test", SAME, { channel: "discord" });
    assert.deepEqual([r.status, r.body.error], [502, "Discord didn't take the test: HTTP 404 · the webhook may have been deleted."]);
    // An alert whose Discord delivery failed, retried once it works again.
    const t = new Date(Date.now() - 60000).toISOString(), auth = { Authorization: "Bearer tok-123" };
    await request(base, "POST", "/api/events", auth, [{ type: "hook", t, session: "s1", ev: "SessionStart", cwd: "/p/shop", gitRoot: "/p/shop" }, { type: "usage", t, session: "s1", cost: 5 }]);
    app.alerts.check();
    await app.alerts.idle();
    r = await request(base, "GET", "/api/alerts");
    const a = r.body.alerts[0];
    assert.deepEqual([a.kind, a.sent.slack.status, a.sent.discord.status], ["session", "sent", "failed"]);
    delete fail.discord;
    r = await request(base, "POST", `/api/alerts/${a.id}/retry`, SAME, { channel: "discord" });
    assert.deepEqual([r.status, r.body.alert.sent.discord.status, r.body.alert.sent.discord.tries], [200, "sent", 2]);
    assert.equal((await request(base, "POST", `/api/alerts/${a.id}/retry`, SAME, { channel: "discord" })).status, 409);
    assert.equal((await request(base, "POST", "/api/alerts/zzzzzzzz/retry", SAME, { channel: "discord" })).status, 404);
    // The live data says when the history changed.
    const s1 = (await request(base, "GET", "/api/state")).body.alertsRev;
    await request(base, "POST", "/api/alerts/test", SAME, { channel: "slack" });
    assert.ok((await request(base, "GET", "/api/state")).body.alertsRev > s1);
    // Settings can't change where alerts go or their rules (only the Alerts Center can), nor reach the old test route.
    r = await request(base, "PUT", "/api/settings", SAME, { slackWebhookUrl: "https://hooks.slack.com/services/evil", discordWebhookUrl: "", alertRules: { waiting: { on: false } }, dailyBudgetUsd: 9 });
    assert.equal(r.status, 200);
    const after = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.deepEqual([after.slackWebhookUrl, after.discordWebhookUrl, after.alertRules.waiting.on, after.dailyBudgetUsd], [SLACK, DISCORD, true, 9]);
    assert.equal((await request(base, "POST", "/api/settings/test-webhook", SAME, {})).status, 404);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("endpoints: team mode needs signing in; a webhook from the environment is shown as such and can't be changed", async () => {
  const { app, dir, base, token } = await boot({ env: { HOST: "0.0.0.0", DISCORD_WEBHOOK_URL: DISCORD } });
  try {
    assert.equal((await request(base, "GET", "/api/alerts")).status, 401);
    const auth = { Authorization: `Bearer ${token}`, ...SAME };
    const r = await request(base, "GET", "/api/alerts", auth);
    assert.deepEqual(r.body.channels[1], { id: "discord", name: "Discord", channel: null, url: "discord.com/…9876", source: "env", env: "DISCORD_WEBHOOK_URL", status: "new",
      lastOk: null, failSince: null, error: null, hint: null, delivered: 0, testing: false });
    const put = await request(base, "PUT", "/api/alerts", auth, { discord: { url: "" } });
    assert.deepEqual([put.status, put.body.error], [409, "DISCORD_WEBHOOK_URL is set on the server, so the Discord webhook is changed there."]);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the demo ----------
let built = null;
/** The demo day with its alerts at the pinned 15:42, as the browser gets it. Built once; the tests only read it. */
async function demo() {
  if (built) return built;
  const cfg = { offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 25, ...DEMO_CHANNELS, alertRules: config.rulesOf() };
  const store = new Store({ getConfig: () => cfg }), alerts = new Alerts({ store, getConfig: () => cfg, transport: demoWebhook(NOW), env: {}, log: quiet });
  loadScenario(store, NOW, { alerts });
  await alerts.idle();
  return (built = { store, alerts, view: json(alerts.view(NOW)), snap: json(store.snapshot(NOW)) });
}
const hm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

test("demo: refund flow waited 3 min to edit .env.production; Discord failing with HTTP 404 since 15:36; budget, cost and error alerts on earlier days", async () => {
  const { view: v } = await demo();
  const [receipt, refund] = v.alerts;
  assert.deepEqual([refund.label, hm(refund.t), refund.waited, refund.what, refund.target, refund.end, hm(refund.sent.slack.at), refund.sent.discord.status, refund.sent.discord.error],
    ["refund flow", "15:36", 3, "to edit a file", ".env.production", null, "15:36", "failed", "HTTP 404"]);
  assert.deepEqual([receipt.label, hm(receipt.t), receipt.what, receipt.target, receipt.end], ["receipt printer", "15:41", "to run a command", "sudo apt install cups-filters", null]);
  const [slack, discord] = v.channels;
  assert.deepEqual([slack.name, slack.channel, slack.status, hm(slack.lastOk), slack.url], ["Slack", "#agent-office", "ok", "15:41", "hooks.slack.com/…demo"]);
  assert.deepEqual([discord.channel, discord.status, hm(discord.failSince), discord.error, discord.hint], ["#ops", "failing", "15:36", "HTTP 404", "the webhook may have been deleted"]);
  const kinds = (k) => v.alerts.filter((a) => a.kind === k);
  assert.deepEqual(kinds("waiting").map((a) => [a.label, hm(a.t), a.end && a.end.how]), [["receipt printer", "15:41", null], ["refund flow", "15:36", null],
    ["rate limiter", "14:08", "answered"], ["basket bill", "13:43", "answered"], ["inventory sync", "10:43", "answered"], ["login fix", "09:15", "answered"]]);
  assert.deepEqual(kinds("budget").map((a) => [a.level, a.date]), [["over", "2026-10-19"], ["warn", "2026-10-19"]], "the day over the $25 budget");
  assert.deepEqual(kinds("failures").map((a) => [a.label, a.count, a.target, a.end.how, a.date]), [["card captures", 3, "npm test -- captures", "recovered", undefined]]);
  assert.equal(kinds("session")[0].label, "basket bill", "today's costliest, past $3.50");
  assert.ok(v.alerts.every((a) => Date.parse(a.t) <= NOW && Date.parse(a.t) > NOW - 7 * DAY), "the last 7 days, nothing in the future");
  assert.ok(v.alerts.every((a) => Date.parse(a.t) < Date.parse(DEMO_DELETED()) ? a.sent.discord.status === "sent" : a.sent.discord.status === "failed"), "Discord worked until 15:35");
});
const DEMO_DELETED = () => iso(new Date(2026, 9, 24, 15, 35).getTime());

test("demo: the same alerts at any time of day: a morning squeezes the day, but the answered waits keep their real length", async () => {
  // A session's cost passes $3.50 at a step whose time depends on how many steps fit in the day, so those alerts are
  // compared as a set; everything else in order, with its deliveries.
  const summary = (list) => ({ costly: list.filter((a) => a.kind === "session").map((a) => a.label).sort(),
    timed: list.filter((a) => a.kind !== "session").map((a) => [a.kind, a.level || null, a.label, a.waited ?? a.count ?? null, a.end ? a.end.how : null,
      a.end ? Math.round((Date.parse(a.end.t) - Date.parse(a.since)) / M) : null, a.sent.slack.status, a.sent.discord.status]) });
  const story = async (h, m) => {
    const now = new Date(2026, 9, 24, h, m).getTime(), cfg = { offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 25, ...DEMO_CHANNELS, alertRules: config.rulesOf() };
    const store = new Store({ getConfig: () => cfg }), alerts = new Alerts({ store, getConfig: () => cfg, transport: demoWebhook(now), env: {}, log: quiet });
    loadScenario(store, now, { alerts });
    await alerts.idle();
    return summary(json(alerts.view(now).alerts));
  };
  const afternoon = summary((await demo()).view.alerts); // 15:42, built once for every test
  assert.deepEqual(afternoon.timed.filter((x) => x[0] === "waiting").map((x) => [x[2], x[5]]), [["receipt printer", null], ["refund flow", null],
    ["rate limiter", 12], ["basket bill", 4], ["inventory sync", 12], ["login fix", 8]], "answered after their real length");
  for (const [h, m] of [[3, 0], [7, 0]]) assert.deepEqual(await story(h, m), afternoon, `${h}:00`);
});

// ---------- the model ----------
test("model: types and their colours, sentences, statuses and deliveries in plain English; the filters and their counts", async () => {
  const A = await pub("alerts-model.js"), { view: v } = await demo();
  const h = A.history(v, { now: NOW });
  assert.deepEqual([h.total, h.counts], [v.alerts.length, { all: v.alerts.length, needs: 6, budget: v.alerts.length - 7, errors: 1 }]);
  const [receipt, refund] = h.rows;
  assert.deepEqual([refund.time, refund.day, refund.type, refund.text, refund.context, refund.target],
    ["15:36", "Today", { group: "needs", tone: "needs", icon: "hand", label: "Needs you" }, "refund flow has waited 3 min to edit a file", ["checkout-api", "thinkpad-x1"], ".env.production"]);
  assert.deepEqual([refund.status, receipt.status.text], [{ tone: "needs", icon: "hand", text: "still waiting · 9m" }, "still waiting · 4m"]);
  assert.deepEqual([refund.sent.slack, refund.sent.discord], [{ tone: "ok", icon: "check", text: "Delivered 15:36" }, { tone: "error", icon: "x", text: "Failed · HTTP 404", retry: true }]);
  assert.deepEqual(refund.open, { session: "demo-refund", at: "convo" });
  const rate = h.rows.find((r) => r.who === "rate limiter");
  assert.deepEqual([rate.status.text, rate.status.tone], ["answered after 12m", "done"]);
  const over = h.rows.find((r) => r.type.label === "Over budget" && r.costReport);
  assert.deepEqual([over.type.tone, over.day, over.text, over.context, over.open], ["over", "Oct 19", "Spend on Oct 19 passed the $25 daily budget", ["$25.35 spent"], null]);
  const warn = h.rows.find((r) => r.type.label === "Budget warning");
  assert.deepEqual([warn.type.tone, warn.text, warn.context[1], warn.status], ["warn", "Spend on Oct 19 passed 80% of the $25 daily budget", "It alerts again at 100%", null]);
  const err = h.rows.find((r) => r.type.group === "errors");
  assert.deepEqual([err.type.tone, err.text, err.context, err.target, err.status, err.open], ["error", "card captures failed 3 tool calls in a row", ["checkout-api", "thinkpad-x1", "Last: Ran tests"], "npm test -- captures",
    { tone: "done", icon: "check", text: "working again after 3m" }, { session: "demo-hist-2-checkout-api", at: "trace" }]);
  const cost = h.rows.find((r) => r.who === "basket bill" && r.type.label === "Over budget");
  assert.deepEqual([cost.text, cost.target, cost.open.at], ["basket bill has cost $3.54, more than the $3.50 limit for one session", "claude-sonnet-4-6", null]);
  assert.deepEqual(A.history(v, { filter: "needs", now: NOW }).rows.map((r) => r.who), ["receipt printer", "refund flow", "rate limiter", "basket bill", "inventory sync", "login fix"]);
  assert.deepEqual([A.history(v, { filter: "errors", now: NOW }).rows.length, A.history(v, { filter: "bogus", now: NOW }).filter], [1, "all"]);
  assert.deepEqual(A.history(v, { now: NOW, retrying: new Set([`${refund.id}:discord`]) }).rows[1].sent.discord, { tone: "busy", icon: null, text: "Retrying…" });
  // Deliveries: retried, on another day, still sending, off, not set up.
  const at = iso(NOW);
  // The next day by the calendar, not NOW + 24 h: Europe's clocks go back that night.
  const next = new Date(2026, 9, 25, 15, 42).getTime();
  assert.deepEqual([{ status: "sent", at, tries: 2 }, { status: "sent", at: iso(next), tries: 1 }, { status: "sending", tries: 1 }, { status: "off" }, { status: "none" }].map((d) => A.deliveryOf(d, { ref: NOW }).text),
    ["Delivered 15:42 (retried)", "Delivered Oct 25, 15:42", "Sending…", "Off for this rule", "Not set up"]);
  assert.deepEqual([A.dayLabel(NOW - DAY, NOW), A.dayLabel(NOW - 3 * DAY, NOW)], ["Yesterday", "Oct 21"]);
  // Statuses of waits and runs that ended otherwise.
  const w = { kind: "waiting", since: iso(NOW - 10 * M) };
  assert.deepEqual([{ t: iso(NOW), how: "ended" }, { t: iso(NOW), how: "offline" }, { t: iso(NOW), how: "gone" }].map((end) => A.statusOf({ ...w, end }, NOW).text), ["session ended after 10m", "went offline after 10m", "no longer waiting"]);
  assert.deepEqual([A.statusOf({ kind: "failures", since: at, end: null }).tone, A.statusOf({ kind: "failures", since: at, end: { t: at, how: "offline" } }).text], ["error", "went offline"]);
  assert.match(A.alertText({ kind: "waiting", name: "shop · x", label: "x", project: "shop", waited: 18, what: "for your input", repeat: 1 }).context[0], /^Reminder 1$/);
});

test("model: channel cards and rule cards", async () => {
  const A = await pub("alerts-model.js"), { view: v } = await demo();
  const [slack, discord] = v.channels.map((c) => A.channelCard(c, { now: NOW }));
  assert.deepEqual([slack.title, slack.pill.label, slack.pill.tone, slack.line, slack.edit], ["Slack · #agent-office", "Healthy", "ok", `Last delivery 15:41 · ${v.channels[0].delivered} alerts delivered in 7 days`, "Change webhook"]);
  assert.deepEqual([discord.title, discord.pill.label, discord.pill.tone, discord.line, discord.edit, discord.failing],
    ["Discord · #ops", "Failing", "error", "Failing · HTTP 404 since 15:36 · the webhook may have been deleted", "Fix webhook", true]);
  const none = A.channelCard({ id: "slack", name: "Slack", status: "none", delivered: 0 }), fresh = A.channelCard({ id: "slack", name: "Slack", status: "new", delivered: 0, url: "x/…1" });
  assert.deepEqual([none.title, none.pill.label, none.line, none.edit, none.setUp], ["Slack", "Not set up", "Alerts don't go to Slack yet. Add an incoming webhook to send them there.", "Set up Slack", false]);
  assert.deepEqual([fresh.pill.label, fresh.line], ["Not tried yet", "Nothing sent to this webhook yet. Send a test to check it."]);
  assert.deepEqual([A.channelCard({ status: "ok", source: "env", env: "SLACK_WEBHOOK_URL", name: "Slack", delivered: 1, lastOk: iso(NOW) }, { now: NOW }).edit, A.channelCard({ status: "new" }, { testing: true }).testing], [null, true]);
  const cards = A.ruleCards(v);
  assert.deepEqual(cards.map((c) => [c.kind, c.rule[c.key], `${c.before} ${c.unit || ""}${c.rule[c.key]} ${c.after}`.replace(/\s+/g, " ").trim()]), [
    ["waiting", 3, "Alert when an agent has waited longer than 3 minutes"], ["session", 3.5, "Alert when one session costs more than $3.5"],
    ["budget", 80, "Warn when today's spend reaches 80 % of the daily budget, and again at 100%"], ["failures", 3, "Alert when an agent fails 3 tool calls in a row"]]);
  assert.deepEqual(cards.map((c) => c.note), [{ text: "It repeats every 15 min until it's answered." }, { text: "Once per session. Raise the limit and it alerts again past the new one." },
    { text: "The daily budget is $25.", link: "Change it in Settings", href: "#/settings?section=budgets" }, { text: "Once per run of failures. It counts again after a call works." }]);
  assert.deepEqual(A.ruleCards({ ...v, budget: 0 })[2].note, { text: "No daily budget is set, so this can't alert yet.", link: "Set one in Settings", href: "#/settings?section=budgets" });
  assert.deepEqual(cards[0].channels, [{ id: "slack", name: "Slack", setUp: true, on: true }, { id: "discord", name: "Discord", setUp: true, on: true }]);
});

// ---------- the markup ----------
const RAW = ["PreToolUse", "PostToolUse", "PermissionRequest", "TodoWrite", "Bash", "<ide_", "<system-reminder", "/Users/", "/srv/", "undefined", "NaN", "[object", "hooks.slack.com/services"];
const noRaw = (html, what) => { for (const r of RAW) assert.ok(!html.includes(r), `${what}: no ${r}`); };

test("view: every panel's loading, error, empty and stale states; colour rules; real buttons and inputs; escaped", async () => {
  const A = await pub("alerts-model.js"), V = await pub("alerts-view.js"), { view: v } = await demo();
  const h = A.history(v, { now: NOW }), cards = A.ruleCards(v), card = A.channelCard(v.channels[1], { now: NOW });
  for (const [name, p] of [["history", (o) => V.historyPanel({ v: h, ...o })], ["rules", (o) => V.rulesPanel({ cards, ...o })]]) {
    assert.match(p({ status: "loading", v: null, cards: null }), /aria-busy="true"[^]*ao-loading/, `${name} loading`);
    assert.match(p({ status: "error", v: null, cards: null }), /role="alert"[^]*Couldn&#39;t load the alerts\. The server didn&#39;t answer\.[^]*data-al-reload/, `${name} error`);
    assert.match(p({ status: "stale", asOf: v.t }), /ao-stale-note[^]*As of 15:42[^]*ao-panel-body ao-stale/, `${name} stale`);
    noRaw(p({ status: "live" }), name);
  }
  assert.match(V.channelCard({ id: "slack", status: "loading" }), /aria-busy="true"[^]*Loading the Slack channel/);
  assert.match(V.channelCard({ id: "slack", status: "error" }), /role="alert"[^]*data-al-reload/);
  assert.match(V.channelCard({ id: "discord", card, status: "stale", asOf: v.t }), /As of 15:42[^]*ao-panel-body ao-stale/);
  assert.match(V.historyPanel({ v: { ...h, total: 0, rows: [] } }), /ao-state--empty is-ok[^]*No alerts in the last 7 days\./);
  assert.match(V.historyPanel({ v: A.history({ alerts: v.alerts.filter((a) => a.kind !== "failures") }, { filter: "errors", now: NOW }) }), /aria-pressed="true"[^]*Errors[^]*No runs of failed tool calls in the last 7 days\./);

  // The failing channel: red line with an icon, Fix webhook first (teal), Send test.
  const dc = V.channelCard({ id: "discord", card, status: "live" });
  assert.match(dc, /<h2 class="ao-panel-title" id="al-ch-discord-h">Discord · #ops<\/h2><span class="al-pill al-pill--error"><svg[^]*<span>Failing<\/span>/);
  assert.match(dc, /al-ch-line is-failing"><svg[^]*Failing · HTTP 404 since 15:36 · the webhook may have been deleted/);
  assert.match(dc, /ao-btn--primary[^"]*" data-al-open="discord" data-key="al-open:discord" aria-expanded="false" aria-controls="al-form-discord"><span>Fix webhook[^]*data-al-test="discord"[^>]*aria-label="Send a test to Discord"/);
  assert.match(V.channelCard({ id: "slack", card: A.channelCard(v.channels[0], { now: NOW }), status: "live" }), /al-pill--ok[^]*Healthy[^]*<code>hooks\.slack\.com\/…demo<\/code>[^]*Send test[^]*ao-btn--ghost[^]*Change webhook/);
  assert.match(V.channelCard({ id: "slack", card: A.channelCard({ ...v.channels[0], testing: true }, { now: NOW }), status: "live" }), /aria-busy="true" aria-label="Sending a test to Slack"><svg[^]*Sending…/);

  // The table: a row header per alert, the amber pill only for needs you, red for failures and errors, Retry and Open.
  const t = V.historyPanel({ v: h });
  assert.equal((t.match(/<th scope="row" class="al-what">/g) || []).length, h.rows.length);
  assert.match(t, /<div class="al-filters" role="group" aria-label="Show alerts of one type">[^]*aria-pressed="true" data-chip="all" data-key="al-filter:all"><span>All<\/span><span class="ao-chip-count">18<\/span>/);
  assert.match(t, /<th scope="col">When<\/th><th scope="col">Type<\/th><th scope="col">Alert<\/th><th scope="col">Status<\/th><th scope="col">Slack<\/th><th scope="col">Discord<\/th>/);
  assert.match(t, /<span class="ao-pill ao-pill--needs"><svg[^]*<span>Needs you<\/span><\/span><\/td><th scope="row" class="al-what"><span class="al-text">refund flow has waited 3 min to edit a file<\/span><span class="ao-meta al-context">checkout-api · thinkpad-x1 · <code title="\.env\.production">\.env\.production<\/code>/);
  assert.match(t, /al-status is-needs"><svg[^]*still waiting · 9m/);
  assert.match(t, /al-dl is-error" tabindex="-1" data-key="al-dl:[\w-]+:discord"><svg[^]*Failed · HTTP 404<\/span><\/span><button type="button" class="ao-btn ao-btn--secondary ao-btn--sm" data-al-retry="[\w-]+" data-al-channel="discord" data-key="al-retry:[\w-]+:discord" aria-label="Retry sending to Discord: refund flow has waited 3 min to edit a file">/);
  assert.match(t, /data-agent="demo-refund" data-agent-at="convo" data-key="al-agent:[\w-]+" aria-label="Open refund flow"/);
  assert.match(t, /<a class="ao-btn ao-btn--secondary ao-btn--sm" href="#\/cost" data-key="al-cost:[\w-]+">Cost report<\/a>/);
  assert.match(t, /al-pill al-pill--warn"><svg[^]*Budget warning[^]*Nothing to follow/);
  assert.ok(!/al-pill--needs|ao-btn--answer/.test(t.replace(/ao-pill--needs/g, "")), "amber only on the Needs you pill and the waiting status");
  assert.ok(!/is-needs/.test(V.historyPanel({ v: A.history(v, { filter: "budget", now: NOW }) })), "no amber among budget alerts");

  // Rules: a real switch (checkbox, role="switch") with On/Off in words, a labelled number, channel checkboxes, notes.
  const rp = V.rulesPanel({ cards });
  assert.equal((rp.match(/<input type="checkbox" role="switch" class="ao-switch"/g) || []).length, 4);
  assert.match(rp, /id="al-waiting-on" data-al-field="on" data-key="al-waiting-on" checked aria-describedby="al-waiting-text">\s*<label class="al-rule-title" for="al-waiting-on">An agent waits on you<\/label><span class="al-onoff" aria-hidden="true"><span class="al-on">On<\/span><span class="al-off">Off<\/span>/);
  assert.match(rp, /Alert when one session costs more than <span class="al-unit" aria-hidden="true">\$<\/span><input type="number" class="al-num" id="al-session-n" data-al-field="usd" data-key="al-session-n" value="3\.50" min="0\.01" max="10000" step="0\.01" inputmode="decimal" aria-label="Session cost in dollars that alerts" aria-describedby="al-session-note">/);
  assert.match(rp, /The daily budget is \$25\. <a class="cc-link" href="#\/settings\?section=budgets">Change it in Settings<\/a>/);
  assert.match(rp, /<fieldset class="al-send"><legend>Send to<\/legend><span class="cc-check"><input type="checkbox" id="al-waiting-slack" data-al-field="slack" data-key="al-waiting-slack" checked><label for="al-waiting-slack">Slack<\/label>/);
  assert.match(V.rulesPanel({ cards: A.ruleCards({ ...v, channels: v.channels.map((c) => ({ ...c, status: "none" })) }) }), /Discord <span class="ao-meta">\(not set up\)<\/span>/);
  assert.match(V.rulesPanel({ cards, demo: true }), /Demo mode: changes last until the demo stops and are never saved\./);
  assert.ok(!/amber|needs|--red|is-error/.test(rp), "no amber or red in the rules");

  // The webhook form: labelled inputs, never the URL itself; Remove only when there's one.
  const f = V.editForm(v.channels[1]);
  assert.match(f, /<label for="al-url-discord">Discord webhook URL<\/label><input type="url" id="al-url-discord" name="url" autocomplete="off" spellcheck="false" placeholder="https:\/\/discord\.com\/api\/webhooks\/…" aria-describedby="al-url-discord-hint">/);
  assert.match(f, /Leave it empty to keep the current one \(discord\.com\/…demo\)\./);
  assert.match(f, /value="#ops"[^]*data-al-remove="discord"[^]*data-al-cancel="discord"[^]*type="submit"/);
  assert.ok(!f.includes(DEMO_CHANNELS.discordWebhookUrl));
  assert.ok(!V.editForm({ id: "slack", name: "Slack", status: "none" }).includes("data-al-remove"));
  assert.match(V.editForm(v.channels[0], { demo: true }), /Demo mode: nothing is sent or saved\./);
  assert.match(V.testToast({ ok: true, name: "Slack", channel: "#agent-office" }), /Test sent to Slack[^]*Check #agent-office\./);
  assert.match(V.testToast({ ok: false, name: "Discord", error: "Discord didn't take the test: HTTP 404" }), /The test didn&#39;t reach Discord[^]*HTTP 404/);

  // Escaped.
  const evil = "<img src=x onerror=alert(1)>";
  const bad = { ...v, channels: v.channels.map((c) => ({ ...c, channel: evil, error: evil, url: evil })),
    alerts: v.alerts.map((a) => ({ ...a, name: evil, label: evil, project: evil, host: evil, target: evil, what: evil, model: evil, sent: { slack: { status: "failed", error: evil }, discord: a.sent.discord } })) };
  const html = [V.historyPanel({ v: A.history(bad, { now: NOW }) }), ...bad.channels.map((c) => V.channelCard({ id: c.id, card: A.channelCard(c, { now: NOW }) }) + V.editForm(c))].join("");
  assert.ok(!html.includes("<img"));
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
function server(routes) {
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
const tick = () => new Promise((r) => setTimeout(r, 0));
const settings = { offlineAfterMin: 30, dailyBudgetUsd: 25, notifyOnWaiting: false, aliases: {}, demo: true, teamMode: false, viewer: "mk" };

/** The demo engine behind the shell's fake server, at 15:43. writes: a fresh one, so the screen's changes really change
 *  it; else the one built for every test (read only). */
async function alertsShell({ hash = "#/alerts", routes = () => ({}), tab = null, writes = false } = {}) {
  let cfg = { offlineAfterMin: 30, retentionDays: 30, aliases: {}, dailyBudgetUsd: 25, ...DEMO_CHANNELS, alertRules: config.rulesOf() };
  let store, engine;
  if (writes) {
    store = new Store({ getConfig: () => cfg });
    engine = new Alerts({ store, getConfig: () => cfg, transport: demoWebhook(NOW), env: {}, log: quiet });
    loadScenario(store, NOW, { alerts: engine });
    await engine.idle();
  } else ({ store, alerts: engine } = await demo());
  const later = NOW + M, realNow = Date.now;
  Date.now = () => later;
  const put = (body) => {
    if (!writes) return { status: 409, error: "This test's server is read only." };
    const r = engine.settings(body);
    if (r.error) return { status: r.code, error: r.error };
    const c = config.applyAlerts(cfg, r.patch);
    if (c.error) return { status: 400, error: c.error };
    cfg = c.cfg;
    return engine.view(later);
  };
  const reply = (r) => (r.error ? { status: r.code, error: r.error } : r);
  const dom = withDom(), win = fakeWindow(hash), srv = server({
    "/api/state": { ...json(store.snapshot(NOW)), alertsRev: engine.rev, settings }, "/api/timeline": { date: "2026-10-24", sessions: [], buckets: [] },
    "/api/alerts": () => engine.view(later), "PUT /api/alerts": (u, o) => put(JSON.parse(o.body)),
    ...(writes ? {
      "POST /api/alerts/test": async (u, o) => reply(await engine.test(JSON.parse(o.body).channel, later)),
      ...Object.fromEntries(engine.list.map((a) => [`POST /api/alerts/${a.id}/retry`, async (u, o) => reply(await engine.retry(a.id, JSON.parse(o.body).channel, later))])),
    } : {}),
    ...routes(engine),
  });
  if (tab) win.stored.set("ao-alerts-tab", tab);
  const { createShell } = await pub("shell.js");
  const shell = createShell({ doc: dom.document, win, fetch: srv.fetch, EventSource: srv.EventSource });
  const body = dom.document.body, page = body.querySelector('[data-screen="alerts"]');
  await shell.ready;
  await tick(); await tick();
  const q = (s) => page.querySelector(s), all = (s) => page.querySelectorAll(s);
  const rows = () => page.querySelectorAll("tr").filter((r) => r.parentNode.localName === "tbody");
  const done = () => { Date.now = realNow; shell.destroy(); dom.restore(); };
  return { dom, win, srv, engine, shell, body, page, q, all, rows, done, active: () => dom.document.activeElement, cfg: () => cfg };
}

test("alerts DOM: at #/alerts the channel cards and history fill from GET /api/alerts; the filters; Open goes to the agent; Cost report to the report", async () => {
  let t = null;
  try {
    t = await alertsShell();
    const { q, all, rows, page, srv, body, active } = t;
    assert.equal(page.hidden, false);
    assert.ok(!page.textContent.includes("isn't built yet"), "the placeholder is gone");
    assert.ok(srv.calls.some((c) => c.url === "/api/alerts" && c.opts.headers["X-Requested-With"] === "agent-office"));
    assert.equal(q('[data-al="updated"]').textContent, "Updated 15:43");
    assert.match(q('[data-al-card="slack"]').textContent, /Slack · #agent-office\s*Healthy[^]*Last delivery 15:41 · 18 alerts delivered in 7 days/);
    assert.match(q('[data-al-card="discord"]').textContent, /Discord · #ops\s*Failing\s*Failing · HTTP 404 since 15:36 · the webhook may have been deleted/);
    assert.equal(rows().length, 18);
    assert.match(rows()[1].textContent, /^15:36Today\s*Needs you\s*refund flow has waited 3 min to edit a file\s*checkout-api · thinkpad-x1 · \.env\.production\s*still waiting · 10m\s*Delivered 15:36\s*Failed · HTTP 404\s*Retry\s*Open$/);
    // Filters: one at a time; the same again goes back to All.
    const chip = (k) => q(`[data-chip="${k}"]`);
    chip("needs").click();
    assert.equal(rows().length, 6);
    assert.deepEqual(["all", "needs", "budget", "errors"].map((k) => chip(k).getAttribute("aria-pressed")), ["false", "true", "false", "false"]);
    chip("needs").click();
    assert.deepEqual([rows().length, chip("all").getAttribute("aria-pressed")], [18, "true"]);
    chip("all").click();
    assert.equal(chip("all").getAttribute("aria-pressed"), "true", "All stays pressed");
    chip("errors").click();
    assert.match(rows()[0].textContent, /Errors\s*card captures failed 3 tool calls in a row[^]*Last: Ran tests · npm test -- captures\s*working again after 3m/);
    // Open: the agent's detail at its trace; closing it gives focus back.
    const open = rows()[0].querySelector("[data-agent]");
    open.focus();
    open.click();
    const sheet = body.querySelector('[data-dialog="agent"]');
    assert.equal(sheet.open, true);
    assert.ok(sheet.querySelector(".ad-back").textContent.includes("Back to alerts"));
    await tick(); await tick();
    sheet.querySelector("[data-close]").click();
    assert.equal(active(), open);
    chip("budget").click();
    assert.ok(rows().some((r) => r.querySelector('a[href="#/cost"]')), "budget alerts link to the cost report");
    assert.equal(all("[data-al-retry]").length, 0, "budget alerts went out before Discord broke");
  } finally { t?.done(); }
});

test("alerts DOM: Retry says Retrying…, then fails again until the webhook is fixed; Fix webhook saves a new URL; then Delivered (retried); Send test", async () => {
  let t = null;
  try {
    t = await alertsShell({ writes: true });
    const { q, rows, srv, active, page } = t, discordCell = () => rows()[1].querySelectorAll("td")[4]; // the alert itself is the row's th
    discordCell().querySelector("[data-al-retry]").click();
    assert.equal(discordCell().textContent, "Retrying…");
    await tick(); await tick(); await tick();
    assert.match(discordCell().textContent, /^Failed · HTTP 404Retry$/, "the deleted webhook still answers 404");
    assert.match(q('[data-al="toasts"]').textContent, /Still failing on Discord\s*HTTP 404 · the webhook may have been deleted/);
    assert.equal(active().getAttribute("data-key"), `al-dl:${t.engine.list.at(-2).id}:discord`, "focus stays on that delivery");
    // Fix webhook: the form opens under the card, focus on its URL; Esc closes it and gives focus back.
    const fix = q("[data-al-open=\"discord\"]");
    assert.equal(fix.textContent, "Fix webhook");
    fix.click();
    const form = q('[data-al-form="discord"]');
    assert.equal(active(), form.querySelector('[name="url"]'));
    assert.equal(q("[data-al-open=\"discord\"]").getAttribute("aria-expanded"), "true");
    t.dom.fire(form.querySelector('[name="url"]'), "keydown", { key: "Escape" });
    assert.equal(q('[data-al-form="discord"]'), null);
    assert.equal(active().getAttribute("data-key"), "al-open:discord");
    q("[data-al-open=\"discord\"]").click();
    const f2 = q('[data-al-form="discord"]');
    f2.querySelector('[name="url"]').value = "https://discord.com/api/webhooks/77/n3wh00k";
    t.dom.fire(f2, "submit");
    await tick(); await tick();
    const put = srv.calls.find((c) => c.opts.method === "PUT");
    assert.deepEqual(put.body, { discord: { channel: "#ops", url: "https://discord.com/api/webhooks/77/n3wh00k" } });
    assert.equal(q('[data-al-form="discord"]'), null);
    assert.match(q('[data-al="toasts"]').textContent, /Discord webhook saved\s*Send a test to check it\./);
    assert.equal(active().getAttribute("data-key"), "al-test:discord");
    assert.match(q('[data-al-card="discord"]').textContent, /Not tried yet[^]*discord\.com\/…h00k/);
    // Now the retry goes through.
    discordCell().querySelector("[data-al-retry]").click();
    await tick(); await tick(); await tick();
    assert.equal(discordCell().textContent, "Delivered 15:43 (retried)");
    assert.match(q('[data-al="toasts"]').textContent, /Delivered to Discord/);
    assert.match(q('[data-al-card="discord"]').textContent, /Healthy[^]*Last delivery 15:43/);
    // Send test.
    q('[data-al-test="slack"]').click();
    assert.equal(q('[data-al-test="slack"]').textContent, "Sending…");
    await tick(); await tick(); await tick();
    assert.match(q('[data-al="toasts"]').textContent, /Test sent to Slack\s*Demo mode: nothing was really sent\./);
    assert.equal(q('[data-al-test="slack"]').textContent, "Send test");
    assert.ok(srv.calls.some((c) => c.url === "/api/alerts/test" && c.body.channel === "slack" && c.opts.headers["X-Requested-With"] === "agent-office"));
    assert.ok(!page.textContent.includes("n3wh00k") || page.textContent.includes("…h00k"), "the URL only masked");
  } finally { t?.done(); }
});

test("alerts DOM: Rules save as you change them, with what went wrong when not; the tab is remembered; a failed load says so and recovers", async () => {
  let t = null, up = false;
  try {
    t = await alertsShell({ writes: true, routes: (engine) => ({ "/api/alerts": () => (up ? engine.view(NOW + M) : undefined) }) });
    const { q, all, win, srv, page } = t;
    assert.equal(all('[role="alert"]').length, 4, "both cards, history and rules say what failed");
    assert.equal(q('[data-al="updated"]').textContent, "Not loaded");
    up = true;
    q("[data-al-reload]").click();
    await tick(); await tick();
    assert.equal(all('[role="alert"]').filter((x) => x.textContent).length, 0);
    q('[data-value="rules"]').click();
    assert.deepEqual([q('[data-al-pane="rules"]').hidden, q('[data-al-pane="history"]').hidden, win.stored.get("ao-alerts-tab")], [false, true, "rules"]);
    const card = (k) => q(`[data-al-rule="${k}"]`), field = (k, f) => card(k).querySelector(`[data-al-field="${f}"]`);
    field("waiting", "on").focus();
    field("waiting", "on").checked = false;
    t.dom.fire(field("waiting", "on"), "change");
    await tick(); await tick();
    assert.equal(t.active().getAttribute("data-key"), "al-waiting-on", "focus stays on the switch through the redraw");
    const puts = () => srv.calls.filter((c) => c.opts.method === "PUT").map((c) => c.body);
    assert.deepEqual(puts()[0], { rules: { waiting: { on: false, minutes: 3, slack: true, discord: true } } });
    assert.equal(t.cfg().alertRules.waiting.on, false);
    assert.equal(field("waiting", "on").checked, false);
    assert.equal(q('[data-al-saved="waiting"]').textContent, "Saved");
    assert.equal(q('[data-al="said"]').textContent, "An agent waits on you: Saved");
    field("failures", "count").value = "0";
    t.dom.fire(field("failures", "count"), "change");
    await tick(); await tick();
    assert.equal(q('[data-al-saved="failures"]').textContent, "Not saved. Failed calls in a row must be 1 to 50.");
    assert.ok(q('[data-al-saved="failures"]').classList.contains("is-error"));
    field("failures", "count").value = "";
    t.dom.fire(field("failures", "count"), "change");
    assert.equal(q('[data-al-saved="failures"]').textContent, "Type a number first.");
    field("budget", "discord").checked = false;
    t.dom.fire(field("budget", "discord"), "change");
    await tick(); await tick();
    assert.deepEqual(puts().at(-1), { rules: { budget: { on: true, percent: 80, slack: true, discord: false } } });
    assert.equal(field("budget", "discord").checked, false);
    assert.ok(!page.textContent.includes("NaN"));
    // Another visit opens on the tab you left it on.
    t.done(); t = null;
    t = await alertsShell({ tab: "rules" });
    assert.deepEqual([t.q('[data-al-pane="rules"]').hidden, t.q('[data-value="rules"]').getAttribute("aria-checked")], [false, "true"]);
  } finally { t?.done(); }
});
