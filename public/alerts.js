// The Alerts Center (M10) at #/alerts: the Slack and Discord channel cards (health, last delivery, Send test, and the
// form to set up, fix or change a webhook), then History (the last 7 days of alerts, filtered by type, with each one's
// delivery per channel and Retry) or Rules (the four rules, saved as you change them). Open goes to the Agent Detail
// (data-agent); Cost report to #/cost.
// Data: GET /api/alerts while the screen shows, again when the live data's alertsRev changes (at most every 3 s);
// PUT /api/alerts for the rules and webhooks; POST /api/alerts/test; POST /api/alerts/:id/retry. The shell owns the
// live data and calls render().
//
//   const alerts = createAlerts({ root, doc?, win?, api, context: () => ({ snap, status, asOf, settings }) })
//   alerts.show(on) · alerts.render() · alerts.destroy()
import { createPatch, byKey } from "./ui/patch.js";
import * as M from "./alerts-model.js";
import * as V from "./alerts-view.js";

const TAB_KEY = "ao-alerts-tab", REFETCH_MS = 3000, TOAST_MS = 6000;

export function createAlerts({ root, doc = document, win = window, api, context }) {
  const patch = createPatch(doc);
  const saved = { get(k) { try { return win.localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { win.localStorage.setItem(k, v); } catch {} } };
  let tab = M.tabOf(saved.get(TAB_KEY)), filter = "all", shown = false, dead = false, toastTimer = 0, editing = null;
  // GET /api/alerts: the view, status (loading, live, stale, error), key (what it was fetched for).
  const data = { view: null, status: "loading", key: null, lastFetch: 0, inflight: false, again: false, timer: 0 };
  // This tab's own: tests on their way (channel), retries ("<alert id>:<channel>"), rule saves (kind → { again }), the
  // webhook form being saved.
  const testing = new Set(), retrying = new Set(), saving = new Map();
  let formBusy = false;
  root.classList.add("al-root");
  root.innerHTML = V.frame({ tab });
  const slot = (k) => root.querySelector(`[data-al="${k}"]`);
  const part = (k, ch) => root.querySelector(`[data-al-${k}="${ch}"]`);
  const setText = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };
  const demo = () => !!(context().settings || {}).demo;

  // ---------- data ----------
  /** What the view depends on: the day, and the server's alert revision (it goes up with every alert and delivery). */
  const keyOf = (snap) => `${new Date().toDateString()}|${snap && snap.alertsRev != null ? snap.alertsRev : "-"}`;

  function want(snap) {
    const key = keyOf(snap);
    if (key === data.key) return;
    data.key = key;
    fetchSoon();
  }

  function fetchSoon() {
    clearTimeout(data.timer);
    const wait = data.lastFetch + REFETCH_MS - Date.now();
    if (wait <= 0) fetchNow(); else data.timer = setTimeout(fetchNow, wait);
  }

  async function fetchNow() {
    if (data.inflight) { data.again = true; return; }
    Object.assign(data, { inflight: true, again: false, lastFetch: Date.now() });
    try {
      const v = await api("/api/alerts");
      if (dead) return;
      Object.assign(data, { view: v, status: "live" });
    } catch {
      if (dead) return;
      data.status = data.view ? "stale" : "error";
    } finally { data.inflight = false; }
    render();
    if (data.again) fetchSoon();
  }

  /** A view the server just sent back (after a change): used at once. */
  function use(v) {
    Object.assign(data, { view: v, status: "live" });
    render();
  }

  // ---------- rendering ----------
  /** Redraws what changed, keeping focus and scroll (patch.js). Only while the screen shows. Behind (the last load
   *  failed, or the live data stopped) = the last view, dimmed, "As of" its time. */
  function render() {
    if (!shown || dead) return;
    const c = context(), r = data.view;
    want(c.snap);
    const status = !r ? (data.status === "error" ? "error" : "loading") : data.status === "stale" || c.status === "stale" ? "stale" : "live";
    const asOf = r ? r.t : null, now = status === "stale" ? Date.parse(asOf) : Date.now();
    patch(slot("updated"), V.updated(status, asOf));
    for (const ch of M.CHANNELS) {
      const cv = r && r.channels.find((x) => x.id === ch);
      patch(part("card", ch), V.channelCard({ card: cv ? M.channelCard(cv, { now, testing: testing.has(ch) }) : null, id: ch, status, asOf, editing: editing === ch }));
      // Drawn from what doesn't change while you type, so live updates leave the form alone.
      patch(part("edit", ch), editing === ch && cv ? V.editForm(cv, { demo: demo() }) : "");
    }
    patch(slot("history"), V.historyPanel({ v: r ? M.history(r, { filter, now, retrying }) : null, status, asOf }));
    patch(slot("rules"), V.rulesPanel({ cards: r ? M.ruleCards(r) : null, status, asOf, demo: demo() }));
    syncChips();
  }

  /** The filter chips act as one choice: exactly the current one is pressed (bind() flips the one you click). */
  function syncChips() {
    for (const chip of root.querySelectorAll("[data-chip]")) chip.setAttribute("aria-pressed", String(chip.getAttribute("data-chip") === filter));
  }

  function showToast(html) {
    const box = slot("toasts");
    box.innerHTML = html;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.innerHTML = ""; }, TOAST_MS);
  }

  // ---------- channels ----------
  async function sendTest(ch) {
    if (testing.has(ch) || !data.view) return;
    const c = data.view.channels.find((x) => x.id === ch);
    testing.add(ch);
    render();
    try {
      await api("/api/alerts/test", { method: "POST", body: JSON.stringify({ channel: ch }) });
      if (!dead) showToast(V.testToast({ ok: true, name: c.name, channel: c.channel, demo: demo() }));
    } catch (e) {
      if (!dead) showToast(V.testToast({ ok: false, name: c.name, error: e.message }));
    } finally {
      testing.delete(ch);
      if (!dead) { render(); fetchNow(); }
    }
  }

  /** Opens the webhook form under a channel (closing another), and puts focus on its URL. */
  function openForm(ch) {
    editing = ch;
    render();
    part("edit", ch).querySelector("input").focus();
  }

  /** Closes the form; focus goes back to the button that opened it. */
  function closeForm(back = true) {
    const ch = editing;
    editing = null;
    render();
    if (back && ch) byKey(root, `al-open:${ch}`)?.focus();
  }

  /** Saves the form: a new URL (empty keeps the current one) and the channel name. remove = take the webhook out. */
  async function saveForm(form, { remove = false } = {}) {
    if (formBusy) return;
    const ch = form.getAttribute("data-al-form"), name = M.NAMES[ch], url = form.querySelector('[name="url"]').value.trim();
    const body = remove ? { url: "" } : { channel: form.querySelector('[name="channel"]').value.trim(), ...(url ? { url } : {}) };
    const err = form.querySelector("[data-al-error]");
    formBusy = true;
    form.setAttribute("aria-busy", "true");
    setText(err, "");
    try {
      const v = await api("/api/alerts", { method: "PUT", body: JSON.stringify({ [ch]: body }) });
      if (dead) return;
      editing = null;
      use(v);
      const c = v.channels.find((x) => x.id === ch);
      showToast(remove ? V.noteToast(`${name} webhook removed`, `Alerts don't go to ${name} any more.`)
        : V.noteToast(url ? `${name} webhook saved` : `${name} channel saved`, url ? "Send a test to check it." : ""));
      byKey(root, c && c.status !== "none" && url ? `al-test:${ch}` : `al-open:${ch}`)?.focus();
    } catch (e) {
      if (!dead) setText(err, `Couldn't save it. ${e.message}`);
    } finally {
      formBusy = false;
      form.removeAttribute("aria-busy");
    }
  }

  // ---------- history ----------
  /** Sends a failed delivery again: "Retrying…", then "Delivered 15:43 (retried)" or the new failure. */
  async function retry(id, ch) {
    const k = `${id}:${ch}`, name = M.NAMES[ch];
    if (retrying.has(k) || !data.view) return;
    retrying.add(k);
    render();
    try {
      const r = await api(`/api/alerts/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({ channel: ch }) });
      if (dead) return;
      retrying.delete(k);
      use({ ...data.view, alerts: data.view.alerts.map((a) => (a.id === r.alert.id ? r.alert : a)) });
      const d = r.alert.sent[ch];
      showToast(d.status === "sent" ? V.noteToast(`Delivered to ${name}`, "It went through on the retry.") : V.noteToast(`Still failing on ${name}`, `${d.error} · ${d.hint || ""}`.replace(/ · $/, ""), false));
    } catch (e) {
      if (dead) return;
      retrying.delete(k);
      render();
      showToast(V.noteToast(`Couldn't retry on ${name}`, e.message, false));
    } finally {
      if (!dead) fetchNow();
    }
    byKey(root, `al-dl:${k}`)?.focus({ preventScroll: true });
  }

  function setFilter(v) {
    filter = M.filterOf(v);
    render();
    syncChips();
  }

  // ---------- rules ----------
  /** Saves a rule from its card. One save per rule at a time; a change during one is saved right after. */
  async function saveRule(kind) {
    const s = saving.get(kind);
    if (s) { s.again = true; return; }
    const card = root.querySelector(`[data-al-rule="${kind}"]`), R = M.RULES.find((x) => x.kind === kind), f = (k) => card.querySelector(`[data-al-field="${k}"]`);
    const raw = f(R.key).value.trim();
    if (!raw) return said(kind, "Type a number first.", true);
    const rule = { on: f("on").checked, [R.key]: Number(raw), ...Object.fromEntries(M.CHANNELS.map((ch) => [ch, f(ch).checked])) };
    saving.set(kind, { again: false });
    said(kind, "Saving…");
    try {
      const v = await api("/api/alerts", { method: "PUT", body: JSON.stringify({ rules: { [kind]: rule } }) });
      if (dead) return;
      use(v);
      said(kind, "Saved");
    } catch (e) {
      if (!dead) said(kind, `Not saved. ${e.message}`, true);
    } finally {
      const again = saving.get(kind).again;
      saving.delete(kind);
      if (again && !dead) saveRule(kind);
    }
  }

  /** What a rule change did: on its card, and for screen readers. */
  function said(kind, text, error = false) {
    const el = part("saved", kind);
    if (el) { setText(el, text); el.classList.toggle("is-error", error); }
    setText(slot("said"), `${M.RULES.find((x) => x.kind === kind).title}: ${text}`);
  }

  // ---------- input ----------
  const CLICKS = "[data-al-test], [data-al-open], [data-al-cancel], [data-al-remove], [data-al-retry], [data-al-reload]";
  const onClick = (e) => {
    const t = e.target.closest?.(CLICKS);
    if (!t) return;
    const v = (k) => t.getAttribute(k);
    if (t.matches("[data-al-test]")) sendTest(v("data-al-test"));
    else if (t.matches("[data-al-open]")) { if (editing === v("data-al-open")) closeForm(); else openForm(v("data-al-open")); }
    else if (t.matches("[data-al-cancel]")) closeForm();
    else if (t.matches("[data-al-remove]")) saveForm(t.closest("form"), { remove: true });
    else if (t.matches("[data-al-retry]")) retry(v("data-al-retry"), v("data-al-channel"));
    else { data.status = "loading"; render(); fetchNow(); }
  };
  const onSubmit = (e) => { if (e.target.matches?.("[data-al-form]")) { e.preventDefault(); saveForm(e.target); } };
  const onChange = (e) => { const card = e.target.closest?.("[data-al-rule]"); if (card && e.target.matches("[data-al-field]")) saveRule(card.getAttribute("data-al-rule")); };
  // A rule's number saves on change (Enter or leaving it). Esc closes the webhook form.
  const onKey = (e) => { if (e.key === "Escape" && editing && e.target.closest?.("[data-al-form]")) { e.preventDefault(); closeForm(); } };
  const onSegment = (e) => {
    if (!e.target.closest?.(".al-tabs")) return;
    tab = M.tabOf(e.detail.value);
    saved.set(TAB_KEY, tab);
    for (const pane of root.querySelectorAll("[data-al-pane]")) pane.hidden = pane.getAttribute("data-al-pane") !== tab;
  };
  const onChip = (e) => { if (root.contains(e.target)) setFilter(e.detail.value === filter && filter !== "all" ? "all" : e.detail.value); };
  const handlers = [["click", onClick], ["submit", onSubmit], ["change", onChange], ["keydown", onKey], ["ao-segment", onSegment], ["ao-chip", onChip]];
  for (const [type, fn] of handlers) root.addEventListener(type, fn);

  // ---------- api ----------
  /** The screen is on (true) or not. Coming back after a failed load tries again. */
  function show(on) {
    shown = !!on;
    if (!shown) return;
    if (data.status === "error") data.key = null;
    render();
  }

  function destroy() {
    dead = true;
    for (const t of [data.timer, toastTimer]) clearTimeout(t);
    for (const [type, fn] of handlers) root.removeEventListener(type, fn);
  }

  return { show, render, destroy };
}
