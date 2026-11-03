// The Meeting Hall (M8) at #/hall: each room's standup, written by Virtual Office from each agent's plan and activity.
// Room tabs, Replay standup (one bubble every 1.1 s) and Copy summary; who is at the table; the transcript; a message
// to the room; and a rail with the decisions waiting on you, where agents overlap and the room's scorecard.
// The shell owns the live data and calls render(); the hall fetches only what the snapshot doesn't carry.
// Data: GET /api/rooms (plan items, files edited by more than one agent today, today's room messages) while the hall
// shows, again when an agent's plan, inbox, state or steps changed (at most every 3 s); POST /api/rooms/:project/message.
// Answer and Trace open the agent's detail at that section (data-agent, data-agent-at).
//
//   const hall = createHall({ root, doc?, win?, api, context: () => ({ snap, status, asOf, colors, settings }), stepMs? })
//   hall.show(on) · hall.render() · hall.setFilter(states | null) · hall.destroy()
import { staleNote } from "./ui/components.js";
import { createPatch } from "./ui/patch.js";
import { normFilter } from "./office3d-model.js";
import * as H from "./hall-model.js";
import * as V from "./hall-view.js";

const ROOM_KEY = "ao-hall-room", REFETCH_MS = 3000, TOAST_MS = 4000, LOG_LINES = 20;

export function createHall({ root, doc = document, win = window, api, context, stepMs = H.STEP_MS }) {
  const patch = createPatch(doc);
  const saved = { get(k) { try { return win.localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { win.localStorage.setItem(k, v); } catch {} } };
  let room = saved.get(ROOM_KEY) ?? H.ALL, shown = false, filter = null, dead = false, toastTimer = 0, view = null, sending = false;
  // GET /api/rooms: data, status (loading, live, stale, error), okAt (when it last arrived), key (what it was fetched for).
  // sent = room messages you just sent, shown until the next fetch has them.
  const rooms = { data: null, status: "loading", okAt: null, key: null, lastFetch: 0, inflight: false, again: false, timer: 0, sent: new Map() };
  // replay = { order (bubble keys, frozen at the start), n (how many are shown), timer }; open = who waited on you at
  // the last render, to announce their answers.
  let replay = null, open = null;
  root.classList.add("mh-root");
  root.innerHTML = V.frame();
  const slot = (k) => root.querySelector(`[data-mh="${k}"]`);
  const setText = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };

  // ---------- data ----------
  /** What GET /api/rooms depends on: the day, and each agent's plan, inbox, state and step count. */
  function keyOf(snap) {
    if (!snap) return null;
    const day = (t) => new Date(t).toDateString();
    return [day(Date.now()), ...snap.agents.map((a) => `${a.session}:${a.planAt || ""}:${a.queued}:${a.state}:${a.toolCount}:${day(a.updated)}`)].join("|");
  }

  function want(snap) {
    const key = keyOf(snap);
    if (!key || key === rooms.key) return;
    rooms.key = key;
    fetchSoon();
  }

  function fetchSoon() {
    clearTimeout(rooms.timer);
    const wait = rooms.lastFetch + REFETCH_MS - Date.now();
    if (wait <= 0) fetchNow(); else rooms.timer = setTimeout(fetchNow, wait);
  }

  async function fetchNow() {
    if (rooms.inflight) { rooms.again = true; return; }
    Object.assign(rooms, { inflight: true, again: false, lastFetch: Date.now() });
    try {
      const d = await api("/api/rooms");
      if (dead) return;
      const today = new Date().toDateString();
      for (const m of d.messages || []) rooms.sent.delete(m.id);
      for (const [id, m] of rooms.sent) if (new Date(m.t).toDateString() !== today) rooms.sent.delete(id);
      Object.assign(rooms, { data: d, status: "live", okAt: Date.now() });
    } catch {
      if (dead) return;
      rooms.status = rooms.data ? "stale" : "error";
    } finally { rooms.inflight = false; }
    render();
    if (rooms.again) fetchSoon();
  }

  /** The rooms data with the messages you just sent that it doesn't have yet. */
  const roomsData = () => (rooms.data && rooms.sent.size ? { ...rooms.data, messages: [...rooms.data.messages, ...rooms.sent.values()] } : rooms.data);

  // ---------- rendering ----------
  function log(text) {
    const box = slot("log"), p = doc.createElement("p");
    p.textContent = text;
    box.append(p);
    while (box.children.length > LOG_LINES) box.firstElementChild.remove();
  }

  /** Redraws what changed, keeping focus and scroll (patch.js). Only while the hall shows. Data that is behind is drawn as
   *  of its "As of" time. */
  function render() {
    if (!shown || dead) return;
    const c = context(), now = Date.now();
    want(c.snap);
    const status = !c.snap ? (c.status === "error" ? "error" : "loading") : c.status === "stale" ? "stale" : "live";
    const asOf = status === "stale" ? c.asOf : null, at = asOf != null ? +new Date(asOf) : now;
    const behind = [asOf != null ? at : null, rooms.status === "stale" ? rooms.okAt : null].filter((t) => t != null);
    const roomsAsOf = behind.length ? Math.min(...behind) : null;
    const tabs = c.snap ? H.roomTabs(c.snap.agents, { now: at, colors: c.colors }) : [];
    // The room emptied (its agents left today's table): back to All rooms, and a replay of it ends.
    if (c.snap && !tabs.some((t) => t.value === room)) {
      room = H.ALL; open = null;
      if (endReplay()) log("Replay stopped: nobody from that room is at the table now.");
    }
    view = c.snap ? H.hall(c.snap, roomsData(), { room, now: at, colors: c.colors, offlineMin: (c.settings || {}).offlineAfterMin || 30 }) : null;
    const frame = replay && view ? H.replayFrame(view.bubbles, replay.order, replay.n) : null;
    patch(slot("tabs"), c.snap ? V.roomTabs(tabs, room) : "");
    patch(slot("tools"), V.tools({ text: view ? view.text : "", replaying: !!replay, ready: !!(view && view.bubbles) }));
    patch(slot("table"), V.tablePanel({ v: view, status, asOf, filter, speaking: frame && frame.speaking }));
    patch(slot("transcript"), V.transcriptPanel({ v: view, status, asOf: roomsAsOf, rooms: rooms.status, frame, filter }));
    renderCompose(status, asOf);
    patch(slot("decisions"), V.decisionsPanel({ v: view, status, asOf }));
    patch(slot("overlaps"), V.overlapsPanel({ v: view, status, asOf: roomsAsOf, rooms: rooms.status }));
    patch(slot("score"), V.scorePanel({ v: view, status, asOf }));
    announceAnswers();
  }

  /** The message box: drawn once per room, so your text survives; who gets it and the Send label follow the live data
   *  (dimmed, with "As of", while it's behind). */
  function renderCompose(status, asOf) {
    const mode = !view ? (status === "error" ? "error" : "loading") : view.empty ? "empty" : room === H.ALL ? "all" : !view.project ? "noproject" : "form";
    patch(slot("compose"), V.composePanel({ mode, room }));
    if (mode !== "form") return;
    const n = view.reach.filter((r) => r.can).length, form = root.querySelector("[data-mh-form]");
    setText(slot("send-label"), V.sendLabel(n));
    patch(slot("reach"), V.reachList(view.reach));
    patch(slot("reach-asof"), asOf != null ? staleNote(asOf) : "");
    slot("reach").classList.toggle("ao-stale", asOf != null);
    if (!sending) setDisabled(form.querySelector("[data-mh-send]"), !n || !form.querySelector("textarea").value.trim());
  }

  const setDisabled = (el, on) => { if (on) el.setAttribute("disabled", ""); else el.removeAttribute("disabled"); };

  /** An answer from the Agent Detail reached someone in the Decisions list: say so ("refund flow: Approved once"). */
  function announceAnswers() {
    if (!view) return;
    const now = new Set(view.decisions.filter((d) => d.open).map((d) => d.session));
    if (open) for (const d of view.decisions) if (!d.open && open.has(d.session)) log(`${d.name}: ${d.text}`);
    open = now;
  }

  // ---------- replay ----------
  function startReplay() {
    if (!view || !view.bubbles) return;
    replay = { order: view.bubbles.map((b) => b.key), n: 0, timer: setTimeout(step, stepMs) };
    log("Replaying the standup, one speaker at a time.");
    render();
  }

  function step() {
    if (!replay) return;
    replay.n++;
    const b = view && view.bubbles && view.bubbles.find((x) => x.key === replay.order[replay.n - 1]);
    if (b) log(H.spoken(b));
    if (replay.n >= replay.order.length) { replay = null; log("End of the standup."); } else replay.timer = setTimeout(step, stepMs);
    render();
  }

  /** Ends a replay without drawing. True if one was running. */
  function endReplay() {
    if (!replay) return false;
    clearTimeout(replay.timer);
    replay = null;
    return true;
  }

  function stopReplay(say = true) {
    if (!endReplay()) return;
    if (say) log("Replay stopped. The whole standup shows again.");
    render();
  }

  // ---------- message the room ----------
  async function sendMessage(form) {
    const area = form.querySelector("textarea"), text = area.value.trim(), err = form.querySelector("[data-mh-error]"), btn = form.querySelector("[data-mh-send]");
    const v = view, target = room;
    if (!text || sending || !v || !v.project || !v.reach.some((r) => r.can)) return;
    sending = true;
    for (const el of [area, btn]) setDisabled(el, true);
    form.setAttribute("aria-busy", "true");
    setText(err, "");
    try {
      // The table (at most 50): the server queues it for those who can take it and records why the others can't.
      const r = await api(`/api/rooms/${encodeURIComponent(v.project)}/message`, { method: "POST", body: JSON.stringify({ text, sessions: H.recipients(v.reach) }) });
      if (dead) return;
      rooms.sent.set(r.message.id, r.message);
      if (room === target) area.value = "";
      const n = r.message.to.length, say = `Sent to ${n} ${n === 1 ? "agent" : "agents"}. Each gets it the next time it stops.`;
      if (room === target) patch(slot("status"), V.sentNote(say));
      log(say);
      showToast(V.sentToast(n, target));
      rooms.key = null;
      fetchSoon();
    } catch (e) {
      if (!dead && room === target) setText(err, `Couldn't send your message. ${e.message}`);
    } finally {
      sending = false;
      form.removeAttribute("aria-busy");
      setDisabled(area, false);
      render();
    }
  }

  function showToast(html) {
    const box = slot("toasts");
    box.innerHTML = html;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.innerHTML = ""; }, TOAST_MS);
  }

  function setRoom(v) {
    room = v;
    saved.set(ROOM_KEY, room);
    open = null;
    stopReplay(false);
    render();
  }

  // ---------- input ----------
  const onSegment = (e) => { if (e.target.closest?.(".mh-rooms")) setRoom(e.detail.value); };
  const onClick = (e) => {
    const t = e.target.closest?.("[data-mh-replay], [data-mh-retry]");
    if (!t) return;
    if (t.matches("[data-mh-replay]")) { if (replay) stopReplay(); else startReplay(); return; }
    rooms.status = "loading";
    render();
    fetchNow();
  };
  const onCopied = (e) => { if (e.target.closest?.("[data-mh-copy]")) showToast(V.copyToast(e.detail.ok)); };
  const onSubmit = (e) => { if (e.target.matches?.("[data-mh-form]")) { e.preventDefault(); sendMessage(e.target); } };
  const onInput = (e) => {
    if (!e.target.closest?.(".mh-msg") || sending || !view) return;
    setDisabled(root.querySelector("[data-mh-send]"), !e.target.value.trim() || !view.reach.some((r) => r.can));
    patch(slot("status"), "");
  };
  // Ctrl+Enter (⌘+Enter) sends; Esc stops a replay (overlays live outside the hall and close themselves).
  const onKey = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.closest?.(".mh-msg")) { e.preventDefault(); sendMessage(e.target.closest("form")); }
    else if (e.key === "Escape" && replay) { e.preventDefault(); stopReplay(); }
  };
  const handlers = [["ao-segment", onSegment], ["click", onClick], ["ao-copied", onCopied], ["submit", onSubmit], ["input", onInput], ["keydown", onKey]];
  for (const [type, fn] of handlers) root.addEventListener(type, fn);

  // ---------- api ----------
  /** The hall is on screen (true) or not. Leaving it stops a replay; coming back after a failed load tries again. */
  function show(on) {
    shown = !!on;
    if (!shown) { stopReplay(false); return; }
    if (rooms.status === "error") rooms.key = null;
    render();
  }

  /** The top bar's state chips: agents in other states dim, as in the office. */
  function setFilter(states) {
    filter = normFilter(states);
    render();
  }

  function destroy() {
    dead = true;
    endReplay();
    for (const t of [rooms.timer, toastTimer]) clearTimeout(t);
    for (const [type, fn] of handlers) root.removeEventListener(type, fn);
  }

  return { show, render, setFilter, destroy };
}
