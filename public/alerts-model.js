// The Alerts Center, pure part: the channel cards, the history (its filters, and each alert's type, sentence, status and
// delivery per channel) and the rule cards. Input: GET /api/alerts (src/alerts.js). No DOM: safe to import in Node tests.
import { money, clock, waitTime, duration } from "./ui/format.js";
import { describeTool } from "./lib/describe.js";
import { displayName } from "./office3d-model.js";

export const CHANNELS = ["slack", "discord"];
export const NAMES = { slack: "Slack", discord: "Discord" };
export const TABS = [{ value: "history", label: "History" }, { value: "rules", label: "Rules" }];
export const tabOf = (v) => (v === "rules" ? "rules" : "history");
/** The history's filter chips: [value, label]. */
export const FILTERS = [["all", "All"], ["needs", "Needs you"], ["budget", "Budget"], ["errors", "Errors"]];
export const filterOf = (v) => (FILTERS.some(([k]) => k === v) ? v : "all");

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayKey = (t) => new Date(t).toDateString();
const shortDay = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "Today", "Yesterday" or "Oct 19". */
export function dayLabel(t, now = Date.now()) {
  const n = new Date(now);
  if (dayKey(t) === n.toDateString()) return "Today";
  if (dayKey(t) === new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).toDateString()) return "Yesterday";
  return shortDay(t);
}

/** "15:41", or "Oct 20, 09:12" on another day than ref. */
export const when = (t, ref = Date.now()) => (dayKey(t) === dayKey(ref) ? clock(t) : `${shortDay(t)}, ${clock(t)}`);

// ---------- channels ----------
const PILLS = {
  none: { tone: "muted", icon: "power", label: "Not set up" },
  new: { tone: "muted", icon: "clock", label: "Not tried yet" },
  ok: { tone: "ok", icon: "check", label: "Healthy" },
  failing: { tone: "error", icon: "alert", label: "Failing" },
};

/**
 * A channel card: "Slack · #agent-office", its health pill and line, the masked webhook, and its buttons. edit = the
 * label of the button that opens the webhook form (none when the URL is set in the server's environment).
 * testing = a test is on its way (this tab's own, or one the server reports).
 */
export function channelCard(c, { now = Date.now(), testing = false } = {}) {
  const line = c.status === "none" ? `Alerts don't go to ${c.name} yet. Add an incoming webhook to send them there.`
    : c.status === "failing" ? `Failing · ${c.error} since ${when(c.failSince, now)} · ${c.hint}`
    : c.status === "ok" ? `Last delivery ${when(c.lastOk, now)} · ${plural(c.delivered, "alert")} delivered in 7 days`
    : "Nothing sent to this webhook yet. Send a test to check it.";
  return {
    id: c.id, name: c.name, title: c.channel ? `${c.name} · ${c.channel}` : c.name, pill: PILLS[c.status] || PILLS.none, line,
    failing: c.status === "failing", setUp: c.status !== "none", url: c.url, env: c.source === "env" ? c.env : null, testing: testing || !!c.testing,
    edit: c.source === "env" ? null : c.status === "none" ? `Set up ${c.name}` : c.status === "failing" ? "Fix webhook" : "Change webhook",
  };
}

// ---------- history ----------
/** The type pill: Needs you (amber), Over budget (red), Budget warning (neutral), Errors (red). group = its filter. */
export function typeOf(a) {
  if (a.kind === "waiting") return { group: "needs", tone: "needs", icon: "hand", label: "Needs you" };
  if (a.kind === "failures") return { group: "errors", tone: "error", icon: "alert", label: "Errors" };
  if (a.kind === "budget" && a.level === "warn") return { group: "budget", tone: "warn", icon: "chart", label: "Budget warning" };
  return { group: "budget", tone: "over", icon: "alert", label: "Over budget" };
}

const nameOf = (a) => displayName({ name: a.name, label: a.label, project: a.project });

/** The alert in plain English: text, context (the parts of its second line), and the command or file it's about. */
export function alertText(a, now = Date.now()) {
  const who = a.name ? nameOf(a) : null, where = [a.project && a.project !== who ? a.project : null, a.host].filter(Boolean);
  if (a.kind === "waiting") return { who, text: `${who} has waited ${a.waited} min ${a.what}`, context: [a.repeat ? `Reminder ${a.repeat}` : null, ...where].filter(Boolean), target: a.target || null };
  if (a.kind === "session") return { who, text: `${who} has cost ${money(a.cost)}, more than the ${money(a.limit, { trim: true })} limit for one session`, context: where, target: a.model || null };
  if (a.kind === "failures") {
    const last = a.tool ? describeTool({ tool: a.tool, target: a.target }) : null;
    return { who, text: `${who} failed ${plural(a.count, "tool call")} in a row`, context: [a.agent ? "In a sub-agent" : null, ...where, last ? `Last: ${last.text}` : null].filter(Boolean),
      target: last ? last.target : a.target || null };
  }
  const day = dayKey(a.t) === dayKey(now) ? "Today's spend" : `Spend on ${shortDay(a.t)}`, cap = money(a.budget, { trim: true });
  return a.level === "warn"
    ? { who: null, text: `${day} passed ${a.percent}% of the ${cap} daily budget`, context: [`${money(a.spent)} spent`, "It alerts again at 100%"], target: null }
    : { who: null, text: `${day} passed the ${cap} daily budget`, context: [`${money(a.spent)} spent`], target: null };
}

const WAIT_END = { answered: "answered after", ended: "session ended after", offline: "went offline after" };
/** Needs you: "still waiting · 9m" (amber, raised hand) or "answered after 7m". Errors: "still failing" or "working again
 *  after 3m". Null for the budget kinds, which have nothing to follow. */
export function statusOf(a, now = Date.now()) {
  if (a.kind === "waiting") {
    const since = Date.parse(a.since);
    if (!a.end) return { tone: "needs", icon: "hand", text: `still waiting · ${waitTime(now - since)}` };
    const w = WAIT_END[a.end.how];
    return w ? { tone: "done", icon: a.end.how === "answered" ? "check" : "power", text: `${w} ${waitTime(Date.parse(a.end.t) - since)}` } : { tone: "done", icon: "power", text: "no longer waiting" };
  }
  if (a.kind === "failures") {
    if (!a.end) return { tone: "error", icon: "alert", text: "still failing" };
    if (a.end.how === "recovered") return { tone: "done", icon: "check", text: `working again after ${duration(Date.parse(a.end.t) - Date.parse(a.since))}` };
    return { tone: "done", icon: "power", text: a.end.how === "offline" ? "went offline" : "no longer failing" };
  }
  return null;
}

/** One channel's delivery: "Delivered 15:41" (or "… (retried)", "… in the digest"), "Failed · HTTP 404" with Retry,
 *  "Retrying…", "Held for quiet hours", or why it wasn't sent. ref = the alert's time (another day's delivery says its day). */
export function deliveryOf(d = {}, { ref = Date.now(), retrying = false } = {}) {
  if (retrying || d.status === "sending") return { tone: "busy", icon: null, text: retrying || d.tries > 1 ? "Retrying…" : "Sending…" };
  if (d.status === "held") return { tone: "muted", icon: "moon", text: "Held for quiet hours" };
  if (d.status === "sent") return { tone: "ok", icon: "check", text: `Delivered ${when(d.at, ref)}${d.tries > 1 ? " (retried)" : d.digest ? " in the digest" : ""}` };
  if (d.status === "failed") return { tone: "error", icon: "x", text: `Failed · ${d.error || "no answer"}`, retry: true };
  return { tone: "muted", icon: null, text: d.status === "off" ? "Off for this rule" : "Not set up" };
}

/**
 * The history table: its rows (newest first) under the filter, and how many there are of each type. Each row: when,
 * type, sentence, status, delivery per channel, and what Open opens (the agent's detail: at its conversation for a
 * wait, its trace for errors) or the cost report. retrying = "<alert id>:<channel>" keys this tab is retrying.
 */
export function history(r, { filter = "all", now = Date.now(), retrying = new Set() } = {}) {
  const f = filterOf(filter), counts = { all: 0, needs: 0, budget: 0, errors: 0 };
  const rows = r.alerts.map((a) => {
    const type = typeOf(a);
    counts.all++; counts[type.group]++;
    return {
      id: a.id, t: a.t, time: clock(a.t), day: dayLabel(a.t, now), type, ...alertText(a, now), status: statusOf(a, now),
      sent: Object.fromEntries(CHANNELS.map((ch) => [ch, deliveryOf(a.sent[ch], { ref: a.t, retrying: retrying.has(`${a.id}:${ch}`) })])),
      open: a.session && a.kind !== "budget" ? { session: a.session, at: a.kind === "waiting" ? "convo" : a.kind === "failures" ? "trace" : null } : null,
      costReport: a.kind === "budget",
    };
  });
  return { rows: f === "all" ? rows : rows.filter((x) => x.type.group === f), counts, filter: f, total: rows.length };
}

// ---------- rules ----------
/** The four rule cards: the sentence around the number, its input's range and name, and the note under it. */
export const RULES = [
  { kind: "waiting", key: "minutes", title: "An agent waits on you", before: "Alert when an agent has waited longer than", after: "minutes", min: 1, max: 240, step: 1, label: "Minutes an agent waits before the alert" },
  { kind: "session", key: "usd", title: "A costly session", before: "Alert when one session costs more than", unit: "$", after: "", min: 0.01, max: 10000, step: 0.01, label: "Session cost in dollars that alerts" },
  { kind: "budget", key: "percent", title: "Today's spend", before: "Warn when today's spend reaches", after: "% of the daily budget, and again at 100%", min: 1, max: 99, step: 1, label: "Percent of the daily budget that warns" },
  { kind: "failures", key: "count", title: "Failing tool calls", before: "Alert when an agent fails", after: "tool calls in a row", min: 1, max: 50, step: 1, label: "Failed tool calls in a row that alert" },
];

function noteOf(kind, r) {
  const q = r.quiet || {};
  if (kind === "waiting") return q.on ? { text: `It repeats every ${r.repeatMin} min until it's answered. Quiet hours (${q.from}–${q.to}) hold it for one message at ${q.to}.`, link: "Quiet hours", href: "#/settings?section=notifications" }
    : { text: `It repeats every ${r.repeatMin} min until it's answered.` };
  if (kind === "session") return { text: "Once per session. Raise the limit and it alerts again past the new one." };
  if (kind === "budget") return r.budget ? { text: `The daily budget is ${money(r.budget, { trim: true })}.`, link: "Change it in Settings", href: "#/settings?section=budgets" }
    : { text: "No daily budget is set, so this can't alert yet.", link: "Set one in Settings", href: "#/settings?section=budgets" };
  return { text: "Once per run of failures. It counts again after a call works." };
}

/** Each rule with its settings, its note, and its channels (setUp: a webhook is set up for it). */
export function ruleCards(r) {
  return RULES.map((R) => ({ ...R, rule: r.rules[R.kind], note: noteOf(R.kind, r),
    channels: r.channels.map((c) => ({ id: c.id, name: c.name, setUp: c.status !== "none", on: !!r.rules[R.kind][c.id] })) }));
}
