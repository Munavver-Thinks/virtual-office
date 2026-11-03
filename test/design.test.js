"use strict";
// Design rules across every screen (M12, the final review): the colour rules read straight from the stylesheets, stale
// and offline states that never fade text, long names that wrap or end in an ellipsis instead of widening a page, 44px
// touch targets, and the sign-in page saying what failed.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), vm = require("vm");

const PUBLIC = path.join(__dirname, "..", "public");
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), "utf8");

/** Every stylesheet the app ships, and the <style> blocks of its pages, except the token definitions themselves. */
function sheets() {
  const out = [];
  for (const dir of ["", "ui"]) {
    for (const f of fs.readdirSync(path.join(PUBLIC, dir))) {
      const rel = path.join(dir, f);
      if (f.endsWith(".css") && f !== "tokens.css") out.push([rel, read(rel)]);
      if (f.endsWith(".html")) for (const m of read(rel).matchAll(/<style>([\s\S]*?)<\/style>/g)) out.push([rel, m[1]]);
    }
  }
  return out;
}

/** A selector list split at its top-level commas (not the ones inside :is(…) or :not(…)). */
function selectors(list) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && !depth) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  return [...out, cur.trim()].filter(Boolean);
}

/** [file, selector, declarations] for every rule, including those inside @media blocks. */
function rules() {
  const out = [];
  for (const [file, css] of sheets()) {
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const sel of selectors(m[1].trim())) out.push([file, sel, m[2]]);
    }
  }
  return out;
}

// Amber means an agent needs you; red means an error or spend over budget. A selector that paints either must say so:
// with a whole modifier or state class (.x--needs, .is-needs, .x--wait: a wait on you), or by being one of the classes
// listed, each drawn only for that meaning (the Answer button, the Alerts badge, the needs-you card, the agent's question
// bubble, the office's spotlight sign...). A class that merely contains the word (.al-await, .cc-answer-err) is caught.
const AMBER = /var\(--(?:amber|on-amber)/, RED = /var\(--red/;
const AMBER_OK = new RegExp([
  String.raw`(?:--|\.is-)(?:needs|wait)(?![\w-])`,
  String.raw`^\.(?:ao-tone-needs|ao-btn--answer(?::hover)?|cc-answer|cc-badge|cc-needs-card|cc-bubble--agent(?: \.cc-dlg-q > \.ao-icon)?|g-needs|mh-needs|mh-dec\.is-open|mh-dec-q \.ao-icon|o3-sign\.is-on(?: > \.ao-icon)?|wb-tag)$`,
].join("|"));
const RED_OK = new RegExp([
  String.raw`(?:--|\.is-)(?:error|failing|failed|over)(?![\w-])`,
  String.raw`^\.(?:al-form-err|cc-act-fail|cc-answer-err|cc-day-err > \.ao-icon|cc-step-err > \.ao-icon|login \.err|st-err)$`,
].join("|"));

test("colour rules: amber only on needs-you selectors, red only on error and over-budget ones, in every stylesheet", () => {
  const all = rules();
  assert.ok(all.length > 500, "the stylesheets were read");
  const bad = [];
  for (const [file, sel, body] of all) {
    if (AMBER.test(body) && !AMBER_OK.test(sel)) bad.push(`amber in ${file}: ${sel}`);
    if (RED.test(body) && !RED_OK.test(sel)) bad.push(`red in ${file}: ${sel}`);
  }
  assert.deepEqual(bad, []);
});

test("colour rules: the checks themselves catch a class that only contains a needs-you or error word", () => {
  for (const sel of [".al-await", ".cc-answer-err", ".cc-answered", ".cc-answer .x", ".wb-tag-over", ".x--needsy", ".x-needs", ".is-needs-more",
    ".cr-bar.is-over", ".st-pill--retry", ".o3-sign", ".mh-dec", ".cc-badge-x"]) assert.ok(!AMBER_OK.test(sel), `amber: ${sel}`);
  for (const sel of [".terror", ".errand", ".err", ".x-err", ".cc-answer-errand", ".st-err-x", ".cr-bar.is-overlay", ".x--overflow", ".failsafe",
    ".cc-nav-link:hover", ".ao-pill--idle", ".x-fail", ".is-failure"]) assert.ok(!RED_OK.test(sel), `red: ${sel}`);
  for (const sel of [".ao-pill--needs", ".al-status.is-needs", ".ad-gap--wait > .ao-icon", ".ao-btn--answer:hover", ".cc-answer", ".wb-tag"]) assert.ok(AMBER_OK.test(sel), sel);
  for (const sel of [".ao-state--error", ".al-pill--over", ".cc-feed-acts li.is-failed > .ao-icon", ".cc-answer-err", ".login .err"]) assert.ok(RED_OK.test(sel), sel);
});

// ---------- literal colours ----------
/** [r, g, b] of a literal colour: #rgb, #rgba, #rrggbb, #rrggbbaa (also URL-encoded, %23), rgb() and rgba(). */
function literals(text) {
  const out = [];
  for (const m of text.matchAll(/(?:#|%23)([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) {
    const h = m[1] && (m[1].length < 6 ? [...m[1]].map((c) => c + c).join("") : m[1]);
    out.push({ text: m[0], rgb: h ? [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) : [m[2], m[3], m[4]].map(Number) });
  }
  return out;
}
/** Red, orange or amber to the eye: a saturated colour with a hue from about 330° round to 60°. */
function warm([r, g, b]) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2, d = max - min;
  if (!d) return false;
  const s = d / (1 - Math.abs(2 * l - 1)), [R, G, B] = [r, g, b].map((x) => x / 255);
  const h = (max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4) * 60;
  return s > 0.3 && l > 0.12 && l < 0.92 && (h < 60 || h > 330);
}
/** The amber and red token values of both themes, as "r,g,b". */
const tokenRgb = () => [...read(path.join("ui", "tokens.css")).matchAll(/--(?:amber|on-amber|red)[\w-]*:\s*([^;]+);/g)].map((m) => literals(m[1])[0].rgb.join());
/** Every file the browser loads from public/: [file, text]. */
function publicFiles(dir = "") {
  return fs.readdirSync(path.join(PUBLIC, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = path.join(dir, d.name);
    return d.isDirectory() ? publicFiles(rel) : /\.(?:css|html|js)$/.test(d.name) ? [[rel, read(rel)]] : [];
  });
}

test("colour rules: no literal amber or red outside the tokens, so nothing gets round the selector checks", () => {
  const tokens = new Set(tokenRgb());
  assert.equal(tokens.size, 10, "--amber, --amber-t, -s, -b, --on-amber, --red, --red-t and -s of both themes: 10 colours (some share one)");
  // The office draws its scene in SVG with its own palette: its amber is the token's, theme by theme, and only there.
  const office = read("office3d-draw.js"), pal = [...office.matchAll(/^\s+teal: "#\w+", amber: "(#\w+)"/gm)].map((m) => m[1].toLowerCase());
  const amber = [...read(path.join("ui", "tokens.css")).matchAll(/--amber: (#\w+);/g)].map((m) => m[1].toLowerCase());
  assert.deepEqual(pal, amber, "dark, then light");
  const bad = [];
  for (const [file, text] of publicFiles()) {
    if (file === path.join("ui", "tokens.css")) continue;
    const t = file === "office3d-draw.js" ? text.replace(/(teal: "#\w+", )amber: "#\w+"/g, "$1") : text;
    for (const c of literals(t)) if (tokens.has(c.rgb.join())) bad.push(`${file}: ${c.text}`);
  }
  // Stylesheets: no warm literal at all, a token's value or not (the office's skin and hair live in its script).
  for (const [file, , body] of rules()) for (const c of literals(body.replace(/url\([^)]*\)/g, ""))) if (warm(c.rgb)) bad.push(`${file}: ${c.text}`);
  assert.deepEqual(bad, []);
  // The checks themselves: these would be caught.
  assert.deepEqual(literals("a { color: #FBBF24; b: rgba(248, 113, 113, .2); c: #f87; fill: %23DC2626 }").map((c) => tokens.has(c.rgb.join())), [true, true, false, true]);
  assert.deepEqual(["#EF4444", "#F97316", "#F59E0B", "rgba(220,38,38,.1)", "#8A3B07"].map((x) => warm(literals(x)[0].rgb)), [true, true, true, true, true]);
  assert.deepEqual(["#2DD4BF", "#A78BFA", "#F0ABFC", "rgba(0,0,0,.3)", "#0A1120", "#FFFFFF", "#2A1A00"].map((x) => warm(literals(x)[0].rgb)), [false, false, false, false, false, false, false]);
});

test("stale, offline and error states dim graphics, never text: no opacity on what holds words", () => {
  const FADED = /is-stale|is-off\b|is-offline|is-error|ao-stale/, GRAPHIC = /(?:> svg|\.cc-ribbon)$/;
  const bad = [];
  for (const [file, sel, body] of rules()) {
    const m = /(?:^|;)\s*opacity\s*:\s*([\d.]+)/.exec(body);
    if (m && Number(m[1]) < 1 && FADED.test(sel) && !GRAPHIC.test(sel)) bad.push(`${file}: ${sel} { opacity: ${m[1]} }`);
  }
  assert.deepEqual(bad, [], "fade text and it drops under 4.5:1; use the .ao-stale way (grayscale, a step down in colour)");
  const office = read("office3d.css");
  assert.match(office, /\.o3\.is-stale \.o3-world > svg, \.o3\.is-error \.o3-world > svg \{ opacity: \.55; \}/, "the office scene still dims");
  assert.match(office, /\.o3:is\(\.is-stale, \.is-error\) :is\(span\.o3-lbl, \.o3-lbl > \*, \.o3-tag, \.o3-itag\) \{ filter: grayscale\(1\); \}/,
    "its tags lose their colour instead; buttons and links aren't filtered, so their focus ring stays teal");
  assert.doesNotMatch(office, /is-(?:stale|error)[^{]*:is\([^)]*\.o3-agents/, "not the agents list: its buttons' rings would go gray");
  assert.match(read("hall.css"), /\.mh-seat\.is-off \{ border-style: dashed; border-color: var\(--off\); color: var\(--text-2\); \}/, "an offline seat is gray and dashed");
});

/** WCAG contrast of two "#rrggbb" colours. */
function contrast(a, b) {
  const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("stale panels: what holds no control goes gray, never a control or what holds one, so focus rings stay teal; text keeps 4.5:1", () => {
  const css = rules(), F = /FOCUSABLE = "([^"]+)"/.exec(read(path.join("ui", "patch.js")))[1], flat = (s) => s.replace(/\s+/g, " ");
  const filters = css.filter(([, s, b]) => /ao-stale/.test(s) && /filter\s*:/.test(b)).map(([f, s, b]) => [f, flat(s), b.trim()]);
  assert.deepEqual(filters, [[path.join("ui", "components.css"), `:is(.ao-stale, .ao-stale :is(${F}, :has(${F}))) > :not(${F}, :has(${F}))`, "filter: grayscale(1);"]],
    "children of the panel, or of a control or anything around one, that neither are nor hold a control: never the panel itself");
  assert.deepEqual(F.split(", "), ["a[href]", "button", "input", "select", "textarea", "summary", "[tabindex]"], "every control: Retry, Ping, Copy, Answer, links, fields, scroll boxes");
  assert.equal(css.find(([f, s]) => f === path.join("ui", "components.css") && s === ".ao-stale")[2].trim(), "color: var(--text-2); --text: var(--text-2);");
  // The top bar's chips (buttons) go gray the same way when the stream stops: shell.js marks them .ao-stale.
  assert.ok(!css.some(([, s, b]) => /cc-(?:chips|spend)/.test(s) && /filter\s*:/.test(b)), "no filter of its own on the chips");
  // Text in a stale panel steps down to --text-2: still 4.5:1 on the page and on a panel, in both themes.
  const tokens = read(path.join("ui", "tokens.css"));
  for (const theme of ["ao-dark", "ao-light"]) {
    const block = new RegExp(`\\.${theme} \\{([^}]*)\\}`).exec(tokens)[1], v = (k) => new RegExp(`--${k}: (#\\w{6});`).exec(block)[1];
    for (const bg of ["bg", "bg-2"]) assert.ok(contrast(v("text-2"), v(bg)) >= 4.5, `${theme}: --text-2 on --${bg} is ${contrast(v("text-2"), v(bg)).toFixed(2)}:1`);
  }
});

test("long names and lines wrap or end in an ellipsis instead of widening the page", () => {
  const rule = (file, sel) => rules().filter(([f, s]) => f === file && s === sel).map(([, , b]) => b).join(";");
  const has = (file, sel, decl) => assert.match(rule(file, sel), decl, `${file} ${sel}`);
  // A slot in Settings may shrink, so the machines table scrolls in its own box.
  has("settings.css", ".st-pane > *", /min-width:\s*0/);
  // The Meeting Hall: who overlaps, a bubble's name and its delivery lines break anywhere.
  has("hall.css", ".mh-ov-body > :not(.mh-ov-path)", /overflow-wrap:\s*anywhere/);
  has("hall.css", ".mh-b-name", /overflow-wrap:\s*anywhere/);
  has("hall.css", ".mh-line > span", /overflow-wrap:\s*anywhere/);
  // A toast's title, and the office hover card, where a cut-short name tag is read in full.
  has(path.join("ui", "components.css"), ".ao-toast-title", /overflow-wrap:\s*anywhere/);
  for (const sel of [".o3-card-name", ".o3-card-id > .ao-meta", ".o3-card-subrow > span"]) has("office3d.css", sel, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(rule("office3d.css", ".o3-card-subrow > span"), /nowrap/);
  // Phones: every other day's label under the cost chart, so they don't run together.
  assert.match(read("cost.css"), /@media \(max-width: 480px\) \{ \.cr-bar:nth-child\(even\):not\(\.is-today\) \.cr-bar-day \{ visibility: hidden; \} \}/);
});

test("focus rings: the rail's and the board's scroll boxes leave 4px inside on every side, so a ring is never cut", () => {
  const body = (file, sel) => rules().filter(([f, s]) => f === file && s === sel).map(([, , b]) => b).join(";");
  for (const [file, sel] of [["shell.css", ".cc-slot .ao-panel-body"], ["board.css", ".wb-col .ao-panel-body"]]) {
    const b = body(file, sel);
    assert.match(b, /overflow:\s*auto/, `${sel} scrolls`);
    assert.match(b, /margin:\s*-4px -6px;/, `${sel}: negative margin on all four sides (the last item's ring too)`);
    assert.match(b, /padding:\s*4px 6px;/, `${sel}: given back as padding`);
  }
});

test("touch screens: segmented options and the agent's name field grow to 44px", () => {
  assert.match(read(path.join("ui", "components.css")), /@media \(pointer: coarse\) \{ \.ao-seg-opt \{ min-height: var\(--h-btn\); min-width: var\(--h-btn\);/);
  assert.match(read("agent-detail.css"), /@media \(pointer: coarse\) \{[^}]*\}[^}]*\.ad-name-in \{ min-height: 44px; \}/);
});

// ---------- the sign-in page ----------
/** Runs login.html's script on a stub page. fetch is the stand-in for the network. */
function loginPage(fetchImpl) {
  const html = read("login.html"), script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const els = {}, page = { focused: null };
  const el = (id) => (els[id] ||= { id, textContent: "", value: "", disabled: false, listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; }, focus() { page.focused = id; } });
  const location = { href: "/login.html" };
  vm.runInNewContext(script, { document: { getElementById: el }, fetch: fetchImpl, location, JSON });
  return { input: el("token"), err: el("err"), button: el("go"), location, page, submit: () => el("f").listeners.submit({ preventDefault() {} }) };
}

test("sign in: says when the server can't be reached, passes on the server's own error, and goes in on success", async () => {
  const down = loginPage(() => Promise.reject(new TypeError("Failed to fetch")));
  down.input.value = "abc";
  await down.submit();
  assert.equal(down.err.textContent, "Couldn't reach the server. Check that it's running, then try again.", "not a silent dead button");
  assert.equal(down.location.href, "/login.html");

  const wrong = loginPage(async () => ({ ok: false, json: async () => ({ error: "That token isn't right." }) }));
  wrong.input.value = "abc";
  await wrong.submit();
  assert.equal(wrong.err.textContent, "That token isn't right.");

  const empty = loginPage(() => assert.fail("no request without a token"));
  await empty.submit();
  assert.equal(empty.err.textContent, "Enter the token first.");

  const ok = loginPage(async () => ({ ok: true }));
  ok.input.value = "abc";
  await ok.submit();
  assert.equal(ok.location.href, "/");
  // The hint and the error describe the field for screen readers.
  assert.match(read("login.html"), /<input[^>]*id="token"[^>]*aria-describedby="token-hint err"/);
  assert.match(read("login.html"), /<button class="ao-btn ao-btn--primary" type="submit" id="go">Sign in<\/button>/);
});

test("sign in: while it's out the button is off and says so, so a double click sends once; it comes back when sign-in fails", async () => {
  let reply = null;
  const calls = [], p = loginPage((...a) => { calls.push(a); return new Promise((r) => (reply = r)); });
  p.input.value = " abc ";
  const first = p.submit(), second = p.submit();
  assert.equal(calls.length, 1, "one request");
  assert.equal(JSON.parse(calls[0][1].body).token, "abc");
  assert.deepEqual([p.button.disabled, p.button.textContent], [true, "Signing in…"]);
  await second;
  reply({ ok: false, json: async () => ({ error: "That token isn't right. Run agent-office token on the server to see it." }) });
  await first;
  assert.deepEqual([p.button.disabled, p.button.textContent, p.err.textContent], [false, "Sign in", "That token isn't right. Run agent-office token on the server to see it."]);
  assert.equal(p.page.focused, "token", "back to the field to fix it");
  // Again, and the server can't be reached: the button comes back too.
  const down = loginPage(() => Promise.reject(new TypeError("Failed to fetch")));
  down.input.value = "abc";
  const sent = down.submit();
  assert.equal(down.button.disabled, true);
  await sent;
  assert.deepEqual([down.button.disabled, down.button.textContent], [false, "Sign in"]);
  // Going in: it stays off while the dashboard loads.
  const ok = loginPage(async () => ({ ok: true }));
  ok.input.value = "abc";
  await ok.submit();
  assert.deepEqual([ok.location.href, ok.button.disabled], ["/", true]);
});
