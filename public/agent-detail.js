// The Agent Detail slide-over (M6): one agent's header and facts, mission, conversation (answer it, or message it),
// plan, trace and files & usage, in a <dialog> the shell owns. Opened from any screen; the shell feeds it live data.
// Data: GET /api/agents/:id on open and when the agent changes (at most every 2 s); POST /api/agents/:id/message;
// POST /api/agents/:id/name. Answers go through the shell's answer flow (POST /api/answer), which calls answered().
//
//   const detail = createAgentDetail({ dialog, doc?, api, agentOf: (id) => snapshotAgent, context: () => ({ status, asOf, colors, route }) })
//   detail.open(id) → bool · detail.goTo(section) → bool · detail.update() · detail.answered(sent) · detail.close() · detail.destroy()
import { staleNote } from "./ui/components.js";
import { esc } from "./ui/format.js";
import { createPatch } from "./ui/patch.js";
import { projectKey } from "./office3d-model.js";
import * as M from "./agent-detail-model.js";
import * as V from "./agent-detail-view.js";
import { answerView, answerLeft, deliveryView, answerNotice } from "./shell-model.js";
import { answerBox, answerStatus } from "./shell-view.js";

const REFETCH_MS = 2000, PAGE = 150, CONVO = 40, TICK_MS = 1000, REDRAW_MS = 5000;
const ANSWERING = new Set(["form", "terminal"]);
const SECTIONS = ["mission", "convo", "plan", "trace", "files"];

export function createAgentDetail({ dialog, doc = document, api, agentOf, context = () => ({}) }) {
  const patch = createPatch(doc);
  const slot = (k) => dialog.querySelector(`[data-ad="${k}"]`);
  const setText = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };
  // st = the open agent: id, a (last seen), data (the detail), load (loading/live/stale/error/gone), filters, open rows.
  let st = null, fetchTimer = 0, ticker = 0;

  // ---------- data ----------
  async function fetchNow() {
    const mine = st;
    if (!mine) return;
    if (mine.inflight) { mine.again = true; return; }
    Object.assign(mine, { inflight: true, again: false, lastFetch: Date.now() });
    try {
      const d = await api(`/api/agents/${encodeURIComponent(mine.id)}`);
      if (st !== mine) return;
      Object.assign(mine, { data: d, load: "live", dataAt: Date.now() });
    } catch (e) {
      if (st !== mine) return;
      mine.load = mine.data ? "stale" : e.status === 404 || e.status === 400 ? "gone" : "error";
    } finally { mine.inflight = false; }
    renderAll();
    if (mine.again) fetchSoon();
  }

  function fetchSoon() {
    if (!st) return;
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(fetchNow, Math.max(0, st.lastFetch + REFETCH_MS - Date.now()));
  }

  /** The agent as the live snapshot has it; otherwise (older than a day, or it left) the detail's copy; null before
   *  the detail arrives for an agent the snapshot never had. */
  const agentNow = () => agentOf(st.id) || (st.data && st.data.agent) || st.a;

  // ---------- rendering ----------
  /** No agent to show yet: the session id, with a skeleton while it loads. */
  function renderBare() {
    for (const k of ["avatar", "sub", "facts", "asof", "composer", "composer-note", "status"]) patch(slot(k), "");
    setText(slot("title"), "Agent details");
    patch(slot("name"), V.bareName(st.id, { loading: st.load === "loading" }));
    st.nameShown = null;
  }

  /** The parts that follow the live snapshot: header, facts, "As of", and the message or answer box. */
  function renderHead() {
    const a = (st.a = agentNow()), ctx = context(), now = Date.now();
    if (!a) return renderBare();
    patch(slot("avatar"), V.avatarBadge(a, ctx.colors && ctx.colors.get(projectKey(a))));
    setText(slot("title"), `Agent details: ${a.name}`);
    const input = dialog.querySelector("#ad-name-in");
    // Your edit wins until you save it or leave the field.
    if (!input || (st.nameShown !== a.name && doc.activeElement !== input)) { patch(slot("name"), V.nameForm(a)); st.nameShown = a.name; }
    patch(slot("sub"), V.subLine(a, { now }));
    patch(slot("facts"), V.facts(a, { now, avgCost: st.data ? st.data.avgCost : null }));
    const asOf = ctx.status === "stale" ? ctx.asOf : st.load === "stale" ? st.dataAt : null;
    patch(slot("asof"), asOf ? staleNote(asOf) : "");
    slot("body").classList.toggle("ao-stale", !!asOf);
    renderComposer(a, now);
  }

  /** Answer it (it needs you), message it, or say why you can't. The box is redrawn only when that changes, so text
   *  you're typing survives; if it goes from under your focus, focus moves to the Conversation heading, and a screen
   *  reader hears why. */
  function renderComposer(a, now) {
    const mode = M.composerMode(a), box = slot("composer"), had = box.contains(doc.activeElement);
    const sent = st.sent && a.question && st.sent.questionId === a.question.id ? st.sent : null;
    let html = "", v = null;
    if (mode === "answer") { v = answerView(a, { q: a.question, now }); html = sent ? "" : `<div class="ad-answer">${answerBox(v, a, a.question, { prefix: "ad-" })}</div>`; }
    else html = mode === "message" ? V.messageForm() : mode === "offline" ? V.offlineNote(a) : V.endedNote();
    const before = st.mode;
    st.mode = sent ? "sent" : v ? v.mode : mode;
    if (ANSWERING.has(before) && before !== st.mode && st.mode !== "sent") st.say = answerNotice(v || { mode: "over" }, a);
    patch(box, html);
    if (had && !box.contains(doc.activeElement)) dialog.querySelector("#ad-convo-h").focus({ preventScroll: true });
    const left = box.querySelector("[data-answer-left]");
    if (left && v && v.ask) setText(left, answerLeft(v.ask.until, now));
    patch(slot("composer-note"), mode === "message" ? esc(M.deliveryHint(a)) : "");
    patch(slot("status"), st.sent ? answerStatus(deliveryView(a, st.sent, now)) : st.note ? V.statusNote(st.note) : st.say ? `<p class="ao-sr">${esc(st.say)}</p>` : "");
  }

  /** The sections built from the detail: on every fetch, filter or toggle, and every few seconds for running steps. */
  function renderData() {
    const d = st.data, a = st.a, now = Date.now();
    const failed = !d && (st.load === "error" || st.load === "gone");
    patch(slot("state"), failed ? V.bodyState(st.load) : "");
    for (const k of SECTIONS) {
      const sec = dialog.querySelector(`#ad-sec-${k}`);
      if (failed) sec.setAttribute("hidden", ""); else sec.removeAttribute("hidden");
    }
    if (!d) { if (!failed) for (const k of SECTIONS) patch(slot(k), V.sectionLoading(k)); patch(slot("filters"), ""); return; }
    st.drawnAt = now;
    patch(slot("mission"), V.missionSection(d.mission, { open: !!st.open.get("mission") }));
    patch(slot("convo"), V.convoSection(M.conversation(d, a), { limit: st.convoLimit, open: st.open }));
    patch(slot("plan"), V.planSection(M.planView(d.plan)));
    const m = M.traceModel({ ...d, agent: a }, { now });
    patch(slot("filters"), V.traceFilters(m, st.filter));
    patch(slot("trace"), V.traceList(M.filterRows(m.rows, st.filter), m, { limit: st.limit, open: st.open }));
    patch(slot("files"), V.filesSection(M.fileRows(d.files), M.usageView(d, a, { now }), { file: st.filter.file }));
  }

  function renderAll() { if (!st) return; renderHead(); renderData(); }

  // ---------- actions ----------
  /** Scrolls to a section (mission, convo, plan, trace, files) and moves focus to its heading. False if there's none. */
  function goTo(section) {
    const sec = SECTIONS.includes(section) ? dialog.querySelector(`#ad-sec-${section}`) : null;
    if (!sec) return false;
    sec.scrollIntoView?.({ block: "start" });
    dialog.querySelector(`#ad-${section}-h`).focus({ preventScroll: true });
    return true;
  }

  const setFilter = (f) => { Object.assign(st.filter, f); st.limit = PAGE; renderData(); };

  async function sendMessage(form) {
    const area = form.querySelector("textarea"), text = area.value.trim(), err = form.querySelector("[data-ad-msg-error]"), send = form.querySelector("[data-ad-send]");
    if (!text || st.sending) return;
    const mine = st;
    mine.sending = true;
    for (const c of [area, send]) c.setAttribute("disabled", "");
    form.setAttribute("aria-busy", "true");
    setText(err, "");
    try {
      await api(`/api/agents/${encodeURIComponent(mine.id)}/message`, { method: "POST", body: JSON.stringify({ text }) });
      if (st !== mine) return;
      area.value = "";
      Object.assign(mine, { sent: null, say: null, note: "Message sent. It gets it the next time it stops." });
      renderHead();
      fetchNow();
    } catch (e) {
      if (st === mine) setText(err, `Couldn't send your message. ${e.message}`);
    } finally {
      mine.sending = false;
      area.removeAttribute("disabled");
      form.removeAttribute("aria-busy");
      if (area.value.trim()) send.removeAttribute("disabled");
    }
  }

  async function saveName(form) {
    const input = form.querySelector("input"), name = input.value.trim(), say = slot("name-status"), mine = st;
    say.classList.remove("is-error");
    setText(say, "Saving…");
    try {
      const r = await api(`/api/agents/${encodeURIComponent(mine.id)}/name`, { method: "POST", body: JSON.stringify({ name }) });
      if (st !== mine) return;
      input.value = r.name;
      mine.nameShown = r.name;
      setText(say, name ? "Name saved." : "Back to the automatic name.");
    } catch (e) {
      if (st !== mine) return;
      say.classList.add("is-error");
      setText(say, `Couldn't save the name. ${e.message}`);
    }
  }

  // ---------- input ----------
  const onClick = (e) => {
    const t = e.target.closest?.("[data-ad-section], [data-ad-toggle], [data-ad-more], [data-ad-file], [data-ad-clear], [data-ad-earlier], [data-ad-retry]");
    if (!t || !st) return;
    const v = (k) => t.getAttribute(k);
    if (t.matches("[data-ad-section]")) { e.preventDefault(); goTo(v("data-ad-section")); }
    else if (t.matches("[data-ad-toggle], [data-ad-more]")) {
      const key = v("data-ad-toggle") ?? v("data-ad-more");
      st.open.set(key, t.getAttribute("aria-expanded") !== "true");
      renderData();
    } else if (t.matches("[data-ad-file]")) {
      const file = v("data-ad-file");
      setFilter(st.filter.file === file ? { file: null } : { cat: "all", errors: false, file });
      goTo("trace");
    } else if (t.matches("[data-ad-clear]")) { setFilter({ cat: "all", errors: false, file: null }); dialog.querySelector("#ad-trace-h").focus({ preventScroll: true }); }
    else if (t.matches("[data-ad-earlier]")) {
      if (v("data-ad-earlier") === "convo") st.convoLimit += CONVO; else st.limit += PAGE;
      renderData();
    } else if (t.matches("[data-ad-retry]")) { st.load = "loading"; renderData(); fetchNow(); }
  };
  const onSegment = (e) => { if (st && e.target.closest?.(".ad-cats")) setFilter({ cat: e.detail.value }); };
  const onChip = (e) => { if (st && e.detail.value === "errors") setFilter({ errors: e.detail.pressed }); };
  const onChange = (e) => { if (st && e.target.matches?.("[data-ad-files]")) setFilter({ file: e.target.value || null }); };
  const onSubmit = (e) => {
    if (!st) return;
    if (e.target.matches?.("[data-ad-message]")) { e.preventDefault(); sendMessage(e.target); }
    else if (e.target.matches?.("[data-ad-name]")) { e.preventDefault(); saveName(e.target); }
  };
  const onInput = (e) => {
    const area = e.target.closest?.(".ad-msg");
    if (!area || !st || st.sending) return;
    const send = area.closest("form").querySelector("[data-ad-send]");
    if (area.value.trim()) send.removeAttribute("disabled"); else send.setAttribute("disabled", "");
  };
  // Esc closes it from anywhere inside (the browser's own Esc for a modal dialog does the same).
  const onKey = (e) => {
    if (!st) return;
    if (e.key === "Escape") { e.preventDefault(); dialog.close(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.closest?.(".ad-msg")) { e.preventDefault(); sendMessage(e.target.closest("form")); }
  };
  const handlers = [["click", onClick], ["ao-segment", onSegment], ["ao-chip", onChip], ["change", onChange], ["submit", onSubmit], ["input", onInput], ["keydown", onKey]];
  for (const [type, fn] of handlers) dialog.addEventListener(type, fn);

  // ---------- api ----------
  /** Starts on a session: from the live snapshot if it has it, else (a link to an older one, or an id the server may
   *  not know) on what GET /api/agents/:id says. False only without an id. The shell shows the dialog. */
  function open(id) {
    if (typeof id !== "string" || !id) return false;
    close();
    st = { id, a: agentOf(id), data: null, load: "loading", dataAt: null, inflight: false, again: false, lastFetch: 0, key: null, nameShown: null,
      filter: { cat: "all", errors: false, file: null }, open: new Map(), limit: PAGE, convoLimit: CONVO, sent: null, note: null, say: null, mode: null, drawnAt: 0 };
    dialog.innerHTML = V.frame({ back: M.backLabel(context().route) });
    renderAll();
    fetchNow();
    // The time left to answer here ticks every second; running steps and waits redraw every few seconds.
    ticker = setInterval(() => {
      if (!st || !dialog.open) return;
      if (st.a) renderComposer(st.a, Date.now());
      if (st.data && Date.now() - st.drawnAt >= REDRAW_MS) renderData();
    }, TICK_MS);
    return true;
  }

  /** New live data: the header follows it at once; the detail is fetched again when the agent changed. */
  function update() {
    if (!st || !dialog.open) return;
    const a = agentOf(st.id), q = a && a.question;
    const key = a ? [a.updated, a.state, a.queued, a.name, q && q.id, q && q.ask && q.ask.id, a.answer && a.answer.delivered].join("|") : "gone";
    if (st.key != null && key !== st.key) fetchSoon();
    st.key = key;
    renderHead();
  }

  /** Your answer from the inline answer box went out (the shell posted it). */
  function answered(sent) {
    if (!st) return;
    Object.assign(st, { sent, note: null, say: null });
    renderHead();
    dialog.querySelector("#ad-convo-h").focus({ preventScroll: true });
  }

  function close() {
    clearTimeout(fetchTimer);
    clearInterval(ticker);
    st = null;
  }

  function destroy() {
    close();
    for (const [type, fn] of handlers) dialog.removeEventListener(type, fn);
  }

  return { open, update, answered, close, destroy, goTo: (section) => !!st && goTo(section), isOpen: () => !!st, current: () => (st ? st.id : null) };
}
