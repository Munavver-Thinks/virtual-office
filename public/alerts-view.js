// The Alerts Center, markup: small functions that return HTML strings. Text is escaped; no DOM.
// Colour rules: amber only for "needs you" (its type pill and "still waiting"); red only for errors (a failing webhook,
// a failed delivery, the Errors pill, "still failing") and over budget (its pill). Budget warnings are neutral. Every
// state also has an icon and words.
import { panel, emptyState, loadingState, errorState, button, segmented, filterChip, toast, staleNote } from "./ui/components.js";
import { esc, clock } from "./ui/format.js";
import { icon } from "./ui/icons.js";
import { CHANNELS, NAMES, TABS, FILTERS } from "./alerts-model.js";

const cx = (...n) => n.filter(Boolean).join(" ");
const RETRY = { label: "Retry", attrs: { "data-al-reload": true } };
const FAILED = "Couldn't load the alerts. The server didn't answer.";
const stateOf = (status, asOf) => (status === "stale" ? asOf : null);

// ---------- frame and header ----------
/** The screen's fixed parts; alerts.js fills each slot. Each channel card has its own slot for the webhook form, so a
 *  URL you're typing survives live updates. The toasts are a polite live region; "said" tells screen readers what a
 *  rule change did. */
export function frame({ tab = "history" } = {}) {
  const ch = (c) => `<section class="ao-panel al-channel" data-al-ch="${c}" aria-labelledby="al-ch-${c}-h"><div data-al-card="${c}"></div><div data-al-edit="${c}"></div></section>`;
  return `<div class="al-head"><p class="al-updated" data-al="updated"></p>${segmented({ label: "Alerts view", value: tab, options: TABS, attrs: { class: "al-tabs" } })}</div>
    <div class="al-channels" role="group" aria-label="Channels">${CHANNELS.map(ch).join("")}</div>
    <div class="al-pane" data-al-pane="history"${tab === "history" ? "" : " hidden"}><div data-al="history"></div></div>
    <div class="al-pane" data-al-pane="rules"${tab === "rules" ? "" : " hidden"}><div data-al="rules"></div></div>
    <p class="ao-sr" role="status" data-al="said"></p>
    <div class="al-toasts" data-al="toasts" role="status" aria-live="polite"></div>`;
}

/** "Updated 15:42", or "As of 15:40" while the data is behind. */
export function updated(status, t) {
  if (status === "loading") return "<span>Loading…</span>";
  if (status === "error") return "<span>Not loaded</span>";
  if (status === "stale") return staleNote(t);
  return `<span class="al-live">${icon("clock", { size: 14 })}Updated ${esc(clock(t))}</span>`;
}

// ---------- channel cards ----------
const pill = (p) => `<span class="${cx("al-pill", `al-pill--${p.tone}`)}">${icon(p.icon, { size: 13 })}<span>${esc(p.label)}</span></span>`;
const head = (id, title, extra = "") => `<header class="ao-panel-head">${icon("chat")}<h2 class="ao-panel-title" id="al-ch-${id}-h">${esc(title)}</h2>${extra}</header>`;

/** A channel's card: its health (Healthy, Failing with since when and what it may mean, Not set up), last delivery and
 *  count, the masked webhook, Send test, and the button that opens the webhook form. Loading, error and stale too. */
export function channelCard({ card = null, id, status = "live", asOf = null, editing = false } = {}) {
  const name = NAMES[id];
  if (status === "loading" || (!card && status !== "error")) return head(id, name) + `<div class="ao-panel-body" aria-busy="true">${loadingState({ rows: 1, avatar: false, label: `Loading the ${name} channel` })}</div>`;
  if (!card) return head(id, name) + `<div class="ao-panel-body">${errorState({ text: FAILED, action: RETRY })}</div>`;
  const c = card, stale = stateOf(status, asOf);
  const end = stale ? `<div class="ao-panel-end">${staleNote(stale)}</div>` : "";
  const line = `<p class="${cx("al-ch-line", c.failing && "is-failing")}">${c.failing ? icon("alert", { size: 15 }) : ""}<span>${esc(c.line)}</span></p>`;
  const where = c.url ? `<p class="ao-meta al-ch-url"><span class="ao-sr">Webhook: </span><code>${esc(c.url)}</code>${c.env ? ` · Set on the server with <code>${esc(c.env)}</code>` : ""}</p>` : "";
  const edit = c.edit ? button({ label: c.edit, variant: c.setUp && !c.failing ? "ghost" : "primary", size: "sm",
    attrs: { "data-al-open": id, "data-key": `al-open:${id}`, "aria-expanded": String(editing), "aria-controls": `al-form-${id}` } }) : "";
  const test = c.setUp ? button({ label: c.testing ? "Sending…" : "Send test", icon: "send", size: "sm",
    attrs: { "data-al-test": id, "data-key": `al-test:${id}`, "aria-busy": c.testing ? "true" : null, "aria-label": c.testing ? `Sending a test to ${name}` : `Send a test to ${name}` } }) : "";
  return head(id, c.title, pill(c.pill) + end) + `<div class="${cx("ao-panel-body", stale && "ao-stale")}">${line}${where}<div class="al-ch-actions">${c.failing ? edit + test : test + edit}</div></div>`;
}

/** The webhook form under a channel card. The URL is never filled in (the server only shows its masked form): empty
 *  keeps the current one. Remove takes it out. */
export function editForm(c, { demo = false } = {}) {
  const id = c.id, name = c.name, set = c.status !== "none";
  const where = id === "slack" ? "In Slack: Apps, Incoming Webhooks, Add to a channel, then copy the Webhook URL."
    : "In Discord: the channel's settings, Integrations, Webhooks, New Webhook, then Copy Webhook URL.";
  const hint = `${set ? `Leave it empty to keep the current one (${c.url}). ` : ""}${where}${demo ? " Demo mode: nothing is sent or saved." : ""}`;
  const placeholder = id === "slack" ? "https://hooks.slack.com/services/…" : "https://discord.com/api/webhooks/…";
  return `<form class="al-form" id="al-form-${id}" data-al-form="${id}" novalidate aria-label="${esc(`${name} webhook`)}">
    <div class="cc-field"><label for="al-url-${id}">${esc(name)} webhook URL</label><input type="url" id="al-url-${id}" name="url" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" aria-describedby="al-url-${id}-hint"><p class="ao-meta" id="al-url-${id}-hint">${esc(hint)}</p></div>
    <div class="cc-field"><label for="al-name-${id}">Channel name <span class="ao-meta">(optional, only shown here)</span></label><input type="text" id="al-name-${id}" name="channel" maxlength="40" value="${esc(c.channel || "")}" placeholder="${id === "slack" ? "#agent-office" : "#ops"}"></div>
    <p class="al-form-err" role="alert" data-al-error></p>
    <div class="al-form-actions">${set ? button({ label: "Remove webhook", variant: "ghost", size: "sm", attrs: { "data-al-remove": id } }) : ""}${button({ label: "Cancel", size: "sm", attrs: { "data-al-cancel": id } })}${button({ label: "Save", variant: "primary", size: "sm", type: "submit" })}</div>
  </form>`;
}

/** After Send test: it arrived, or what went wrong. */
export function testToast({ ok, name, channel = null, demo = false, error = "" } = {}) {
  if (!ok) return toast({ icon: "alert", title: `The test didn't reach ${name}`, text: error });
  return toast({ icon: "send", title: `Test sent to ${name}`, text: demo ? "Demo mode: nothing was really sent." : channel ? `Check ${channel}.` : "Check the channel." });
}

/** After saving or removing a webhook, or a retry. */
export const noteToast = (title, text = "", ok = true) => toast({ icon: ok ? "check" : "alert", title, text });

// ---------- history ----------
function typePill(t) {
  return t.tone === "needs" ? `<span class="ao-pill ao-pill--needs">${icon(t.icon, { size: 13 })}<span>${esc(t.label)}</span></span>`
    : `<span class="${cx("al-pill", `al-pill--${t.tone}`)}">${icon(t.icon, { size: 13 })}<span>${esc(t.label)}</span></span>`;
}

function deliveryCell(d, row, ch) {
  const mark = d.icon ? icon(d.icon, { size: 14 }) : d.tone === "busy" ? '<span class="cc-pulse" aria-hidden="true"></span>' : "";
  const retry = d.retry ? button({ label: "Retry", size: "sm", attrs: { "data-al-retry": row.id, "data-al-channel": ch, "data-key": `al-retry:${row.id}:${ch}`, "aria-label": `Retry sending to ${NAMES[ch]}: ${row.text}` } }) : "";
  return `<td><div class="al-dl-cell"><span class="${cx("al-dl", `is-${d.tone}`)}" tabindex="-1" data-key="al-dl:${row.id}:${ch}">${mark}<span>${esc(d.text)}</span></span>${retry}</div></td>`;
}

function historyRow(r) {
  const context = r.context.map(esc).join(" · ") + (r.target ? `${r.context.length ? " · " : ""}<code title="${esc(r.target)}">${esc(r.target)}</code>` : "");
  const status = r.status ? `<span class="${cx("al-status", `is-${r.status.tone}`)}">${icon(r.status.icon, { size: 14 })}<span>${esc(r.status.text)}</span></span>`
    : '<span aria-hidden="true">—</span><span class="ao-sr">Nothing to follow</span>';
  const open = r.open ? button({ label: "Open", size: "sm", attrs: { "data-agent": r.open.session, "data-agent-at": r.open.at, "data-key": `al-agent:${r.id}`, "aria-label": `Open ${r.who}` } }) : "";
  const cost = r.costReport ? `<a class="ao-btn ao-btn--secondary ao-btn--sm" href="#/cost" data-key="al-cost:${esc(r.id)}">Cost report</a>` : "";
  return `<tr><td class="al-when"><time datetime="${esc(r.t)}">${esc(r.time)}</time><span class="ao-meta">${esc(r.day)}</span></td><td>${typePill(r.type)}</td>` +
    `<th scope="row" class="al-what"><span class="al-text">${esc(r.text)}</span>${context ? `<span class="ao-meta al-context">${context}</span>` : ""}</th>` +
    `<td>${status}</td>${CHANNELS.map((ch) => deliveryCell(r.sent[ch], r, ch)).join("")}<td class="al-acts">${open}${cost}</td></tr>`;
}

const EMPTY = { needs: "No agent waited on you long enough to alert in the last 7 days.", budget: "No budget alerts in the last 7 days.", errors: "No runs of failed tool calls in the last 7 days." };

/** The last 7 days of alerts, newest first, with the type filters (and their counts) and a delivery column per channel. */
export function historyPanel({ v = null, status = "live", asOf = null } = {}) {
  const base = { id: "al-history", title: "History", icon: "bell", meta: "Last 7 days" };
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows: 4, label: "Loading the alert history" }) });
  if (status === "error") return panel({ ...base, body: errorState({ text: FAILED, action: RETRY }) });
  const stale = stateOf(status, asOf);
  if (!v.total) return panel({ ...base, stale, body: emptyState({ ok: true, text: "No alerts in the last 7 days. They show up here when a rule fires, with how each one was delivered." }) });
  const chips = `<div class="al-filters" role="group" aria-label="Show alerts of one type">${FILTERS.map(([k, label]) =>
    filterChip({ label, count: v.counts[k], pressed: v.filter === k, value: k, attrs: { "data-key": `al-filter:${k}` } })).join("")}</div>`;
  if (!v.rows.length) return panel({ ...base, stale, body: chips + emptyState({ icon: "bell", text: EMPTY[v.filter] }) });
  const cols = ["When", "Type", "Alert", "Status", "Slack", "Discord"].map((h) => `<th scope="col">${h}</th>`).join("") + '<th scope="col"><span class="ao-sr">Open</span></th>';
  return panel({ ...base, stale, body: `${chips}<div class="al-table-wrap" role="region" aria-labelledby="al-history-title" tabindex="0">
    <table class="al-table"><caption class="ao-sr">Alerts, newest first, with their delivery to each channel</caption><thead><tr>${cols}</tr></thead><tbody>${v.rows.map(historyRow).join("")}</tbody></table></div>` });
}

// ---------- rules ----------
function ruleCard(c) {
  const id = `al-${c.kind}`, r = c.rule, n = c.key === "usd" ? Number(r.usd).toFixed(2) : r[c.key]; // dollars as "3.50"
  const note = `<p class="ao-meta" id="${id}-note">${esc(c.note.text)}${c.note.link ? ` <a class="cc-link" href="${esc(c.note.href)}">${esc(c.note.link)}</a>` : ""}</p>`;
  const send = c.channels.map((ch) => `<span class="cc-check"><input type="checkbox" id="${id}-${ch.id}" data-al-field="${ch.id}" data-key="${id}-${ch.id}"${ch.on ? " checked" : ""}>` +
    `<label for="${id}-${ch.id}">${esc(ch.name)}${ch.setUp ? "" : ' <span class="ao-meta">(not set up)</span>'}</label></span>`).join("");
  return `<li class="al-rule" data-al-rule="${c.kind}">
    <div class="al-rule-head"><input type="checkbox" role="switch" class="ao-switch" id="${id}-on" data-al-field="on" data-key="${id}-on"${r.on ? " checked" : ""} aria-describedby="${id}-text">
      <label class="al-rule-title" for="${id}-on">${esc(c.title)}</label><span class="al-onoff" aria-hidden="true"><span class="al-on">On</span><span class="al-off">Off</span></span>
      <span class="al-saved" data-al-saved="${c.kind}"></span></div>
    <p class="al-rule-text" id="${id}-text">${esc(c.before)} ${c.unit ? `<span class="al-unit" aria-hidden="true">${esc(c.unit)}</span>` : ""}<input type="number" class="al-num" id="${id}-n" data-al-field="${c.key}" data-key="${id}-n" value="${esc(n)}" min="${c.min}" max="${c.max}" step="${c.step}" inputmode="decimal" aria-label="${esc(c.label)}" aria-describedby="${id}-note"> ${esc(c.after)}</p>
    ${note}
    <fieldset class="al-send"><legend>Send to</legend>${send}</fieldset></li>`;
}

/** The four rules, each with its switch, number, channels and note. They save as you change them. */
export function rulesPanel({ cards = null, status = "live", asOf = null, demo = false } = {}) {
  const base = { id: "al-rules", title: "Rules", icon: "settings", meta: "Changes save as you make them" };
  if (status === "loading") return panel({ ...base, busy: true, body: loadingState({ rows: 4, avatar: false, label: "Loading the rules" }) });
  if (status === "error") return panel({ ...base, body: errorState({ text: FAILED, action: RETRY }) });
  const note = demo ? `<p class="cc-note">${icon("alert", { size: 15 })}Demo mode: changes last until the demo stops and are never saved.</p>` : "";
  return panel({ ...base, stale: stateOf(status, asOf), body: `${note}<ul class="al-rules">${cards.map(ruleCard).join("")}</ul>` });
}
