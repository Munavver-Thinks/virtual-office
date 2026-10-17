#!/usr/bin/env node
"use strict";
const http = require("http");
const https = require("https");
const config = require("../src/config");
const inst = require("../hooks/install");

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function ping(url) {
  return new Promise((resolve) => {
    const u = new URL("/healthz", url);
    const req = (u.protocol === "https:" ? https : http).get(u, { timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) { console.error(`Agent Office needs Node 18 or newer. You have ${process.versions.node}.`); process.exit(1); }

  switch (cmd) {
    case "start":
      require("../src/server").start({ demo: flag("--demo") });
      break;

    case "demo":
      require("../src/server").start({ demo: true });
      break;

    case "install": {
      const cfg = config.load();
      if (opt("--url")) {
        if (!opt("--token")) { console.error("Joining a team server needs its token too: --url <url> --token <token>"); process.exit(1); }
        cfg.serverUrl = opt("--url").replace(/\/+$/, "");
        cfg.token = opt("--token");
        config.save(cfg);
      }
      const rt = config.runtime(cfg);
      const url = cfg.serverUrl || `http://127.0.0.1:${rt.port}`;
      const file = inst.settingsPath();
      const r = inst.applyInstall(inst.readSettings(file), { command: inst.hookCommand(), telemetry: !flag("--no-telemetry"), plans: flag("--with-plans"), url, token: cfg.token });
      inst.writeSettings(file, r.settings);
      console.log(`Hooks installed in ${file} (backup: settings.json.agent-office.bak).`);
      console.log(r.telemetry ? "Cost and token tracking is on." : "Cost and token tracking is off.");
      if (r.plans) console.log("Plans are on: Claude Code keeps a to-do list on every model, so the dashboard can show planned and done.");
      r.warnings.forEach((w) => console.log("Note: " + w));
      console.log("Restart any running claude sessions so they pick up the change.");
      break;
    }

    case "uninstall": {
      const file = inst.settingsPath();
      inst.writeSettings(file, inst.applyUninstall(inst.readSettings(file)));
      console.log(`Agent Office removed from ${file}. Your data in ${config.paths().dir} was kept.`);
      break;
    }

    case "token": {
      const cfg = config.load();
      console.log(cfg.token);
      break;
    }

    case "doctor": {
      const cfg = config.load();
      const rt = config.runtime(cfg);
      const s = inst.readSettings(inst.settingsPath());
      const url = cfg.serverUrl || `http://127.0.0.1:${rt.port}`;
      const up = await ping(url);
      const hooks = inst.installState(s);
      const checks = [
        [true, `Node ${process.versions.node}`],
        [true, `Data folder: ${config.paths().dir}`],
        [hooks === "installed", { installed: "Hooks installed", outdated: "Hooks are from an older version. Re-run: agent-office install", missing: "Hooks missing. Run: agent-office install" }[hooks]],
        [s.env?.CLAUDE_CODE_ENABLE_TELEMETRY === "1", s.env?.CLAUDE_CODE_ENABLE_TELEMETRY === "1" ? `Telemetry goes to ${s.env.OTEL_EXPORTER_OTLP_ENDPOINT}` : "Cost tracking off. Run: agent-office install"],
        [up, up ? `Server is running at ${url}` : `Server not reachable at ${url}. Run: agent-office start`],
      ];
      for (const [ok, msg] of checks) console.log(`${ok ? "✔" : "✘"} ${msg}`);
      // Information only: plans are optional.
      console.log(s.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS === "1" ? "ℹ Plans are on for every model."
        : "ℹ Plans show only for Opus 4.7, Sonnet 4.6, Haiku 4.5 and earlier models. For newer models run: agent-office install --with-plans");
      process.exitCode = checks.every((c) => c[0]) ? 0 : 1;
      break;
    }

    default:
      console.log(`Agent Office: a live office for your Claude Code sessions

Usage: agent-office <command>

  start            Start the dashboard server (http://localhost:4380)
  demo             Start with fake agents to try it out
  install          Add hooks and cost tracking to Claude Code
      --no-telemetry   hooks only, no cost or token tracking
      --with-plans     make newer models keep a to-do list (sets CLAUDE_CODE_ENABLE_TODO_TOOLS=1)
      --url <url> --token <token>
                       send to a team server instead of this machine
  uninstall        Remove hooks and cost tracking from Claude Code
  doctor           Check that everything is connected
  token            Print the access token

Environment: PORT, HOST (0.0.0.0 for team mode), AGENT_OFFICE_DIR`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
