"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// The Alerts Center's rules: the number each one is set by, its default and its range (see src/alerts.js).
const RULES = {
  waiting: { key: "minutes", def: 3, min: 1, max: 240, whole: true, error: "The wait must be 1 to 240 minutes." },
  session: { key: "usd", def: 3.5, min: 0.01, max: 10000, whole: false, error: "The session cost must be $0.01 to $10,000." },
  budget: { key: "percent", def: 80, min: 1, max: 99, whole: true, error: "The budget warning must be 1 to 99% (the alert at 100% always comes too)." },
  failures: { key: "count", def: 3, min: 1, max: 50, whole: true, error: "Failed calls in a row must be 1 to 50." },
};
const CHANNELS = ["slack", "discord"];
const DISCORD = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\S+$/i;
const URL_MAX = 500, CHANNEL_MAX = 40;
// Projects (by git folder name): the most that keep a name or colour, the longest name, and the 6 room colours.
const PROJECTS = 200, PROJECT_NAME = 40, COLORS = 6, KEY_MAX = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
// "__proto__" can't be a plain object's own key, so it can't keep settings.
const badKey = (key) => !key || key.length > KEY_MAX || CONTROL.test(key) || key === "__proto__";

/** Quiet hours, filled in from defaults: off, 22:00 to 08:00 (server time). */
function quietOf(raw) {
  const q = raw && typeof raw === "object" ? raw : {};
  return { on: q.on === true, from: TIME.test(q.from) ? q.from : "22:00", to: TIME.test(q.to) ? q.to : "08:00" };
}

/** Whether t falls in quiet hours that are on, by the server's clock. 22:00–08:00 spans midnight. */
function isQuiet(raw, t = Date.now()) {
  const q = quietOf(raw);
  if (!q.on) return false;
  const d = new Date(t), m = d.getHours() * 60 + d.getMinutes(), [a, b] = [q.from, q.to].map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** The name and colour you gave each project: { "<git folder>": { name?, color? } }, anything else dropped. */
function projectsOf(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw).slice(0, PROJECTS)) {
    if (badKey(key) || !v || typeof v !== "object") continue;
    const p = {};
    if (typeof v.name === "string" && v.name.trim() && v.name.length <= PROJECT_NAME && !CONTROL.test(v.name)) p.name = v.name.trim();
    if (Number.isInteger(v.color) && v.color >= 0 && v.color < COLORS) p.color = v.color;
    if (Object.keys(p).length) out[key] = p;
  }
  return out;
}

/** Every rule, filled in from defaults: on, its number, and which channels it sends to. */
function rulesOf(raw = {}) {
  const out = {};
  for (const [kind, R] of Object.entries(RULES)) {
    const r = raw && typeof raw[kind] === "object" && raw[kind] ? raw[kind] : {};
    const n = Number(r[R.key]);
    out[kind] = { on: r.on !== false, [R.key]: Number.isFinite(n) && n >= R.min && n <= R.max ? n : R.def, slack: r.slack !== false, discord: r.discord !== false };
  }
  return out;
}

const DEFAULTS = {
  port: 4380,
  host: "127.0.0.1",
  offlineAfterMin: 30,
  retentionDays: 30,
  // Alerts: one incoming webhook per channel (the environment's SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL win), the
  // channel's name as you call it (webhooks don't say), and the rules.
  slackWebhookUrl: "",
  discordWebhookUrl: "",
  slackChannel: "",
  discordChannel: "",
  alertRules: rulesOf(),
  dailyBudgetUsd: 0,
  monthlyBudgetUsd: 0,
  // desktop notifications when an agent needs you
  notifyOnWaiting: true,
  // needs-you alerts held overnight and sent as one digest when they end (src/alerts.js)
  quietHours: quietOf(),
  aliases: {},
  // a display name and room colour per project (git folder name)
  projects: {},
  serverUrl: "",
  // false = hooks on this machine keep only names, paths and counts (no diffs, output or replies)
  captureDetail: true,
};

/** Config from before separate channels: its one webhookUrl goes to Discord or Slack by its address, and with
 *  notifyOnWaiting off (which then held back webhook alerts too) the waiting rule starts off. */
function migrate(raw) {
  const { webhookUrl, ...out } = raw;
  if (typeof webhookUrl === "string" && webhookUrl && !raw.slackWebhookUrl && !raw.discordWebhookUrl) out[DISCORD.test(webhookUrl) ? "discordWebhookUrl" : "slackWebhookUrl"] = webhookUrl;
  if (!raw.alertRules && raw.notifyOnWaiting === false) out.alertRules = { waiting: { on: false } };
  return out;
}

function baseDir() {
  return process.env.AGENT_OFFICE_DIR || path.join(os.homedir(), ".agent-office");
}

function paths(dir = baseDir()) {
  return {
    dir,
    config: path.join(dir, "config.json"),
    data: path.join(dir, "data"),
    spool: path.join(dir, "spool"),
  };
}

function save(cfg, dir = baseDir()) {
  const p = paths(dir);
  fs.mkdirSync(p.dir, { recursive: true });
  const persisted = {};
  for (const k of [...Object.keys(DEFAULTS), "token", "tokenCreatedAt"]) if (cfg[k] !== undefined) persisted[k] = cfg[k];
  const tmp = p.config + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p.config);
}

/** Loads persisted config, creating a token on first run. */
function load(dir = baseDir()) {
  const p = paths(dir);
  fs.mkdirSync(p.dir, { recursive: true });
  let raw = {};
  try { raw = migrate(JSON.parse(fs.readFileSync(p.config, "utf8")) || {}); } catch {}
  const cfg = { ...DEFAULTS, ...raw, aliases: { ...(raw.aliases || {}) }, alertRules: rulesOf(raw.alertRules), quietHours: quietOf(raw.quietHours), projects: projectsOf(raw.projects) };
  if (!cfg.token) {
    Object.assign(cfg, newToken());
    save(cfg, dir);
  }
  return cfg;
}

/** A fresh workspace token, and when it was made (tokens from before this was kept have no date). */
const newToken = (now = Date.now()) => ({ token: crypto.randomBytes(24).toString("hex"), tokenCreatedAt: new Date(now).toISOString() });
/** The config with a new token. Every machine that sends with the old one is refused from then on. */
const rotateToken = (cfg, now = Date.now()) => ({ ...cfg, ...newToken(now) });

/** Runtime view: environment variables override host and port without being saved. */
function runtime(cfg) {
  return {
    ...cfg,
    port: process.env.PORT ? Number(process.env.PORT) : cfg.port,
    host: process.env.HOST || cfg.host,
  };
}

/** A number from the settings form: empty text isn't 0. */
const numberOf = (v) => (typeof v === "string" && !v.trim() ? NaN : Number(v));

/**
 * Validates and applies a settings update from the UI. known = the project folders the store has seen, so a display
 * name can't be another project's. Returns the error message or the new config.
 */
function applySettings(cfg, body, { known = [] } = {}) {
  const out = { ...cfg };
  if ("offlineAfterMin" in body) {
    const v = numberOf(body.offlineAfterMin);
    if (!Number.isFinite(v) || v < 1 || v > 1440) return { error: "Offline timeout must be 1 to 1440 minutes." };
    out.offlineAfterMin = Math.round(v);
  }
  for (const [k, what] of [["dailyBudgetUsd", "Daily budget"], ["monthlyBudgetUsd", "Monthly budget"]]) {
    if (!(k in body)) continue;
    const v = numberOf(body[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1e6) return { error: `${what} must be $0 to $1,000,000 (0 = none).` };
    out[k] = Math.round(v * 100) / 100;
  }
  if ("notifyOnWaiting" in body) out.notifyOnWaiting = !!body.notifyOnWaiting;
  if ("quietHours" in body) {
    const p = body.quietHours, q = quietOf(cfg.quietHours);
    if (!p || typeof p !== "object") return { error: "quietHours must be an object." };
    for (const k of ["from", "to"]) {
      if (!(k in p)) continue;
      if (!TIME.test(p[k])) return { error: "Quiet hours need times like 22:00." };
      q[k] = p[k];
    }
    if ("on" in p) q.on = !!p.on;
    if (q.from === q.to) return { error: "Quiet hours need different start and end times." };
    out.quietHours = q;
  }
  if ("project" in body) {
    const r = applyProject(out.projects, body.project, known);
    if (r.error) return r;
    out.projects = r.projects;
  }
  if ("alias" in body) {
    const { folder, name } = body.alias || {};
    if (!folder || typeof folder !== "string") return { error: "Rename needs a folder." };
    const n = String(name || "").trim().slice(0, 40);
    out.aliases = { ...out.aliases };
    if (n) out.aliases[folder] = n; else delete out.aliases[folder];
  }
  return { cfg: out };
}

/** One project's name and colour: { key, name?, color? }. name "" goes back to the folder's name; color null to the
 *  automatic one. A name can't be another project's folder or name, so two rooms never merge by accident. */
function applyProject(current, p, known) {
  if (!p || typeof p !== "object") return { error: "project must be an object." };
  const key = typeof p.key === "string" ? p.key : "";
  if (badKey(key)) return { error: "That project isn't valid." };
  const projects = { ...current }, next = { ...(Object.hasOwn(projects, key) ? projects[key] : {}) };
  if ("name" in p) {
    const name = String(p.name ?? "").trim();
    if (name.length > PROJECT_NAME || CONTROL.test(name)) return { error: `Keep the name under ${PROJECT_NAME} characters, on one line.` };
    const taken = (n) => n.toLowerCase() === name.toLowerCase();
    if (name && name !== key && (known.some((k) => k !== key && taken(k)) || Object.entries(projects).some(([k, v]) => k !== key && v.name && taken(v.name))))
      return { error: `Another project is already called ${name}.` };
    if (name && name !== key) next.name = name; else delete next.name;
  }
  if ("color" in p) {
    if (p.color == null) delete next.color;
    else if (!Number.isInteger(p.color) || p.color < 0 || p.color >= COLORS) return { error: "Pick one of the 6 room colours." };
    else next.color = p.color;
  }
  delete projects[key];
  if (Object.keys(next).length) {
    if (Object.keys(projects).length >= PROJECTS) return { error: `Up to ${PROJECTS} projects keep a name or colour.` };
    projects[key] = next;
  }
  return { projects };
}

/** Validates and applies a change from the Alerts Center (the only place that changes these): each channel's webhook
 *  URL ("" removes it) and channel name, and the rules. Returns the error message or the new config. */
function applyAlerts(cfg, body) {
  const out = { ...cfg };
  for (const ch of CHANNELS) {
    const name = ch === "slack" ? "Slack" : "Discord";
    if (`${ch}WebhookUrl` in body) {
      const v = String(body[`${ch}WebhookUrl`] ?? "").trim();
      if (v && (v.length > URL_MAX || !/^https:\/\/[^\s/]+\/\S*$/.test(v))) return { error: `The ${name} webhook URL must start with https://` };
      if (v && ch === "discord" && !DISCORD.test(v)) return { error: "A Discord webhook URL starts with https://discord.com/api/webhooks/" };
      if (v && ch === "slack" && DISCORD.test(v)) return { error: "That's a Discord webhook. Add it under Discord." };
      out[`${ch}WebhookUrl`] = v;
    }
    if (`${ch}Channel` in body) {
      const v = String(body[`${ch}Channel`] ?? "").trim();
      if (v.length > CHANNEL_MAX || /[\u0000-\u001f\u007f]/.test(v)) return { error: `Keep the ${name} channel name under ${CHANNEL_MAX} characters.` };
      out[`${ch}Channel`] = v;
    }
  }
  if ("alertRules" in body) {
    const r = applyRules(out.alertRules, body.alertRules);
    if (r.error) return r;
    out.alertRules = r.rules;
  }
  return { cfg: out };
}

/** Changes to some rules: { waiting: { on, minutes, slack, discord }, … }, any part of each. */
function applyRules(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "alertRules must be an object." };
  const rules = rulesOf(current);
  for (const [kind, p] of Object.entries(patch)) {
    if (!Object.hasOwn(RULES, kind)) return { error: `There's no alert rule called ${String(kind).slice(0, 40)}.` };
    const R = RULES[kind];
    if (!p || typeof p !== "object") return { error: `The ${kind} rule must be an object.` };
    const r = { ...rules[kind] };
    for (const k of ["on", "slack", "discord"]) if (k in p) r[k] = !!p[k];
    if (R.key in p) {
      const n = typeof p[R.key] === "string" && !p[R.key].trim() ? NaN : Number(p[R.key]);
      if (!Number.isFinite(n) || n < R.min || n > R.max) return { error: R.error };
      r[R.key] = R.whole ? Math.round(n) : Math.round(n * 100) / 100;
    }
    rules[kind] = r;
  }
  return { rules };
}

module.exports = { DEFAULTS, RULES, baseDir, paths, load, save, runtime, applySettings, applyAlerts, rulesOf, migrate, quietOf, isQuiet, projectsOf, rotateToken };
