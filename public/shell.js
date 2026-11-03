// The Command Center: top bar, router, right rail, day timeline with replay, toasts and onboarding around the 3D office,
// the answer dialog, the Agent Detail slide-over (agent-detail.js, from any screen), the Work Board (board.js), the
// Meeting Hall (hall.js), the Cost Report (cost.js), the Alerts Center (alerts.js) and Settings (settings.js).
// Data: GET /api/state, then the /api/stream event stream (both again if the server refuses the stream); GET
// /api/timeline every minute; GET /api/setup while empty; POST /api/answer from the answer dialog and the agent detail.
//
//   const shell = createShell({ doc?, win?, fetch?, EventSource? })   ·   shell.destroy()
// Any element with data-agent="<session>" opens that agent's detail, on any screen (at a section with
// data-agent-at="convo" or "trace"); so does "#/<screen>?agent=<session>".
import { createOffice, projectColors, projectKey } from "./office3d.js";
import { createAgentDetail } from "./agent-detail.js";
import { createBoard } from "./board.js";
import { createHall } from "./hall.js";
import { createCost } from "./cost.js";
import { createAlerts } from "./alerts.js";
import { createSettings } from "./settings.js";
import { inQuiet } from "./settings-model.js";
import { initTheme } from "./ui/theme.js";
import { initPrefs } from "./ui/prefs.js";
import { bind } from "./ui/components.js";
import { esc, tokensLine, clock } from "./ui/format.js";
import { createPatch, byKey } from "./ui/patch.js";
import * as S from "./shell-model.js";
import * as V from "./shell-view.js";

const MIN = 60000, RANGE_KEY = "ao-range", TOASTS = 2, LOG_LINES = 20, REOPEN = 3000;
const CLICKS = "[data-answer], [data-choice], [data-answer-next], [data-jump], [data-agent], [data-dismiss], [data-retry], [data-live], [data-day-retry], [data-close]";

export function createShell({ doc = document, win = window, fetch: fetchImpl = (...a) => win.fetch(...a), EventSource: ES = win.EventSource } = {}) {
  const saved = { get(k) { try { return win.localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { win.localStorage.setItem(k, v); } catch {} } };
  let range = S.rangeOf(saved.get(RANGE_KEY)).value;
  initTheme();
  initPrefs();
  const body = doc.body;
  body.classList.add("cc-body");
  body.innerHTML = V.layout({ range });
  const q = (s) => body.querySelector(s);
  const top = q(".cc-top"), main = q(".cc-main"), rail = q(".cc-rail"), day = q(".cc-day"), log = q("[data-log]");
  const slots = { needs: q('[data-slot="needs"]'), progress: q('[data-slot="progress"]'), activity: q('[data-slot="activity"]') };
  const toastsEl = q(".cc-toasts"), onboardEl = q(".cc-onboard");
  const dlg = { answer: q('[data-dialog="answer"]'), agent: q('[data-dialog="agent"]') };
  const scrub = q(".cc-scrub"), ribbonEl = q(".cc-ribbon"), ticksEl = q(".cc-ticks"), dayStateEl = q(".cc-day-state"), clockEl = q(".cc-day-clock"), modeEl = q(".cc-day-mode");
  const page = (id) => q(`[data-screen="${id}"]`).querySelector(".cc-page-body");

  // ---------- state ----------
  let snap = null, settings = {}, settingsLoaded = false, settingsBusy = false, status = "loading", asOf = null, colors = new Map(), route = null;
  // tl.at = when the timeline was last asked for; tl.okAt = when it last arrived.
  let timeline = null, tl = { status: "loading", at: 0, okAt: null }, span = null, replayAt = null;
  let prevWait = null, logReady = false, setup = null, setupFailed = false, setupBusy = false;
  // openers = per dialog, what had focus when it opened (and its data-key, in case a re-render replaced it); restore =
  // give it back on close. answer = the open answer dialog: { id, last (the agent), q (its question), sent (your answer) }.
  let restore = true, answer = null, answerTimer = 0, es = null, reopenTimer = 0;
  const openers = new Map(), sending = new WeakSet(); // sending = answer forms whose answer is on its way
  const seen = new Set(), toasts = new Map(), dismissed = new Set();
  const patch = createPatch(doc);

  /** JSON from the server; raw: the Response itself once it's ok (the cost report's CSV). */
  async function api(path, { raw = false, ...opts } = {}) {
    const res = await fetchImpl(path, { ...opts, headers: { "Content-Type": "application/json", "X-Requested-With": "agent-office", ...(opts.headers || {}) } });
    if (res.status === 401) { win.location.href = "/login.html"; throw new Error("Sign in first."); }
    if (raw && res.ok) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Request failed."), { status: res.status });
    return data;
  }

  const office = createOffice(q(".cc-office3d"), { onSelect: (id) => openAgent(id), onRetry: () => load(), showEmpty: false });
  const agents = () => (snap ? snap.agents : []);
  const agentById = (id) => agents().find((a) => a.session === id) || null;
  const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
  const setAttr = (el, k, v) => { if (v == null || v === false) el.removeAttribute(k); else if (el.getAttribute(k) !== String(v)) el.setAttribute(k, v === true ? "" : v); };
  const detail = createAgentDetail({ dialog: dlg.agent, doc, api, agentOf: agentById, context: () => ({ status, asOf, colors, route }) });
  const board = createBoard({ root: page("board"), doc, win, api, context: () => ({ snap, status, asOf, colors, settings, timeline, tl }) });
  const hall = createHall({ root: page("hall"), doc, win, api, context: () => ({ snap, status, asOf, colors, settings }) });
  const cost = createCost({ root: page("cost"), doc, win, api, context: () => ({ snap, status, asOf, colors, settings }) });
  const alerts = createAlerts({ root: page("alerts"), doc, win, api, context: () => ({ snap, status, asOf, settings }) });
  // A saved change comes back as the new settings: every screen redraws with them.
  const settingsScreen = createSettings({ root: page("settings"), doc, win, api, context: () => ({ snap, status, asOf, colors, settings, loaded: settingsLoaded }),
    onSettings: (s) => { useSettings(s); render(); } });

  // ---------- data ----------
  async function load() {
    try {
      const s = await api("/api/state");
      apply(s);
    } catch {
      if (snap) return;
      status = "error";
      office.setStatus("error");
      render();
    }
  }

  /** Settings on their own, when the live data came from the stream (which doesn't carry them). */
  async function loadSettings() {
    settingsBusy = true;
    try { useSettings(await api("/api/settings")); render(); } catch {}
    settingsBusy = false;
  }

  function useSettings(s) {
    settings = s;
    settingsLoaded = true;
  }

  function connect() {
    es = new ES("/api/stream");
    es.onmessage = (m) => { let s; try { s = JSON.parse(m.data); } catch { return; } apply(s); };
    // While the stream is down everything keeps its last data, dimmed, with "As of <time of that data>".
    es.onerror = () => {
      if (es.readyState === 2) reopen();
      if (!snap || status === "stale") return;
      status = "stale"; asOf = snap.t; office.setStatus("stale", snap.t); render(); renderDay();
    };
  }

  /** The browser retries a stream that dropped, but not one the server refused (its sign-in ended because the token was
   *  rotated, or a proxy's error page): ask for the state, so a 401 goes to sign-in, and open the stream again later. */
  function reopen() {
    load();
    clearTimeout(reopenTimer);
    reopenTimer = setTimeout(() => { if (timer) connect(); }, REOPEN);
  }

  function apply(s) {
    const first = !snap;
    snap = s; status = "live"; asOf = null;
    if (s.settings) useSettings(s.settings); // /api/state carries them; stream snapshots don't
    else if (!settingsLoaded && !settingsBusy) loadSettings();
    colors = projectColors(s.agents);
    if (replayAt == null) office.update(s.agents, { offlineAfterMin: settings.offlineAfterMin });
    office.setStatus("live");
    syncToasts(s.agents, first);
    render();
    if (Date.now() - tl.at > MIN) loadTimeline(); else renderDay();
  }

  // ---------- rendering ----------
  function render() {
    renderTop();
    renderRail();
    renderOnboard();
    renderDayMode();
    detail.update();
    board.render();
    hall.render();
    cost.render();
    alerts.render();
    settingsScreen.render();
    if (answer && dlg.answer.open) renderAnswer();
    doc.title = S.pageTitle(route, snap ? snap.totals.waiting : 0);
  }

  function renderTop() {
    const t = snap && snap.totals, c = t ? S.stateCounts(t) : null;
    for (const chip of top.querySelectorAll("[data-chip]")) setText(chip.querySelector(".ao-chip-count"), c ? String(c[chip.getAttribute("data-chip")]) : "");
    const badge = top.querySelector(".cc-badge"), n = c ? c.needs : 0;
    setAttr(badge, "hidden", !n);
    patch(badge, n ? V.alertsBadge(n) : "");
    const cv = t ? S.costView(t, range, settings.dailyBudgetUsd) : null;
    patch(top.querySelector(".cc-tokens"), cv && !cv.noData ? `<span class="ao-sr">Tokens ${esc(cv.period)}: </span>${esc(tokensLine(cv.tokens))}` : "");
    patch(top.querySelector(".cc-cost"), cv ? V.costBlock(cv) : "");
    patch(top.querySelector(".cc-who"), V.who(settings));
    top.classList.toggle("is-stale", status === "stale");
    // Stale: the counts and spend are the last known ones (the office HUD and panels say "As of"). They lose their colour
    // like a stale panel's content, and the chips keep their teal focus ring.
    for (const el of top.querySelectorAll(".cc-chips, .cc-spend")) el.classList.toggle("ao-stale", status === "stale");
    const demo = top.querySelector(".cc-demo");
    setAttr(demo, "hidden", !settings.demo);
    setText(demo, settings.demo ? "Demo data" : "");
    setAttr(demo, "title", settings.demo ? "Made-up agents. Run agent-office start to see your real sessions." : null);
  }

  function renderRail() {
    const now = Date.now(), list = agents();
    patch(slots.needs, V.needsPanel({ items: S.needsItems(list, { now, colors }), status, asOf, offlineMin: settings.offlineAfterMin || 30 }));
    patch(slots.progress, V.progressPanel({ view: snap ? S.progressView(snap.totals, colors) : null, status, asOf }));
    const groups = S.activityGroups(list, { colors });
    patch(slots.activity, V.activityPanel({ groups, status, asOf }));
    if (!snap) return;
    // New actions are announced through a polite log, a few at a time; the visible feed is not live (it re-renders).
    for (const line of S.freshLines(groups, seen, { first: !logReady }).slice(-5)) {
      const p = doc.createElement("p");
      p.textContent = line;
      log.append(p);
    }
    logReady = true;
    while (log.children.length > LOG_LINES) log.firstElementChild.remove();
  }

  function renderOnboard() {
    const show = status === "live" && !!snap && !snap.agents.length && replayAt == null;
    setAttr(onboardEl, "hidden", !show);
    if (!show) return;
    if (!setup && !setupFailed && !setupBusy) loadSetup();
    patch(onboardEl, V.onboarding(setup, { failed: setupFailed, lastEvent: snap.lastEvent || null }));
  }

  async function loadSetup() {
    setupBusy = true;
    try { setup = await api("/api/setup"); } catch { setupFailed = true; }
    setupBusy = false;
    renderOnboard();
  }

  // ---------- toasts and desktop notifications ----------
  function syncToasts(list, first) {
    const fresh = S.newWaiters(prevWait, list, { now: Date.now() });
    prevWait = new Map(list.map((a) => [a.session, S.waitKey(a)]));
    // Answered waits go first, so the cap only ever pushes out a toast that is still current when there are too many.
    const waiting = new Set(list.map(S.waitKey).filter(Boolean));
    for (const [k, el] of toasts) if (!waiting.has(k)) dropToast(k, el);
    for (const a of fresh) addToast(a);
    if (!first) for (const a of fresh) notify(a);
  }

  function addToast(a) {
    const key = S.waitKey(a);
    if (toasts.has(key) || dismissed.has(key)) return;
    const box = doc.createElement("div");
    box.innerHTML = V.needsToast(a, key);
    const el = box.firstElementChild;
    toastsEl.insertBefore(el, toastsEl.firstChild);
    toasts.set(key, el);
    while (toasts.size > TOASTS) { const [k, old] = toasts.entries().next().value; dropToast(k, old); }
  }

  function dropToast(key, el) {
    const had = el.contains(doc.activeElement);
    el.remove();
    toasts.delete(key);
    if (had) q("#cc-office-h").focus();
  }

  function dismissToast(key) {
    const el = toasts.get(key);
    if (!el) return;
    dismissed.add(key);
    if (dismissed.size > 200) dismissed.delete(dismissed.values().next().value);
    dropToast(key, el);
  }

  /** A desktop notification, unless they're off, not allowed, or it's quiet hours (by the server's clock). */
  function notify(a) {
    const N = win.Notification;
    if (!settings.notifyOnWaiting || !N || N.permission !== "granted" || inQuiet(settings.quietHours, Date.now(), settings.tzOffsetMin)) return;
    try {
      const n = new N(`${a.name} needs you`, { body: a.message || "Waiting for your input", tag: a.session });
      n.onclick = () => { win.focus(); openAnswer(a.session); };
    } catch {} // some browsers only allow notifications from a service worker
  }

  // ---------- day timeline and replay ----------
  async function loadTimeline() {
    tl.at = Date.now();
    try { timeline = await api("/api/timeline"); tl.status = "live"; tl.okAt = Date.now(); }
    catch { tl.status = timeline ? "stale" : "error"; }
    renderDay();
    board.render();
    if (replayAt != null) setReplay(replayAt);
  }

  function renderDay() {
    const now = Date.now();
    span = timeline ? S.dayRange(timeline, now) : null;
    day.classList.toggle("is-stale", !!timeline && (tl.status === "stale" || status === "stale"));
    patch(dayStateEl, V.dayState(timeline ? "live" : tl.status, !!span));
    if (!span) {
      patch(ribbonEl, "");
      patch(ticksEl, "");
      ribbonEl.setAttribute("aria-label", tl.status === "loading" ? "Loading today's timeline" : "No activity today yet");
      setAttr(scrub, "disabled", true);
      renderDayMode();
      return;
    }
    patch(ribbonEl, V.dayBars(S.ribbon(timeline, span), span));
    setAttr(ribbonEl, "aria-label", S.ribbonSummary(timeline, span));
    patch(ticksEl, V.dayTicks(S.hourTicks(span)));
    scrub.style.width = S.scrubWidth(span);
    setAttr(scrub, "max", Math.max(1, Math.round((now - span.start) / MIN)));
    setAttr(scrub, "disabled", false);
    syncScrub();
    renderDayMode();
  }

  function syncScrub() {
    if (!span) return;
    const max = Number(scrub.getAttribute("max")), v = replayAt == null ? max : Math.max(0, Math.min(max, Math.round((replayAt - span.start) / MIN)));
    if (String(scrub.value) !== String(v)) scrub.value = String(v);
    setAttr(scrub, "aria-valuetext", replayAt == null ? `Live, ${clock(Date.now())}` : `Replaying ${clock(replayAt)}`);
  }

  function renderDayMode() {
    setText(clockEl, clock(replayAt ?? (status === "stale" ? asOf : Date.now())));
    patch(modeEl, V.dayMode({ replayAt, status, asOf, day: tl.status, dayAsOf: tl.okAt }));
  }

  function onScrub() {
    if (!span) return;
    const v = Number(scrub.value), max = Number(scrub.getAttribute("max"));
    setReplay(v >= max ? null : span.start + v * MIN);
  }

  /** Shows the office at time t (only states are known), or live again with null. The rail always stays live. */
  function setReplay(t) {
    replayAt = t;
    const opts = { offlineAfterMin: settings.offlineAfterMin };
    if (t == null) office.update(agents(), opts);
    else office.update(S.replayAgents(timeline, agents(), t), { ...opts, replayAt: t });
    day.classList.toggle("is-replay", t != null);
    syncScrub();
    renderDayMode();
    renderOnboard();
  }

  // ---------- dialogs ----------
  function showDialog(d) {
    const a = doc.activeElement;
    if (!d.open) openers.set(d, a && a !== body && body.contains(a) && !d.contains(a) ? { el: a, key: a.getAttribute("data-key") } : null);
    restore = true;
    if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute("open", ""); }
  }

  /** The answer dialog follows live data: the wait time, the window closing, delivery, or the agent moving on. It stays
   *  on the question it opened with (a newer one is offered, never swapped in: its ask belongs to another hook). */
  function renderAnswer() {
    const a = agentById(answer.id), now = Date.now();
    if (a) answer.last = a;
    if (!answer.sent && a && a.question && answer.q && a.question.id === answer.q.id) answer.q = a.question;
    const v = S.answerView(a, { q: answer.q, sent: answer.sent, now }), ag = answer.last, part = (k) => dlg.answer.querySelector(`[data-a="${k}"]`);
    patch(part("head"), V.answerHead(ag, { now, color: colors.get(projectKey(ag)), mode: v.mode, asOf: status === "stale" ? asOf : null }));
    patch(part("convo"), V.answerConvo(ag, { q: answer.q, now, sent: answer.sent, mode: v.mode, gone: !a }));
    const box = part("box"), inBox = box.contains(doc.activeElement);
    patch(box, V.answerBox(v, ag, answer.q));
    // The box changed under you (the window passed, the request was answered elsewhere): say why, and keep focus in the
    // dialog. After your own answer, the status line speaks instead.
    if (answer.mode && answer.mode !== v.mode && v.mode !== "sent") {
      setText(part("say"), S.answerNotice(v, ag));
      if (inBox) q("#cc-answer-h").focus({ preventScroll: true });
    }
    answer.mode = v.mode;
    const left = box.querySelector("[data-answer-left]");
    if (left) setText(left, S.answerLeft(v.ask.until, now));
    patch(part("status"), answer.sent ? V.answerStatus(S.deliveryView(a, answer.sent, now)) : "");
    patch(part("resume"), v.mode === "over" || v.mode === "sent" ? "" : V.resumeBox(ag));
    patch(part("foot"), V.answerFoot(v.mode, ag, { gone: !a }));
  }

  function openAnswer(id) {
    const a = agentById(id);
    if (!a) return;
    answer = { id, last: a, q: a.question, sent: null, mode: null };
    dlg.answer.innerHTML = V.answerFrame();
    renderAnswer();
    showDialog(dlg.answer);
    // A second's tick for the time left to answer here, and for the window closing.
    clearInterval(answerTimer);
    answerTimer = setInterval(() => { if (answer && dlg.answer.open) renderAnswer(); }, 1000);
  }

  /** Approve once, Allow for this session, Deny, or Send reply, from the answer dialog or the agent detail's answer box
   *  (form = its [data-answer-form]). On failure the box stays, with what went wrong. */
  async function sendAnswer(form, kind) {
    const inDialog = !!form && dlg.answer.contains(form), owner = inDialog ? answer : detail.current();
    if (!form || !owner || sending.has(form)) return;
    const area = form.querySelector("textarea"), text = kind === "reply" ? area.value.trim() : "";
    if (kind === "reply" && !text) return;
    const controls = [...form.querySelectorAll("button, textarea")], err = form.querySelector("[data-answer-error]");
    const still = () => (inDialog ? answer === owner : detail.current() === owner);
    sending.add(form);
    for (const c of controls) setAttr(c, "disabled", true);
    setAttr(form, "aria-busy", "true");
    setText(err, "");
    try {
      const r = await api("/api/answer", { method: "POST", body: JSON.stringify({ askId: form.getAttribute("data-answer-form"), kind, text }) });
      if (!still()) return;
      const sent = { questionId: r.questionId, choice: kind, text: text || null, at: Date.now(), until: r.until, delivered: r.delivered };
      if (!inDialog) { detail.answered(sent); return; }
      owner.sent = sent;
      renderAnswer();
      dlg.answer.querySelector('[data-a="foot"]').querySelector("[data-close]").focus({ preventScroll: true });
    } catch (e) {
      if (!still()) return;
      for (const c of controls) setAttr(c, "disabled", c.matches('[data-choice="reply"]') && !area.value.trim());
      setAttr(form, "aria-busy", null);
      setText(err, `Couldn't send your answer. ${e.message}`);
    } finally { sending.delete(form); }
  }

  /** "Show the new request": the dialog moves on to the agent's current question. */
  function nextQuestion() {
    const a = answer && agentById(answer.id);
    if (!a) return;
    Object.assign(answer, { q: a.question, mode: null });
    setText(dlg.answer.querySelector('[data-a="say"]'), "");
    renderAnswer();
    q("#cc-answer-h").focus({ preventScroll: true });
  }

  /** The Agent Detail slide-over, over whatever screen is showing. Focus starts on "Back to …", or on the section asked
   *  for (at: "convo" to answer it, "trace"). */
  function openAgent(id, at = null) {
    if (!detail.open(id)) return;
    showDialog(dlg.agent);
    if (!at || !detail.goTo(at)) dlg.agent.querySelector('[data-key="ad-back"]').focus({ preventScroll: true });
  }

  function closeDialogs(back = true) {
    restore = back;
    for (const d of Object.values(dlg)) if (d.open) d.close();
  }

  /** Focus goes back to that dialog's opener; if a re-render replaced it, to its twin by data-key; else to the screen's
   *  heading. Closing the agent detail also drops ?agent= from the address. */
  const onDialogClose = (e) => {
    const d = e.target;
    if (d.open) return; // reopened before this close event arrived: it belongs to what was shown before
    if (d === dlg.agent) {
      const id = detail.current();
      detail.close();
      // Only its own ?agent=: the address may already ask for another agent (close events come a moment later).
      if (id && S.routeAgent(win.location.hash) === id) win.location.hash = `#/${route}`;
    } else { answer = null; clearInterval(answerTimer); }
    const o = openers.get(d), back = restore;
    openers.delete(d);
    restore = true;
    if (!back) return; // Jump moves focus itself
    const usable = (n) => (n && body.contains(n) && !n.closest("[hidden]") ? n : null); // not on a screen you've left
    const n = (o && (usable(o.el) || usable(byKey(body, o.key)))) || q(`#cc-${route}-h`);
    n.focus({ preventScroll: true });
  };

  /** Jump: back to live, zoom the office to the agent, pulse its tag and move focus to it. From another screen
   *  (an answer opened from a desktop notification) the office is shown first and measures itself before zooming. */
  function jump(id) {
    closeDialogs(false);
    if (replayAt != null) setReplay(null);
    const go = () => {
      office.focusAgent(id);
      [...body.querySelectorAll(".o3-agent")].find((b) => b.getAttribute("data-session") === id)?.focus({ preventScroll: true });
    };
    if (route === "office") return go();
    win.location.hash = "#/office";
    onRoute();
    setTimeout(go, 60);
  }

  // ---------- screens ----------
  function onRoute() {
    const next = S.parseRoute(win.location.hash), first = route == null, moved = next !== route;
    if (moved) {
      route = next;
      for (const sec of main.querySelectorAll(".cc-screen")) setAttr(sec, "hidden", sec.getAttribute("data-screen") !== route);
      for (const a of top.querySelectorAll("[data-nav]")) setAttr(a, "aria-current", a.getAttribute("data-nav") === route ? "page" : null);
      board.show(route === "board");
      hall.show(route === "hall");
      cost.show(route === "cost");
      alerts.show(route === "alerts");
      if (route === "settings") settingsScreen.go(win.location.hash);
      settingsScreen.show(route === "settings");
      doc.title = S.pageTitle(route, snap ? snap.totals.waiting : 0);
      if (!first) q(`#cc-${route}-h`).focus({ preventScroll: true });
    } else if (route === "settings") settingsScreen.go(win.location.hash, { focus: true }); // its own nav: another section
    // "?agent=<session>": that agent's detail over this screen, at once: it loads on its own, so a session older than
    // the live data's day, or one the server doesn't know, still gets its detail or says it's gone.
    const want = S.routeAgent(win.location.hash);
    if (want && want !== detail.current()) openAgent(want);
  }

  // ---------- input ----------
  const onClick = (e) => {
    // The backdrop: a click on the dialog element itself, outside its box (inside it is its padding or scrollbar).
    if (e.target.matches?.("dialog")) {
      const r = e.target.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
      return;
    }
    // The skip link moves focus to the current screen; following its #cc-main hash would trip the router.
    if (e.target.closest?.(".cc-skip")) { e.preventDefault(); q(`#cc-${route}-h`).focus(); return; }
    const t = e.target.closest?.(CLICKS);
    if (!t || t.closest(".o3")) return; // the office handles its own retry
    const v = (k) => t.getAttribute(k);
    if (t.matches("[data-answer]")) openAnswer(v("data-answer"));
    else if (t.matches("[data-choice]")) { if (v("data-choice") !== "reply") sendAnswer(t.closest("[data-answer-form]"), v("data-choice")); } // Send reply submits the form
    else if (t.matches("[data-answer-next]")) nextQuestion();
    else if (t.matches("[data-jump]")) jump(v("data-jump"));
    else if (t.matches("[data-agent]")) openAgent(v("data-agent"), v("data-agent-at"));
    else if (t.matches("[data-dismiss]")) dismissToast(v("data-dismiss"));
    else if (t.matches("[data-retry]")) load();
    else if (t.matches("[data-live]")) { setReplay(null); scrub.focus(); }
    else if (t.matches("[data-day-retry]")) loadTimeline();
    else if (t.matches("[data-close]")) t.closest("dialog")?.close();
  };
  const onSubmit = (e) => {
    const f = e.target;
    if (f.matches("[data-answer-form]")) { e.preventDefault(); sendAnswer(f, "reply"); }
  };
  // The reply: Send reply is enabled once there's text; Ctrl+Enter (⌘+Enter on a Mac) sends it.
  const onInput = (e) => {
    const area = e.target.closest?.(".cc-reply");
    if (area && !sending.has(area.closest("form"))) setAttr(area.closest("form").querySelector('[data-choice="reply"]'), "disabled", !area.value.trim());
  };
  const onKey = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.closest?.(".cc-reply")) { e.preventDefault(); sendAnswer(e.target.closest("form"), "reply"); }
  };
  const onChip = () => {
    const states = [...top.querySelectorAll("[data-chip]")].filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.getAttribute("data-chip"));
    office.setFilter(states);
    board.setFilter(states);
    hall.setFilter(states);
    cost.setFilter(states);
  };
  const onRange = (e) => {
    if (!e.target.closest?.(".cc-range")) return;
    range = S.rangeOf(e.detail.value).value;
    saved.set(RANGE_KEY, range);
    renderTop();
  };
  const tick = () => { if (!doc.hidden) loadTimeline(); };

  const unbinds = [top, rail, day, onboardEl, ...Object.values(dlg), ...main.querySelectorAll(".cc-page")].map((el) => bind(el));
  body.addEventListener("click", onClick);
  body.addEventListener("submit", onSubmit);
  body.addEventListener("input", onInput);
  body.addEventListener("keydown", onKey);
  top.addEventListener("ao-chip", onChip);
  top.addEventListener("ao-segment", onRange);
  scrub.addEventListener("input", onScrub);
  for (const d of Object.values(dlg)) d.addEventListener("close", onDialogClose);
  win.addEventListener("hashchange", onRoute);
  let timer = setInterval(tick, MIN);

  onRoute();
  render();
  renderDay();
  const ready = load().then(connect);
  loadTimeline();

  /** Safe to call twice. */
  function destroy() {
    if (!timer) return;
    clearInterval(timer);
    clearInterval(answerTimer);
    clearTimeout(reopenTimer);
    timer = 0;
    es?.close();
    for (const u of unbinds) u();
    body.removeEventListener("click", onClick);
    body.removeEventListener("submit", onSubmit);
    body.removeEventListener("input", onInput);
    body.removeEventListener("keydown", onKey);
    win.removeEventListener("hashchange", onRoute);
    detail.destroy();
    board.destroy();
    hall.destroy();
    cost.destroy();
    alerts.destroy();
    settingsScreen.destroy();
    office.destroy();
    body.innerHTML = "";
  }

  return { ready, destroy };
}
