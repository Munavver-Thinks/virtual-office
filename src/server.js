"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const { Store, localDate, validDate } = require("./store");
const { parseLogs } = require("./otlp");
const { attachAlerts, sendWebhook } = require("./alerts");
const { startDemo } = require("./demo");

const PUBLIC = path.join(__dirname, "..", "public");
const MAX_BODY = 2 * 1024 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function cookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : req.headers["x-agent-office-token"] || null;
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Creates the Agent Office server.
 * @param {{dir?: string, demo?: boolean, log?: Console}} opts
 */
function createServer(opts = {}) {
  const log = opts.log || console;
  const p = config.paths(opts.dir);
  let cfg = config.load(p.dir);
  // Demo mode shows a $25 budget when none is set. Demo settings live in memory only and are never saved.
  if (opts.demo && !cfg.dailyBudgetUsd) cfg = { ...cfg, dailyBudgetUsd: 25 };
  const getConfig = () => cfg;
  const rt = config.runtime(cfg);
  const openUI = LOOPBACK.has(rt.host);

  const store = new Store({ getConfig, dataDir: opts.demo ? null : p.data, log });
  const replayed = store.replay();
  attachAlerts(store, getConfig, log);
  const stopDemo = opts.demo ? startDemo(store) : null;

  // ---- spool: events saved by hooks while the server was down ----
  function ingestSpool() {
    const file = path.join(p.spool, "pending.jsonl");
    if (!fs.existsSync(file)) return;
    const work = path.join(p.spool, `ingest-${Date.now()}.jsonl`);
    try { fs.renameSync(file, work); } catch { return; }
    const lines = fs.readFileSync(work, "utf8").split("\n").filter(Boolean);
    for (const l of lines) { try { store.apply(JSON.parse(l)); } catch {} }
    fs.unlinkSync(work);
  }
  if (!opts.demo) { fs.mkdirSync(p.spool, { recursive: true }); ingestSpool(); }
  const spoolTimer = opts.demo ? null : setInterval(ingestSpool, 2000);

  // ---- live updates over server-sent events ----
  const clients = new Set();
  let pending = null;
  function broadcast() {
    pending = null;
    const data = `data: ${JSON.stringify(store.snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  }
  store.on("change", () => { if (!pending) pending = setTimeout(broadcast, 250); });
  const tick = setInterval(() => { if (clients.size) broadcast(); }, 15000);
  const heartbeat = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 20000);
  // prune() handles file trouble itself; this guard keeps any other surprise from killing the server.
  const pruner = setInterval(() => { try { store.prune(); } catch (err) { log.warn(`Hourly cleanup failed: ${err.message}`); } }, 3600000);

  const canView = (req) => openUI || safeEqual(cookie(req, "ao_token"), cfg.token) || safeEqual(bearer(req), cfg.token);
  const canIngest = (req) => safeEqual(bearer(req), cfg.token);
  const sameOrigin = (req) => req.headers["x-requested-with"] === "agent-office";

  function publicSettings() {
    return { offlineAfterMin: cfg.offlineAfterMin, dailyBudgetUsd: cfg.dailyBudgetUsd, webhookUrl: cfg.webhookUrl, notifyOnWaiting: cfg.notifyOnWaiting, aliases: cfg.aliases, demo: !!opts.demo, teamMode: !openUI };
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /healthz") return send(res, 200, { ok: true, agents: store.sessions.size });

    // Ingest: hooks and OpenTelemetry (always need the token)
    if (route === "POST /api/events" || route === "POST /v1/logs" || route === "POST /v1/metrics" || route === "POST /v1/traces") {
      if (!canIngest(req)) return send(res, 401, { error: "Missing or wrong token." });
      let body;
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return send(res, 400, { error: "Body must be JSON. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json." }); }
      if (url.pathname === "/api/events") {
        const list = Array.isArray(body) ? body : [body];
        let n = 0; for (const e of list.slice(0, 500)) if (store.apply(e)) n++;
        return send(res, 200, { accepted: n });
      }
      if (url.pathname === "/v1/logs") { let n = 0; for (const e of parseLogs(body)) if (store.apply(e)) n++; return send(res, 200, { accepted: n }); }
      return send(res, 200, {});
    }

    if (route === "POST /api/login") {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      if (!safeEqual(body.token, cfg.token)) return send(res, 401, { error: "That token isn't right. Run `agent-office token` on the server to see it." });
      return send(res, 200, { ok: true }, { "Set-Cookie": `ao_token=${encodeURIComponent(cfg.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    }

    const isApi = url.pathname.startsWith("/api/");
    if (!canView(req)) {
      if (isApi) return send(res, 401, { error: "Sign in first." });
      if (url.pathname !== "/login.html" && !url.pathname.endsWith(".css")) { res.writeHead(302, { Location: "/login.html" }); return res.end(); }
    }

    if (route === "GET /api/state") return send(res, 200, { ...store.snapshot(), settings: publicSettings() });
    if (route === "GET /api/report") {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 14));
      return send(res, 200, { days: store.report(days) });
    }
    if (route === "GET /api/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const agentPath = /^\/api\/agents\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && agentPath) {
      let id = null;
      try { id = decodeURIComponent(agentPath[1]); } catch {}
      if (!id || !/^[\w.:-]{1,100}$/.test(id)) return send(res, 400, { error: "That agent id isn't valid." });
      const d = store.detail(id);
      return d ? send(res, 200, d) : send(res, 404, { error: "No agent with that id." });
    }
    if (route === "GET /api/timeline") {
      const date = url.searchParams.get("date") || localDate(Date.now());
      if (!validDate(date)) return send(res, 400, { error: "date must be a real day as YYYY-MM-DD." });
      return send(res, 200, store.timeline(date));
    }
    if (route === "GET /api/settings") return send(res, 200, publicSettings());
    if (route === "PUT /api/settings" || route === "POST /api/settings/test-webhook") {
      if (!sameOrigin(req)) return send(res, 403, { error: "Blocked cross-site request." });
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "Body must be JSON." }); }
      if (url.pathname.endsWith("test-webhook")) {
        const ok = await sendWebhook(String(body.webhookUrl || cfg.webhookUrl), "✅ Virtual Office test alert. Webhook works.");
        return send(res, ok ? 200 : 502, ok ? { ok } : { error: "The webhook didn't accept the message. Check the URL." });
      }
      const r = config.applySettings(cfg, body);
      if (r.error) return send(res, 400, { error: r.error });
      cfg = r.cfg;
      if (!opts.demo) config.save(cfg, p.dir);
      store.emit("change");
      return send(res, 200, publicSettings());
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 404, { error: "Not found." });
    let rel;
    try { rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^[/\\]+/, ""); }
    catch { return send(res, 400, { error: "Bad path." }); } // malformed %-encoding
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "Forbidden." });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: "Not found." });
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => { log.error(err); if (!res.headersSent) send(res, 500, { error: "Server error." }); else res.end(); });
  });

  function close() {
    clearInterval(spoolTimer); clearInterval(tick); clearInterval(heartbeat); clearInterval(pruner);
    if (stopDemo) stopDemo();
    for (const res of clients) res.end();
    return new Promise((r) => server.close(r));
  }

  return { server, store, close, runtime: rt, replayed, openUI };
}

function start(opts = {}) {
  const app = createServer(opts);
  const { port, host } = app.runtime;
  app.server.listen(port, host, () => {
    const shown = LOOPBACK.has(host) ? "localhost" : host;
    console.log(`Virtual Office is running at http://${shown}:${port}${opts.demo ? "  (demo data)" : ""}`);
    if (!opts.demo) console.log(`Loaded ${app.replayed} saved events from ${config.paths(opts.dir).data}`);
    if (!app.openUI) console.log("Team mode: the dashboard asks for the token. Run `agent-office token` to see it.");
  });
  app.server.on("error", (err) => {
    if (err.code === "EADDRINUSE") console.error(`Port ${port} is already in use. Stop the other process or set PORT=4381.`);
    else console.error(err.message);
    process.exit(1);
  });
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  return app;
}

module.exports = { createServer, start };
