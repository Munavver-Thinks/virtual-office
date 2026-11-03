// The Cost Report (M9) at #/cost: "Updated 15:42", the Today / 7 days switch and Export CSV; KPI tiles with rings; spend
// by day over 14 days with the daily budget line; spend by project, by model and what prompt caching saved (an
// estimate, with the price table); spend by agent and the 5 costliest sessions. Agents and View trace open the Agent
// Detail (data-agent); the top bar's state chips dim other agents here too.
// Data: GET /api/cost while the report shows, again when the live data's spend changed (at most every 3 s);
// GET /api/cost/export?range= for Export CSV. The shell owns the live data and calls render().
//
//   const cost = createCost({ root, doc?, win?, api, context: () => ({ snap, status, asOf, colors, settings }) })
//   cost.show(on) · cost.render() · cost.setFilter(states | null) · cost.destroy()
//   api(path, { raw: true }) must resolve to the Response itself (for the CSV).
import { createPatch } from "./ui/patch.js";
import { normFilter } from "./office3d-model.js";
import * as M from "./cost-model.js";
import * as V from "./cost-view.js";

const RANGE_KEY = "ao-cost-range", REFETCH_MS = 3000, TOAST_MS = 6000, FILE = "virtual-office-requests.csv";

export function createCost({ root, doc = document, win = window, api, context }) {
  const patch = createPatch(doc);
  const saved = { get(k) { try { return win.localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { win.localStorage.setItem(k, v); } catch {} } };
  let range = M.rangeOf(saved.get(RANGE_KEY)), shown = false, filter = null, dead = false, exporting = false, toastTimer = 0;
  // GET /api/cost: the report, status (loading, live, stale, error), key (what it was fetched for).
  const data = { report: null, status: "loading", key: null, lastFetch: 0, inflight: false, again: false, timer: 0 };
  root.classList.add("cr-root");
  root.innerHTML = V.frame({ range });
  const slot = (k) => root.querySelector(`[data-cr="${k}"]`);

  // ---------- data ----------
  /** What the report depends on: the day, and the spend the live data has seen (it changes with every request). */
  function keyOf(snap) {
    const p = snap && snap.totals && snap.totals.periods && snap.totals.periods["30d"];
    return `${new Date().toDateString()}|${p ? `${p.requests}:${p.cost}` : "-"}`;
  }

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
      const r = await api("/api/cost");
      if (dead) return;
      Object.assign(data, { report: r, status: "live" });
    } catch {
      if (dead) return;
      data.status = data.report ? "stale" : "error";
    } finally { data.inflight = false; }
    render();
    if (data.again) fetchSoon();
  }

  // ---------- rendering ----------
  /** Redraws what changed, keeping focus and scroll (patch.js). Only while the report shows. Behind (the last load
   *  failed, or the live data stopped) = the last report, dimmed, "As of" its time. */
  function render() {
    if (!shown || dead) return;
    const c = context(), r = data.report;
    want(c.snap);
    const status = !r ? (data.status === "error" ? "error" : "loading") : data.status === "stale" || c.status === "stale" ? "stale" : "live";
    const budget = Math.max(0, +(c.settings || {}).dailyBudgetUsd || 0), monthly = Math.max(0, +(c.settings || {}).monthlyBudgetUsd || 0), asOf = r ? r.t : null;
    const v = r ? M.report(r, { range, budget, monthly, colors: c.colors, live: c.snap ? c.snap.agents : [] }) : null, o = { v, status, asOf, filter };
    patch(slot("updated"), V.updated(status, asOf));
    patch(slot("export"), V.exportButton({ ready: !!v && v.requests > 0, busy: exporting, range }));
    patch(slot("kpis"), V.kpiPanel({ ...o, budget }));
    patch(slot("days"), V.daysPanel(o));
    patch(slot("projects"), V.projectsPanel(o));
    patch(slot("models"), V.modelsPanel(o));
    patch(slot("cache"), V.cachePanel(o));
    patch(slot("agents"), V.agentsPanel(o));
    patch(slot("top"), V.topPanel(o));
  }

  // ---------- export ----------
  /** Downloads the period's requests as CSV, then says which file and how many rows (or what went wrong). */
  async function exportCsv() {
    if (exporting) return;
    const what = range;
    exporting = true;
    render();
    try {
      const res = await api(`/api/cost/export?range=${what}`, { raw: true });
      const text = await res.text();
      if (dead) return;
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || FILE;
      save(text, name);
      showToast(V.exportToast({ ok: true, name, rows: Number(res.headers.get("X-Rows")) || 0, partial: res.headers.get("X-Partial") === "1", range: what }));
    } catch (e) {
      if (!dead) showToast(V.exportToast({ ok: false, error: e.message }));
    } finally {
      exporting = false;
      render();
    }
  }

  /** Hands the text to the browser as a file download. */
  function save(text, name) {
    const url = win.URL.createObjectURL(new win.Blob([text], { type: "text/csv;charset=utf-8" })), a = doc.createElement("a");
    a.setAttribute("href", url);
    a.setAttribute("download", name);
    a.setAttribute("hidden", "");
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => win.URL.revokeObjectURL(url), 1000);
  }

  function showToast(html) {
    const box = slot("toasts");
    box.innerHTML = html;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.innerHTML = ""; }, TOAST_MS);
  }

  // ---------- input ----------
  const onSegment = (e) => {
    if (!e.target.closest?.(".cr-range")) return;
    range = M.rangeOf(e.detail.value);
    saved.set(RANGE_KEY, range);
    render();
  };
  const onClick = (e) => {
    const t = e.target.closest?.("[data-cr-export], [data-cr-retry]");
    if (!t) return;
    if (t.matches("[data-cr-export]")) { exportCsv(); return; }
    data.status = "loading";
    render();
    fetchNow();
  };
  const handlers = [["ao-segment", onSegment], ["click", onClick]];
  for (const [type, fn] of handlers) root.addEventListener(type, fn);

  // ---------- api ----------
  /** The report is on screen (true) or not. Coming back after a failed load tries again. */
  function show(on) {
    shown = !!on;
    if (!shown) return;
    if (data.status === "error") data.key = null;
    render();
  }

  /** The top bar's state chips: agents in other states dim, as in the office. */
  function setFilter(states) {
    filter = normFilter(states);
    render();
  }

  function destroy() {
    dead = true;
    for (const t of [data.timer, toastTimer]) clearTimeout(t);
    for (const [type, fn] of handlers) root.removeEventListener(type, fn);
  }

  return { show, render, setFilter, destroy };
}
