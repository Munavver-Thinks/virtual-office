"use strict";
// Demo data: one deterministic working day across 3 projects and 8 agents, plus 13 earlier days of cost
// (and the quiet, busy and empty scenes below).
// Every event is a raw Claude Code hook payload run through the real hook's build(), so the demo uses the
// same pipeline as live data. "Now" plays 15:42 in docs/redesign/reference/command-center.png; every
// scenario time is relative to now, so nothing lands in the future.

const { build } = require("../hooks/hook");

const MIN = 60000, DAY = 86400000, NOW_REF = 15 * 60 + 42;
const DEMO_USER = "mk"; // every demo session's user, and the top bar's avatar in demo mode
const SP = "/Users/mk/code/supermarket-pos", CA = "/Users/mk/code/checkout-api", DS = "/Users/mk/code/docs-site";
// Today's totals in the reference: $13.72, in 48.2k · out 1.21M · cache 92.4M.
const TOKENS_PER_USD = { input: 48200 / 13.72, output: 1210000 / 13.72, cacheRead: 87780000 / 13.72, cacheWrite: 4620000 / 13.72 };
const IDE = (file) => `<ide_opened_file>The user opened the file ${file} in the IDE. This may or may not be related to the current task.</ide_opened_file>`;
const bash = (command, description) => ({ command, description });

// Sub-agents under basket bill: one finished foreground explorer, one background test writer still running.
const SUBAGENTS = [
  { agentId: "agent-explore-1", type: "Explore", description: "Explore loyalty rules", at: "15:30", until: "15:36", background: false,
    last: "Loyalty discounts apply per line, then the basket coupon applies to the subtotal. Rounding happens once, at the end.",
    steps: [["15:31", "Read", { file_path: `${SP}/src/loyalty/rules.ts` }], ["15:32", "Grep", { pattern: "stackDiscount", path: `${SP}/src` }], ["15:34", "Read", { file_path: `${SP}/src/loyalty/stacking.ts` }]] },
  { agentId: "agent-tests-1", type: "general-purpose", description: "Write bill tests", at: "15:30:05", background: true,
    steps: [["15:31", "Read", { file_path: `${SP}/src/basket/BasketTotals.tsx` }],
      ["15:33", "Write", { file_path: `${SP}/src/basket/__tests__/BasketTotals.test.tsx`, content: "import { total } from '../BasketTotals';\n\ntest('stacks loyalty discounts', () => {\n  expect(total(basket)).toBe(1999);\n});\n" }, { type: "create" }],
      ["15:35", "Bash", bash("npx jest BasketTotals", "Run the new bill tests")],
      ["15:38", "Edit", { file_path: `${SP}/src/basket/__tests__/BasketTotals.test.tsx`, old_string: "  expect(total(basket)).toBe(1999);", new_string: "  expect(total(basket)).toBe(1999);\n  expect(total(withCoupon)).toBe(1799);" }]] },
];

// Plan rows: [content, activeForm, started, done]. No times = pending.
const AGENTS = [
  {
    id: "demo-basket", root: SP, host: "thinkpad-x1", model: "claude-sonnet-4-6", cost: 3.84, start: "13:05", subagents: SUBAGENTS,
    prompts: [["13:10", IDE(`${SP}/src/basket/Basket.tsx`) + "Basket bill rounding: totals are off by a cent when loyalty discounts stack. Fix the totals and add tests."]],
    plan: [
      ["Read the basket totals code", "Reading the basket totals code", "13:11", "13:24"],
      ["Find where loyalty discounts are applied", "Finding where loyalty discounts are applied", "13:24", "13:52"],
      ["Switch money maths to whole cents", "Switching money maths to whole cents", "13:52", "14:30"],
      ["Round each line before summing", "Rounding each line before summing", "14:30", "14:48"],
      ["Fix the failing basket test", "Fixing the failing basket test", "14:48", "15:10"],
      ["Write bill tests for stacked discounts", "Writing bill tests for stacked discounts", "15:14"],
      ["Run the full test suite", "Running the full test suite"],
      ["Update the changelog", "Updating the changelog"],
    ],
    work: [["13:11", "15:29"], ["15:37", "15:41"]],
    waits: [{ at: "13:40", until: "13:44", tool: "Bash", input: bash("npm install decimal.js", "Install decimal.js for exact money maths") }],
    steps: [
      { at: "14:52", tool: "Bash", input: bash("npm test -- basket", "Run the basket tests"), dur: 21,
        fail: "Exit code 1\nFAIL src/basket/BasketTotals.test.tsx\n  ✕ stacks loyalty discounts (12 ms)\n    Expected: 1999\n    Received: 2000" },
      { at: "15:41:50", tool: "Edit", input: { file_path: `${SP}/src/basket/BasketTotals.tsx`, old_string: "  return lines.reduce((sum, l) => sum + l.price, 0);", new_string: "  return lines.reduce((sum, l) => sum + roundCents(l.price - l.discount), 0);" }, open: true },
    ],
    // Sent from the dashboard while it works: it gets it the next time it stops.
    messages: [["15:39", "Keep the old rounding helper exported until the next release."]],
    pool: {
      read: ["src/basket/Basket.tsx", "src/basket/BasketTotals.tsx", "src/loyalty/discounts.ts", "src/money/round.ts"],
      edit: [["src/basket/BasketTotals.tsx", "const total = sum(lines);", "const total = roundCents(sum(lines));\nconst saved = sum(discounts);"], ["src/money/round.ts", "export const round = (n) => Math.round(n * 100) / 100;", "export const roundCents = (n) => Math.round(n);"]],
      cmd: ["npm test -- basket", "npx tsc --noEmit", "git diff --stat"], grep: ["roundCents", "applyLoyalty"],
    },
  },
  {
    id: "demo-inventory", root: SP, host: "thinkpad-x1", model: "claude-sonnet-4-6", cost: 2.1, start: "09:20",
    prompts: [["09:21", "Inventory sync keeps double-counting returns after the nightly job. Find out why and fix it."], ["12:30", "Now make the nightly job safe to run twice."]],
    plan: [
      ["Trace a return through the nightly sync", "Tracing a return through the nightly sync", "09:22", "10:05"],
      ["Find where returns are counted twice", "Finding where returns are counted twice", "10:05", "11:20"],
      ["Fix the return counting", "Fixing the return counting", "11:20", "12:08"],
      ["Make the nightly job safe to run twice", "Making the nightly job safe to run twice", "12:31"],
      ["Replay last week's data to check totals", "Replaying last week's data"],
      ["Document the sync job", "Documenting the sync job"],
    ],
    work: [["09:22", "12:09"], ["12:31", "15:41"]],
    waits: [{ at: "10:40", until: "10:52", tool: "Bash", input: bash('psql "$DATABASE_URL" -f scripts/returns-audit.sql', "Run the returns audit query") }],
    // A message from the dashboard, handed over by the 12:10 Stop: it carries on, logs skipped returns, then stops again.
    messages: [["11:30", "Also log every return the job skips, so we can audit them later."]],
    stops: [["12:10", "Returns were counted once by the till and again by the nightly job. The job now skips returns that already have a stock movement.", { inbox: true }],
      ["12:12", "Skipped returns are now written to the sync log with their order number.", { active: true }]],
    steps: [{ at: "12:11", tool: "Edit", input: { file_path: `${SP}/src/inventory/returns.ts`, old_string: "if (r.movementId) continue;", new_string: "if (r.movementId) { log.info('skipped return', r.orderId); continue; }" }, dur: 2 },
      { at: "14:40", tool: "Edit", input: { file_path: `${SP}/src/money/round.ts`, old_string: "export const round = (n) => Math.round(n * 100) / 100;", new_string: "export const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;" }, dur: 2 }],
    pool: {
      read: ["src/inventory/sync.ts", "src/inventory/returns.ts", "jobs/nightly.ts"],
      edit: [["src/inventory/returns.ts", "stock += r.qty;", "if (!r.movementId) stock += r.qty;"], ["jobs/nightly.ts", "await syncAll();", "await syncAll({ since: lastRun });"]],
      cmd: ["npm test -- inventory", "node scripts/replay-sync.js --dry-run"], grep: ["returnQty", "syncBatch"],
    },
  },
  {
    id: "demo-receipt", root: SP, host: "studio-mac", model: "claude-sonnet-4-6", cost: 1.12, start: "11:05",
    prompts: [["11:06", "Receipt printer cuts off the last line on the Epson TM-T20. Get printing working on the store till."], ["12:50", "Try the CUPS filter route instead of raw ESC/POS."]],
    plan: [
      ["Reproduce the cut-off receipt", "Reproducing the cut-off receipt", "11:07", "11:35"],
      ["Check the ESC/POS paper feed", "Checking the ESC/POS paper feed", "11:35", "12:22"],
      ["Install the printer filter package", "Installing the printer filter package", "12:51"],
      ["Switch printing to the CUPS queue", "Switching printing to the CUPS queue"],
      ["Print a test receipt", "Printing a test receipt"],
      ["Write up the printer setup", "Writing up the printer setup"],
    ],
    work: [["11:07", "12:24"], ["12:51", "15:37"]],
    // The open wait can be answered in the dashboard for 10 minutes (the longest hold), so there's time to try it.
    waits: [
      { at: "11:40", until: "11:43", tool: "Bash", input: bash("sudo lpadmin -p TM-T20 -E -v usb://EPSON/TM-T20", "Add the printer queue") },
      { at: "15:38", tool: "Bash", input: bash("sudo apt install cups-filters", "Install the printer filter package"), hold: 600 },
    ],
    stops: [["12:25", "The cut-off comes from the driver ignoring the final paper feed. A CUPS filter should fix it. Want me to try that?"]],
    // The same file as inventory sync, today: the meeting hall lists it under "Where agents overlap".
    steps: [{ at: "13:20", tool: "Edit", input: { file_path: `${SP}/src/money/round.ts`, old_string: "export const fmt = (n) => n.toFixed(2);", new_string: "export const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);" }, dur: 2 }],
    pool: {
      read: ["src/printing/receipt.ts", "src/printing/escpos.ts", "docs/printers.md"],
      edit: [["src/printing/escpos.ts", "buf.push(CUT);", "buf.push(FEED, FEED, FEED, CUT);"], ["src/printing/receipt.ts", "printer.raw(bytes);", "printer.queue('TM-T20', bytes);"]],
      cmd: ["lpstat -p", "npm run print:test"], grep: ["cutPaper", "lineFeed"],
    },
  },
  {
    id: "demo-login", root: SP, host: "thinkpad-x1", model: "claude-sonnet-4-6", cost: 1.46, start: "08:05",
    prompts: [["08:06", "Login fix for the cashier tablets: staff get logged out when the shift changes."], ["10:00", "Also keep cashiers signed in when the tablet sleeps."], ["14:10", "Check the midnight edge case for overnight shifts."]],
    plan: [
      ["Find why sessions end at shift change", "Finding why sessions end at shift change", "08:07", "08:50"],
      ["Tie session expiry to the shift, not the clock", "Tying session expiry to the shift", "08:50", "09:38"],
      ["Keep sessions alive through tablet sleep", "Keeping sessions alive through tablet sleep", "10:01", "11:48"],
      ["Handle overnight shifts at midnight", "Handling overnight shifts at midnight", "14:11", "15:20"],
      ["Agree the session length policy", "Agreeing the session length policy"],
    ],
    work: [["08:07", "09:39"], ["10:01", "11:49"], ["14:11", "15:24"]],
    waits: [{ at: "09:12", until: "09:20", tool: "Bash", input: bash("npm run db:migrate", "Apply the shift sessions migration") }],
    stops: [
      ["09:40", "Sessions now end with the shift instead of at a fixed time."],
      ["11:50", "Cashiers stay signed in while the tablet sleeps. The token refreshes when it wakes."],
      ["15:25", "Overnight shifts now keep one session across midnight. One thing is left: should a session last the whole shift or at most 8 hours? Tell me and I'll finish."],
    ],
    pool: {
      read: ["src/auth/session.ts", "src/auth/shift.ts"],
      edit: [["src/auth/session.ts", "expiresAt: startOfDay() + DAY,", "expiresAt: shift.end,"], ["src/auth/shift.ts", "return now > shift.end;", "return now > shift.end && !shift.overnight;"]],
      cmd: ["npm test -- auth"], grep: ["shiftEnd", "refreshToken"],
    },
  },
  {
    id: "demo-refund", root: CA, host: "thinkpad-x1", model: "claude-opus-4-7", cost: 2.05, start: "10:40",
    prompts: [["10:41", "Refund flow: partial refunds should go back to the original card and notify the webhook."], ["12:20", "Carry on with the webhook part."]],
    plan: [
      ["Map the current refund flow", "Mapping the current refund flow", "10:42", "11:10"],
      ["Send partial refunds to the original card", "Sending partial refunds to the original card", "11:10", "11:58"],
      ["Add refund webhook events", "Adding refund webhook events", "12:21", "15:18"],
      ["Add the refund webhook secret", "Adding the refund webhook secret", "15:20"],
      ["Sign webhook payloads", "Signing webhook payloads"],
      ["Retry failed refund webhooks", "Retrying failed refund webhooks"],
      ["Test partial refunds end to end", "Testing partial refunds end to end"],
      ["Update the API docs", "Updating the API docs"],
      ["Tell support about the change", "Telling support about the change"],
    ],
    work: [["10:42", "11:59"], ["12:21", "15:32"]],
    // Its hook waited the default 2 minutes and gave up, so this one is answered in the terminal.
    waits: [{ at: "15:33", tool: "Edit", input: { file_path: `${CA}/.env.production`, old_string: "REFUND_WEBHOOK_URL=https://hooks.example.com/refunds", new_string: "REFUND_WEBHOOK_URL=https://hooks.example.com/refunds\nREFUND_WEBHOOK_SECRET=${vault:refund-webhook-secret}" }, hold: 120 }],
    stops: [["12:00", "Partial refunds now go back to the original card. The webhook part is next."]],
    // Webhook retries edited this file this morning on the build server, in its own clone: an overlap in the room.
    steps: [{ at: "11:15", tool: "WebFetch", input: { url: "https://docs.stripe.com/refunds", prompt: "How do partial refunds work?" }, dur: 4 },
      { at: "14:20", tool: "Edit", input: { file_path: `${CA}/src/webhooks/retry.ts`, old_string: "export const EVENTS = ['charge'];", new_string: "export const EVENTS = ['charge', 'refund'];" }, dur: 2 }],
    pool: {
      read: ["src/refunds/refund.ts", "src/webhooks/send.ts", "src/payments/card.ts"],
      edit: [["src/refunds/refund.ts", "await payments.refund(order.id, amount);", "await payments.refund(order.chargeId, amount, { toOriginalCard: true });"], ["src/refunds/partial.ts", "export function partial() {}", "export function partial(order, amount) {\n  return refund(order, Math.min(amount, order.total));\n}"]],
      cmd: ["npm test -- refunds", "npm run lint"], grep: ["originalCard", "REFUND_"],
    },
  },
  {
    id: "demo-rate", root: CA, host: "thinkpad-x1", model: "claude-sonnet-4-6", cost: 1.38, start: "12:30",
    prompts: [["12:31", "Add a rate limiter to the public checkout endpoints: 100 requests a minute per API key."]],
    plan: [
      ["Find the public checkout routes", "Finding the public checkout routes", "12:32", "12:50"],
      ["Pick a limiter that works per API key", "Picking a limiter", "12:50", "13:30"],
      ["Add the limiter middleware", "Adding the limiter middleware", "13:30", "14:30"],
      ["Return 429 with a Retry-After header", "Returning 429 with Retry-After", "14:30", "15:05"],
      ["Load-test the limits", "Load-testing the limits", "15:05"],
      ["Document the limits", "Documenting the limits"],
    ],
    work: [["12:32", "15:41"]],
    waits: [{ at: "14:05", until: "14:17", tool: "Bash", input: bash("npm install express-rate-limit", "Install express-rate-limit") }],
    steps: [{ at: "12:55", tool: "WebSearch", input: { query: "express rate limit per api key" }, dur: 3 }],
    pool: {
      read: ["src/http/server.ts", "src/http/routes.ts"],
      edit: [["src/http/rateLimit.ts", "// limits", "export const limit = rateLimit({ windowMs: 60_000, limit: 100, keyGenerator: (req) => req.get('x-api-key') });"], ["src/http/server.ts", "app.use(routes);", "app.use('/checkout', limit);\napp.use(routes);"]],
      cmd: ["npm test -- rate", "npx autocannon -c 50 -d 5 http://localhost:3000/checkout"], grep: ["app.use(", "x-api-key"],
    },
  },
  {
    id: "demo-webhook", root: "/srv/work/checkout-api", host: "build-server", model: "claude-sonnet-4-6", cost: 0.86, start: "09:10", offline: true,
    prompts: [["09:11", "Webhook retries should back off exponentially and give up after 24 hours."]],
    plan: [
      ["Read the current retry loop", "Reading the current retry loop", "09:12", "09:40"],
      ["Add exponential backoff with jitter", "Adding exponential backoff", "09:40", "11:05"],
      ["Stop retrying after 24 hours", "Stopping retries after 24 hours", "11:05"],
      ["Test retries against a flaky endpoint", "Testing retries against a flaky endpoint"],
      ["Add a dead-letter queue", "Adding a dead-letter queue"],
    ],
    work: [["09:12", "12:03"]],
    // The machine dropped off mid-command: no result ever came back.
    steps: [{ at: "10:30", tool: "Edit", input: { file_path: "/srv/work/checkout-api/src/webhooks/retry.ts", old_string: "const MAX_ATTEMPTS = 5;", new_string: "const GIVE_UP_AFTER = 24 * HOUR;" }, dur: 2 },
      { at: "12:05", tool: "Bash", input: bash("npm run test:webhooks", "Run the webhook tests"), open: true }],
    pool: {
      read: ["src/webhooks/retry.ts", "src/webhooks/queue.ts"],
      edit: [["src/webhooks/retry.ts", "const delay = 1000;", "const delay = Math.min(2 ** attempt * 1000, HOUR) * (0.5 + Math.random());"]],
      cmd: ["npm run test:webhooks"], grep: ["backoff"],
    },
  },
  {
    id: "demo-tokens", root: DS, host: "studio-mac", model: "claude-haiku-4-5", cost: 0.91, start: "14:10",
    prompts: [["14:11", "Build the tokens page for the design docs, with every colour and spacing token."]],
    plan: [
      ["List every colour and spacing token", "Listing every token", "14:12", "14:35"],
      ["Generate the token tables", "Generating the token tables", "14:35", "15:00"],
      ["Add copy buttons to each token", "Adding copy buttons", "15:00", "15:30"],
      ["Style the tokens page", "Styling the tokens page", "15:30"],
      ["Link the page from the sidebar", "Linking the page from the sidebar"],
    ],
    work: [["14:12", "15:36"]],
    steps: [
      { at: "15:37", tool: "Read", input: { file_path: `${DS}/src/components/Button.mdx` }, dur: 1 },
      { at: "15:40", tool: "Edit", input: { file_path: `${DS}/src/styles/tokens.css`, old_string: "  --space-2: 8px;", new_string: "  --space-2: 8px;\n  --space-3: 12px;\n  --space-4: 16px;" }, dur: 2 },
    ],
    pool: {
      read: ["src/tokens/colors.ts", "src/tokens/spacing.ts", "src/components/Button.mdx"],
      edit: [["src/pages/tokens.mdx", "# Tokens", "# Tokens\n\n<TokenTable group=\"color\" />"], ["src/styles/tokens.css", "--teal: #2DD4BF;", "--teal: #2DD4BF;\n--teal-t: #5EEAD4;"]],
      cmd: ["npm run build:docs"], grep: ["--space-"],
    },
  },
];

// Earlier days: [cost, supermarket-pos share, checkout-api share]; docs-site gets the rest. Day -5 is over the $25 budget.
const HISTORY = [[9.8, 0.5, 0.35], [14.25, 0.45, 0.4], [11.6, 0.55, 0.3], [7.45, 0.5, 0.3], [16.9, 0.4, 0.45], [12.3, 0.5, 0.35],
  [10.15, 0.6, 0.25], [8.95, 0.5, 0.35], [27.4, 0.45, 0.45], [9.7, 0.5, 0.3], [6.88, 0.55, 0.3], [10.1, 0.5, 0.35], [7.35, 0.5, 0.3]];

/** Small seeded random numbers, so the demo is the same every run. */
function rng(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Splits an amount into n parts (to 1/100 of a cent) that add up exactly. */
const split = (total, n) => {
  const units = Math.round(total * 1e4), each = Math.floor(units / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? units - each * (n - 1) : each) / 1e4);
};
const START_REF = 8 * 60, KEEP = 20, MIN_ROOM = 90;
const minutesOf = (hms) => { const [h, m, s = 0] = hms.split(":").map(Number); return h * 60 + m + s / 60; };
// The answered waits, as minutes before 15:42 ([from, to], none overlapping): squeezed or not, each keeps its length.
const KEPT = AGENTS.flatMap((a) => (a.waits || []).filter((w) => w.until).map((w) => [NOW_REF - minutesOf(w.until), NOW_REF - minutesOf(w.at)]));
/** Minutes of the KEPT waits between KEEP and m minutes before 15:42. */
const keptTo = (m) => KEPT.reduce((n, [a, b]) => n + Math.max(0, Math.min(m, b) - Math.max(a, KEEP)), 0);
/**
 * Maps a scenario time ("13:40") to a real time, never later than now: normally 15:42 = now.
 * Early in the morning the day so far is shorter than the scenario, so everything older than the last KEEP
 * minutes is squeezed in after midnight and the scenario stays in today. Waits keep their real length: the open
 * ones are in the last KEEP minutes, and the answered ones (KEPT) are left out of the squeeze, so the same waits pass
 * the Alerts Center's 3 minutes whatever the time of day. With less than MIN_ROOM minutes since midnight, squeezing
 * would break the story (the offline machine would look recent), so the times stay as they are and the start of
 * the day falls in yesterday evening.
 */
const clockAt = (now) => {
  const room = (now - new Date(now).setHours(0, 0, 0, 0)) / MIN - 1, span = NOW_REF - START_REF, squeeze = room < span && room >= MIN_ROOM;
  const k = (room - KEEP - keptTo(span)) / (span - KEEP - keptTo(span)); // the squeeze outside the kept waits
  // ms before now. The kept and the squeezed parts are rounded apart, so a kept wait is exactly its length.
  const back = (m) => (!squeeze || m <= KEEP ? Math.round(m * MIN) : Math.round((KEEP + keptTo(m)) * MIN) + Math.round(k * (m - KEEP - keptTo(m)) * MIN));
  return (hms) => now - back(NOW_REF - minutesOf(hms));
};
// Each machine's OS, and its hook's report on its sends (hook.js healthOf) as of time t: studio-mac's sends failed at
// 15:05 and 15:21 (Retrying, "2 failed sends in the last hour"); build-server's last events, before it went quiet at
// 12:05, said 143 events waited in its spool. thinkpad-x1 never failed.
const HOST_OS = { "thinkpad-x1": "linux", "studio-mac": "darwin", "build-server": "linux" };
const HEALTH = {
  "studio-mac": (at, t) => { const fails = ["15:05", "15:21"].map(at).filter((f) => f < t); return fails.length ? { fails: fails.map((f) => new Date(f).toISOString()) } : null; },
  "build-server": (at, t) => (t >= at("11:50") ? { backlog: 143 } : null),
};
const healthAt = (at) => (host, t) => (HEALTH[host] ? HEALTH[host](at, t) : null);
const BASH_OUT = (cmd) => (/test|jest/.test(cmd) ? "PASS\nTests: 12 passed, 12 total\nTime: 3.2 s" : /install/.test(cmd) ? "added 1 package in 2s" : "");
const responseOf = (tool, input) => (tool === "Bash" ? { stdout: BASH_OUT(input.command), stderr: "", interrupted: false } : tool === "Write" ? { type: "create", filePath: input.file_path } : {});

// The demo's alert channels. Nothing is sent anywhere: demoWebhook() stands in for both.
const DEMO_CHANNELS = {
  slackWebhookUrl: "https://hooks.slack.com/services/T0DEMO/B0DEMO/k3Vd9demo", slackChannel: "#agent-office",
  discordWebhookUrl: "https://discord.com/api/webhooks/1290000000000000000/q8Lr2demo", discordChannel: "#ops",
};
// The server checks the alert rules every 15 s; the Alerts Center keeps 7 days. In a stretch of over 2 × QUIET without
// events, the checks between its first and its last QUIET are skipped: only a wait could alert there, and nobody waits
// through one in the demo.
const CHECK_MS = 15000, ALERT_DAYS = 7, QUIET = 3600000;

/** The demo's stand-in for Slack and Discord: nothing leaves the machine. Its Discord webhook was deleted at 15:35, so
 *  from then on it answers 404, until you give Discord another URL. */
function demoWebhook(now) {
  const gone = clockAt(now)("15:35");
  return async ({ channel, url, at }) => (channel === "discord" && url === DEMO_CHANNELS.discordWebhookUrl && at >= gone
    ? { ok: false, code: 404, error: "HTTP 404" } : { ok: true, code: 200 });
}

/** Turns script lines into hook payloads, usage events and messages from the dashboard, then applies them in time order.
 *  health(host, t): what that machine's hook says about its sends at t (see HEALTH).
 *  wait = { hold, onAsk }: a PermissionRequest whose hook waits `hold` seconds from its own time, as the real hook's does;
 *  onAsk gets the ask it opened (or null). Every Stop can take messages, as the real hook's does: it hands over any
 *  queued for that session. checks = { alerts, from, to }: the alert rules run every 15 s of that span, between the
 *  events, as the server runs them. */
function makeEmitter(store, health = () => null) {
  const queue = [];
  const hook = (a, t, ev, extra = {}, wait = null) => queue.push({ t, a, wait, raw: { session_id: a.id, hook_event_name: ev, cwd: a.root, ...extra } });
  const usage = (a, t, cost) => {
    const tok = (k) => Math.round(cost * TOKENS_PER_USD[k]);
    queue.push({ t, event: { type: "usage", t: new Date(t).toISOString(), session: a.id, cost, model: a.model, input: tok("input"), output: tok("output"), cacheRead: tok("cacheRead"), cacheWrite: tok("cacheWrite") } });
  };
  const message = (a, t, text) => queue.push({ t, event: { type: "message", t: new Date(t).toISOString(), session: a.id, text } });
  // A message to a room, sent as the dashboard sends it, to whoever is in the room at that moment.
  const room = (t, project, text) => queue.push({ t, room: { project, text } });
  const flush = (live, checks = null) => {
    queue.sort((x, y) => x.t - y.t);
    let next = checks ? checks.from : Infinity, last = -Infinity;
    const tickTo = (t) => { for (; next <= t; next += CHECK_MS) checks.alerts.check(next); };
    const until = (t) => {
      if (t - last > 2 * QUIET) {
        tickTo(last + QUIET);
        if (next < t - QUIET) next += Math.ceil((t - QUIET - next) / CHECK_MS) * CHECK_MS;
      }
      tickTo(t);
      last = t;
    };
    for (const q of queue.splice(0)) {
      until(q.t);
      if (q.room) { store.messageRoom(q.room.project, q.room.text, {}, q.t); continue; }
      const e = q.event || build(q.raw, { now: new Date(q.t), gitRoot: q.a.root, host: q.a.host, user: DEMO_USER, name: null, inbox: true,
        health: health(q.a.host, q.t), platform: HOST_OS[q.a.host] || "linux" });
      if (q.wait) q.wait.onAsk(store.applyHeld({ ...e, hold: q.wait.hold }, { persist: false, live }, q.t).ask);
      else if (e.inbox) store.applyStop(e, { persist: false, live }, q.t);
      else store.apply(e, { persist: false, live });
    }
    if (checks) until(checks.to);
  };
  return { hook, usage, message, room, flush, queue };
}

// Messages to a room from the dashboard, still waiting for each agent's next stop at 15:42: the meeting hall shows a
// delivery line per agent (working, waiting on you, idle), and one for the offline machine it couldn't reach.
const ROOM_MESSAGES = [
  ["15:30", "supermarket-pos", "Commit what you have before you start anything new."],
  ["15:36", "checkout-api", "Keep the refund and webhook retry changes in separate commits."],
];

// Other scenes, to check the Command Center's states: quiet = one agent; busy = the same day in three teams
// (24 agents in 9 projects); empty = a fresh install with nothing yet (the onboarding card).
const SCENES = {
  quiet: () => AGENTS.filter((a) => a.id === "demo-tokens"),
  busy: () => AGENTS.flatMap((a) => ["", "-eu", "-mobile"].map((s) => (s ? { ...JSON.parse(JSON.stringify(a).split(a.root).join(a.root + s)), id: a.id + s } : a))),
  empty: () => [],
};
const DEMO_SCENES = Object.keys(SCENES);

/** Builds today's scenario and the earlier days into the store. With alerts (src/alerts.js), its rules run over the
 *  last 7 days as they would have, so the Alerts Center has a history. Returns the live actors. */
function loadScenario(store, now, { scene, alerts = null } = {}) {
  const at = clockAt(now), em = makeEmitter(store, healthAt(at));
  const actors = [];
  (SCENES[scene] ? SCENES[scene]() : AGENTS).forEach((a, idx) => {
    const rand = rng(idx + 1), steps = [];
    let n = 0;
    const id = () => `toolu_${a.id.slice(5)}_${++n}`;
    const tool = (t, name, input, { dur = 5, fail, response, open, agent } = {}) => {
      const tid = id(), who = agent ? { agent_id: agent.agentId, agent_type: agent.type } : {};
      em.hook(a, t, "PreToolUse", { tool_name: name, tool_input: input, tool_use_id: tid, ...who });
      steps.push(t + 1000);
      if (open) return tid;
      const end = t + dur * 1000;
      if (fail) em.hook(a, end, "PostToolUseFailure", { tool_name: name, tool_input: input, tool_use_id: tid, error: fail, duration_ms: dur * 1000, ...who });
      else em.hook(a, end, "PostToolUse", { tool_name: name, tool_input: input, tool_use_id: tid, tool_response: response || responseOf(name, input), duration_ms: dur * 1000, ...who });
      return tid;
    };
    em.hook(a, at(a.start), "SessionStart", { source: "startup", model: a.model });
    for (const [t, text] of a.prompts) em.hook(a, at(t), "UserPromptSubmit", { prompt: text });
    for (const [t, text] of a.messages || []) em.message(a, at(t), text);
    // inbox: this Stop hands over a message, so Claude carries on (no "waiting for your input"); active: the Stop after that.
    for (const [t, text, o = {}] of a.stops || []) {
      em.hook(a, at(t), "Stop", { stop_hook_active: !!o.active, last_assistant_message: text });
      if (!o.inbox && at(t) + MIN <= now) em.hook(a, at(t) + MIN, "Notification", { message: "Claude is waiting for your input", notification_type: "idle_prompt" });
    }
    // The plan: a TodoWrite each time an item starts or finishes.
    const times = [...new Set(a.plan.flatMap(([, , s, d]) => [s, d]).filter(Boolean))].map(at).sort((x, y) => x - y);
    for (const T of times) {
      const todos = a.plan.map(([content, activeForm, s, d]) => ({ content, activeForm, status: d && at(d) <= T ? "completed" : s && at(s) <= T ? "in_progress" : "pending" }));
      tool(T, "TodoWrite", { todos }, { dur: 1 });
    }
    // Busy windows that filler steps must avoid.
    const busy = [];
    for (const w of a.waits || []) {
      const t0 = at(w.at), tid = id();
      const actor = w.until ? null : { a, mode: "wait", open: { tid, tool: w.tool, input: w.input }, ask: null };
      em.hook(a, t0 - 1000, "PreToolUse", { tool_name: w.tool, tool_input: w.input, tool_use_id: tid });
      em.hook(a, t0, "PermissionRequest", { tool_name: w.tool, tool_input: w.input }, actor && w.hold ? { hold: w.hold, onAsk: (ask) => { actor.ask = ask && ask.id; } } : null);
      em.hook(a, t0 + 6000, "Notification", { message: `Claude needs your permission to use ${w.tool}`, notification_type: "permission_prompt" });
      steps.push(t0);
      if (w.until) em.hook(a, at(w.until), "PostToolUse", { tool_name: w.tool, tool_input: w.input, tool_use_id: tid, tool_response: responseOf(w.tool, w.input), duration_ms: 4000 });
      busy.push([t0 - 60000, w.until ? at(w.until) + 30000 : Infinity]);
      if (actor) actors.push(actor);
    }
    for (const s of a.steps || []) {
      const tid = tool(at(s.at), s.tool, s.input, s);
      busy.push([at(s.at) - 30000, at(s.at) + (s.dur || 5) * 1000 + 30000]);
      if (s.open && !a.offline) actors.push({ a, mode: "work", open: { tid, tool: s.tool, input: s.input } });
    }
    if (a.subagents) busy.push(...subagents(a, at, em, tool));
    for (const [from, to] of a.work) {
      for (let t = at(from) + 30000; t < at(to); t += (90 + Math.floor(rand() * 120)) * 1000) {
        const clash = busy.find(([x, y]) => t >= x && t < y);
        if (clash) { if (clash[1] === Infinity) break; t = clash[1]; }
        if (t >= at(to)) break;
        const kind = ["read", "read", "grep", "edit", "edit", "cmd"][Math.floor(rand() * 6)], pool = a.pool[kind];
        const pickOne = pool[Math.floor(rand() * pool.length)];
        if (kind === "read") tool(t, "Read", { file_path: `${a.root}/${pickOne}` }, { dur: 1 });
        else if (kind === "grep") tool(t, "Grep", { pattern: pickOne, path: `${a.root}/src` }, { dur: 2 });
        else if (kind === "edit") tool(t, "Edit", { file_path: `${a.root}/${pickOne[0]}`, old_string: pickOne[1], new_string: pickOne[2] }, { dur: 2 });
        else tool(t, "Bash", bash(pickOne, "Run a check"), { dur: 8 + Math.floor(rand() * 30) });
      }
    }
    // Spread the agent's cost over its steps.
    const costs = split(a.cost, steps.length);
    steps.sort((x, y) => x - y).forEach((t, i) => em.usage(a, t, costs[i]));
    const plan = a.plan.map(([content, activeForm, s, d]) => ({ content, activeForm, status: d ? "completed" : s ? "in_progress" : "pending" }));
    const lastStop = (a.stops || []).at(-1), idle = lastStop && at(lastStop[0]) > at(a.work.at(-1)[1]);
    const actor = actors.find((x) => x.a === a);
    if (actor) Object.assign(actor, { plan, n: () => id() });
    else actors.push({ a, plan, n: () => id(), mode: a.offline ? "off" : idle ? "idle" : "work" });
  });
  if (scene !== "empty") history(em, now);
  for (const [t, project, text] of ROOM_MESSAGES) em.room(at(t), project, text);
  em.flush(false, alerts && { alerts, from: now - ALERT_DAYS * DAY, to: now });
  return actors;
}

function subagents(a, at, em, tool) {
  const busy = [];
  for (const s of a.subagents) {
    const t0 = at(s.at), tid = tool(t0, "Agent", { description: s.description, subagent_type: s.type, prompt: s.description, run_in_background: s.background }, { open: true });
    em.hook(a, t0 + 500, "SubagentStart", { agent_id: s.agentId, agent_type: s.type });
    const post = (t) => em.hook(a, t, "PostToolUse", { tool_name: "Agent", tool_input: { description: s.description, subagent_type: s.type }, tool_use_id: tid, tool_response: {}, duration_ms: t - t0 });
    if (s.background) post(t0 + 1000);
    for (const [t, name, input, response] of s.steps) tool(at(t), name, input, { dur: name === "Bash" ? 14 : 2, response, agent: s });
    if (s.until) {
      em.hook(a, at(s.until), "SubagentStop", { agent_id: s.agentId, agent_type: s.type, stop_hook_active: false, last_assistant_message: s.last });
      post(at(s.until) + 1000);
      busy.push([t0 - 30000, at(s.until) + 60000]);
    }
  }
  return busy;
}

// Each earlier day's prompt per project, by days ago (mod 4): the cost report's agents differ from day to day.
const HISTORY_PROMPTS = {
  "supermarket-pos": ["Add barcode scanning to the stock count", "Product search on the till is slow, make it faster", "Show low stock on the shelf report", "Fix the receipt total for refunds"],
  "checkout-api": ["Add idempotency keys to payments", "Checkout requests that are slow should be logged", "Card captures that fail should be retried", "Clean up the order status emails"],
  "docs-site": ["Write the API quickstart", "Fix broken links in the setup guide", "Add a search box to the docs", "Update the screenshots in the guide"],
};

/** Thirteen earlier days, one short session per project, so the cost report and timeline have history. */
function history(em, now) {
  HISTORY.forEach(([cost, sp, ca], i) => {
    const d = HISTORY.length - i, spCost = +(cost * sp).toFixed(2), caCost = +(cost * ca).toFixed(2), say = (p) => HISTORY_PROMPTS[p][d % 4];
    const parts = [["supermarket-pos", SP, spCost, "claude-sonnet-4-6", say("supermarket-pos")],
      ["checkout-api", CA, caCost, "claude-opus-4-7", say("checkout-api")],
      ["docs-site", DS, +(cost - spCost - caCost).toFixed(2), "claude-haiku-4-5", say("docs-site")]];
    // Three 10-minute sessions ending just before this time d days ago: on that calendar day (from 00:41 on),
    // and never inside the last-24-hours agent list.
    parts.forEach(([project, root, part, model, prompt], k) => {
      const a = { id: `demo-hist-${d}-${project}`, root, host: "thinkpad-x1", model };
      const t0 = now - d * DAY - (41 - 12 * k) * MIN;
      em.hook(a, t0, "SessionStart", { source: "startup", model });
      em.hook(a, t0 + MIN, "UserPromptSubmit", { prompt });
      split(part, 4).forEach((c, j) => em.usage(a, t0 + (j + 2) * MIN, c));
      if (d === FAILING.day && project === FAILING.project) failingRun(em, a, t0);
      em.hook(a, t0 + 8 * MIN, "Stop", { stop_hook_active: false, last_assistant_message: "Done for now." });
      em.hook(a, t0 + 10 * MIN, "SessionEnd", { reason: "prompt_input_exit" });
    });
  });
}

// Two days ago, card captures' tests couldn't reach the database three times in a row (an alert), then passed once it
// was started.
const FAILING = { day: 2, project: "checkout-api" };
function failingRun(em, a, t0) {
  const test = bash("npm test -- captures", "Run the capture tests"), db = bash("docker compose up -d db", "Start the database");
  const run = (m, input, n, fail) => {
    const t = t0 + m * MIN, tool_use_id = `toolu_hist_${n}`, base = { tool_name: "Bash", tool_input: input, tool_use_id, duration_ms: 20000 };
    em.hook(a, t, "PreToolUse", { tool_name: "Bash", tool_input: input, tool_use_id });
    if (fail) em.hook(a, t + 20000, "PostToolUseFailure", { ...base, error: "Exit code 1\nError: connect ECONNREFUSED 127.0.0.1:5432" });
    else em.hook(a, t + 20000, "PostToolUse", { ...base, tool_response: responseOf("Bash", input) });
  };
  [3, 4, 5].forEach((m, i) => run(m, test, i + 1, true));
  run(6, db, 4, false);
  run(7, test, 5, false);
}

// Live ticking: working agents keep stepping through their plans; two waiting agents get answered in the terminal
// after a few minutes, and rate limiter asks for permission every 10 minutes from minute 3 (a toast in the Command
// Center). Its hook waits the default 2 minutes for an answer in the dashboard; without one, the terminal answers
// 4 minutes in. Answers from the dashboard are picked up by the demo's stand-in for the hook. Nothing flips at random.
const ANSWER_AT = { "demo-receipt": 100, "demo-refund": 160 };
const ASK_FIRST = 60, ASK_EVERY = 200, ASK_HOLD = 80; // in 3-second ticks
const HOLD = 120, PICK_UP_MS = 400;
const FOLLOW_UPS = ["Tidy up and add a short summary to the PR.", "Add one more test for the edge case we found."];

function startDemo(store, intervalMs = 3000, now = Date.now(), { scene, alerts = null } = {}) {
  const actors = loadScenario(store, now, { scene, alerts });
  store.emit("change");
  const em = makeEmitter(store, healthAt(clockAt(now)));
  let tick = 0, asked = null, nextAsk = ASK_FIRST, stopped = false;
  const t = () => Date.now();
  // The hook's side of an ask, as its long-poll would see it. Allowed: the call runs. Denied: it never runs, and the
  // agent carries on with something else.
  const pickUp = (x) => setTimeout(() => {
    const r = !stopped && x.ask ? store.pollAsk(x.ask) : null;
    if (!r || r.status !== "answered") return;
    x.ask = null;
    if (r.decision.behavior === "allow") close(x); else x.open = null;
    x.mode = "work";
    em.flush(true);
  }, PICK_UP_MS);
  const onAsk = (a) => { const x = actors.find((y) => y.ask === a.id); if (x && a.decision) pickUp(x); };
  store.on("ask", onAsk);
  const todo = (x) => { const tid = x.n(); em.hook(x.a, t(), "PreToolUse", { tool_name: "TodoWrite", tool_input: { todos: x.plan }, tool_use_id: tid }); em.hook(x.a, t() + 1, "PostToolUse", { tool_name: "TodoWrite", tool_input: { todos: x.plan }, tool_use_id: tid, tool_response: {} }); };
  const close = (x) => {
    const o = x.open; x.open = null;
    em.hook(x.a, t(), "PostToolUse", { tool_name: o.tool, tool_input: o.input, tool_use_id: o.tid, tool_response: responseOf(o.tool, o.input), duration_ms: 2000 });
  };
  const advance = (x) => {
    const i = x.plan.findIndex((p) => p.status === "in_progress");
    if (i >= 0) x.plan[i].status = "completed";
    const next = x.plan.find((p) => p.status === "pending");
    if (next) { next.status = "in_progress"; todo(x); return; }
    todo(x);
    em.hook(x.a, t() + 2, "Stop", { stop_hook_active: false, last_assistant_message: "All done. Every item on the plan is finished." });
    Object.assign(x, { mode: "idle", idleTicks: 0, followUp: true });
  };
  const timer = setInterval(() => {
    tick++;
    for (const x of actors) {
      if (x.mode === "wait" && ANSWER_AT[x.a.id] === tick) { close(x); x.mode = "work"; x.ask = null; }
      if (x.mode === "idle" && x.followUp && ++x.idleTicks === 80) {
        em.hook(x.a, t(), "UserPromptSubmit", { prompt: FOLLOW_UPS[tick % FOLLOW_UPS.length] });
        x.plan.push({ content: "Tidy the code", activeForm: "Tidying the code", status: "in_progress" }, { content: "Write a summary", activeForm: "Writing a summary", status: "pending" });
        todo(x); x.mode = "work";
      }
    }
    const rate = actors.find((x) => x.a.id === "demo-rate");
    if (rate && tick >= nextAsk && rate.mode === "work" && !rate.open) {
      const input = bash("npm install -D autocannon", "Install the load-test tool");
      rate.open = { tid: rate.n(), tool: "Bash", input };
      em.hook(rate.a, t(), "PreToolUse", { tool_name: "Bash", tool_input: input, tool_use_id: rate.open.tid });
      // Allowed for this session earlier: decided at once, so the stand-in hook picks it up straight away.
      em.hook(rate.a, t() + 1, "PermissionRequest", { tool_name: "Bash", tool_input: input }, { hold: HOLD, onAsk: (ask) => { rate.ask = ask && ask.id; if (ask) pickUp(rate); } });
      rate.mode = "wait"; asked = tick; nextAsk = tick + ASK_EVERY;
    }
    if (rate && rate.mode === "wait" && tick === asked + ASK_HOLD) { close(rate); rate.mode = "work"; rate.ask = null; }
    const workers = actors.filter((x) => x.mode === "work");
    if (workers.length) {
      const x = workers[tick % workers.length];
      if (x.open) {
        close(x);
        x.steps = (x.steps || 0) + 1;
        if (x.steps % 12 === 0) advance(x);
      } else {
        const files = x.a.pool.read, file = files[tick % files.length];
        const input = tick % 3 ? { file_path: `${x.a.root}/${file}` } : bash(x.a.pool.cmd[tick % x.a.pool.cmd.length], "Run a check");
        x.open = { tid: x.n(), tool: tick % 3 ? "Read" : "Bash", input };
        em.hook(x.a, t(), "PreToolUse", { tool_name: x.open.tool, tool_input: input, tool_use_id: x.open.tid });
        em.usage(x.a, t() + 1, 0.012 + (tick % 5) * 0.004);
      }
    }
    em.flush(true);
  }, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); store.off("ask", onAsk); };
}

module.exports = { startDemo, loadScenario, demoWebhook, DEMO_USER, DEMO_SCENES, DEMO_CHANNELS };
