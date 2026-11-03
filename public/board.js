// The Work Board (M7) at #/board: the daily summary with its six KPIs and Copy summary, then today's work three ways:
// Kanban and Projects (from every agent's own to-do list) and Swimlanes (from each session's state-change log).
// The shell owns the live data and calls render(); the board fetches only the plan items.
// Data: GET /api/board while the board shows, again when a plan changed (at most every 3 s); the live snapshot (with
// today's spend per project) and GET /api/timeline come through context(). Any card, row or name opens that agent's
// detail (data-agent).
//
//   const board = createBoard({ root, doc?, win?, api, context: () => ({ snap, status, asOf, colors, settings, timeline, tl }) })
//   board.show(on) · board.render() · board.setFilter(states | null) · board.destroy()
import { staleNote } from "./ui/components.js";
import { createPatch } from "./ui/patch.js";
import { normFilter } from "./office3d-model.js";
import * as M from "./board-model.js";
import * as V from "./board-view.js";

const VIEW_KEY = "ao-board-view", REFETCH_MS = 3000, TOAST_MS = 4000, RESIZE_MS = 150, PX = 900;

export function createBoard({ root, doc = document, win = window, api, context }) {
  const patch = createPatch(doc);
  const saved = { get(k) { try { return win.localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { win.localStorage.setItem(k, v); } catch {} } };
  let view = M.viewOf(saved.get(VIEW_KEY)), shown = false, filter = null, px = 0, dead = false, toastTimer = 0, resizeTimer = 0;
  // GET /api/board: data, status (loading, live, stale, error), okAt (when it last arrived), key (what it was fetched for).
  const plans = { data: null, status: "loading", okAt: null, key: null, lastFetch: 0, inflight: false, again: false, timer: 0 };
  root.classList.add("wb-root");
  root.innerHTML = V.frame({ view });
  const slot = (k) => root.querySelector(`[data-wb="${k}"]`), pane = (v) => root.querySelector(`[data-wb-pane="${v}"]`);
  const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };

  // ---------- data ----------
  /** What the plan items depend on: the day, and each agent's plan version and day. */
  function keyOf(snap) {
    if (!snap) return null;
    const day = (t) => new Date(t).toDateString();
    return [day(Date.now()), ...snap.agents.map((a) => `${a.session}:${a.planAt || ""}:${day(a.updated)}`)].join("|");
  }

  function want(snap) {
    const key = keyOf(snap);
    if (!key || key === plans.key) return;
    plans.key = key;
    fetchSoon();
  }

  function fetchSoon() {
    clearTimeout(plans.timer);
    const wait = plans.lastFetch + REFETCH_MS - Date.now();
    if (wait <= 0) fetchNow(); else plans.timer = setTimeout(fetchNow, wait);
  }

  async function fetchNow() {
    if (plans.inflight) { plans.again = true; return; }
    Object.assign(plans, { inflight: true, again: false, lastFetch: Date.now() });
    try {
      const d = await api("/api/board");
      if (dead) return;
      Object.assign(plans, { data: d, status: "live", okAt: Date.now() });
    } catch {
      if (dead) return;
      plans.status = plans.data ? "stale" : "error";
    } finally { plans.inflight = false; }
    render();
    if (plans.again) fetchSoon();
  }

  // ---------- rendering ----------
  // A view whose data is behind is drawn as of then: its wait times and bars stop at the "As of" time it shows.
  const at = (stale, now) => (stale != null ? +new Date(stale) : now);

  /** Kanban needs the live data and the plan items: the first one missing decides. */
  function kanbanOf(c, now, s) {
    if (!c.snap) return { html: c.status === "error" ? V.failedPanel("state", "Tasks") : V.kanbanPane() };
    if (!plans.data) return { html: plans.status === "error" ? V.failedPanel("plans", "Tasks") : V.kanbanPane() };
    const stale = c.status === "stale" ? c.asOf : plans.status === "stale" ? plans.okAt : null;
    const k = M.kanban(c.snap, plans.data, { now: at(stale, now), colors: c.colors });
    return { html: V.kanbanPane({ k, filter, hint: !k.hasPlans && !s.empty }), stale };
  }

  /** Projects come from the live data alone. */
  function projectsOf(c, now) {
    if (!c.snap) return { html: c.status === "error" ? V.failedPanel("state", "Projects") : V.projectsPane() };
    const stale = c.status === "stale" ? c.asOf : null;
    return { html: V.projectsPane({ cards: M.projects(c.snap, { now: at(stale, now), colors: c.colors }), filter, now: at(stale, now) }), stale };
  }

  /** Swimlanes need the timeline; the live data names the rows. Behind is the older of the two: the stream's "As of"
   *  or the timeline's last load. Only while both are live does the running segment go on towards now. */
  function lanesOf(c, now) {
    const tl = c.tl || {};
    if (!c.timeline) return { html: tl.status === "error" ? V.failedPanel("timeline", V.VIEW_TITLES.swimlanes) : V.lanesPane({ loading: true }) };
    const behind = [c.status === "stale" ? c.asOf : null, tl.status === "stale" ? tl.okAt : null].filter((t) => t != null).map((t) => +new Date(t));
    const stale = behind.length ? Math.min(...behind) : null;
    const L = M.swimlanes(c.timeline, c.snap, { now, live: stale == null && c.status === "live", until: stale, colors: c.colors, px: px || PX });
    return { html: V.lanesPane({ L, filter }), stale };
  }

  /** Redraws what changed, keeping focus and scroll (patch.js). Only while the board shows. */
  function render() {
    if (!shown || dead) return;
    const c = context(), now = Date.now();
    want(c.snap);
    setText(slot("date"), `From every agent's own to-do list · ${M.dayTitle(now)}`);
    const s = c.snap ? M.summary(c.snap, { now, budget: (c.settings || {}).dailyBudgetUsd }) : null;
    const status = !c.snap ? (c.status === "error" ? "error" : "loading") : c.status === "stale" ? "stale" : "live";
    patch(slot("summary"), V.summaryPanel({ s, status, asOf: c.asOf }));
    setText(slot("view-h"), V.VIEW_TITLES[view]);
    const out = view === "swimlanes" ? lanesOf(c, now) : view === "projects" ? projectsOf(c, now) : kanbanOf(c, now, s);
    const p = pane(view), stale = out.stale ?? null;
    p.classList.toggle("ao-stale", stale != null);
    patch(p, out.html);
    patch(slot("note"), stale != null ? staleNote(stale) : "");
    // Which swimlane labels fit depends on the track's width: measured once it's drawn.
    const w = view === "swimlanes" ? p.querySelector(".wb-bar")?.clientWidth || 0 : 0;
    if (w && Math.abs(w - (px || PX)) > 40) { px = w; render(); }
  }

  function setView(v) {
    view = M.viewOf(v);
    saved.set(VIEW_KEY, view);
    for (const p of root.querySelectorAll("[data-wb-pane]")) {
      if (p.getAttribute("data-wb-pane") === view) p.removeAttribute("hidden"); else p.setAttribute("hidden", "");
    }
    render();
  }

  function showToast(ok) {
    const box = slot("toasts");
    box.innerHTML = V.copyToast(ok);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.innerHTML = ""; }, TOAST_MS);
  }

  // ---------- input ----------
  const onSegment = (e) => { if (e.target.closest?.(".wb-views")) setView(e.detail.value); };
  const onClick = (e) => {
    if (!e.target.closest?.("[data-wb-retry]")) return;
    plans.status = "loading";
    render();
    fetchNow();
  };
  const onCopied = (e) => { if (e.target.closest?.("[data-wb-copy]")) showToast(e.detail.ok); };
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (view === "swimlanes") render(); }, RESIZE_MS); };
  const handlers = [["ao-segment", onSegment], ["click", onClick], ["ao-copied", onCopied]];
  for (const [type, fn] of handlers) root.addEventListener(type, fn);
  win.addEventListener("resize", onResize);

  // ---------- api ----------
  /** The board is on screen (true) or not. Coming back after a failed load tries again. */
  function show(on) {
    shown = !!on;
    if (!shown) return;
    if (plans.status === "error") plans.key = null;
    render();
  }

  /** The top bar's state chips: agents in other states dim, as in the office. */
  function setFilter(states) {
    filter = normFilter(states);
    render();
  }

  function destroy() {
    dead = true;
    for (const t of [plans.timer, toastTimer, resizeTimer]) clearTimeout(t);
    for (const [type, fn] of handlers) root.removeEventListener(type, fn);
    win.removeEventListener("resize", onResize);
  }

  return { show, render, setFilter, destroy };
}
