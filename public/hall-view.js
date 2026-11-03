// The Meeting Hall, markup: small functions that return HTML strings. Text is escaped; no DOM.
// Colour rules: amber only for what waits on you (a Blocked row and its wait, the Answer button, open decisions, "N
// waiting on you" on the scorecard); red only for errors (a failed load, a turn that ended on an API error). Every state
// carries an icon and a word too.
import { panel, emptyState, loadingState, errorState, button, answerButton, segmented, statePill, waitPill, avatar, codeBox, toast, STATES } from "./ui/components.js";
import { esc } from "./ui/format.js";
import { icon } from "./ui/icons.js";
import { APP } from "./shell-model.js";
import { ALL } from "./hall-model.js";

const cx = (...n) => n.filter(Boolean).join(" ");
const proj = (i) => `--av:var(--proj-${((i % 6) + 6) % 6 + 1})`;
const idOf = (s) => String(s).replace(/[^\w-]/g, "_");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Filtered out by the top bar's chips: dimmed, as in the office. */
const dim = (filter, state) => !!filter && !filter.has(state);
const RETRY = { label: "Retry", attrs: { "data-retry": true } }, ROOMS_RETRY = { label: "Retry", attrs: { "data-mh-retry": true } };
const stale = (status, asOf) => (status === "stale" ? asOf : null);

// ---------- frame ----------
/** The hall's fixed parts; hall.js fills each [data-mh] slot. New bubbles and deliveries are announced through the log;
 *  the toasts only repeat what it says, so they're hidden from screen readers. */
export function frame() {
  return `<div class="mh-head"><div class="mh-tabs" data-mh="tabs"></div><div class="mh-tools" data-mh="tools"></div></div>
    <div data-mh="table"></div>
    <div class="mh-grid">
      <div class="mh-main"><div data-mh="transcript"></div><div data-mh="compose"></div></div>
      <div class="mh-rail" role="complementary" aria-label="Decisions, overlaps and scorecard"><div data-mh="decisions"></div><div data-mh="overlaps"></div><div data-mh="score"></div></div>
    </div>
    <div class="ao-sr" role="log" aria-live="polite" aria-label="Meeting hall updates" data-mh="log"></div>
    <div class="mh-toasts" data-mh="toasts" aria-hidden="true"></div>`;
}

/** All rooms and one tab per project, with its colour dot and head count. */
export const roomTabs = (tabs, room) => segmented({ label: "Room", value: room, options: tabs, attrs: { class: "mh-rooms" } });

/** Replay standup (Stop replay while it runs) and Copy summary. */
export function tools({ text = "", replaying = false, ready = false } = {}) {
  return button({ label: replaying ? "Stop replay" : "Replay standup", icon: replaying ? "x" : "play", attrs: { "data-mh-replay": true, "data-key": "mh-replay", disabled: !ready && !replaying } }) +
    button({ label: "Copy summary", icon: "copy", attrs: { "data-copy": text || null, "data-mh-copy": true, "data-key": "mh-copy", disabled: !text } });
}

// ---------- at the table ----------
function seat(s, { filter, speaking }) {
  const st = STATES[s.state], on = speaking === s.session;
  return `<li><button type="button" class="${cx("mh-seat", s.state === "offline" && "is-off", dim(filter, s.state) && "is-dim", on && "is-speaking")}" data-agent="${esc(s.session)}" data-key="${esc(`mh-seat:${s.session}`)}" style="${proj(s.color)}" title="${esc(`${s.name} · ${st.label}`)}">` +
    `${avatar({ name: s.name, color: s.color, size: "sm", decorative: true })}<span class="mh-seat-name">${esc(s.name)}</span>` +
    `<span class="mh-seat-state ao-tone-${s.state}">${icon(st.icon, { size: 13 })}<span class="ao-sr">, ${esc(st.label)}</span></span>${on ? '<span class="mh-speaking">speaking</span>' : ""}</button></li>`;
}

/** Every agent in the room as a pill: avatar, name, state icon; offline ones faded; the speaker marked during replay. */
export function tablePanel({ v = null, status = "live", asOf = null, filter = null, speaking = null } = {}) {
  const base = { id: "mh-table", title: "At the table", icon: "meeting", cls: "mh-table" };
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows: 1, label: "Loading who is at the table" }) });
  if (status === "error") return panel({ ...base, body: errorState({ text: "Couldn't load the room. The server didn't answer.", action: RETRY }) });
  if (v.empty) return panel({ ...base, stale: stale(status, asOf), body: emptyState({ icon: "meeting", text: "Nobody is at the table yet today. An agent takes a seat once it works in this room." }) });
  const attending = v.seats.filter((s) => s.state !== "offline").length;
  return panel({ ...base, stale: stale(status, asOf), meta: `${plural(v.seats.length, "agent")} · ${attending} attending`,
    body: `<ul class="mh-seats" aria-label="At the table">${v.seats.map((s) => seat(s, { filter, speaking })).join("")}</ul>` });
}

// ---------- the transcript ----------
function row(r) {
  const body = r.k === "done" ? `<span class="mh-items">${r.items.map((t) => `<span class="mh-item">${esc(t)}</span>`).join("")}${r.more ? `<span class="ao-meta">+${r.more} more</span>` : ""}</span>`
    : `<span class="mh-row-text">${esc(r.text)}${r.mono ? `<code title="${esc(r.full || r.mono)}">${esc(r.mono)}</code>` : ""}</span>` +
      `${r.code ? codeBox(r.code, { what: r.what || "target" }) : ""}${r.wait != null ? waitPill(r.wait) : ""}` +
      `${r.said ? `<span class="mh-said"><span class="ao-label">Said</span><q class="cc-clamp" title="${esc(r.said)}">${esc(r.said)}</q></span>` : ""}`;
  return `<li class="${cx("mh-row", `mh-row--${r.k}`, r.tone && `is-${r.tone}`)}"><span class="mh-row-k">${icon(r.icon, { size: 14 })}${esc(r.label)}</span><div class="mh-row-v">${body}</div></li>`;
}

const hostBubble = (b) => `<li class="mh-b mh-b--host" aria-labelledby="mh-${idOf(b.key)}"><div class="mh-b-head"><span class="mh-host" aria-hidden="true">${icon("office", { size: 15 })}</span>` +
  `<h3 class="mh-b-name" id="mh-${idOf(b.key)}">${esc(APP)}</h3><span class="ao-meta">Host</span></div><p class="mh-b-text">${esc(b.text)}</p></li>`;

function agentBubble(b, { filter, speaking }) {
  const id = `mh-${idOf(b.key)}`;
  const foot = (b.blocked ? answerButton({ agent: b.name, attrs: { "data-agent": b.session, "data-agent-at": "convo", "data-key": `mh-answer:${b.session}` } }) : "") +
    button({ label: "Trace", icon: "pulse", size: "sm", attrs: { "data-agent": b.session, "data-agent-at": "trace", "data-key": `mh-trace:${b.session}`, "aria-label": `Trace of ${b.name}` } });
  return `<li class="${cx("mh-b mh-b--agent", dim(filter, b.state) && "is-dim", speaking === b.session && "is-speaking")}" style="${proj(b.color)}" aria-labelledby="${id}">
    <div class="mh-b-head">${avatar({ name: b.name, color: b.color, size: "sm", decorative: true })}<h3 class="mh-b-name" id="${id}">${esc(b.name)}</h3>${b.showProject ? `<span class="ao-meta">${esc(b.project)}</span>` : ""}` +
    `${statePill(b.state, { waitMs: b.waitMs })}<span class="ao-meta mh-b-facts">${esc(b.facts)}</span></div>
    <ul class="mh-rows">${b.rows.map(row).join("")}</ul><div class="mh-b-foot">${foot}</div></li>`;
}

/** A delivery line: who, and where your message stands with it. Teal once delivered; never red. */
const line = (l) => `<li class="mh-line is-${l.tone}">${icon(l.icon, { size: 13 })}<span><b>${esc(l.name)}</b> ${esc(l.text)}</span></li>`;

const youBubble = (b) => `<li class="mh-b mh-b--you"><p class="mh-b-meta">${esc(b.meta)}</p><p class="mh-b-text cc-clamp" title="${esc(b.text)}">${esc(b.text)}</p>` +
  `<ul class="mh-lines" aria-label="Delivery">${b.lines.map(line).join("")}</ul></li>`;

const bubble = (b, o) => (b.kind === "host" ? hostBubble(b) : b.kind === "you" ? youBubble(b) : agentBubble(b, o));

/**
 * The standup: the host's opening, a bubble per agent, the host's close, then your messages to the room. During replay
 * (frame = replayFrame()) only what was revealed so far, and who is up next. rooms = the status of GET /api/rooms.
 */
export function transcriptPanel({ v = null, status = "live", asOf = null, rooms = "live", frame = null, filter = null } = {}) {
  const base = { id: "mh-transcript", title: "Standup", icon: "chat", cls: "mh-transcript", meta: `Written by ${APP} from each agent's plan and activity` };
  const loading = panel({ ...base, busy: true, body: loadingState({ rows: 4, label: "Loading the standup" }) });
  if (status === "loading") return loading;
  if (status === "error") return panel({ ...base, body: errorState({ text: "Couldn't load the room. The server didn't answer.", action: RETRY }) });
  if (v.empty) return panel({ ...base, meta: null, stale: stale(status, asOf), body: emptyState({ icon: "chat", text: "No standup yet: nobody worked in this room today." }) });
  if (!v.bubbles) return rooms === "error" ? panel({ ...base, body: errorState({ text: "Couldn't load today's plans and messages. The server didn't answer.", action: ROOMS_RETRY }) }) : loading;
  const list = frame ? frame.shown : [...v.bubbles, ...v.messages], o = { filter, speaking: frame ? frame.speaking : null };
  const typing = frame && frame.next ? `<p class="mh-typing" aria-hidden="true"><span class="mh-dots"><i></i><i></i><i></i></span>${esc(frame.next)} is up next</p>` : "";
  return panel({ ...base, stale: asOf, body: `<ol class="${cx("mh-thread", frame && "is-replay")}" aria-label="Standup transcript">${list.map((b) => bubble(b, o)).join("")}</ol>${typing}` });
}

// ---------- message the room ----------
/** The message box for a room (its markup never changes while it's shown, so a message you're typing survives live
 *  updates), or why this tab can't be messaged. Who gets it and the Send label are filled in by hall.js. */
export function composePanel({ mode = "loading", room = "" } = {}) {
  const base = { id: "mh-compose", title: "Message the room", icon: "send", cls: "mh-compose" };
  const note = (ic, text) => panel({ ...base, body: `<p class="mh-note">${icon(ic, { size: 16 })}<span>${esc(text)}</span></p>` });
  if (mode === "loading") return panel({ ...base, busy: true, body: loadingState({ rows: 1, avatar: false, label: "Loading the room" }) });
  if (mode === "error") return panel({ ...base, body: errorState({ text: "Couldn't load the room. The server didn't answer.", action: RETRY }) });
  if (mode === "all") return note("meeting", "Pick a room above to message its agents.");
  if (mode === "noproject") return note("meeting", "These agents have no project folder, so they can't be messaged as a room. Message each one from its details.");
  if (mode === "empty") return note("meeting", "Nobody to message in this room today.");
  return panel({ ...base, body: `<form class="mh-form" data-mh-form novalidate>
      <label class="cc-reply-label" for="mh-msg">Message everyone in ${esc(room)}. Each agent gets it the next time it stops.</label>
      <textarea class="mh-msg" id="mh-msg" rows="2" maxlength="1000" aria-describedby="mh-msg-keys mh-reach"></textarea>
      <div class="cc-reply-row"><span class="ao-meta" id="mh-msg-keys">Ctrl+Enter or ⌘+Enter sends it</span>` +
      `<button type="submit" class="ao-btn ao-btn--primary" data-mh-send data-key="mh-send" disabled>${icon("send")}<span data-mh="send-label">Send</span></button></div>
      <p class="cc-answer-err" role="alert" data-mh-error></p></form>
    <div class="mh-reach-h"><h3 class="ao-label">Who gets it</h3><span data-mh="reach-asof"></span></div><ul class="mh-lines" id="mh-reach" data-mh="reach"></ul>
    <div class="mh-status" data-mh="status"></div>` });
}

/** After a message went out (the log announces it). */
export const sentNote = (text) => `<p class="cc-answer-note is-ok">${icon("check", { size: 16 })}<span>${esc(text)}</span></p>`;

/** Who gets it: a line per agent at the table, for a message sent now. */
export const reachList = (list) => list.map(line).join("");

/** "Send to 3 agents" */
export const sendLabel = (n) => (n ? `Send to ${plural(n, "agent")}` : "Nobody can get it now");

// ---------- the rail ----------
function decision(d, all) {
  const head = `<div class="mh-dec-head">${avatar({ name: d.name, color: d.color, size: "sm", decorative: true })}<div class="mh-dec-id"><h3 class="mh-dec-name">${esc(d.name)}</h3>` +
    `<span class="ao-meta">${esc([all ? d.project : null, d.host].filter(Boolean).join(" · "))}</span></div>${d.open && d.waitMs != null ? waitPill(d.waitMs) : ""}</div>`;
  if (!d.open) {
    return `<li class="mh-dec is-done">${head}<p class="mh-dec-done">${icon("check", { size: 14 })}<span>${esc(d.text)} · ${esc(d.at)}</span></p>` +
      `${button({ label: "Details", size: "sm", variant: "ghost", attrs: { "data-agent": d.session, "data-agent-at": "convo", "data-key": `mh-decide:${d.session}`, "aria-label": `${d.name}: details` } })}</li>`;
  }
  return `<li class="mh-dec is-open">${head}<p class="mh-dec-q">${icon("hand", { size: 14 })}<span>${esc(d.text)}</span></p>${d.target ? codeBox(d.target, { what: d.what }) : ""}` +
    `<div class="mh-dec-foot">${answerButton({ agent: d.name, attrs: { "data-agent": d.session, "data-agent-at": "convo", "data-key": `mh-decide:${d.session}` } })}</div></li>`;
}

/** Decisions for you: who waits on you, with Answer (the agent's conversation, in its detail), then what you decided today. */
export function decisionsPanel({ v = null, status = "live", asOf = null } = {}) {
  const base = { id: "mh-decisions", title: "Decisions for you", icon: "hand", cls: "mh-decisions" };
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows: 2, label: "Loading decisions" }) });
  if (status === "error") return panel({ ...base, body: errorState({ text: "Couldn't load the decisions. The server didn't answer.", action: RETRY }) });
  const open = v.decisions.filter((d) => d.open).length;
  if (!v.decisions.length) return panel({ ...base, stale: stale(status, asOf), body: emptyState({ ok: true, text: "Nothing is waiting on you in this room." }) });
  return panel({ ...base, stale: stale(status, asOf), badge: open ? `<span class="ao-pill ao-pill--needs">${open} waiting</span>` : "",
    body: `<ul class="mh-decs">${v.decisions.map((d) => decision(d, v.room === ALL)).join("")}</ul>` });
}

/** Where agents overlap: the same file edited by more than one today, and agents sharing a machine. */
export function overlapsPanel({ v = null, status = "live", asOf = null, rooms = "live" } = {}) {
  const base = { id: "mh-overlaps", title: "Where agents overlap", icon: "file-edit", cls: "mh-overlaps" };
  const loading = panel({ ...base, busy: true, body: loadingState({ rows: 2, avatar: false, label: "Loading overlaps" }) });
  if (status === "loading") return loading;
  if (status === "error") return panel({ ...base, body: errorState({ text: "Couldn't load the overlaps. The server didn't answer.", action: RETRY }) });
  if (!v.empty && !v.files) return rooms === "error" ? panel({ ...base, body: errorState({ text: "Couldn't load today's edits. The server didn't answer.", action: ROOMS_RETRY }) }) : loading;
  const files = v.files || [], hosts = v.machines, all = v.room === ALL;
  if (!files.length && !hosts.length) return panel({ ...base, stale: asOf, body: emptyState({ icon: "file-edit", text: "No overlaps. No two agents edited the same file today, and no machine runs two of them." }) });
  const where = (p) => (all ? `<span class="ao-meta">${esc(p)}</span>` : "");
  const f = files.length ? `<h3 class="ao-label">Same file today</h3><ul class="mh-ovs">${files.map((x) => `<li class="mh-ov">${icon("file-edit", { size: 14 })}<div class="mh-ov-body">` +
    `<code class="mh-ov-path" title="${esc(x.path)}">${esc(x.path)}</code>${where(x.project)}<span class="ao-meta">${esc(x.who.map((w) => `${w.name} ${w.at}`).join(" · "))}</span></div></li>`).join("")}</ul>` : "";
  const h = hosts.length ? `<h3 class="ao-label">Same machine</h3><ul class="mh-ovs">${hosts.map((x) => `<li class="mh-ov">${icon("terminal", { size: 14 })}<div class="mh-ov-body">` +
    `<span><b>${esc(x.host)}</b>: ${esc(x.names)}${x.sameFolder ? " · same folder" : ""}</span>${where(x.project)}</div></li>`).join("")}</ul>` : "";
  return panel({ ...base, stale: asOf, body: f + h });
}

/** The room's scorecard: tasks done, spend, waited on you, blocked now. */
export function scorePanel({ v = null, status = "live", asOf = null } = {}) {
  const base = { id: "mh-score", title: "Room scorecard", icon: "chart", cls: "mh-scorecard" };
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows: 2, avatar: false, label: "Loading the scorecard" }) });
  if (status === "error") return panel({ ...base, body: errorState({ text: "Couldn't load the scorecard. The server didn't answer.", action: RETRY }) });
  if (v.empty) return panel({ ...base, stale: stale(status, asOf), body: emptyState({ icon: "chart", text: "No scorecard yet: nobody worked in this room today." }) });
  const part = (p) => (p.tone === "needs" ? `<span class="mh-needs">${icon("hand", { size: 13 })}${esc(p.text)}</span>` : esc(p.text));
  const sub = (s) => (Array.isArray(s) ? s.map(part).join(" · ") : esc(s));
  const kpi = (k) => `<div class="mh-kpi mh-kpi--${k.key}"><dt class="ao-label">${icon(k.icon, { size: 14 })}${esc(k.label)}</dt><dd class="mh-kpi-n">${esc(k.value)}</dd><dd class="ao-meta">${sub(k.sub)}</dd></div>`;
  return panel({ ...base, stale: stale(status, asOf), body: `<dl class="mh-kpis">${v.score.map(kpi).join("")}</dl>` });
}

// ---------- toasts ----------
export const copyToast = (ok) => (ok ? toast({ icon: "copy", title: "Standup copied", text: "Paste it into Slack, an email or a doc." })
  : toast({ icon: "alert", title: "Couldn't copy the standup", text: "The browser blocked the clipboard. Select the text and copy it instead." }));
export const sentToast = (n, room) => toast({ icon: "send", title: `Sent to ${plural(n, "agent")}`, text: `Each agent in ${room} gets it the next time it stops.` });
