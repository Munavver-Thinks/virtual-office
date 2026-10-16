"use strict";
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const HISTORY = 20;
const STATE_ORDER = { waiting: 0, working: 1, idle: 2, offline: 3 };

function localDate(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}
function baseName(p) {
  if (!p) return null;
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || p;
}
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

class Store extends EventEmitter {
  /** @param {{getConfig: () => object, dataDir?: string|null}} opts  dataDir null = no persistence */
  constructor({ getConfig, dataDir = null }) {
    super();
    this.getConfig = getConfig;
    this.dataDir = dataDir;
    this.sessions = new Map();
    this.daily = new Map();
    this.budgetAlertedOn = null;
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  }

  session(id, t) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        session: id, name: null, folder: null, host: null, user: null,
        state: "idle", ended: false, task: null, tool: null, target: null, message: null,
        toolCount: 0, requests: 0, cost: 0, model: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        started: t, updated: t, history: [],
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  day(t) {
    const key = localDate(t);
    let d = this.daily.get(key);
    if (!d) { d = { date: key, cost: 0, tokens: 0, requests: 0, byProject: {} }; this.daily.set(key, d); }
    return d;
  }

  /** Validates an incoming event. Returns a clean copy or null. */
  static clean(e) {
    if (!e || typeof e !== "object" || typeof e.session !== "string" || !e.session) return null;
    const t = Date.parse(e.t);
    const out = { ...e, session: e.session.slice(0, 100), t: new Date(Number.isFinite(t) ? t : Date.now()).toISOString() };
    if (e.type === "hook" && typeof e.ev === "string") return out;
    if (e.type === "usage") return out;
    return null;
  }

  apply(raw, { persist = true, live = true } = {}) {
    const e = Store.clean(raw);
    if (!e) return false;
    if (persist) this.persist(e);
    const s = this.session(e.session, e.t);
    const before = s.state;
    if (e.t > s.updated) s.updated = e.t;
    if (e.t < s.started) s.started = e.t;

    if (e.type === "hook") {
      if (e.cwd) s.folder = e.cwd;
      if (e.name) s.name = e.name;
      if (e.host) s.host = e.host;
      if (e.user) s.user = e.user;
      switch (e.ev) {
        case "SessionStart": s.ended = false; s.state = "idle"; break;
        case "UserPromptSubmit": s.ended = false; s.state = "working"; s.task = e.prompt || s.task; s.tool = null; s.target = null; s.message = null; break;
        case "PreToolUse": s.state = "working"; s.tool = e.tool || null; s.target = e.target || null; s.toolCount++; s.message = null; break;
        case "PostToolUse": if (s.state !== "waiting") s.state = "working"; break;
        case "Notification": s.state = "waiting"; s.message = e.message || "Waiting for you"; break;
        case "Stop": s.state = "idle"; s.message = null; break;
        case "SessionEnd": s.state = "idle"; s.ended = true; s.message = null; break;
        default: break;
      }
      s.history.unshift({ t: e.t, ev: e.ev, tool: e.tool || null, target: e.target || null, msg: e.prompt || e.message || null });
      if (s.history.length > HISTORY) s.history.length = HISTORY;
    } else {
      const cost = num(e.cost), tok = num(e.input) + num(e.output) + num(e.cacheRead) + num(e.cacheWrite);
      s.cost += cost; s.requests++;
      s.tokens.input += num(e.input); s.tokens.output += num(e.output);
      s.tokens.cacheRead += num(e.cacheRead); s.tokens.cacheWrite += num(e.cacheWrite);
      if (e.model) s.model = e.model;
      const d = this.day(e.t);
      d.cost += cost; d.tokens += tok; d.requests++;
      const proj = baseName(s.folder) || "unknown";
      d.byProject[proj] = (d.byProject[proj] || 0) + cost;
      if (live) this.checkBudget();
    }

    if (live && before !== s.state) this.emit("transition", { agent: this.viewOne(s), from: before, to: s.state });
    if (live) this.emit("change");
    return true;
  }

  checkBudget() {
    const budget = num(this.getConfig().dailyBudgetUsd);
    if (!budget) return;
    const today = this.daily.get(localDate(Date.now()));
    if (today && today.cost >= budget && this.budgetAlertedOn !== today.date) {
      this.budgetAlertedOn = today.date;
      this.emit("budget", { spent: today.cost, budget });
    }
  }

  persist(e) {
    if (!this.dataDir) return;
    fs.appendFileSync(path.join(this.dataDir, `events-${localDate(e.t)}.jsonl`), JSON.stringify(e) + "\n");
  }

  /** Rebuilds state from saved event files and deletes files past retention. */
  replay() {
    if (!this.dataDir) return 0;
    const keep = this.getConfig().retentionDays || 30;
    const cutoff = localDate(Date.now() - keep * 86400000);
    let count = 0;
    const files = fs.readdirSync(this.dataDir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    for (const f of files) {
      const full = path.join(this.dataDir, f);
      if (f.slice(7, 17) < cutoff) { fs.unlinkSync(full); continue; }
      for (const line of fs.readFileSync(full, "utf8").split("\n")) {
        if (!line) continue;
        try { if (this.apply(JSON.parse(line), { persist: false, live: false })) count++; } catch {}
      }
    }
    const today = this.daily.get(localDate(Date.now()));
    const budget = num(this.getConfig().dailyBudgetUsd);
    if (today && budget && today.cost >= budget) this.budgetAlertedOn = today.date;
    return count;
  }

  statusOf(s, now = Date.now()) {
    const ageMin = (now - Date.parse(s.updated)) / 60000;
    if (s.ended || ageMin > (this.getConfig().offlineAfterMin || 30)) return "offline";
    return s.state;
  }

  viewOne(s, now = Date.now()) {
    const aliases = this.getConfig().aliases || {};
    return {
      ...s,
      tokens: { ...s.tokens },
      history: s.history.slice(0, 10),
      state: this.statusOf(s, now),
      name: (s.folder && aliases[s.folder]) || s.name || baseName(s.folder) || `session ${s.session.slice(0, 6)}`,
    };
  }

  /** Agents active in the last 24 hours, most urgent first. */
  agents(now = Date.now()) {
    return [...this.sessions.values()]
      .filter((s) => now - Date.parse(s.updated) < 86400000)
      .map((s) => this.viewOne(s, now))
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.started.localeCompare(b.started));
  }

  report(days = 14, now = Date.now()) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = localDate(now - i * 86400000);
      const d = this.daily.get(key);
      out.push(d ? { ...d, byProject: { ...d.byProject } } : { date: key, cost: 0, tokens: 0, requests: 0, byProject: {} });
    }
    return out;
  }

  snapshot(now = Date.now()) {
    const agents = this.agents(now);
    const today = this.daily.get(localDate(now)) || { cost: 0, tokens: 0 };
    const week = this.report(7, now).reduce((a, d) => a + d.cost, 0);
    const count = (st) => agents.filter((a) => a.state === st).length;
    return {
      t: new Date(now).toISOString(),
      agents,
      totals: { todayCost: today.cost, todayTokens: today.tokens, weekCost: week, working: count("working"), waiting: count("waiting"), idle: count("idle") },
    };
  }
}

module.exports = { Store, localDate, baseName };
