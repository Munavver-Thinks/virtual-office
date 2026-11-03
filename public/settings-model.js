// Settings, pure part: the sections and their nav notes, the machines table, the workspace token, the budgets and what
// they've used, the projects, quiet hours and the alert channels. Input: GET /api/settings, /api/machines,
// /api/projects, /api/setup and /api/alerts, and the live snapshot. No DOM: safe to import in Node tests.
import { projectColor } from "./ui/components.js";
import { money, clock } from "./ui/format.js";
import { displayName } from "./office3d-model.js";
import { channelCard } from "./alerts-model.js";

export const SECTIONS = [
  { id: "machines", label: "Machines", icon: "machine" },
  { id: "token", label: "Token", icon: "key" },
  { id: "budgets", label: "Budgets", icon: "chart" },
  { id: "projects", label: "Projects", icon: "office" },
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "notifications", label: "Notifications", icon: "bell" },
];
const IDS = new Set(SECTIONS.map((s) => s.id));
/** "#/settings?section=token" → "token"; null when the address names none (or one that doesn't exist). */
export function sectionOf(hash) {
  const m = /[?&]section=([^&#]*)/.exec(String(hash ?? ""));
  return m && IDS.has(m[1]) ? m[1] : null;
}
export const sectionHref = (id) => `#/settings?section=${id}`;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayKey = (t) => new Date(t).toDateString();
const shortDay = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
/** "15:41", or "Oct 20, 12:05" on another day. */
export const when = (t, now = Date.now()) => (dayKey(t) === dayKey(now) ? clock(t) : `${shortDay(t)}, ${clock(t)}`);
/** "12 s ago", "4 min ago", "2 h ago", "3 days ago". */
export function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return plural(Math.floor(s / 86400), "day") + " ago";
}

/** The nav's notes: machines offline (neutral) or retrying (red only when sends failed; else just sending what waited),
 *  channels failing (red). */
export function navNotes({ machines = null, alerts = null } = {}) {
  const ms = machines ? machines.machines : [], of = (s) => ms.filter((m) => m.status === s);
  const off = of("offline").length, retry = of("retrying"), failing = alerts ? alerts.channels.filter((c) => c.status === "failing").length : 0;
  return {
    machines: [off && { tone: "muted", icon: "power", text: `${off} offline` },
      retry.length && { tone: retry.some((m) => m.failed > 0) ? "error" : "muted", icon: "retry", text: `${retry.length} retrying` }].filter(Boolean),
    notifications: failing ? [{ tone: "error", icon: "alert", text: `${failing} failing` }] : [],
  };
}

// ---------- machines ----------
const OS = { darwin: "macOS", win32: "Windows", linux: "Linux" };
export const osName = (os) => (os ? OS[os] || os : null);
export const HEALTH = {
  healthy: { tone: "ok", icon: "check", label: "Healthy" },
  retrying: { tone: "retry", icon: "retry", label: "Retrying" },
  offline: { tone: "off", icon: "power", label: "Offline" },
};

/** What waits in a machine's spool, as its newest event said: the text, and the bar's share of max. */
function backlogOf(m, max, now) {
  if (!m.backlog && !m.more) return { n: 0, w: 0, text: "Nothing queued" };
  const n = m.backlog ? `${m.backlog.toLocaleString("en-US")}${m.more ? "+" : ""} ${m.backlog === 1 && !m.more ? "event" : "events"}` : "Events";
  const tail = m.status === "offline" ? `queued on the machine${m.reportedAt ? ` as of ${when(m.reportedAt, now)}` : ""}, sends on reconnect` : "queued on the machine, sends with its next events";
  return { n: m.backlog, w: Math.min(1, m.backlog / max), text: `${n} · ${tail}` };
}

/** Events the machine's spool dropped when it was full, as its newest event said (null for none): lost, so it's an error. */
const droppedOf = (m, now) => (m.dropped > 0 && m.droppedAt
  ? { text: `${m.dropped.toLocaleString("en-US")} ${m.dropped === 1 ? "event" : "events"} dropped when its spool was full, the latest at ${when(m.droppedAt, now)}` } : null);

/** The machines table: per machine its name, OS, live sessions, health pill and line, spool (and what it dropped), last
 *  event, sessions today and the result of its last Ping. server = this computer's name. */
export function machineRows(r, { now = Date.now(), pings = new Map() } = {}) {
  const max = Math.max(100, ...r.machines.map((m) => m.backlog || 0));
  return r.machines.map((m) => {
    const failed = `${m.failed}${m.capped ? "+" : ""} failed ${m.failed === 1 && !m.capped ? "send" : "sends"} in the last hour`;
    const line = m.status === "offline" ? { text: `No contact since ${when(m.lastEvent, now)}`, error: false }
      : m.failed ? { text: failed, error: true } : m.status === "retrying" ? { text: "Sending what waited in its spool", error: false } : { text: "No failed sends in the last hour", error: false };
    return {
      host: m.host, self: m.host === r.server, os: osName(m.os), live: m.live, about: [osName(m.os), `${m.live} live`].filter(Boolean).join(" · "),
      health: HEALTH[m.status] || HEALTH.healthy, status: m.status, line, backlog: backlogOf(m, max, now), dropped: droppedOf(m, now),
      last: when(m.lastEvent, now), lastAt: m.lastEvent, today: plural(m.today, "session"), ping: pings.get(m.host) || null,
    };
  });
}

/** What Ping found: the server can't reach a machine (its hooks only send), so this is when it last heard from it. */
export function pingText(m, now = Date.now()) {
  if (!m) return "It hasn't reported in the last 7 days.";
  const at = `Checked ${clock(now)}: `;
  if (m.status === "offline") return `${at}nothing since ${when(m.lastEvent, now)}. Its hooks only send while claude runs there.`;
  return `${at}its last event came ${ago(now - Date.parse(m.lastEvent))}.`;
}

// ---------- token ----------
export const maskToken = (t) => (t && t.length > 12 ? `${t.slice(0, 4)}••••••••${t.slice(-4)}` : "••••••••");
const dateTime = (t, now) => (new Date(t).getFullYear() === new Date(now).getFullYear() ? `${shortDay(t)}, ${clock(t)}` : `${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`);

/** The token's facts and what rotating it means here. machines = GET /api/machines: those that reported in the last 7
 *  days, apart from this computer, whose hooks read the new token from its config by themselves. */
export function tokenView(s, { now = Date.now(), machines = null } = {}) {
  const used = s.lastUsedAt ? `Last used ${when(s.lastUsedAt, now)}` : `Not used since the server started at ${when(s.since, now)}`;
  const others = machines ? machines.machines.filter((m) => m.host !== machines.server).length : 0;
  const confirm = !s.teamMode
    ? { lead: "Hooks on this computer switch to the new token by themselves.", more: "Cost tracking here stops until you run agent-office install again." }
    : { lead: others > 1 ? `All ${others} other machines stop reporting until their token is updated.` : others ? "1 other machine stops reporting until its token is updated."
      : "Machines with the old token stop reporting until it's updated.",
      more: "Everyone signed in to this dashboard signs in again with the new token." };
  return { masked: maskToken(s.token), created: s.createdAt ? `Created ${dateTime(s.createdAt, now)}` : "Creation date not recorded", used, confirm,
    install: s.teamMode ? `agent-office install --url ${s.url} --token ${s.token}` : null };
}

// ---------- budgets ----------
const MONTH = (t) => new Date(t).toLocaleDateString("en-US", { month: "long" });
/** Spend against a limit: the bar's share, over, and its words. */
function usage(spent, limit, words) {
  if (spent == null) return { w: 0, over: false, text: words };
  const over = limit > 0 && spent > limit;
  const pct = limit > 0 ? ` · ${over ? "over budget, " : ""}${Math.round((spent / limit) * 100)}% of ${money(limit, { trim: true })}` : "";
  return { w: limit > 0 ? Math.min(1, spent / limit) : 0, over, text: `${words}${pct}` };
}

/** The costliest session of the live data (the last 24 hours) that reported a cost, or null. */
export function costliest(agents = []) {
  return agents.filter((a) => a.requests > 0 || a.cost > 0).sort((a, b) => b.cost - a.cost)[0] || null;
}

/** Daily, monthly and per-session: each limit, and what it has used. rule = the Alerts Center's session rule (null
 *  until GET /api/alerts loads); noCost = telemetry never reported a cost. */
export function budgetRows(settings = {}, { snap = null, rule = null, now = Date.now() } = {}) {
  const p = snap && snap.totals && snap.totals.periods, top = snap ? costliest(snap.agents) : null;
  const noCost = !!p && !p["30d"]?.requests && !p["30d"]?.cost;
  const spend = (k) => (p && p[k] ? p[k].cost : null);
  const none = noCost ? "No cost data yet: cost needs telemetry (agent-office install)" : null;
  return [
    { key: "daily", field: "dailyBudgetUsd", label: "Daily budget", value: settings.dailyBudgetUsd || 0, step: "0.5",
      hint: "The top bar's ring turns red past it, and the Alerts Center warns at its share. 0 = none.",
      use: usage(spend("today"), settings.dailyBudgetUsd || 0, none || `${money(spend("today"))} spent today`) },
    { key: "monthly", field: "monthlyBudgetUsd", label: "Monthly budget", value: settings.monthlyBudgetUsd || 0, step: "1",
      hint: "The cost report's month tile measures against it. 0 = the daily budget × the days in the month.",
      use: usage(spend("month"), settings.monthlyBudgetUsd || 0, none || `${money(spend("month"))} spent in ${MONTH(now)}`) },
    { key: "session", field: "usd", label: "Alert when one session costs more than", value: rule ? rule.usd : null, step: "0.01", min: "0.01", rule,
      hint: rule ? (rule.on ? "The Alerts Center's session rule: on." : "The Alerts Center's session rule is off, so this doesn't alert.") : "",
      use: usage(top ? top.cost : null, rule ? rule.usd : 0, none || (top ? `${money(top.cost)} · ${displayName(top)}, the costliest session in the last 24 hours` : "No session has reported a cost in the last 24 hours")) },
  ];
}

// ---------- projects ----------
/** Same order as PROJECT_COLORS. */
export const COLOR_NAMES = ["Violet", "Sky", "Lime", "Pink", "Indigo", "Slate"];

/** Each project: its key, shown name, root(s), today's agents, and its colour (picked, else the office's automatic one). */
export function projectRows(r, { colors = new Map() } = {}) {
  return r.projects.map((p) => ({
    key: p.key, name: p.named ? p.name : "", folder: p.key, root: p.roots[0] || null, more: p.moreRoots + Math.max(0, p.roots.length - 1),
    others: p.roots.slice(1), today: `${plural(p.agentsToday, "agent")} today`,
    color: p.color ?? colors.get(p.name) ?? projectColor(p.name), picked: p.color != null,
  }));
}

/** GET /api/projects with one project's saved change ({ key, name?, color? }) in it, by the server's rules: a name that's
 *  empty or the folder's own is no name, and no colour is the automatic one. Shown until the list loads again. */
export function withProject(r, p) {
  if (!r || !p) return r;
  return { ...r, projects: r.projects.map((x) => {
    if (x.key !== p.key) return x;
    const y = { ...x }, name = "name" in p ? String(p.name ?? "").trim() : null;
    if (name != null) Object.assign(y, name && name !== x.key ? { name, named: true } : { name: x.key, named: false });
    if ("color" in p) y.color = p.color ?? null;
    return y;
  }) };
}

// ---------- notifications ----------
/** Slack and Discord as the Alerts Center sees them: name, health pill, its line (red when failing) and masked URL. */
export const channelRows = (r, now = Date.now()) => r.channels.map((c) => channelCard(c, { now }));

const utc = (min) => `UTC${min < 0 ? "−" : "+"}${Math.floor(Math.abs(min) / 60)}${Math.abs(min) % 60 ? `:${String(Math.abs(min) % 60).padStart(2, "0")}` : ""}`;
/** Quiet hours in words, and a note when the server's clock (which they follow) isn't this browser's. */
export function quietView(q = {}, { serverOffset = 0, browserOffset = -new Date().getTimezoneOffset() } = {}) {
  const v = { on: !!q.on, from: q.from || "22:00", to: q.to || "08:00" };
  return { ...v, text: `Needs-you alerts to Slack and Discord wait, then go out as one message at ${v.to}. Desktop notifications pause too. Budget, cost and error alerts still go out.`,
    tz: serverOffset !== browserOffset ? `These are the server's times (${utc(serverOffset)}). You're on ${utc(browserOffset)}.` : null };
}

/** Whether t falls in quiet hours that are on, by the server's clock (offsetMin = its UTC offset). */
export function inQuiet(q, t = Date.now(), offsetMin = 0) {
  if (!q || !q.on || !q.from || !q.to) return false;
  const m = (((Math.floor(t / 60000) + offsetMin) % 1440) + 1440) % 1440, [a, b] = [q.from, q.to].map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)));
  return a < b ? m >= a && m < b : m >= a || m < b;
}
