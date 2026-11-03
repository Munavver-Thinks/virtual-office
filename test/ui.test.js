"use strict";
// Design system (public/ui): formatters, token contrast, component markup and hover-card placement.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");
const { pathToFileURL } = require("url");

const UI = path.join(__dirname, "..", "public", "ui");
const load = (name) => import(pathToFileURL(path.join(UI, name)).href);
const M = 60000;

// ---------- formatters ----------
test("compact numbers and the one-line tokens summary", async () => {
  const f = await load("format.js");
  const cases = [[0, "0"], [950, "950"], [999.6, "1k"], [2000, "2k"], [1500, "1.5k"], [48210, "48.2k"], [231400, "231k"],
    [999950, "1M"], [1210000, "1.21M"], [34400000, "34.4M"], [2.5e9, "2.5B"], [-5, "0"], [undefined, "0"], ["abc", "0"]];
  for (const [n, want] of cases) assert.equal(f.compact(n), want, `compact(${n})`);
  assert.equal(f.tokensLine({ input: 2000, output: 231000, cacheRead: 34000000, cacheWrite: 400000 }), "in 2k · out 231k · cache 34.4M");
  assert.equal(f.tokensLine(), "in 0 · out 0 · cache 0");
});

test("money", async () => {
  const f = await load("format.js");
  assert.equal(f.money(13.72), "$13.72");
  assert.equal(f.money(1234.5), "$1,234.50");
  assert.equal(f.money(25, { trim: true }), "$25");
  assert.equal(f.money(25.5, { trim: true }), "$25.50");
  assert.equal(f.money(0.004), "<$0.01");
  assert.equal(f.money(0), "$0.00");
  assert.equal(f.money(-0), "$0.00");
  assert.equal(f.money(NaN), "$0.00");
});

test("cost text says No cost data rather than $0.00 when nothing was reported", async () => {
  const f = await load("format.js");
  assert.equal(f.costText({ cost: 0, requests: 0 }), "No cost data");
  assert.equal(f.costText({}), "No cost data");
  assert.equal(f.costText({ cost: 0, requests: 3 }), "$0.00");
  assert.equal(f.costText({ cost: 2.05, requests: 0 }), "$2.05", "cost from OTel without a request count still shows");
});

test("middle and end truncation", async () => {
  const f = await load("format.js");
  assert.equal(f.middleTruncate("/Users/me/projects/clients/supermarket-pos", 32), "/Users/me/…/supermarket-pos");
  assert.equal(f.middleTruncate("/Users/me/projects/clients/supermarket-pos/", 32), "/Users/me/…/supermarket-pos");
  assert.equal(f.middleTruncate("C:\\Users\\PC\\Documents\\Munavver-Thinks\\agent-office-v1", 32), "C:\\Users\\PC\\…\\agent-office-v1");
  assert.equal(f.middleTruncate("/srv/docs", 32), "/srv/docs");
  assert.equal(f.middleTruncate("abcdefghijklmnopqrstuvwxyz", 11), "abcde…vwxyz");
  for (const s of ["/a/" + "x".repeat(50), "/home/you/" + "deep/".repeat(20) + "project", "x".repeat(80)]) {
    for (const max of [12, 20, 36]) {
      const out = f.middleTruncate(s, max);
      assert.ok(out.length <= max && out.includes("…"), `${out} fits ${max}`);
    }
  }
  assert.equal(f.endTruncate("npm run test -- --watch --coverage", 28), "npm run test -- --watch --c…");
  assert.equal(f.endTruncate("npm test", 28), "npm test");
  assert.equal(f.endTruncate(null), "");
});

test("initials, duration, wait time, clock and escaping", async () => {
  const f = await load("format.js");
  assert.equal(f.initials("refund flow"), "RF");
  assert.equal(f.initials("supermarket-pos · basket bill"), "BB");
  assert.equal(f.initials("supermarket-pos"), "SP");
  assert.equal(f.initials("docs"), "DO");
  assert.equal(f.initials("élan vital"), "ÉV");
  assert.equal(f.initials(""), "?");
  assert.equal(f.initials(null), "?");
  assert.equal(f.duration(152 * M), "2h 32m");
  assert.equal(f.duration(60 * M), "1h");
  assert.equal(f.duration(45000), "45s");
  assert.equal(f.duration(26 * 60 * M), "1d 2h");
  assert.equal(f.duration(-5), "0s");
  assert.equal(f.waitTime(9 * M + 59000), "9m");
  assert.equal(f.waitTime(30000), "<1m");
  assert.equal(f.waitTime(65 * M), "1h 5m");
  assert.equal(f.clock(new Date(2026, 9, 16, 15, 40)), "15:40");
  assert.equal(f.clock(new Date(2026, 0, 1, 9, 5).getTime()), "09:05");
  assert.equal(f.clock("not a date"), "");
  assert.equal(f.clock(null), "");
  assert.equal(f.esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});

// ---------- tokens ----------
function parseTokens(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out = {};
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const vars = (out[sel.trim()] ||= {});
    for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+)/g)) vars[name] = value.trim();
  }
  return out;
}
function rgba(c) {
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) { const [r, g, b, a = 1] = m[1].split(",").map(Number); return [r, g, b, a]; }
  throw new Error(`Unknown colour ${c}`);
}
/** Paints translucent layers over an opaque base, bottom first. */
const paint = (base, ...layers) => layers.reduce((b, t) => [0, 1, 2].map((i) => t[i] * t[3] + b[i] * (1 - t[3])).concat(1), base);
function luminance([r, g, b]) {
  const lin = (v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const TOKENS = parseTokens(fs.readFileSync(path.join(UI, "tokens.css"), "utf8"));
const THEMES = ["dark", "light"];
const SPEC = ["bg", "bg-2", "glass", "glass-2", "line", "line-2", "hover", "text", "text-2", "text-3", "teal", "teal-t", "teal-s", "teal-btn", "on-teal",
  "amber", "amber-t", "amber-s", "amber-b", "on-amber", "red", "red-t", "red-s", "idle", "off", "code"];

/** Checks [label, fg, bg] pairs and lists every one under `min`, so a failure shows all ratios at once. */
function lowPairs(pairs, min) {
  return pairs.filter(([, fg, bg]) => ratio(fg, bg) < min).map(([label, fg, bg]) => `${label} = ${ratio(fg, bg).toFixed(2)}:1`);
}

test("tokens: both themes define every spec token and the same set", () => {
  const dark = TOKENS[".ao-dark"], light = TOKENS[".ao-light"];
  for (const name of SPEC) { assert.ok(dark[name], `dark --${name}`); assert.ok(light[name], `light --${name}`); }
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
});

test("tokens: text keeps 4.5:1 contrast in both themes", () => {
  const pairs = [];
  for (const theme of THEMES) {
    const c = (n) => rgba(TOKENS[`.ao-${theme}`][n]);
    for (const fg of ["text", "text-2", "text-3"]) for (const bg of ["bg", "bg-2"]) pairs.push([`${theme} --${fg} on --${bg}`, c(fg), c(bg)]);
    pairs.push([`${theme} --on-amber on --amber`, c("on-amber"), c("amber")]);
    pairs.push([`${theme} --on-teal on --teal-btn`, c("on-teal"), c("teal-btn")]);
  }
  assert.deepEqual(lowPairs(pairs, 4.5), []);
});

test("tokens: component text keeps 4.5:1 on the surfaces it is drawn on", () => {
  const pairs = [];
  for (const theme of THEMES) {
    const c = (n) => rgba(TOKENS[`.ao-${theme}`][n]);
    const glass = paint(c("bg"), c("glass")), base = c("bg-2");
    for (const fg of ["text", "text-2", "text-3"]) pairs.push([`${theme} --${fg} on a glass panel`, c(fg), glass]);
    pairs.push([`${theme} working pill`, c("teal-t"), paint(base, c("teal-s"))]);
    pairs.push([`${theme} needs pill`, c("amber-t"), paint(base, c("amber-s"))]);
    pairs.push([`${theme} idle pill`, c("idle"), paint(base, c("hover"))]);
    pairs.push([`${theme} offline pill`, c("off"), base]);
    pairs.push([`${theme} error state text`, c("text"), paint(glass, c("red-s"))]);
    pairs.push([`${theme} over-budget text`, c("red-t"), glass]);
    pairs.push([`${theme} code box`, c("text"), c("code")]);
    pairs.push([`${theme} ghost button`, c("text-2"), glass]);
    pairs.push([`${theme} copied label`, c("teal-t"), paint(glass, c("hover"))]);
  }
  const root = TOKENS[":root"];
  for (let i = 1; i <= 6; i++) pairs.push([`avatar initials on --proj-${i}`, rgba(root["on-proj"]), rgba(root[`proj-${i}`])]);
  assert.deepEqual(lowPairs(pairs, 4.5), []);
});

test("tokens: the teal focus ring keeps 3:1 against the page", () => {
  const pairs = [];
  for (const theme of THEMES) {
    const c = (n) => rgba(TOKENS[`.ao-${theme}`][n]);
    for (const bg of ["bg", "bg-2"]) pairs.push([`${theme} --teal-t ring on --${bg}`, c("teal-t"), c(bg)]);
  }
  assert.deepEqual(lowPairs(pairs, 3), []);
});

test("tokens: project colours match components.js and avoid amber, orange and red", async () => {
  const { PROJECT_COLORS } = await load("components.js");
  const root = TOKENS[":root"];
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((i) => root[`proj-${i}`].toUpperCase()), PROJECT_COLORS);
  for (const hex of PROJECT_COLORS) {
    const [r, g, b] = rgba(hex).map((v) => v / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    const hue = d === 0 ? 0 : max === r ? (60 * ((g - b) / d) + 360) % 360 : max === g ? 60 * ((b - r) / d) + 120 : 60 * ((r - g) / d) + 240;
    assert.ok(d < 0.15 || (hue > 60 && hue < 330), `${hex} hue ${Math.round(hue)} is in the red-orange-amber range`);
  }
});

test("tokens: touch targets grow to 44px and reduced motion stops animation", () => {
  const css = fs.readFileSync(path.join(UI, "tokens.css"), "utf8");
  assert.match(css, /@media \(pointer: coarse\)\s*\{\s*:root\s*\{[^}]*--h-btn:\s*44px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation:\s*none/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
});

// ---------- components ----------
test("state pills pair an icon with a label, and the store's waiting state maps to Needs you", async () => {
  const ui = await load("components.js");
  for (const [s, label] of [["working", "Working"], ["needs", "Needs you"], ["waiting", "Needs you"], ["idle", "Idle"], ["offline", "Offline"]]) {
    const h = ui.statePill(s);
    assert.match(h, /<svg[^>]*aria-hidden="true"/);
    assert.ok(h.includes(`>${label}<`), `${s} → ${label}`);
  }
  assert.ok(ui.statePill("offline").includes("ao-pill--offline"));
  assert.ok(ui.statePill("waiting", { waitMs: 9 * M }).includes(">Needs you · 9m<"));
  assert.ok(ui.statePill("working", { waitMs: 9 * M }).includes(">Working<"));
  assert.ok(ui.waitPill(4 * M).includes(">waiting 4m<"));
});

test("chips, segmented controls and buttons use real buttons with the right ARIA", async () => {
  const ui = await load("components.js");
  const chip = ui.filterChip({ label: "Errors only", value: "errors" });
  assert.match(chip, /^<button type="button" class="ao-chip" aria-pressed="false" data-chip="errors"/);
  assert.ok(ui.filterChip({ label: "x", pressed: true }).includes('aria-pressed="true"'));
  const sc = ui.stateChip("waiting", 2);
  assert.ok(sc.includes('data-chip="needs"') && sc.includes("ao-tone-needs") && sc.includes(">2<"));

  const seg = ui.segmented({ label: "Range", value: "7d", options: ["Today", "7d", "30d"].map((v) => ({ value: v, label: v })) });
  assert.match(seg, /role="radiogroup" aria-label="Range"/);
  assert.equal(seg.match(/role="radio"/g).length, 3);
  assert.equal(seg.match(/aria-checked="true"/g).length, 1);
  assert.match(seg, /aria-checked="true" tabindex="0" data-value="7d"/);
  const none = ui.segmented({ label: "Range", value: "nope", options: ["a", "b"] });
  assert.ok(!none.includes('aria-checked="true"'));
  assert.match(none, /tabindex="0" data-value="a"/);
  const dots = ui.segmented({ label: "Room", value: "", options: [{ value: "", label: "All rooms" }, { value: "shop", label: "shop", dot: 7 }] });
  assert.match(dots, /data-value="shop"><span class="ao-seg-dot" style="--av:var\(--proj-2\)" aria-hidden="true"><\/span>shop<\/button>/, "a project colour dot, decorative");
  assert.ok(!/data-value="">[^<]*<span class="ao-seg-dot"/.test(dots), "only where asked for");

  const ans = ui.answerButton({ agent: "refund flow" });
  assert.ok(ans.includes("ao-btn--answer") && ans.includes(">Answer<") && ans.includes('aria-label="Answer refund flow"'));
  const sneaky = ui.button({ label: "Go", variant: "answer" });
  assert.ok(!sneaky.includes("ao-btn--answer") && sneaky.includes("ao-btn--secondary"), "amber is only reachable through answerButton");
  assert.match(ui.iconButton({ icon: "settings", label: "Settings" }), /aria-label="Settings"/);
  assert.match(ui.button({ label: "Save", variant: "primary", attrs: { class: "wide", disabled: true } }), /class="ao-btn ao-btn--primary wide" disabled/);
});

test("progress bar, budget ring, path chip, code box and avatar", async () => {
  const ui = await load("components.js");
  const bar = ui.progressBar({ done: 26, doing: 7, total: 50 });
  assert.ok(bar.includes('role="img" aria-label="26 of 50 done, 7 in progress"'));
  assert.ok(bar.includes("width:52.00%") && bar.includes("width:14.00%"));
  assert.ok(ui.progressBar({}).includes("No planned tasks"));
  assert.ok(ui.progressBar({ done: 5, total: 2 }).includes("width:100.00%"));

  const ring = ui.budgetRing({ spent: 13.72, budget: 25 });
  assert.ok(!ring.includes("is-over") && ring.includes(">$13.72<") && ring.includes("55% of $25 today"));
  assert.ok(!ui.budgetRing({ spent: 25, budget: 25 }).includes("is-over"));
  const over = ui.budgetRing({ spent: 28.1, budget: 25 });
  assert.ok(over.includes("is-over") && over.includes("Over budget · 112% of $25 today"));
  const noBudget = ui.budgetRing({ spent: 1, budget: 0 });
  assert.ok(noBudget.includes("No budget set") && !noBudget.includes("ao-ring-bar"));

  const chip = ui.pathChip("/Users/me/projects/clients/supermarket-pos", { max: 32 });
  assert.ok(chip.includes('data-copy="/Users/me/projects/clients/supermarket-pos"'));
  assert.ok(chip.includes(">/Users/me/…/supermarket-pos<") && chip.includes("Copied"));

  assert.ok(!ui.codeBox(".env.production").includes("data-expand"));
  const long = ui.codeBox("echo <script>" + " x".repeat(40));
  assert.ok(long.includes('data-expand aria-expanded="false"') && long.includes("&lt;script&gt;") && !long.includes("<script>"));

  const av = ui.avatar({ name: "refund flow", color: 1 });
  assert.ok(av.includes("--av:var(--proj-2)") && av.includes('role="img" aria-label="refund flow"') && av.includes(">RF<"));
  assert.ok(!ui.avatar({ name: "<img src=x onerror=alert(1)>" }).includes("<img"));
  assert.ok(ui.avatar({ name: "a b", decorative: true }).includes('aria-hidden="true"'));
  assert.ok(ui.avatar({ name: "a b", color: "#a3e635" }).includes("--proj-3"));
  assert.equal(ui.projectColor("checkout-api"), ui.projectColor("checkout-api"));
  for (const k of ["a", "supermarket-pos", "docs-site", ""]) assert.ok(ui.projectColor(k) >= 0 && ui.projectColor(k) < 6);
});

test("panels have empty, loading, error and stale states", async () => {
  const ui = await load("components.js");
  const p = ui.panel({ id: "live", title: "Live activity", meta: "Newest first", body: "<i>rows</i>" });
  assert.ok(p.includes('aria-labelledby="live-title"') && p.includes('id="live-title"') && p.includes("<i>rows</i>"));
  assert.ok(ui.panel({ title: "Live", busy: true }).includes('aria-busy="true"'));
  const stale = ui.panel({ title: "Live", stale: new Date(2026, 9, 16, 15, 40), body: "x" });
  assert.ok(stale.includes("ao-stale") && stale.includes("As of 15:40"));
  const empty = ui.emptyState({ text: "Nobody is waiting on you.", ok: true, action: { label: "Add" } });
  assert.ok(empty.includes("<svg") && empty.includes("Nobody is waiting on you.") && empty.includes("is-ok") && empty.includes(">Add<"));
  const err = ui.errorState({ text: "Couldn't load.", action: { label: "Retry" } });
  assert.ok(err.includes('role="alert"') && err.includes("Couldn&#39;t load.") && err.includes(">Retry<"));
  const loading = ui.loadingState();
  assert.ok(loading.includes("Loading…"));
  assert.equal(loading.match(/ao-skel-row/g).length, 3);
});

test("hover card goes above, flips below near the top, and stays 8px inside the bounds", async () => {
  const { placeHover } = await load("components.js");
  const bounds = { left: 0, top: 0, right: 800, bottom: 600 }, card = { width: 280, height: 120 };
  const at = (left, top) => ({ left, right: left + 40, top, bottom: top + 20 });
  assert.deepEqual(placeHover(at(380, 300), card, bounds), { placement: "top", top: 172, left: 260 });
  assert.deepEqual(placeHover(at(380, 50), card, bounds), { placement: "bottom", top: 78, left: 260 });
  assert.equal(placeHover(at(760, 300), card, bounds).left, 800 - 8 - 280);
  assert.equal(placeHover(at(0, 300), card, bounds).left, 8);
  const offset = { left: 100, top: 200, right: 500, bottom: 500 };
  assert.deepEqual(placeHover(at(110, 210), card, offset), { placement: "bottom", top: 238, left: 108 });
  for (let x = -50; x <= 850; x += 50) for (let y = -50; y <= 650; y += 50) {
    const p = placeHover(at(x, y), card, bounds);
    assert.ok(p.left >= 8 && p.left + card.width <= 792 && p.top >= 8 && p.top + card.height <= 592, `anchor ${x},${y}`);
  }
});

test("hover card: when neither side fits it stays on the roomier side, or moves beside the anchor", async () => {
  const { placeHover } = await load("components.js");
  const at = (left, top) => ({ left, right: left + 40, top, bottom: top + 20 });
  const overlaps = (p, a, c) => p.left < a.right && p.left + c.width > a.left && p.top < a.bottom && p.top + c.height > a.top;
  // Below has less room than above: stay above (it used to flip below and cover the anchor).
  const tall = { width: 280, height: 200 }, narrow = { left: 0, top: 0, right: 300, bottom: 300 };
  assert.equal(placeHover(at(130, 150), tall, narrow).placement, "top");
  // Neither side fits and there is no room beside: the roomier side, clamped inside.
  const p = placeHover(at(130, 10), { width: 280, height: 120 }, { left: 0, top: 0, right: 300, bottom: 150 });
  assert.deepEqual(p, { placement: "bottom", top: 22, left: 10 });
  // Neither side fits but there is room beside: never covers the anchor.
  const card = { width: 280, height: 120 }, short = { left: 0, top: 0, right: 800, bottom: 150 };
  for (const x of [8, 200, 380, 600, 752]) {
    const a = at(x, 10), q = placeHover(a, card, short);
    assert.ok(["left", "right"].includes(q.placement) && !overlaps(q, a, card), `anchor at ${x}: ${JSON.stringify(q)}`);
    assert.ok(q.left >= 8 && q.left + card.width <= 792 && q.top >= 8 && q.top + card.height <= 142);
  }
});

test("icons: every icon later modules need exists and is hidden from screen readers by default", async () => {
  const { icon } = await load("icons.js");
  const names = ["pulse", "hand", "coffee", "power", "terminal", "file", "file-edit", "search", "globe", "sub-agent", "check", "x", "clock",
    "plan", "copy", "sun", "moon", "settings", "bell", "office", "board", "meeting", "chart", "alert", "chevron"];
  for (const n of names) {
    const svg = icon(n);
    assert.ok(svg.startsWith("<svg") && svg.includes('aria-hidden="true"') && svg.includes('stroke="currentColor"'), n);
  }
  assert.match(icon("check", { label: "Done" }), /role="img" aria-label="Done"/);
  assert.equal(icon("nope"), "");
});

test("theme: system follows the OS, and a blocked storage falls back to dark", async () => {
  const t = await load("theme.js");
  assert.equal(t.resolveTheme("dark", true), "dark");
  assert.equal(t.resolveTheme("light", false), "light");
  assert.equal(t.resolveTheme("system", true), "light");
  assert.equal(t.resolveTheme("system", false), "dark");
  assert.equal(t.resolveTheme("bogus", true), "dark");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  try { assert.equal(t.themePref(), "dark"); } finally { delete globalThis.localStorage; }
});

// ---------- hover card behaviour (bind) ----------
/** Just enough DOM for bind(): a tree of elements with attributes, classes, boxes and event listeners. */
function fakeDom() {
  const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  class El {
    constructor(attrs = {}, parent = null) {
      Object.assign(this, { attrs, parent, hidden: false, style: {}, dataset: {}, offsetWidth: 200, offsetHeight: 80, offsetParent: null, id: attrs.id, handlers: {} });
      for (const [k, v] of Object.entries(attrs)) if (k.startsWith("data-")) this.dataset[camel(k.slice(5))] = v;
    }
    matches(sel) {
      return sel.split(",").some((s) => {
        s = s.trim();
        const m = /^\[([\w-]+)\]$/.exec(s);
        return m ? m[1] in this.attrs : s.startsWith(".") && String(this.attrs.class || "").split(" ").includes(s.slice(1));
      });
    }
    closest(sel) { for (let e = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
    contains(el) { for (let e = el; e; e = e.parent) if (e === this) return true; return false; }
    getBoundingClientRect() { return { left: 300, top: 300, right: 340, bottom: 340, width: 40, height: 40 }; }
    addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
    removeEventListener(t, fn) { this.handlers[t] = (this.handlers[t] || []).filter((f) => f !== fn); }
    fire(t, e) { for (const fn of this.handlers[t] || []) fn({ preventDefault() {}, ...e }); }
  }
  const doc = new El();
  const root = new El({}, null);
  root.ownerDocument = doc;
  const make = (attrs) => new El(attrs, root);
  const els = { a: make({ "data-hovercard": "ca" }), b: make({ "data-hovercard": "cb" }), ca: make({ id: "ca" }), cb: make({ id: "cb" }) };
  els.ca.hidden = els.cb.hidden = true;
  doc.getElementById = (id) => els[id] || null;
  doc.activeElement = null;
  return { doc, root, ...els };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("hover card: Esc dismisses the focused anchor's card, and hovering another anchor doesn't bring it back", async () => {
  const ui = await load("components.js");
  const saved = globalThis.document;
  globalThis.document = { documentElement: { clientWidth: 1000, clientHeight: 800 } };
  const { doc, root, a, b, ca, cb } = fakeDom();
  const unbind = ui.bind(root);
  try {
    doc.activeElement = a;
    root.fire("focusin", { target: a });
    assert.equal(ca.hidden, false, "focus opens the card");
    root.fire("keydown", { key: "Escape", target: a });
    assert.equal(ca.hidden, true, "Esc closes it");
    root.fire("pointerover", { target: b });
    assert.equal(cb.hidden, false, "hovering another anchor shows its card");
    root.fire("pointerout", { target: b, relatedTarget: root });
    await wait(200);
    assert.equal(cb.hidden, true, "leaving hides it");
    assert.equal(ca.hidden, true, "the dismissed card stays dismissed");
    // Moving focus ends the dismissal: the newly focused anchor's card comes back after a hover elsewhere.
    doc.activeElement = b;
    root.fire("focusin", { target: b });
    root.fire("pointerover", { target: a });
    assert.equal(ca.hidden, false);
    root.fire("pointerout", { target: a, relatedTarget: root });
    await wait(200);
    assert.equal(ca.hidden, true);
    assert.equal(cb.hidden, false, "a focused anchor gets its card back");
    // Hovering the dismissed anchor itself opens its card again.
    root.fire("keydown", { key: "Escape", target: b });
    assert.equal(cb.hidden, true);
    root.fire("pointerover", { target: b });
    assert.equal(cb.hidden, false);
  } finally {
    unbind();
    globalThis.document = saved;
  }
});

test("toast: amber only for needs-you, escaped text, actions kept; panel badge sits after the title", async () => {
  const ui = await load("components.js");
  const needs = ui.toast({ tone: "needs", title: "receipt printer needs you", text: "Wants permission to run a command", actions: ui.answerButton({ agent: "receipt printer" }), attrs: { "data-toast": "k" } });
  assert.ok(needs.includes("ao-toast--needs") && needs.includes('data-toast="k"') && needs.includes(">Answer<") && needs.includes('title="Wants permission to run a command"'));
  const info = ui.toast({ tone: "anything", title: "<img src=x onerror=alert(1)>" });
  assert.ok(info.includes("ao-toast--info") && !info.includes("ao-toast--needs") && !info.includes("<img"), "unknown tones are neutral, text escaped");
  assert.match(ui.panel({ id: "n", title: "Needs you now", badge: "<b>2</b>" }), /<h2 class="ao-panel-title" id="n-title">Needs you now<\/h2><b>2<\/b>/);
  const { icon } = await load("icons.js");
  for (const n of ["half", "circle", "locate", "user"]) assert.ok(icon(n).startsWith("<svg"), n);
});

// ---------- live re-renders (patch.js) ----------
test("patch keeps every panel's scroll by position, and a marked box's scroll by its text", async () => {
  const { fakeDom } = require("./helpers/dom");
  const { createPatch } = await load("patch.js");
  const dom = fakeDom(), doc = dom.document, patch = createPatch(doc), el = doc.createElement("div");
  doc.body.append(el);
  const col = (n, extra = "") => `<section class="ao-panel"><div class="ao-panel-body"><p>${n}</p>${extra}</div></section>`;
  const pre = (text) => `<pre class="ad-pre" data-keep-scroll>${text}</pre>`;
  patch(el, col("a", pre("npm test output")) + col("b") + col("c", pre("diff")));
  const bodies = () => el.querySelectorAll(".ao-panel-body"), boxes = () => el.querySelectorAll("[data-keep-scroll]");
  bodies().forEach((b, i) => { b.scrollTop = [0, 120, 340][i]; });
  boxes()[0].scrollTop = 55;
  boxes()[1].scrollLeft = 30;
  // A live update: new markup for every column, a new box at the top of the first.
  patch(el, col("a2", pre("new step output") + pre("npm test output")) + col("b2") + col("c2", pre("diff")));
  assert.deepEqual(bodies().map((b) => b.scrollTop || 0), [0, 120, 340], "the second and third columns keep their place too");
  const [fresh, kept, diff] = boxes();
  assert.equal(fresh.scrollTop, undefined, "a new box starts at the top");
  assert.deepEqual([kept.scrollTop, diff.scrollLeft], [55, 30], "a box keeps its scroll by its text, wherever it moved");
  patch(el, col("a3"));
  assert.equal(bodies()[0].scrollTop, undefined, "nothing was scrolled at this position: left alone");
});
