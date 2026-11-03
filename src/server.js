"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const { Store, localDate, validDate, INTERNAL } = require("./store");
const { parseLogs } = require("./otlp");
const { Alerts } = require("./alerts");
const { requestsCsv } = require("./csv");
const { startDemo, demoWebhook, DEMO_USER, DEMO_CHANNELS } = require("./demo");
const { applyInstall, hookCommand } = require("../hooks/install");
const { claimSpool } = require("../hooks/hook");

const PUBLIC = path.join(__dirname, "..", "public");
const MAX_BODY = 2 * 1024 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const DECISION = /^\/api\/decision\/([A-Za-z0-9_-]{16,64})$/;
const POLL_MAX = 25; // seconds one long-poll may hold, under common proxy timeouts
const EXPORT = new Map([["today", 1], ["7d", 7]]); // the cost report's CSV export: its periods, in days
// Answers, messages, names and their bookkeeping come only from the dashboard and the store, never from a hook or the spool.
const fromHook = (e) => !(e && INTERNAL.has(e.type));
const AGENT_ID = /^[\w.:-]{1,100}$/;
/** The session id in a /api/agents/<id> path, or null when it isn't a valid one. */
function agentIdOf(raw) {
  let id = null;
  try { id = decodeURIComponent(raw); } catch {}
  return id && AGENT_ID.test(id) ? id : null;
}
/** The project in a /api/rooms/<project> path (a folder name), or null when it can't be one. */
function roomOf(raw) {
  let p = null;
  try { p = decodeURIComponent(raw); } catch {}
  return p && p.length <= 200 && !/[\u0000-\u001f\u007f/\\]/.test(p) ? p : null;
}

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
/** The Host header names this computer. A page on another site that rebinds its name to 127.0.0.1 fails this. */
function loopbackHost(req) {
  const h = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK.has(h);
}
function osUser() {
  try { return os.userInfo().username || null; } catch { return null; }
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
 * @param {{dir?: string, demo?: boolean, scene?: string, log?: Console}} opts  scene: a demo scene (quiet, busy, empty)
 */
function createServer(opts = {}) {
  const log = opts.log || console;
  const p = config.paths(opts.dir);
  let cfg = config.load(p.dir);
  // Demo mode shows a $25 daily and $750 monthly budget when none is set, and its own alert channels and rules (nothing
  // is ever sent). Demo settings live in memory only and are never saved.
  if (opts.demo) cfg = { ...cfg, ...DEMO_CHANNELS, alertRules: config.rulesOf(), dailyBudgetUsd: cfg.dailyBudgetUsd || 25, monthlyBudgetUsd: cfg.monthlyBudgetUsd || 750 };
  const getConfig = () => cfg;
  const rt = config.runtime(cfg);
  const openUI = LOOPBACK.has(rt.host);

  const store = new Store({ getConfig, dataDir: opts.demo ? null : p.data, log });
  const replayed = store.replay();
  // opts.webhook: a stand-in for Slack and Discord (tests). The demo has its own and ignores the environment's URLs.
  const t0 = Date.now();
  const alerts = new Alerts({ store, getConfig, log, file: opts.demo ? null : path.join(p.data, "alerts.json"),
    transport: opts.webhook || (opts.demo ? demoWebhook(t0) : null), env: opts.demo ? {} : process.env });
  store.on("transition", () => alerts.soon()); // a wait may have ended
  const stopDemo = opts.demo ? startDemo(store, undefined, t0, { scene: opts.scene, alerts }) : null;
  alerts.check();

  // ---- spool: events saved by hooks on this machine while the server was down (hooks elsewhere flush their own) ----
  function ingestSpool() {
    for (const { file, offset } of claimSpool(p.spool)) {
      let text = "";
      try { text = fs.readFileSync(file).subarray(offset).toString("utf8"); } catch {}
      for (const l of text.split("\n")) { if (!l) continue; try { const e = JSON.parse(l); if (fromHook(e)) store.apply(e); } catch {} }
      try { fs.unlinkSync(file); } catch {}
    }
  }
  if (!opts.demo) { fs.mkdirSync(p.spool, { recursive: true }); ingestSpool(); }
  const spoolTimer = opts.demo ? null : setInterval(ingestSpool, 2000);

  // ---- live updates over server-sent events ----
  // alertsRev tells the Alerts Center that its history changed.
  const live = () => ({ ...store.snapshot(), alertsRev: alerts.rev });
  const clients = new Set();
  let pending = null;
  function broadcast() {
    pending = null;
    const data = `data: ${JSON.stringify(live())}\n\n`;
    for (const res of clients) res.write(data);
  }
  const schedule = () => { if (!pending) pending = setTimeout(broadcast, 250); };
  store.on("change", schedule);
  alerts.on("change", schedule);
  const tick = setInterval(() => { store.sweepAsks(); alerts.check(); if (clients.size) broadcast(); }, 15000);

  // ---- asks: hooks long-polling GET /api/decision/:askId for the dashboard's answer to a permission request ----
  const waiters = new Map(); // askId → Set of { res, timer }
  function answerPoll(res, id) {
    const r = store.pollAsk(id);
    if (!r) return send(res, 404, { status: "closed", error: "No such question." });
    send(res, 200, r.decision ? { status: r.status, decision: r.decision } : { status: r.status });
  }
  // Decided or closed: every hook waiting on it gets its reply now.
  store.on("ask", (a) => {
    const set = waiters.get(a.id);
    if (!set) return;
    waiters.delete(a.id);
    for (const w of set) { clearTimeout(w.timer); answerPoll(w.res, a.id); }
  });
  /** Replies at once when decided or closed; else holds up to ?wait= seconds (at most POLL_MAX), or to the window's end. */
  function poll(res, id, wait) {
    const r = store.pollAsk(id);
    if (!r || r.status !== "pending" || !wait) return answerPoll(res, id);
    const set = waiters.get(id) || new Set(), w = { res, timer: null };
    waiters.set(id, set);
    set.add(w);
    const drop = () => { clearTimeout(w.timer); set.delete(w); if (!set.size && waiters.get(id) === set) waiters.delete(id); };
    w.timer = setTimeout(() => { drop(); answerPoll(res, id); }, Math.min(wait * 1000, Math.max(0, r.left)));
    // The hook hung up before an answer came: it no longer waits, so the dashboard stops offering to answer.
    res.on("close", () => { if (!res.writableFinished) { drop(); store.leaveAsk(id); } });
  }
  const heartbeat = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 20000);
  // prune() handles file trouble itself; this guard keeps any other surprise from killing the server.
  const pruner = setInterval(() => { try { store.prune(); } catch (err) { log.warn(`Hourly cleanup failed: ${err.message}`); } }, 3600000);

  // tokenUsedAt: the last hook or telemetry call the token let in, since the server started (memory only).
  const startedAt = new Date().toISOString();
  let tokenUsedAt = null;
  const canView = (req) => openUI || safeEqual(cookie(req, "ao_token"), cfg.token) || safeEqual(bearer(req), cfg.token);
  const canIngest = (req) => { const ok = safeEqual(bearer(req), cfg.token); if (ok) tokenUsedAt = new Date().toISOString(); return ok; };
  const sameOrigin = (req) => req.headers["x-requested-with"] === "agent-office";

  // The top bar's avatar: the person running this dashboard. Unknown in team mode, where everyone shares one token.
  const viewer = opts.demo ? DEMO_USER : openUI ? osUser() : null;
  // tzOffsetMin: the server's clock, which quiet hours follow (UTC+2 = 120).
  function publicSettings() {
    return { offlineAfterMin: cfg.offlineAfterMin, dailyBudgetUsd: cfg.dailyBudgetUsd, monthlyBudgetUsd: cfg.monthlyBudgetUsd || 0, notifyOnWaiting: cfg.notifyOnWaiting,
      quietHours: config.quietOf(cfg.quietHours), tzOffsetMin: -new Date().getTimezoneOffset(), aliases: cfg.aliases, demo: !!opts.demo, teamMode: !openUI, viewer };
  }

  /** The token, and the settings.json part `agent-office install` would add (the empty office's onboarding, Settings).
   *  createdAt: null for a token from before that was kept. lastUsedAt: since the server started; the demo's events
   *  stand in for hook calls. t: when this was read (Settings' "As of" once it can't be read again). */
  function setupInfo(req) {
    const port = (server.address() && server.address().port) || rt.port;
    const proto = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const url = openUI ? `http://127.0.0.1:${port}` : `${proto}://${req.headers.host}`;
    const { settings } = applyInstall({}, { command: hookCommand(), url, token: cfg.token });
    return { t: new Date().toISOString(), token: cfg.token, url, snippet: JSON.stringify(settings, null, 2), teamMode: !openUI,
      createdAt: cfg.tokenCreatedAt || null, lastUsedAt: tokenUsedAt || (opts.demo ? store.lastEvent() : null), since: startedAt };
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
        // A hook waiting on its permission request sends it alone, and gets the id of its ask to long-poll. With nobody
        // watching the dashboard it gets none, so it ends at once and the terminal asks.
        if (body && body.type === "hook" && body.ev === "PermissionRequest" && Number(body.hold) > 0) {
          const r = store.applyHeld(body, { watched: clients.size > 0 });
          return send(res, 200, r.ask ? { accepted: r.applied ? 1 : 0, askId: r.ask.id } : { accepted: r.applied ? 1 : 0 });
        }
        // A Stop from a hook that prints messages (inbox): the reply hands over the ones you sent from the dashboard.
        if (body && body.type === "hook" && body.ev === "Stop" && body.inbox === true) {
          const r = store.applyStop(body), accepted = r.applied ? 1 : 0;
          return send(res, 200, r.messages.length ? { accepted, messages: r.messages } : { accepted });
        }
        const list = Array.isArray(body) ? body : [body];
        let n = 0; for (const e of list.slice(0, 500)) if (fromHook(e) && store.apply(e)) n++;
        return send(res, 200, { accepted: n });
      }
      if (url.pathname === "/v1/logs") { let n = 0; for (const e of parseLogs(body)) if (store.apply(e)) n++; return send(res, 200, { accepted: n }); }
      return send(res, 200, {});
    }
    // The hook's long-poll for the dashboard's answer: the ingest token, like every hook call.
    if (req.method === "GET" && url.pathname.startsWith("/api/decision/")) {
      if (!canIngest(req)) return send(res, 401, { error: "Missing or wrong token." });
      const m = DECISION.exec(url.pathname);
      if (!m) return send(res, 400, { error: "That question id isn't valid." });
      return poll(res, m[1], Math.min(POLL_MAX, Math.max(0, Math.floor(Number(url.searchParams.get("wait")) || 0))));
    }

    if (route === "POST /api/login") {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      if (!safeEqual(body.token, cfg.token)) return send(res, 401, { error: "That token isn't right. Run agent-office token on the server to see it." });
      return send(res, 200, { ok: true }, { "Set-Cookie": `ao_token=${encodeURIComponent(cfg.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    }

    const isApi = url.pathname.startsWith("/api/");
    if (!canView(req)) {
      if (isApi) return send(res, 401, { error: "Sign in first." });
      if (url.pathname !== "/login.html" && !url.pathname.endsWith(".css")) { res.writeHead(302, { Location: "/login.html" }); return res.end(); }
    }

    if (route === "GET /api/state") return send(res, 200, { ...live(), settings: publicSettings() });
    if (route === "GET /api/report") {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 14));
      return send(res, 200, { days: store.report(days) });
    }
    if (route === "GET /api/cost") return send(res, 200, store.cost());
    // The cost report's Export CSV: one row per API request of today or the last 7 days, as a download.
    if (route === "GET /api/cost/export") {
      const n = EXPORT.get(url.searchParams.get("range") || "today");
      if (!n) return send(res, 400, { error: "range must be today or 7d." });
      const r = store.requestRows(n), name = `virtual-office-requests-${r.from === r.to ? r.to : `${r.from}-to-${r.to}`}.csv`;
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "X-Rows": String(r.rows.length), ...(r.partial ? { "X-Partial": "1" } : {}) });
      return res.end(requestsCsv(r.rows));
    }
    if (route === "GET /api/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(live())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const agentPath = /^\/api\/agents\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && agentPath) {
      const id = agentIdOf(agentPath[1]);
      if (!id) return send(res, 400, { error: "That agent id isn't valid." });
      const d = store.detail(id);
      return d ? send(res, 200, d) : send(res, 404, { error: "No agent with that id." });
    }
    // A message tells an agent what to do next, so like an answer: same-origin requests only, and on an open local
    // dashboard only under a local host name. Renaming is held to the same rule.
    const agentPost = /^\/api\/agents\/([^/]+)\/(message|name)$/.exec(url.pathname);
    if (req.method === "POST" && agentPost) {
      const message = agentPost[2] === "message";
      if (!sameOrigin(req) || (openUI && !loopbackHost(req))) return send(res, 403, { error: "Blocked cross-site request." });
      const id = agentIdOf(agentPost[1]);
      if (!id) return send(res, 400, { error: "That agent id isn't valid." });
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch { return send(res, 400, { error: "Body must be JSON." }); }
      const r = message ? store.queueMessage(id, body.text) : store.rename(id, body.name);
      return r.error ? send(res, r.code, { error: r.error }) : send(res, 200, { ok: true, ...r });
    }
    // A message to a room is a message to each of its agents: held to the same rule.
    const roomPost = /^\/api\/rooms\/([^/]+)\/message$/.exec(url.pathname);
    if (req.method === "POST" && roomPost) {
      if (!sameOrigin(req) || (openUI && !loopbackHost(req))) return send(res, 403, { error: "Blocked cross-site request." });
      const project = roomOf(roomPost[1]);
      if (!project) return send(res, 400, { error: "That room isn't valid." });
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch { return send(res, 400, { error: "Body must be JSON." }); }
      const r = store.messageRoom(project, body.text, { sessions: body.sessions });
      return r.error ? send(res, r.code, { error: r.error }) : send(res, 200, { ok: true, ...r });
    }
    if (route === "GET /api/rooms") return send(res, 200, store.rooms());
    if (route === "GET /api/timeline") {
      const date = url.searchParams.get("date") || localDate(Date.now());
      if (!validDate(date)) return send(res, 400, { error: "date must be a real day as YYYY-MM-DD." });
      return send(res, 200, store.timeline(date));
    }
    if (route === "GET /api/board") return send(res, 200, store.board());
    if (route === "GET /api/settings") return send(res, 200, publicSettings());
    // Settings: each machine's hook health, and each project's name, colour and roots. server = this computer's name.
    if (route === "GET /api/machines") return send(res, 200, { t: new Date().toISOString(), offlineAfterMin: cfg.offlineAfterMin, server: os.hostname(), machines: store.machines() });
    if (route === "GET /api/projects") return send(res, 200, { t: new Date().toISOString(), projects: store.projects() });
    // Reveals the token: same-origin requests only, and on an open local dashboard only under a local host name.
    if (route === "GET /api/setup") {
      if (!sameOrigin(req) || (openUI && !loopbackHost(req))) return send(res, 403, { error: "Blocked cross-site request." });
      return send(res, 200, setupInfo(req));
    }
    // A new token: every machine with the old one is refused until it gets the new one. Held to the same rule. In team
    // mode, whoever rotates it stays signed in (a new cookie); everyone else signs in again, and every live stream, opened
    // with the old token, ends once the new cookie is on its way (the rotating tab's own reconnects with it). Saved first:
    // a token that couldn't be saved is never used.
    if (route === "POST /api/token/rotate") {
      if (!sameOrigin(req) || (openUI && !loopbackHost(req))) return send(res, 403, { error: "Blocked cross-site request." });
      const next = config.rotateToken(cfg);
      if (!opts.demo) config.save(next, p.dir);
      cfg = next;
      tokenUsedAt = null;
      send(res, 200, setupInfo(req), openUI ? {} : { "Set-Cookie": `ao_token=${encodeURIComponent(cfg.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
      if (!openUI) { for (const c of clients) c.end(); clients.clear(); }
      return;
    }
    // Answering can run a command on the agent's machine: same-origin requests only, and on an open local dashboard only
    // under a local host name, so a web page that points its own name at this computer can't answer.
    if (route === "POST /api/answer") {
      if (!sameOrigin(req) || (openUI && !loopbackHost(req))) return send(res, 403, { error: "Blocked cross-site request." });
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch { return send(res, 400, { error: "Body must be JSON." }); }
      const r = store.answerAsk(body.askId, body);
      return r.error ? send(res, r.code, { error: r.error }) : send(res, 200, { ok: true, ...r });
    }
    // Settings: same-origin requests only, and on an open local dashboard only under a local host name. Where alerts go
    // and their rules are the Alerts Center's (PUT /api/alerts below), not these.
    if (route === "PUT /api/settings") {
      if (!sameOrigin(req) || (openUI && !loopbackHost(req))) return send(res, 403, { error: "Blocked cross-site request." });
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch { return send(res, 400, { error: "Body must be JSON." }); }
      const r = config.applySettings(cfg, body, { known: store.projectKeys() });
      if (r.error) return send(res, 400, { error: r.error });
      cfg = r.cfg;
      if (!opts.demo) config.save(cfg, p.dir);
      store.emit("change");
      if ("quietHours" in body) { alerts.check(); alerts.touch(); } // turned off: what they held goes out now
      return send(res, 200, publicSettings());
    }
    if (route === "GET /api/alerts") return send(res, 200, alerts.view());
    // The rules and the webhooks, a test message, a failed delivery sent again: held to the same rule as settings, so a
    // web page can't point your alerts at its own webhook.
    const retryPath = /^\/api\/alerts\/([\w-]{6,40})\/retry$/.exec(url.pathname);
    if (route === "PUT /api/alerts" || route === "POST /api/alerts/test" || (req.method === "POST" && retryPath)) {
      if (!sameOrigin(req) || (openUI && !loopbackHost(req))) return send(res, 403, { error: "Blocked cross-site request." });
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch { return send(res, 400, { error: "Body must be JSON." }); }
      const r = retryPath ? await alerts.retry(retryPath[1], body.channel) : req.method === "POST" ? await alerts.test(body.channel) : alerts.settings(body);
      if (r.error) return send(res, r.code, { error: r.error });
      if (!r.patch) return send(res, 200, r);
      const c = config.applyAlerts(cfg, r.patch);
      if (c.error) return send(res, 400, { error: c.error });
      cfg = c.cfg;
      if (!opts.demo) config.save(cfg, p.dir);
      alerts.check(); // a rule turned on or changed starts from now
      alerts.touch();
      return send(res, 200, alerts.view());
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 404, { error: "Not found." });
    let rel;
    try { rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^[/\\]+/, ""); }
    catch { return send(res, 400, { error: "Bad path." }); } // malformed %-encoding
    if (rel.includes("\0")) return send(res, 400, { error: "Bad path." });
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
    alerts.close();
    for (const res of clients) res.end();
    for (const set of waiters.values()) for (const w of set) { clearTimeout(w.timer); send(w.res, 200, { status: "closed" }); }
    waiters.clear();
    return new Promise((r) => server.close(r));
  }

  return { server, store, alerts, close, runtime: rt, replayed, openUI };
}

function start(opts = {}) {
  const app = createServer(opts);
  const { port, host } = app.runtime;
  app.server.listen(port, host, () => {
    const shown = LOOPBACK.has(host) ? "localhost" : host;
    console.log(`Virtual Office is running at http://${shown}:${port}${opts.demo ? `  (demo data${opts.scene ? `, ${opts.scene} scene` : ""})` : ""}`);
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
