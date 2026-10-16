"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const DEFAULTS = {
  port: 4380,
  host: "127.0.0.1",
  offlineAfterMin: 30,
  retentionDays: 30,
  webhookUrl: "",
  dailyBudgetUsd: 0,
  notifyOnWaiting: true,
  aliases: {},
  serverUrl: "",
};

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
  for (const k of [...Object.keys(DEFAULTS), "token"]) if (cfg[k] !== undefined) persisted[k] = cfg[k];
  const tmp = p.config + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p.config);
}

/** Loads persisted config, creating a token on first run. */
function load(dir = baseDir()) {
  const p = paths(dir);
  fs.mkdirSync(p.dir, { recursive: true });
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(p.config, "utf8")); } catch {}
  const cfg = { ...DEFAULTS, ...raw, aliases: { ...(raw.aliases || {}) } };
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString("hex");
    save(cfg, dir);
  }
  return cfg;
}

/** Runtime view: environment variables override host and port without being saved. */
function runtime(cfg) {
  return {
    ...cfg,
    port: process.env.PORT ? Number(process.env.PORT) : cfg.port,
    host: process.env.HOST || cfg.host,
  };
}

/** Validates and applies a settings update from the UI. Returns the error message or null. */
function applySettings(cfg, body) {
  const out = { ...cfg };
  if ("offlineAfterMin" in body) {
    const v = Number(body.offlineAfterMin);
    if (!Number.isFinite(v) || v < 1 || v > 1440) return { error: "Offline timeout must be 1 to 1440 minutes." };
    out.offlineAfterMin = Math.round(v);
  }
  if ("dailyBudgetUsd" in body) {
    const v = Number(body.dailyBudgetUsd);
    if (!Number.isFinite(v) || v < 0) return { error: "Daily budget must be 0 or more." };
    out.dailyBudgetUsd = Math.round(v * 100) / 100;
  }
  if ("webhookUrl" in body) {
    const v = String(body.webhookUrl || "").trim();
    if (v && !/^https:\/\/\S+$/.test(v)) return { error: "Webhook URL must start with https://" };
    out.webhookUrl = v;
  }
  if ("notifyOnWaiting" in body) out.notifyOnWaiting = !!body.notifyOnWaiting;
  if ("alias" in body) {
    const { folder, name } = body.alias || {};
    if (!folder || typeof folder !== "string") return { error: "Rename needs a folder." };
    const n = String(name || "").trim().slice(0, 40);
    out.aliases = { ...out.aliases };
    if (n) out.aliases[folder] = n; else delete out.aliases[folder];
  }
  return { cfg: out };
}

module.exports = { DEFAULTS, baseDir, paths, load, save, runtime, applySettings };
