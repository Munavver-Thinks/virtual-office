"use strict";
// Fake agents so you can see the office without Claude Code.

const PROJECTS = ["aurum-api", "aurum-web", "billing", "billing-tests", "docs", "infra", "mobile"];
const WORK = [
  ["Add invoice PDF export", "Edit", "src/billing/invoice.ts"],
  ["Fix login redirect bug", "Read", "src/auth/session.ts"],
  ["Run the test suite", "Bash", "npm test"],
  ["Find unused exports", "Grep", "export function"],
  ["Update setup steps in README", "Write", "README.md"],
  ["Check the failing CI job", "Bash", "gh run view --log-failed"],
  ["Add tax field to invoices", "Edit", "src/billing/tax.ts"],
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function startDemo(store, intervalMs = 1500) {
  const now = Date.now();
  // Two weeks of fake history so the report has something to show.
  for (let d = 13; d >= 1; d--) {
    for (let k = 0; k < 6; k++) {
      const t = new Date(now - d * 86400000 + k * 3600000).toISOString();
      const p = pick(PROJECTS);
      const id = `hist-${d}-${k}`;
      store.apply({ type: "hook", t, session: id, ev: "SessionEnd", cwd: `/home/you/projects/${p}`, host: "demo" }, { persist: false, live: false });
      store.apply({ type: "usage", t, session: id, cost: Math.random() * 1.8, input: 20000 + Math.random() * 60000, output: 3000 + Math.random() * 9000, model: "claude-sonnet-4-5" }, { persist: false, live: false });
    }
  }
  const ids = PROJECTS.map((p, i) => ({ id: `demo-${i}`, cwd: `/home/you/projects/${p}` }));
  ids.forEach(({ id, cwd }) => store.apply({ type: "hook", t: new Date().toISOString(), session: id, ev: "SessionStart", cwd, host: "demo-laptop" }, { persist: false }));

  const timer = setInterval(() => {
    const { id, cwd } = pick(ids);
    const t = new Date().toISOString();
    const r = Math.random();
    if (r < 0.15) {
      const w = pick(WORK);
      store.apply({ type: "hook", t, session: id, ev: "UserPromptSubmit", cwd, prompt: w[0] }, { persist: false });
    } else if (r < 0.65) {
      const w = pick(WORK);
      store.apply({ type: "hook", t, session: id, ev: "PreToolUse", cwd, tool: w[1], target: w[2] }, { persist: false });
      store.apply({ type: "usage", t, session: id, cost: 0.01 + Math.random() * 0.06, input: 4000 + Math.random() * 8000, output: 200 + Math.random() * 900, cacheRead: Math.random() * 20000, model: pick(["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"]) }, { persist: false });
    } else if (r < 0.78) {
      store.apply({ type: "hook", t, session: id, ev: "Notification", cwd, message: "Claude needs your permission to use Bash" }, { persist: false });
    } else {
      store.apply({ type: "hook", t, session: id, ev: "Stop", cwd }, { persist: false });
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startDemo };
