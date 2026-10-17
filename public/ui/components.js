// Base components: small functions that return HTML strings, plus bind(root) for behaviour.
// Text arguments are escaped. `body`, `tools` and hover-card `body` are trusted HTML built from these functions.
import { esc, money, middleTruncate, initials, clock, waitTime } from "./format.js";
import { icon } from "./icons.js";
import { setTheme, currentTheme, themePref } from "./theme.js";

const cx = (...names) => names.filter(Boolean).join(" ");

/** Renders attributes: null and false are skipped, true renders a bare attribute. */
export function attrs(o = {}) {
  let out = "";
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === false || !/^[a-z][\w:.-]*$/i.test(k)) continue;
    out += v === true ? ` ${k}` : ` ${k}="${esc(v)}"`;
  }
  return out;
}

// ---------- agent states: always icon + label, never colour alone ----------
export const STATES = {
  working: { label: "Working", icon: "pulse" },
  needs: { label: "Needs you", icon: "hand" },
  idle: { label: "Idle", icon: "coffee" },
  offline: { label: "Offline", icon: "power" },
};
/** The store says "waiting"; the design says "needs". */
export const stateKey = (s) => (s === "waiting" ? "needs" : Object.hasOwn(STATES, s) ? s : "idle");

export function statePill(state, { waitMs } = {}) {
  const k = stateKey(state), s = STATES[k];
  const text = k === "needs" && waitMs != null ? `${s.label} · ${waitTime(waitMs)}` : s.label;
  return `<span class="ao-pill ao-pill--${k}">${icon(s.icon, { size: 13 })}<span>${esc(text)}</span></span>`;
}

/** Amber "waiting 9m" pill for needs-you items. */
export function waitPill(waitMs) {
  return `<span class="ao-pill ao-pill--needs">${icon("clock", { size: 13 })}<span>waiting ${esc(waitTime(waitMs))}</span></span>`;
}

// ---------- glass panel and its four states ----------
export function panel({ title, icon: ic, meta, tools = "", body = "", stale, busy = false, id, level = 2, label, cls } = {}) {
  const isStale = stale != null && stale !== false;
  const hid = id && title ? `${id}-title` : null, h = `h${Math.min(6, Math.max(1, level | 0))}`;
  const end = (meta ? `<span>${esc(meta)}</span>` : "") + (isStale ? staleNote(stale) : "") + tools;
  const head = title
    ? `<header class="ao-panel-head">${ic ? icon(ic) : ""}<${h} class="ao-panel-title"${attrs({ id: hid })}>${esc(title)}</${h}>${end ? `<div class="ao-panel-end">${end}</div>` : ""}</header>`
    : isStale ? `<header class="ao-panel-head"><div class="ao-panel-end">${staleNote(stale)}</div></header>` : "";
  return `<section${attrs({ class: cx("ao-panel", cls), id, "aria-labelledby": hid, "aria-label": hid ? null : label || title, "aria-busy": busy ? "true" : null })}>${head}<div class="${cx("ao-panel-body", isStale && "ao-stale")}">${body}</div></section>`;
}

/** Empty: icon + one line + optional action ({ label, attrs }). ok = the good kind of empty (teal check). */
export function emptyState({ icon: ic = "check", text, action, ok = false } = {}) {
  return `<div class="${cx("ao-state ao-state--empty", ok && "is-ok")}"><span class="ao-state-icon">${icon(ic, { size: 20 })}</span><p>${esc(text)}</p>${action ? button({ size: "sm", ...action }) : ""}</div>`;
}

const SKEL = [[72, 46], [58, 38], [66, 52]];
/** Loading: skeleton rows shaped like a list (avatar + two lines), or plain lines with avatar: false. */
export function loadingState({ rows = 3, avatar: withAvatar = true, label = "Loading" } = {}) {
  const row = (i) => `<div class="ao-skel-row">${withAvatar ? '<span class="ao-skel ao-skel--avatar"></span>' : ""}<span class="ao-skel-lines"><span class="ao-skel" style="width:${SKEL[i % 3][0]}%"></span><span class="ao-skel ao-skel--sm" style="width:${SKEL[i % 3][1]}%"></span></span></div>`;
  return `<div class="ao-loading"><span class="ao-sr">${esc(label)}…</span><div aria-hidden="true">${Array.from({ length: Math.max(1, rows | 0) }, (_, i) => row(i)).join("")}</div></div>`;
}

/** Error: what failed + one action. The only place a panel uses red. */
export function errorState({ text, action } = {}) {
  return `<div class="ao-state ao-state--error" role="alert"><span class="ao-state-icon">${icon("alert", { size: 20 })}</span><p>${esc(text)}</p>${action ? button({ size: "sm", ...action }) : ""}</div>`;
}

/** "As of 15:40" for stale panels. panel({ stale }) adds it for you. */
export function staleNote(asOf) {
  const t = clock(asOf);
  return `<span class="ao-stale-note">${icon("clock", { size: 13 })}${t ? `As of ${esc(t)}` : "Not live"}</span>`;
}

// ---------- buttons ----------
const VARIANTS = new Set(["primary", "secondary", "ghost"]);

/** Primary (teal), secondary or ghost. The amber style is only available through answerButton(). */
export function button({ label, variant = "secondary", icon: ic, size, attrs: a = {}, type = "button" } = {}) {
  const { class: extra, ...rest } = a;
  const v = VARIANTS.has(variant) ? variant : "secondary";
  return `<button${attrs({ type, class: cx("ao-btn", `ao-btn--${v}`, size === "sm" && "ao-btn--sm", extra), ...rest })}>${ic ? icon(ic) : ""}<span>${esc(label)}</span></button>`;
}

export function iconButton({ icon: ic, label, variant = "ghost", size, attrs: a = {} } = {}) {
  const { class: extra, ...rest } = a;
  const v = VARIANTS.has(variant) ? variant : "ghost";
  return `<button${attrs({ type: "button", class: cx("ao-btn", `ao-btn--${v}`, "ao-btn--icon", size === "sm" && "ao-btn--sm", extra), "aria-label": label, title: label, ...rest })}>${icon(ic)}</button>`;
}

/** The amber button. ONLY for "Answer" on a needs-you item. */
export function answerButton({ agent, attrs: a = {} } = {}) {
  const { class: extra, ...rest } = a;
  return `<button${attrs({ type: "button", class: cx("ao-btn ao-btn--answer", extra), "aria-label": agent ? `Answer ${agent}` : null, ...rest })}>Answer</button>`;
}

// ---------- filter chip ----------
/** Toggle chip. bind() flips aria-pressed and fires "ao-chip" { value, pressed }. */
export function filterChip({ label, count, icon: ic, tone, pressed = false, value, attrs: a = {} } = {}) {
  const t = tone && Object.hasOwn(STATES, tone) ? `ao-tone-${tone}` : "";
  return `<button${attrs({ type: "button", class: "ao-chip", "aria-pressed": String(!!pressed), "data-chip": value ?? label, ...a })}>${ic ? `<span class="${cx("ao-chip-icon", t)}">${icon(ic)}</span>` : ""}<span>${esc(label)}</span>${count != null ? `<span class="ao-chip-count">${esc(count)}</span>` : ""}<span class="ao-chip-check">${icon("check", { size: 14 })}</span></button>`;
}

/** Status filter for the top bar: "Working 4" with the state's icon. */
export function stateChip(state, count, pressed = false) {
  const k = stateKey(state);
  return filterChip({ label: STATES[k].label, count, icon: STATES[k].icon, tone: k, pressed, value: k });
}

// ---------- segmented control ----------
/** Radio group. Options are strings or { value, label, count }. bind() handles arrows and fires "ao-segment" { value }. */
export function segmented({ label, options = [], value, attrs: a = {} } = {}) {
  const { class: extra, ...rest } = a;
  const opts = options.map((o) => (typeof o === "object" ? o : { value: String(o), label: String(o) }));
  const tab = opts.some((o) => o.value === value) ? value : opts[0]?.value;
  const opt = (o) => `<button${attrs({ type: "button", role: "radio", class: "ao-seg-opt", "aria-checked": String(o.value === value), tabindex: o.value === tab ? "0" : "-1", "data-value": o.value })}>${esc(o.label)}${o.count != null ? `<span class="ao-seg-count">${esc(o.count)}</span>` : ""}</button>`;
  return `<div${attrs({ class: cx("ao-seg", extra), role: "radiogroup", "aria-label": label, ...rest })}>${opts.map(opt).join("")}</div>`;
}

// ---------- progress bar and budget ring ----------
/** Solid teal = done, striped teal = in progress. The label is the text alternative. */
export function progressBar({ done = 0, doing = 0, total = 0, label } = {}) {
  const d = Math.max(0, +done || 0), g = Math.max(0, +doing || 0), t = Math.max(+total || 0, d + g);
  const w = (n) => (t ? (n / t) * 100 : 0).toFixed(2);
  const text = label || (t ? `${d} of ${t} done, ${g} in progress` : "No planned tasks");
  return `<div class="ao-progress" role="img" aria-label="${esc(text)}"><span class="ao-progress-done" style="width:${w(d)}%"></span><span class="ao-progress-doing" style="width:${w(g)}%"></span></div>`;
}

/** Teal ring; red only when spend is over 100% of the budget, and then the text says so too. */
export function budgetRing({ spent = 0, budget = 0, period = "today" } = {}) {
  const s = Math.max(0, +spent || 0), b = Math.max(0, +budget || 0), pct = b ? s / b : 0, over = pct > 1;
  const R = 15, C = 2 * Math.PI * R, arc = Math.min(pct, 1) * C;
  const sub = b ? `${over ? "Over budget · " : ""}${Math.round(pct * 100)}% of ${money(b, { trim: true })} ${period}` : "No budget set";
  const bar = arc > 0 ? `<circle class="ao-ring-bar" cx="18" cy="18" r="${R}" stroke-dasharray="${arc.toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 18 18)"/>` : "";
  return `<span class="${cx("ao-ring", over && "is-over")}"><svg width="34" height="34" viewBox="0 0 36 36" aria-hidden="true" focusable="false"><circle class="ao-ring-track" cx="18" cy="18" r="${R}"/>${bar}</svg><span class="ao-ring-text"><b class="ao-ring-amount">${esc(money(s))}</b><span class="ao-ring-sub">${esc(sub)}</span></span></span>`;
}

// ---------- path chip and code box ----------
/** Middle-truncated root ("/Users/me/…/supermarket-pos"). Click copies the full path and shows "Copied". */
export function pathChip(path, { max = 36 } = {}) {
  const full = String(path ?? ""), short = middleTruncate(full, max);
  return `<button${attrs({ type: "button", class: "ao-copy", "data-copy": full, title: "Copy full path", "aria-label": `Copy path ${short}` })}><span class="ao-copy-text">${esc(short)}</span>${icon("copy", { size: 13 })}<span class="ao-copy-done" aria-hidden="true">${icon("check", { size: 13 })}Copied</span></button>`;
}

/** Mono box, end-truncated on one line. Full text in the tooltip; long or multi-line text gets an expand button. */
export function codeBox(text, { what = "command", expandAt = 48 } = {}) {
  const full = String(text ?? ""), long = full.length > expandAt || full.includes("\n");
  const more = long ? `<button${attrs({ type: "button", class: "ao-btn ao-btn--ghost ao-btn--icon ao-btn--sm ao-code-more", "data-expand": true, "aria-expanded": "false", "aria-label": `Full ${what}`, title: `Show full ${what}` })}>${icon("chevron")}</button>` : "";
  return `<div class="ao-code"><code${attrs({ class: "ao-code-text", title: full || null })}>${esc(full)}</code>${more}</div>`;
}

// ---------- avatar ----------
/** Same order as --proj-1 … --proj-6 in tokens.css. Never amber, orange or red. */
export const PROJECT_COLORS = ["#A78BFA", "#60A5FA", "#A3E635", "#F0ABFC", "#818CF8", "#94A3B8"];

/** Stable default colour index (0–5) for a project. */
export function projectColor(key) {
  let h = 2166136261;
  for (const ch of String(key ?? "")) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h % PROJECT_COLORS.length;
}

function colorIndex(color, key) {
  if (Number.isInteger(color)) return ((color % 6) + 6) % 6;
  const i = PROJECT_COLORS.indexOf(String(color ?? "").toUpperCase());
  return i >= 0 ? i : projectColor(key);
}

const SIZES = new Set(["sm", "md", "lg"]);
/** Project colour + initials. color = index 0–5 or one of PROJECT_COLORS; defaults to a hash of project. */
export function avatar({ name, project, color, size = "md", round = false, decorative = false } = {}) {
  const a11y = decorative ? { "aria-hidden": "true" } : { role: "img", "aria-label": name || "Agent" };
  return `<span${attrs({ class: cx("ao-avatar", `ao-avatar--${SIZES.has(size) ? size : "md"}`, round && "ao-avatar--round"), style: `--av:var(--proj-${colorIndex(color, project ?? name) + 1})`, ...a11y })}>${esc(initials(name))}</span>`;
}

// ---------- hover card ----------
/** Tooltip card, max 280px. Give the anchor data-hovercard="<id>" and aria-describedby="<id>"; bind() opens it on hover and focus.
 *  Put the card in a positioned box; mark the box to stay inside with data-hover-bounds. */
export function hoverCard({ id, body = "", cls } = {}) {
  return `<div${attrs({ class: cx("ao-hovercard", cls), role: "tooltip", id, hidden: true })}>${body}</div>`;
}

/** Above the anchor; below only when it fits there or below has more room; beside the anchor when neither
 *  fits but a side does, so the card doesn't cover it. Then clamped `pad` px inside bounds on every side. */
export function placeHover(anchor, card, bounds, { gap = 8, pad = 8 } = {}) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const room = { top: anchor.top - gap - bounds.top - pad, bottom: bounds.bottom - pad - anchor.bottom - gap,
    left: anchor.left - gap - bounds.left - pad, right: bounds.right - pad - anchor.right - gap };
  let placement = room.top >= card.height || (room.bottom < card.height && room.top >= room.bottom) ? "top" : "bottom";
  if (room[placement] < card.height) {
    const side = room.right >= room.left ? "right" : "left";
    if (room[side] >= card.width) placement = side;
  }
  const side = placement === "left" || placement === "right";
  const top = side ? (anchor.top + anchor.bottom) / 2 - card.height / 2 : placement === "top" ? anchor.top - gap - card.height : anchor.bottom + gap;
  const left = !side ? (anchor.left + anchor.right) / 2 - card.width / 2 : placement === "right" ? anchor.right + gap : anchor.left - gap - card.width;
  return {
    placement,
    top: clamp(top, bounds.top + pad, bounds.bottom - pad - card.height),
    left: clamp(left, bounds.left + pad, bounds.right - pad - card.width),
  };
}

/** Positions an absolutely placed card. Bounds = boundsEl (e.g. the office viewport) cut to the window. */
export function positionHoverCard(card, anchor, boundsEl) {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const b = boundsEl ? boundsEl.getBoundingClientRect() : { left: 0, top: 0, right: vw, bottom: vh };
  const bounds = { left: Math.max(0, b.left), top: Math.max(0, b.top), right: Math.min(vw, b.right), bottom: Math.min(vh, b.bottom) };
  card.style.left = card.style.top = "0px";
  const p = placeHover(anchor.getBoundingClientRect(), { width: card.offsetWidth, height: card.offsetHeight }, bounds);
  const op = card.offsetParent, o = op ? op.getBoundingClientRect() : { left: 0, top: 0 };
  const dx = op ? o.left + op.clientLeft - op.scrollLeft : 0, dy = op ? o.top + op.clientTop - op.scrollTop : 0;
  card.style.left = `${Math.round(p.left - dx)}px`;
  card.style.top = `${Math.round(p.top - dy)}px`;
  card.dataset.placement = p.placement;
  return p;
}

// ---------- theme controls ----------
const toggleLabel = (theme) => `Switch to ${theme === "dark" ? "light" : "dark"} theme`;

/** Icon button: sun in dark (goes light), moon in light (goes dark). */
export function themeToggle(theme = currentTheme()) {
  return iconButton({ icon: theme === "dark" ? "sun" : "moon", label: toggleLabel(theme), attrs: { "data-theme-toggle": true } });
}

/** Dark / Light / System, for Settings. */
export function themeSwitch(pref = themePref()) {
  return segmented({ label: "Theme", value: pref, attrs: { "data-theme-switch": true },
    options: [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }] });
}

// ---------- behaviour ----------
let live = null;
/** Polite screen-reader announcement. */
export function announce(msg) {
  if (!live || !live.isConnected) {
    live = document.createElement("div");
    live.className = "ao-sr";
    live.setAttribute("aria-live", "polite");
    document.body.append(live);
  }
  live.textContent = "";
  setTimeout(() => { live.textContent = msg; }, 50);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // Plain-http team mode has no Clipboard API.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

const copyTimers = new WeakMap();
async function onCopy(btn) {
  const ok = await copyText(btn.dataset.copy);
  btn.focus({ preventScroll: true });
  if (!ok) return announce("Couldn't copy. The browser blocked the clipboard.");
  btn.classList.add("is-copied");
  announce("Copied");
  clearTimeout(copyTimers.get(btn));
  copyTimers.set(btn, setTimeout(() => btn.classList.remove("is-copied"), 1600));
}

function toggleChip(chip) {
  const pressed = chip.getAttribute("aria-pressed") !== "true";
  chip.setAttribute("aria-pressed", String(pressed));
  chip.dispatchEvent(new CustomEvent("ao-chip", { bubbles: true, detail: { value: chip.dataset.chip, pressed } }));
}

function checkSeg(group, value) {
  for (const o of group.querySelectorAll(".ao-seg-opt")) {
    const on = o.dataset.value === value;
    o.setAttribute("aria-checked", String(on));
    o.tabIndex = on ? 0 : -1;
  }
}

function pickSeg(opt, focus) {
  if (focus) opt.focus();
  if (opt.getAttribute("aria-checked") === "true") return;
  const group = opt.closest(".ao-seg");
  checkSeg(group, opt.dataset.value);
  group.dispatchEvent(new CustomEvent("ao-segment", { bubbles: true, detail: { value: opt.dataset.value } }));
}

const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
function segKey(e, opt) {
  const opts = [...opt.closest(".ao-seg").querySelectorAll(".ao-seg-opt:not(:disabled)")];
  const i = opts.indexOf(opt), n = opts.length;
  const j = Object.hasOwn(STEP, e.key) ? (i + STEP[e.key] + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
  if (j < 0) return;
  e.preventDefault();
  pickSeg(opts[j], true);
}

function toggleExpand(btn) {
  const box = btn.closest(".ao-code"), open = !box.classList.contains("is-open");
  box.classList.toggle("is-open", open);
  btn.setAttribute("aria-expanded", String(open));
}

function syncTheme(root, { pref, theme }) {
  for (const b of root.querySelectorAll("[data-theme-toggle]")) {
    b.innerHTML = icon(theme === "dark" ? "sun" : "moon");
    b.setAttribute("aria-label", toggleLabel(theme));
    b.title = toggleLabel(theme);
  }
  for (const g of root.querySelectorAll("[data-theme-switch]")) checkSeg(g, pref);
}

/** Event delegation for every component under root: copy, chips, segmented keys, code expand, theme, hover cards.
 *  Call once per root. Returns an unbind function. */
export function bind(root = document) {
  const doc = root.ownerDocument || root;
  let card = null, anchor = null, hideTimer = 0;
  const inside = (el) => !!el && !!((anchor && anchor.contains(el)) || (card && card.contains(el)));
  const hide = () => { clearTimeout(hideTimer); if (card) card.hidden = true; card = anchor = null; };
  // Pointer leaving never hides a card its focused anchor keeps open (WCAG 1.4.13); a focused anchor gets its card back.
  const hideSoon = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const focused = doc.activeElement?.closest?.("[data-hovercard]");
      if (focused && focused === anchor) return;
      hide();
      if (focused && root.contains(focused)) show(focused);
    }, 150);
  };
  function show(a) {
    clearTimeout(hideTimer);
    if (a === anchor) return;
    const c = doc.getElementById(a.dataset.hovercard);
    if (!c) return;
    if (card && card !== c) card.hidden = true;
    card = c; anchor = a; c.hidden = false;
    positionHoverCard(c, a, a.closest("[data-hover-bounds]"));
  }

  const onClick = (e) => {
    const t = e.target.closest?.("[data-copy], [data-chip], .ao-seg-opt, [data-expand], [data-theme-toggle]");
    if (!t) return;
    if (t.matches("[data-copy]")) onCopy(t);
    else if (t.matches("[data-chip]")) toggleChip(t);
    else if (t.matches(".ao-seg-opt")) pickSeg(t, false);
    else if (t.matches("[data-expand]")) toggleExpand(t);
    else setTheme(currentTheme() === "dark" ? "light" : "dark");
  };
  const onKey = (e) => {
    if (e.key === "Escape" && card) return hide();
    const opt = e.target.closest?.(".ao-seg-opt");
    if (opt) segKey(e, opt);
  };
  const onOver = (e) => {
    const a = e.target.closest?.("[data-hovercard]");
    if (a) show(a); else if (inside(e.target)) clearTimeout(hideTimer);
  };
  const onOut = (e) => { if (card && inside(e.target) && !inside(e.relatedTarget)) hideSoon(); };
  const onFocusIn = (e) => { const a = e.target.closest?.("[data-hovercard]"); if (a) show(a); };
  const onFocusOut = (e) => { if (card && anchor.contains(e.target) && !inside(e.relatedTarget)) hide(); };
  const onSegment = (e) => { if (e.target.closest?.("[data-theme-switch]")) setTheme(e.detail.value); };
  const onTheme = (e) => syncTheme(root, e.detail);

  const handlers = [["click", onClick], ["keydown", onKey], ["pointerover", onOver], ["pointerout", onOut],
    ["focusin", onFocusIn], ["focusout", onFocusOut], ["ao-segment", onSegment]];
  for (const [type, fn] of handlers) root.addEventListener(type, fn);
  doc.addEventListener("ao-theme", onTheme);
  return () => {
    hide();
    for (const [type, fn] of handlers) root.removeEventListener(type, fn);
    doc.removeEventListener("ao-theme", onTheme);
  };
}
