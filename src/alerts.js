"use strict";
// The Alerts Center's engine. Four rules, checked every 15 seconds against the store (Store#watch):
//   waiting   an agent has waited on you longer than N minutes; again every 15 minutes until it's answered
//   session   one session costs more than $N
//   budget    today's spend reaches N% of the daily budget, and again at 100%
//   failures  an agent, or one of its sub-agents, fails N tool calls in a row (calls you interrupted don't count)
// Each alert goes to the Slack and the Discord incoming webhook its rule is set to, and every delivery's result is kept
// on the alert (a failed one can be retried) and in its channel's health. The last 7 days are saved in
// <data>/alerts.json, with only a fingerprint of each URL, never the URL. A rule that is turned on or changed starts
// from how things are now, so it alerts on what happens next, not on everything already past its number. Waiting is
// the exception: a wait already past its minutes still needs you.
// Quiet hours (Settings): a waiting alert is held instead of sent, without reminders, and when they end every held
// alert goes to each channel as one digest. The other rules still send.
const fs = require("fs");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { rulesOf, quietOf, isQuiet } = require("./config");
const { localDate } = require("./store");
const { permissionPhrase } = require("../hooks/text");

const CHANNELS = ["slack", "discord"];
const NAMES = { slack: "Slack", discord: "Discord" };
const ENV = { slack: "SLACK_WEBHOOK_URL", discord: "DISCORD_WEBHOOK_URL" };
const KINDS = new Set(["waiting", "session", "budget", "failures"]);
const MIN = 60000, DAY = 86400000;
// History: 7 days, at most MAX alerts. A wait alerts again every REPEAT. KEYS = how many waits, sessions and runs of
// failures are remembered, so none alerts twice. Webhooks get TIMEOUT to answer. SOON = the delay of a check asked for.
const KEEP = 7 * DAY, MAX = 500, REPEAT = 15 * MIN, KEYS = 1000, TIMEOUT = 4000, SOON = 1000, DIGEST = 20; // DIGEST: lines in one
const ENDED = new Set(["session-end", "session-start"]);
const TEST = "✅ Virtual Office test alert. Alerts reach this channel.";

const iso = (n) => new Date(n).toISOString();
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const usd = (n) => `$${(+n || 0).toFixed(2)}`;
const hostOf = (url) => { try { return new URL(url).host; } catch { return "the webhook"; } };
/** A URL's fingerprint: tells whether the webhook changed without keeping it. */
const fingerprint = (url) => (url ? crypto.createHash("sha256").update(url).digest("hex").slice(0, 16) : null);

/** "hooks.slack.com/…k3Vd": enough to tell webhooks apart, not enough to post to one. */
function mask(url) {
  try { const u = new URL(url); return `${u.host}/…${(u.pathname + u.search).replace(/\/+$/, "").slice(-4)}`; } catch { return "…"; }
}

/** Slack's text with & < > as entities, so an agent's name or a command can't become a link, a mention or a channel. */
const slackText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The message as each service takes it. Discord gets no mentions at all, so "@everyone" in a command stays text. */
const payload = (channel, text) => (channel === "discord" ? { content: String(text).slice(0, 2000), allowed_mentions: { parse: [] } } : { text: slackText(text) });

/** Posts text to an incoming webhook (see payload()). Never throws, and never follows a redirect: one comes back as a
 *  failure ("HTTP 302"). error: "HTTP 404", "No answer within 4 s" or "Couldn't reach <host>".
 *  @returns {Promise<{ok: boolean, code: number|null, error: string|null}>} */
async function sendWebhook(url, text, { channel = "slack", fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!url) return { ok: false, code: null, error: "No webhook URL" };
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetchImpl(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, redirect: "manual", signal: ctrl.signal, body: JSON.stringify(payload(channel, text)),
    });
    try { await res.body?.cancel(); } catch {} // the reply doesn't matter, only its status
    // A redirect a browser would hide as status 0 ("opaqueredirect"); Node's fetch gives the real 3xx.
    const code = res.type === "opaqueredirect" && !res.status ? 302 : res.status;
    return res.ok ? { ok: true, code, error: null } : { ok: false, code, error: `HTTP ${code}` };
  } catch {
    return { ok: false, code: null, error: ctrl.signal.aborted ? `No answer within ${TIMEOUT / 1000} s` : `Couldn't reach ${hostOf(url)}` };
  } finally { clearTimeout(timer); }
}

/** What a failed delivery probably means, in a few words. */
function hintOf(code) {
  if (code === 404 || code === 410) return "the webhook may have been deleted";
  if (code === 401 || code === 403) return "the webhook refused it, so check the URL";
  if (code === 429) return "too many messages for now, so try again in a minute";
  if (code >= 500) return "the service had a problem, so try again later";
  if (code >= 400) return "the webhook didn't accept the message";
  if (code >= 300) return "the webhook redirected, and the server doesn't follow redirects, so check the URL";
  return "check the URL and this server's network";
}

/** The agent's label, or its whole name when that isn't "<project> · <label>" (as the UI shows it). */
const display = (a) => (a.label && a.name === `${a.project} · ${a.label}` ? a.label : a.name || a.label || "An agent");
/** "refund flow · checkout-api on thinkpad-x1" */
function whoText(a) {
  const name = display(a);
  return `${name}${a.project && a.project !== name ? ` · ${a.project}` : ""}${a.host ? ` on ${a.host}` : ""}`;
}
/** What a wait is for: "to edit a file", "for an answer to its question", "for your input". */
function waitPhrase(q) {
  if (q.qkind === "permission") return `to ${permissionPhrase(q.tool)}`;
  return q.qkind === "ask" ? "for an answer to its question" : "for your input";
}

/** The alert as a chat message. now: a day's spend says "today" only on that day. */
function message(a, now = Date.now()) {
  if (a.kind === "waiting") return `🟠 ${whoText(a)} has waited ${a.waited} min ${a.what}${a.target ? `: ${a.target}` : ""}`;
  if (a.kind === "session") return `💸 ${whoText(a)} has cost ${usd(a.cost)}, more than your ${usd(a.limit)} limit for one session.`;
  if (a.kind === "failures") return `⚠️ ${whoText(a)} failed ${a.count} tool calls in a row${a.agent ? " in a sub-agent" : ""}.${a.target ? ` The last one: ${a.target}` : ""}`;
  const day = a.date === localDate(now) ? "today" : `on ${a.date}`;
  return a.level === "over" ? `🔴 Claude spend ${day} passed your ${usd(a.budget)} daily budget: ${usd(a.spent)} so far.`
    : `💸 Claude spend ${day} passed ${a.percent}% of your ${usd(a.budget)} daily budget: ${usd(a.spent)} so far.`;
}

const hhmm = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
const minutes = (ms) => Math.max(0, Math.floor(ms / MIN));
const ENDS = { answered: "answered", ended: "its session ended", offline: "went offline" };
/** What became of a held wait: "still waiting · 9h 20m" or "answered at 23:14". */
function outcome(a, now) {
  if (!a.end) { const m = minutes(now - Date.parse(a.since)); return `still waiting · ${m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`}`; }
  return `${ENDS[a.end.how] || "no longer waiting"} at ${hhmm(a.end.t)}`;
}

/** The needs-you alerts quiet hours held, as one message: each one, and what became of it since. */
function digestText(list, q, now = Date.now()) {
  const lines = list.slice(0, DIGEST).map((a) => `• ${message(a, now).replace(/^🟠 /, "")} · ${outcome(a, now)}`), more = list.length - lines.length;
  const head = `🌙 Quiet hours (${q.from}–${q.to}) are over. ${list.length === 1 ? "1 alert was" : `${list.length} alerts were`} held:`;
  return [head, ...lines, ...(more > 0 ? [`…and ${more} more in the Alerts Center.`] : [])].join("\n");
}

/** Sets key last in the map, dropping the oldest past KEYS. */
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > KEYS) map.delete(map.keys().next().value);
}
const mapOf = (list) => new Map(Array.isArray(list) ? list.filter((x) => Array.isArray(x) && x.length === 2) : []);
const validAlert = (a) => !!a && typeof a.id === "string" && typeof a.t === "string" && KINDS.has(a.kind) && !!a.sent &&
  CHANNELS.every((ch) => a.sent[ch] && typeof a.sent[ch].status === "string");
const who = (f) => ({ session: f.session, name: f.name, label: f.label, project: f.project, host: f.host });

/** When a run of failures that alerted ended: at the first call of that agent that worked, or the agent went offline or
 *  left. Null while it lasts. */
function runEnd(a, f, now) {
  const ctx = a.agent || "", done = f && f.recovered.find((x) => x.ctx === ctx && x.since === a.since);
  if (done) return { t: done.endedAt, how: "recovered" };
  if (f && f.state !== "offline" && f.fails.some((x) => x.ctx === ctx && x.since === a.since)) return null;
  return { t: iso(now), how: f && f.state === "offline" ? "offline" : "gone" };
}
const runKey = (session, ctx) => `${session}\n${ctx}`;

class Alerts extends EventEmitter {
  /**
   * @param {{store: object, getConfig: () => object, file?: string|null, log?: Console, transport?: Function|null, env?: object}} opts
   * file: where the history is saved (null = memory only); transport({ channel, url, text, at }) sends one message
   * (default: sendWebhook); env: where SLACK_WEBHOOK_URL and DISCORD_WEBHOOK_URL are read, once, at the start.
   */
  constructor({ store, getConfig, file = null, log = console, transport = null, env = process.env }) {
    super();
    Object.assign(this, { store, getConfig, file, log, env: Object.fromEntries(CHANNELS.map((ch) => [ENV[ch], env[ENV[ch]]])) });
    this.transport = transport || (({ channel, url, text }) => sendWebhook(url, text, { channel }));
    this.rev = 0; // goes up with every change, so the dashboard knows to fetch the history again
    this.list = []; // alerts, oldest first
    this.waits = new Map(); // "<session>:<question id>" → { at: when its latest alert went out, n: reminders so far }
    this.costs = new Map(); // session → the cost limit it was alerted at
    this.runs = new Map(); // "<session>\n<agent>" → the start of the run of failures it was alerted for
    this.day = { date: null, warn: false, over: false }; // today's budget alerts
    this.sigs = {}; // each rule's settings when it last started from now (see seed())
    this.health = {}; // channel → { key (URL fingerprint), okAt, failAt, failSince, error, hint }
    this.testing = new Set();
    this.inflight = new Set();
    this.timers = { save: null, soon: null };
    this.load();
  }

  /** A channel's webhook URL and where it's set: the server's environment wins over the settings. */
  channel(ch, cfg = this.getConfig()) {
    const env = String(this.env[ENV[ch]] || "").trim(), own = cfg[`${ch}WebhookUrl`];
    return env ? { url: env, source: "env" } : own ? { url: own, source: "settings" } : { url: null, source: null };
  }

  // ---------- the rules ----------
  /** Runs the rules at now. Never throws: trouble is logged and the next check tries again. */
  check(now = Date.now()) {
    try { this.run(now); } catch (err) { this.log.warn(`Alert check failed: ${err.message}`); }
  }

  run(now) {
    const cfg = this.getConfig(), rules = rulesOf(cfg.alertRules), facts = this.store.watch(now), quiet = isQuiet(cfg.quietHours, now);
    const changed = [this.prune(now), this.seed(rules, cfg, facts, now), this.settle(facts, now)].some(Boolean);
    // Before the rules: a held wait's reminders then count from the digest, so the digest isn't followed by one at once.
    if (!quiet) this.digest(now);
    for (const f of facts) {
      if (rules.waiting.on) this.waiting(f, rules, now, quiet);
      if (rules.session.on) this.costly(f, rules, now);
      if (rules.failures.on) this.failing(f, rules, now);
    }
    if (rules.budget.on) this.budget(cfg, rules, now);
    if (changed) this.touch();
  }

  /** First once the wait passes the rule's minutes, then every 15 minutes until it's answered. In quiet hours the first
   *  is held (see digest()) and there are no reminders. */
  waiting(f, rules, now, quiet = false) {
    const q = f.question;
    if (!q) return;
    const key = `${f.session}:${q.id}`, since = Date.parse(q.t), w = this.waits.get(key);
    if (w ? quiet || now - w.at < REPEAT : now - since <= rules.waiting.minutes * MIN) return;
    const repeat = w ? w.n + 1 : 0;
    remember(this.waits, key, { at: now, n: repeat });
    this.fire({ kind: "waiting", ...who(f), questionId: q.id, since: q.t, waited: Math.floor((now - since) / MIN), repeat, what: waitPhrase(q), target: q.target }, rules, now, quiet);
  }

  /** Once per session; again only past a higher limit. */
  costly(f, rules, now) {
    const limit = rules.session.usd;
    if (!(f.cost > limit) || (this.costs.get(f.session) ?? 0) >= limit) return;
    remember(this.costs, f.session, limit);
    this.fire({ kind: "session", ...who(f), cost: f.cost, limit, model: f.model }, rules, now);
  }

  /** Once per run of failures of one agent (the main one, or a sub-agent): a call of its own that works ends the run. */
  failing(f, rules, now) {
    for (const x of f.fails) {
      const key = runKey(f.session, x.ctx);
      if (x.n < rules.failures.count || this.runs.get(key) === x.since) continue;
      remember(this.runs, key, x.since);
      this.fire({ kind: "failures", ...who(f), agent: x.ctx || null, count: x.n, since: x.since, tool: x.tool, target: x.target }, rules, now);
    }
  }

  /** At the rule's share of the daily budget, then at 100%: once each a day. Straight past both, only the second. */
  budget(cfg, rules, now) {
    const b = num(cfg.dailyBudgetUsd), r = rules.budget;
    if (!b) return;
    const date = localDate(now), spent = this.store.spent(now);
    if (this.day.date !== date) this.day = { date, warn: false, over: false };
    const base = { kind: "budget", spent, budget: b, percent: r.percent, date };
    if (spent >= b && !this.day.over) { this.day = { date, warn: true, over: true }; this.fire({ ...base, level: "over" }, rules, now); }
    else if (spent >= (b * r.percent) / 100 && !this.day.warn) { this.day.warn = true; this.fire({ ...base, level: "warn" }, rules, now); }
  }

  /** A rule turned on or changed (or seen for the first time) starts from now: what is already past its number counts
   *  as alerted. Returns whether anything changed. */
  seed(r, cfg, facts, now) {
    const b = num(cfg.dailyBudgetUsd);
    const sigs = { session: [r.session.on, r.session.usd], failures: [r.failures.on, r.failures.count], budget: [r.budget.on, r.budget.percent, b] };
    let changed = false;
    for (const [k, v] of Object.entries(sigs)) {
      const sig = JSON.stringify(v);
      if (this.sigs[k] === sig) continue;
      this.sigs[k] = sig;
      changed = true;
      if (k === "session") for (const f of facts) { if (f.cost > r.session.usd) remember(this.costs, f.session, Math.max(this.costs.get(f.session) ?? 0, r.session.usd)); }
      else if (k === "failures") for (const f of facts) { for (const x of f.fails) if (x.n >= r.failures.count) remember(this.runs, runKey(f.session, x.ctx), x.since); }
      else { const spent = this.store.spent(now); this.day = { date: localDate(now), warn: !!b && spent >= (b * r.budget.percent) / 100, over: !!b && spent >= b }; }
    }
    return changed;
  }

  /** Marks when the waits and runs of failures that alerted ended. Returns whether any did. */
  settle(facts, now) {
    const byId = new Map(facts.map((f) => [f.session, f]));
    let changed = false;
    for (const a of this.list) {
      if (a.end || (a.kind !== "waiting" && a.kind !== "failures")) continue;
      const end = a.kind === "waiting" ? this.waitEnd(a, byId.get(a.session), now) : runEnd(a, byId.get(a.session), now);
      if (end) { a.end = end; changed = true; }
    }
    return changed;
  }

  /** Answered (or its session ended or restarted), the agent went offline still waiting, or the question is gone. */
  waitEnd(a, f, now) {
    const q = this.store.questionState(a.session, a.questionId);
    if (q && q.status !== "pending") return { t: q.answeredAt || iso(now), how: ENDED.has(q.resolvedBy) ? "ended" : "answered" };
    if (q && f && f.state === "waiting") return null;
    return { t: iso(now), how: q ? "offline" : "gone" };
  }

  /** Drops alerts older than 7 days. Returns whether any went. */
  prune(now) {
    const from = iso(now - KEEP);
    if (!this.list.length || this.list[0].t >= from) return false;
    this.list = this.list.filter((a) => a.t >= from);
    return true;
  }

  // ---------- delivery ----------
  /** Logs an alert and sends it to each channel its rule is set to: "off" = not set to; "none" = no webhook set up;
   *  "held" = quiet hours keep it for the digest. */
  fire(a, rules, now, held = false) {
    const rule = rules[a.kind], alert = { id: crypto.randomBytes(9).toString("base64url"), t: iso(now), ...a, end: null, sent: {} };
    for (const ch of CHANNELS) alert.sent[ch] = !rule[ch] ? { status: "off" } : !this.channel(ch).url ? { status: "none" } : held ? { status: "held" } : { status: "sending", tries: 0 };
    this.list.push(alert);
    if (this.list.length > MAX) this.list.splice(0, this.list.length - MAX);
    for (const ch of CHANNELS) if (alert.sent[ch].status === "sending") this.deliver(alert, ch, now);
    this.touch();
  }

  /** One attempt to send an alert to a channel. Its result stays on the alert: sent (with tries > 1 when retried) or
   *  failed with what went wrong. */
  deliver(a, ch, now) {
    const d = a.sent[ch], { url } = this.channel(ch);
    Object.assign(d, { status: "sending", tries: (d.tries || 0) + 1 });
    return this.track(this.send(ch, url, message(a, now), now).then((r) => {
      Object.assign(d, r.ok ? { status: "sent", at: iso(now), error: null, hint: null } : { status: "failed", at: iso(now), error: r.error, hint: r.hint });
      this.touch();
      return d;
    }));
  }

  /** After quiet hours (or once they're turned off): what they held goes to each channel as one message. Each alert keeps
   *  that message's result as its delivery (a failed one can be retried on its own), and its reminders start again 15
   *  minutes after it. */
  digest(now) {
    const q = quietOf(this.getConfig().quietHours);
    for (const ch of CHANNELS) {
      const held = this.list.filter((a) => a.sent[ch].status === "held");
      if (!held.length) continue;
      const { url } = this.channel(ch);
      for (const a of held) a.sent[ch] = url ? { status: "sending", tries: 1, digest: true } : { status: "none" };
      for (const a of held) { const w = this.waits.get(`${a.session}:${a.questionId}`); if (w) w.at = now; }
      this.touch();
      if (!url) continue;
      this.track(this.send(ch, url, digestText(held, q, now), now).then((r) => {
        for (const a of held) Object.assign(a.sent[ch], r.ok ? { status: "sent", at: iso(now), error: null, hint: null } : { status: "failed", at: iso(now), error: r.error, hint: r.hint });
        this.touch();
      }));
    }
  }

  /** Sends through the transport, never throwing, and notes the result in the channel's health. */
  async send(ch, url, text, now) {
    let r = null;
    try { r = await this.transport({ channel: ch, url, text, at: now }); } catch {}
    const code = r && Number.isInteger(r.code) ? r.code : null;
    const out = r && r.ok ? { ok: true, code } : { ok: false, code, error: (r && r.error) || (code ? `HTTP ${code}` : "No answer"), hint: hintOf(code) };
    this.note(ch, url, out, now);
    return out;
  }

  /** A channel's health, for its current URL: since when it fails, or when it last delivered. */
  note(ch, url, r, now) {
    const key = fingerprint(url);
    let h = this.health[ch];
    if (!h || h.key !== key) h = this.health[ch] = { key, okAt: null, failAt: null, failSince: null, error: null, hint: null };
    if (r.ok) Object.assign(h, { okAt: iso(now), failSince: null, error: null, hint: null });
    else Object.assign(h, { failAt: iso(now), failSince: h.failSince || iso(now), error: r.error, hint: r.hint });
  }

  track(p) {
    this.inflight.add(p);
    p.then(() => this.inflight.delete(p));
    return p;
  }

  /** Sends a failed delivery again. Resolves once that attempt is over.
   *  @returns {Promise<{alert: object} | {code: number, error: string}>} */
  async retry(id, ch, now = Date.now()) {
    const a = typeof id === "string" ? this.list.find((x) => x.id === id) : null;
    if (!a) return { code: 404, error: "That alert isn't in the history any more. It keeps 7 days." };
    if (!CHANNELS.includes(ch)) return { code: 400, error: "channel must be slack or discord." };
    const d = a.sent[ch], name = NAMES[ch];
    if (d.status === "sending") return { code: 409, error: `It's on its way to ${name} right now.` };
    if (d.status === "held") return { code: 409, error: `Quiet hours hold it. It goes to ${name} in one message when they end, at ${quietOf(this.getConfig().quietHours).to}.` };
    if (d.status !== "failed") return { code: 409, error: d.status === "sent" ? `It already reached ${name}.` : `This alert wasn't for ${name}, so there's nothing to retry.` };
    if (!this.channel(ch).url) return { code: 409, error: `Set up the ${name} webhook first.` };
    const p = this.deliver(a, ch, now);
    this.touch();
    await p;
    return { alert: a };
  }

  /** Sends a test message to a channel.
   *  @returns {Promise<{ok: true, at: string} | {code: number, error: string}>} */
  async test(ch, now = Date.now()) {
    if (!CHANNELS.includes(ch)) return { code: 400, error: "channel must be slack or discord." };
    const { url } = this.channel(ch), name = NAMES[ch];
    if (!url) return { code: 409, error: `Set up the ${name} webhook first.` };
    if (this.testing.has(ch)) return { code: 409, error: `A test is already on its way to ${name}.` };
    this.testing.add(ch);
    this.touch();
    try {
      const r = await this.track(this.send(ch, url, TEST, now));
      return r.ok ? { ok: true, at: iso(now) } : { code: 502, error: `${name} didn't take the test: ${r.error} · ${r.hint}.` };
    } finally {
      this.testing.delete(ch);
      this.touch();
    }
  }

  // ---------- settings ----------
  /** PUT /api/alerts as settings for config.applyAlerts(): { rules?, slack?: { url?, channel? }, discord?: … }. url "" removes
   *  a webhook. A URL set in the server's environment can't be changed here.
   *  @returns {{patch: object} | {code: number, error: string}} */
  settings(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { code: 400, error: "Body must be an object." };
    const patch = {};
    if ("rules" in body) patch.alertRules = body.rules;
    for (const ch of CHANNELS) {
      const c = body[ch];
      if (c == null) continue;
      if (typeof c !== "object" || Array.isArray(c)) return { code: 400, error: `${ch} must be an object.` };
      if ("url" in c) {
        if (typeof c.url !== "string") return { code: 400, error: `The ${NAMES[ch]} webhook URL must be text.` };
        if (this.channel(ch).source === "env") return { code: 409, error: `${ENV[ch]} is set on the server, so the ${NAMES[ch]} webhook is changed there.` };
        patch[`${ch}WebhookUrl`] = c.url;
      }
      if ("channel" in c) {
        if (c.channel != null && typeof c.channel !== "string") return { code: 400, error: "The channel name must be text." };
        patch[`${ch}Channel`] = c.channel || "";
      }
    }
    return { patch };
  }

  // ---------- the view ----------
  /** GET /api/alerts: each channel's health, the rules, quiet hours, and the last 7 days of alerts, newest first. */
  view(now = Date.now()) {
    const cfg = this.getConfig(), from = iso(now - KEEP), list = this.list.filter((a) => a.t >= from);
    return {
      t: iso(now), days: KEEP / DAY, repeatMin: REPEAT / MIN, budget: num(cfg.dailyBudgetUsd), rules: rulesOf(cfg.alertRules), quiet: quietOf(cfg.quietHours),
      channels: CHANNELS.map((ch) => this.channelView(ch, cfg, list)),
      alerts: list.slice().reverse(),
    };
  }

  /** status: none (no webhook), new (nothing sent to this URL yet), ok, or failing (its latest send failed). */
  channelView(ch, cfg, list) {
    const { url, source } = this.channel(ch, cfg), h = this.health[ch] && this.health[ch].key === fingerprint(url) ? this.health[ch] : null;
    const status = !url ? "none" : !h || (!h.okAt && !h.failAt) ? "new" : h.failSince ? "failing" : "ok";
    return {
      id: ch, name: NAMES[ch], channel: cfg[`${ch}Channel`] || null, url: url ? mask(url) : null, source, env: ENV[ch], status,
      lastOk: h ? h.okAt : null, failSince: h ? h.failSince : null, error: h ? h.error : null, hint: h ? h.hint : null,
      delivered: list.filter((a) => a.sent[ch].status === "sent").length, testing: this.testing.has(ch),
    };
  }

  // ---------- saving ----------
  /** Something changed: the dashboard hears of it, and the history is saved half a second later. */
  touch() {
    this.rev++;
    this.emit("change");
    if (!this.file || this.timers.save) return;
    this.timers.save = setTimeout(() => { this.timers.save = null; this.save(); }, 500);
    this.timers.save.unref?.();
  }

  /** A check in a second (an agent's state changed, so a wait may have ended). Several in a row make one. */
  soon() {
    if (this.timers.soon) return;
    this.timers.soon = setTimeout(() => { this.timers.soon = null; this.check(); }, SOON);
    this.timers.soon.unref?.();
  }

  /** Resolves once no delivery or test is on its way. */
  async idle() {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  load() {
    if (!this.file) return;
    let j = null;
    try { j = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (err) {
      if (err.code !== "ENOENT") this.log.warn(`Couldn't read the alert history (${err.message}). Starting a new one.`);
      return;
    }
    if (!j || typeof j !== "object") return;
    this.list = (Array.isArray(j.alerts) ? j.alerts : []).filter(validAlert).slice(-MAX);
    // A send that was on its way when the server stopped never finished.
    for (const a of this.list) for (const ch of CHANNELS) if (a.sent[ch].status === "sending") Object.assign(a.sent[ch], { status: "failed", error: "Stopped by a restart", hint: "retry it" });
    Object.assign(this, { waits: mapOf(j.waits), costs: mapOf(j.costs), runs: mapOf(j.runs) });
    if (j.day && typeof j.day === "object") this.day = { date: typeof j.day.date === "string" ? j.day.date : null, warn: !!j.day.warn, over: !!j.day.over };
    if (j.sigs && typeof j.sigs === "object") this.sigs = { ...j.sigs };
    for (const ch of CHANNELS) if (j.health && j.health[ch] && typeof j.health[ch] === "object") this.health[ch] = j.health[ch];
  }

  /** Writes the history atomically. Never throws. */
  save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    const body = JSON.stringify({ version: 1, alerts: this.list, waits: [...this.waits], costs: [...this.costs], runs: [...this.runs], day: this.day, sigs: this.sigs, health: this.health });
    try { fs.writeFileSync(tmp, body, { mode: 0o600 }); fs.renameSync(tmp, this.file); } catch (err) { this.log.warn(`Couldn't save the alert history: ${err.message}`); }
  }

  close() {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = { save: null, soon: null };
    this.save();
  }
}

module.exports = { Alerts, sendWebhook, message, digestText, mask, hintOf, CHANNELS };
