// The 3D office: an SVG isometric floor with a glass room per git project. Every agent is a real <button>
// (in urgency order) placed over its character; the SVG scene itself is decorative.
//
//   const office = createOffice(el, { onSelect(sessionId), onHover?(sessionId|null), onRetry?(), getTheme?, showNameTags?, offlineAfterMin? })
//   office.update(snapshot.agents, { filter?, now?, replayAt?, offlineAfterMin? })
//   office.setStatus("loading" | "live" | "stale" | "error", asOf?)   // loading until the first update
//   office.setFilter(["working"] | null) · office.focusAgent(id) · office.focusRoom(project) · office.fit() · office.destroy()
//
// Pure layout, geometry and text live in office3d-model.js (re-exported here), SVG drawing in office3d-draw.js.
import * as M from "./office3d-model.js";
import * as D from "./office3d-draw.js";
import { bind, hoverCard, positionHoverCard, iconButton, emptyState, loadingState, errorState, PROJECT_COLORS, STATES, stateKey } from "./ui/components.js";
import { esc, endTruncate } from "./ui/format.js";
import { icon } from "./ui/icons.js";
import { toolIcon } from "./lib/describe.js";

export * from "./office3d-model.js";

const NS = "http://www.w3.org/2000/svg";
// Button box (world px) around a character: [width, height of the body]; the tag sits on top.
const BOX = { seat: [38, 50], stand: [32, 60], gone: [38, 40] };
const HEAD = { seat: 1.27 };
const PAD = { top: 64, right: 72, bottom: 28, left: 28 };
const MAP = { w: 200, h: 104 };
const MAX_WALKERS = 6; // more people changing place at once (a reconnect, a replay jump) snap instead of walking
const STATUSES = new Set(["loading", "live", "stale", "error"]);
const NAME_MAX = 22; // tags and room labels cut longer names with an ellipsis (CSS); the full name goes in a title
let instances = 0;

const pageTheme = () => (document.documentElement.classList.contains("ao-light") ? "light" : "dark");
const svgEl = (cls) => { const g = document.createElementNS(NS, "g"); if (cls) g.setAttribute("class", cls); return g; };
const same = (a, b) => a.kind === b.kind && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
const setOpacity = (el, v) => { const s = v === 1 ? "" : String(v); if (el.style.opacity !== s) el.style.opacity = s; };
// Writes only real changes, so an update with the same snapshot touches nothing.
const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };

function shell(id) {
  return `<div class="o3" role="region" aria-label="Office" aria-describedby="${id}-help ${id}-sum" tabindex="0" data-hover-bounds>
    <p class="ao-sr" id="${id}-help">Arrow keys pan, plus and minus zoom, 0 fits the whole office. Agents are listed most urgent first; press Enter on one for details.</p>
    <p class="ao-sr" id="${id}-sum"></p>
    <div class="o3-world">
      <svg class="o3-floor" aria-hidden="true" focusable="false"></svg>
      <svg class="o3-scene" aria-hidden="true" focusable="false"><g class="o3-under"></g><g class="o3-items"></g><g class="o3-links"></g></svg>
      <div class="o3-labels"></div>
      <div class="o3-itags"></div>
      <ul class="o3-agents" aria-label="Agents, most urgent first"></ul>
    </div>
    <div class="o3-empty" hidden></div>
    <div class="o3-hud"><span class="o3-hud-dot"></span><b class="o3-hud-mode">Loading…</b><span class="o3-hud-meta"></span></div>
    <div class="o3-map" aria-hidden="true"><div class="o3-map-head"><span class="ao-label">Map</span><span class="o3-map-hint">click to move</span></div>
      <svg class="o3-map-svg" width="${MAP.w}" height="${MAP.h}" viewBox="0 0 ${MAP.w} ${MAP.h}"><g class="o3-map-shapes"></g><rect class="o3-map-view" rx="2"/></svg></div>
    <div class="o3-zoom">${iconButton({ icon: "plus", label: "Zoom in", attrs: { "data-zoom": "in" } })}${iconButton({ icon: "minus", label: "Zoom out", attrs: { "data-zoom": "out" } })}${iconButton({ icon: "fit", label: "Fit the whole office", attrs: { "data-zoom": "fit" } })}</div>
    <p class="o3-hint">Drag to pan · scroll to zoom</p>
    <div class="o3-cards"></div>
  </div>`;
}

export function createOffice(container, opts = {}) {
  const { onSelect = () => {}, onHover = null, onRetry = null, getTheme = pageTheme, showNameTags = true } = opts;
  const id = `o3-${++instances}`;
  container.innerHTML = shell(id);
  const root = container.firstElementChild, q = (s) => root.querySelector(s);
  const world = q(".o3-world"), floorSvg = q(".o3-floor"), sceneSvg = q(".o3-scene"), underG = q(".o3-under"), itemsG = q(".o3-items"), linksG = q(".o3-links");
  const labelsEl = q(".o3-labels"), itagsEl = q(".o3-itags"), listEl = q(".o3-agents"), cardsEl = q(".o3-cards"), emptyEl = q(".o3-empty"), sumEl = q(`#${id}-sum`);
  const mapSvg = q(".o3-map-svg"), mapShapes = q(".o3-map-shapes"), mapView = q(".o3-map-view");
  root.classList.toggle("no-tags", !showNameTags);

  let theme = getTheme() === "light" ? "light" : "dark", pal = D.PALETTE[theme];
  let agents = [], L = M.layoutOffice([]), scene = M.sceneBounds(L), key = null, filter = null, now = Date.now(), replayAt = null;
  let offlineMin = opts.offlineAfterMin || 30, lounge = new Map(), booted = false, cardSeq = 0, orderKey = "";
  let view = { x: 0, y: 0, z: 1 }, vp = { w: 0, h: 0 }, fitted = true, mapT = null, tween = null, raf = 0, last = 0, moveT = 0;
  let statics = [], keys = [], hallG = null, spotKey = "", hallKey = "", status = "loading", asOf = null, overlayKey = "", lastCounts = null;
  const chars = new Map(), desks = new Map(), walkers = new Set();
  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let reduced = !!mq?.matches;

  // Glass rims are a touch darker on the light floor.
  const color = (i) => (theme === "light" ? M.shade(PROJECT_COLORS[i], 0.86) : PROJECT_COLORS[i]);
  const W = ([x, y]) => [x - scene.x, y - scene.y];
  const at = (x, y, z = 0) => { const [px, py] = W(M.project(x, y, z)); return `transform:translate(${px.toFixed(1)}px,${py.toFixed(1)}px) scale(var(--tag-s)) translate(-50%,-100%)`; };

  // ---------- layout: everything that only changes when agents join or leave ----------
  function rebuild() {
    L = M.layoutOffice(agents);
    scene = M.sceneBounds(L);
    const vb = `${scene.x} ${scene.y} ${scene.w} ${scene.h}`;
    for (const svg of [floorSvg, sceneSvg]) { svg.setAttribute("viewBox", vb); svg.setAttribute("width", scene.w); svg.setAttribute("height", scene.h); }
    world.style.width = `${scene.w}px`;
    world.style.height = `${scene.h}px`;
    floorSvg.innerHTML = D.drawFloor(L, { id, pal, color });
    buildItems();
    buildLabels();
    buildMap();
    overlayKey = null;
    const live = new Set(agents.map((a) => a.session));
    for (const [s, c] of chars) {
      if (!live.has(s)) { c.g.remove(); c.li.remove(); c.card.remove(); c.links.remove(); chars.delete(s); continue; }
      c.place = null; c.walk = null; c.look = ""; c.links.textContent = "";
    }
    walkers.clear();
    spotKey = hallKey = orderKey = "";
  }

  function item(x, y, svg, cls) {
    const g = svgEl(cls);
    g.innerHTML = svg;
    return { x, y, g };
  }

  function buildItems() {
    itemsG.textContent = underG.textContent = itagsEl.textContent = ""; // not linksG: each character keeps its own links group there
    desks.clear();
    hallG = null;
    const list = [];
    if (!L.empty) {
      for (const r of L.rooms) for (const w of D.wallItems(r, color(r.color), pal, { door: r.doorX })) list.push(item(w.x, w.y, w.svg, "o3-wall"));
      for (const r of L.rooms) {
        for (const d of r.desks) {
          const g = svgEl("o3-desk"), chair = svgEl(), slot = svgEl(), body = svgEl();
          g.append(chair, slot, body);
          desks.set(d.session, { d, g, chair, slot, body, sig: "", chairSig: "", heads: [] });
          list.push({ x: d.x, y: d.y + 1.2, g });
        }
      }
      const lg = L.lounge, sp = L.spot;
      list.push(item(lg.x + lg.w / 2, lg.y + 0.8, D.sofa(L, pal)), item(lg.x + 1.2, lg.y + 0.65, D.coffeeBar(L, pal)), item(lg.table.x, lg.table.y, D.coffeeTable(L, pal)));
      list.push(item(lg.x + 0.8, lg.y + 0.75, D.steam(L), "o3-steam-g"));
      for (const [x, y, h] of [[lg.x + lg.w - 0.5, lg.y + 0.5, 1.2], [lg.x + 0.45, lg.y + lg.d - 0.5, 1], [lg.x + lg.w - 0.45, lg.y + lg.d - 0.45, 0.9], [sp.x + 0.45, sp.y + sp.d - 0.45, 1], [sp.x + sp.w - 0.35, sp.y + 0.45, 1.1]]) {
        list.push(item(x, y, D.plant(x, y, pal, h), "o3-plant"));
      }
      list.push(item(sp.lamp.x, sp.lamp.y, D.lampPost(L, pal)));
      if (L.hall) {
        const h = L.hall;
        for (const w of D.wallItems(h, pal.teal, pal)) list.push(item(w.x, w.y, w.svg, "o3-wall"));
        list.push(item(h.x + h.w / 2, h.y + 0.05, D.hallScreen(L, pal)));
        hallG = item(h.x + h.w / 2, h.y + h.d / 2, "", "o3-hall");
        list.push(hallG);
        hallG = hallG.g;
      }
    }
    statics = M.paintersSort(list);
    keys = statics.map((s) => s.x + s.y);
    for (const s of statics) itemsG.append(s.g);
  }

  function buildLabels() {
    if (L.empty) { labelsEl.innerHTML = ""; return; }
    const spots = M.labelSpots(L), spot = (k) => { const p = spots.get(k); return at(p.x, p.y, p.z); };
    const room = (r) => `<button type="button" class="o3-lbl o3-room" data-room="${esc(r.project)}" style="${spot(r.project)}" aria-label="${esc(`${r.project}, ${r.agents} ${r.agents === 1 ? "agent" : "agents"}. Zoom to this room`)}">` +
      `<span class="o3-dot" style="background:${PROJECT_COLORS[r.color]}"></span><b>${esc(r.project)}</b><span class="o3-lbl-n">${r.agents} ${r.agents === 1 ? "agent" : "agents"}</span></button>`;
    const lg = L.lounge, sp = L.spot, h = L.hall;
    labelsEl.innerHTML = L.rooms.map(room).join("") +
      `<span class="o3-lbl o3-caps" style="${at(lg.x + 0.6, lg.y + 0.2, 1.6)}">${icon("coffee", { size: 13 })}<span>Lounge · <span data-n="idle">0</span> idle</span></span>` +
      (h ? `<a class="o3-lbl o3-hall-lbl" href="#/hall" style="${spot("#hall")}">${icon("meeting", { size: 14 })}<b>Meeting hall</b><span class="o3-lbl-n">Standup · <span data-n="hall">0</span> attending</span></a>` : "") +
      `<span class="o3-lbl o3-sign" style="${at(sp.lamp.x, sp.lamp.y, 3.55)}">${icon("hand", { size: 13 })}<span>Needs you · <span data-n="needs">0</span></span></span>` +
      `<span class="o3-lbl o3-caps o3-entrance" style="${at(L.entrance.x, L.slab.y + L.slab.d, -0.85)}">${icon("door", { size: 13 })}<span>Entrance</span></span>`;
  }

  function buildMap() {
    const f = M.mapFit(scene, MAP);
    mapT = f;
    const poly = (r, fill, extra = "") => `<path d="${D.poly([[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.d], [r.x, r.y + r.d]].map(([x, y]) => M.project(x, y)))}" fill="${fill}" ${extra}/>`;
    let s = L.floor.map((b) => poly(b, pal.slab)).join("");
    if (L.empty) s += poly(L.outline, "none", `stroke="${pal.off}" stroke-width="8" stroke-dasharray="20 20"`);
    for (const r of L.rooms) s += poly(r, PROJECT_COLORS[r.color], 'fill-opacity=".75"');
    if (L.lounge) s += poly(L.lounge, pal.rugIn) + (L.hall ? poly(L.hall, pal.teal, 'fill-opacity=".45"') : "");
    if (L.spot) s += `<ellipse class="o3-map-spot" cx="${M.project(L.spot.cx, L.spot.cy)[0]}" cy="${M.project(L.spot.cx, L.spot.cy)[1]}" rx="60" ry="30" fill="${pal.off}"/>`;
    mapShapes.setAttribute("transform", `translate(${f.ox.toFixed(2)} ${f.oy.toFixed(2)}) scale(${f.k.toFixed(5)}) translate(${-scene.x} ${-scene.y})`);
    mapShapes.innerHTML = s;
  }

  // ---------- per agent: place, desk, character, button ----------
  function refresh() {
    const queue = new Map(M.queueOrder(agents).map((a, i) => [a.session, i]));
    if (!L.empty) lounge = M.assignLounge(agents.filter((a) => stateKey(a.state) === "idle").map((a) => a.session).sort(), lounge, L.lounge.spots.length);
    const places = new Map(agents.map((a) => [a.session, M.placeOf(a, L, { queue, lounge })]));
    const moving = agents.filter((a) => { const c = chars.get(a.session); return c ? !!c.place && !same(c.place, places.get(a.session)) : booted; }).length;
    const snap = replayAt != null || moving > MAX_WALKERS;
    for (const a of agents) syncAgent(a, places.get(a.session), snap);
    syncOrder();
    syncHall();
    syncCounts();
    kick();
  }

  function syncAgent(a, place, snap) {
    let c = chars.get(a.session);
    const fresh = !c;
    if (!c) c = makeChar(a);
    c.a = a;
    const k = stateKey(a.state), ci = L.desks.get(a.session)?.color ?? 0;
    syncDesk(a, k, ci);
    const look = `${theme}|${ci}`;
    if (look !== c.look) { c.look = look; c.shirt = color(ci); c.pose = ""; }
    move(c, place, fresh && booted, snap);
    c.li.classList.toggle("is-lead", place.kind === "queue" && place.index === 0);
    syncButton(c, a, k, ci);
    const op = M.agentOpacity(a.state, filter);
    setOpacity(c.g, op);
    setOpacity(c.li, op);
    setOpacity(c.links, op);
  }

  function syncDesk(a, k, ci) {
    const u = desks.get(a.session);
    if (!u) return;
    const sub = a.subagents || {};
    const list = Array.isArray(sub.list) ? sub.list.slice(0, 3).map((x) => ({ description: x.description || null, status: x.status })) : null;
    const vis = { glow: k === "working" ? "working" : k === "needs" ? "needs" : null, icon: k === "needs" ? "hand" : a.tool ? toolIcon(a.tool) : null,
      running: Math.max(0, sub.running | 0), finished: Math.max(0, sub.finished | 0), list };
    const sig = JSON.stringify(vis);
    if (sig !== u.sig) {
      u.sig = sig;
      const r = D.deskBody(u.d, vis, { pal, id, shirt: color(ci), look: (i) => D.looks(`${a.session}#${i}`) });
      u.body.innerHTML = r.svg;
      u.heads = r.heads;
      renderInternTags(u, r.interns);
      const c = chars.get(a.session);
      if (c) renderLinks(c);
    }
    const away = String(k === "needs" || k === "idle");
    if (away !== u.chairSig) { u.chairSig = away; u.chair.innerHTML = D.chairSVG(u.d, away === "true", pal); }
    setOpacity(u.g, M.deskOpacity(a.state, filter));
    if (u.tags) setOpacity(u.tags, M.deskOpacity(a.state, filter));
  }

  /** Small tags over the interns: what each sub-agent does, with a check once it finished. Stacked so they don't overlap. */
  function renderInternTags(u, interns) {
    if (!u.tags) { u.tags = document.createElement("div"); itagsEl.append(u.tags); }
    u.tags.innerHTML = interns.map((t, i) => {
      const [x, y] = W(t.head), long = t.text.length > 28;
      return `<span class="o3-itag ao-pill ${t.running ? "ao-pill--working" : "o3-itag--done"}"${long ? ` title="${esc(t.text)}"` : ""} style="transform:translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(var(--tag-s)) translate(-50%,calc(-100% - ${i * 19}px))">` +
        `${icon(t.running ? "sub-agent" : "check", { size: 11 })}<span>${esc(endTruncate(t.text, 28))}</span></span>`;
    }).join("");
  }

  function makeChar(a) {
    const g = svgEl("o3-char"), flip = svgEl(), body = svgEl("o3-body"), links = svgEl("o3-links-of");
    flip.append(body);
    g.append(flip);
    linksG.append(links);
    const cardId = `${id}-card-${++cardSeq}`;
    const li = document.createElement("li");
    li.className = "o3-a";
    li.innerHTML = `<button type="button" class="o3-agent" data-session="${esc(a.session)}" data-hovercard="${cardId}" aria-describedby="${cardId}"><span class="o3-tag ao-pill"></span></button>`;
    listEl.append(li);
    cardsEl.insertAdjacentHTML("beforeend", hoverCard({ id: cardId, cls: "o3-hovercard" }));
    const c = { a, g, flip, body, links, li, btn: li.firstElementChild, tag: li.querySelector(".o3-tag"), card: cardsEl.lastElementChild,
      pos: { ...L.entrance }, place: null, walk: null, pose: "", look: "", btnSig: "", cardHtml: "", liKey: "" };
    chars.set(a.session, c);
    return c;
  }

  function syncButton(c, a, k, ci) {
    const label = M.agentAria(a, now), tag = M.tagText(a, now), sig = `${k}|${label}|${tag}`;
    if (sig !== c.btnSig) {
      c.btnSig = sig;
      c.btn.setAttribute("aria-label", label);
      c.tag.className = `o3-tag ao-pill ao-pill--${k}`;
      c.tag.innerHTML = `${icon(STATES[k].icon, { size: 12 })}<span${M.displayName(a).length > NAME_MAX ? ` title="${esc(tag)}"` : ""}>${esc(tag)}</span>`;
      c.li.classList.toggle("is-needs", k === "needs");
    }
    const html = M.cardHTML(a, { now, color: ci, offlineMin });
    if (html !== c.cardHtml) {
      c.cardHtml = html;
      c.card.innerHTML = html;
      if (!c.card.hidden) positionHoverCard(c.card, c.btn, root);
    }
  }

  /** Tab order follows urgency. The focused button never moves, so focus is never lost. */
  function syncOrder() {
    const sorted = M.domOrder(agents), order = sorted.map((a) => chars.get(a.session).li), k = sorted.map((a) => a.session).join("\u0001");
    if (k === orderKey) return;
    orderKey = k;
    const focused = document.activeElement?.closest?.(".o3-a"), i = order.indexOf(focused);
    if (i < 0) { listEl.append(...order); return; }
    for (const li of order.slice(0, i)) listEl.insertBefore(li, focused);
    for (const li of order.slice(i + 1)) listEl.append(li);
  }

  function syncHall() {
    if (!hallG) return;
    const seats = [...agents].sort((a, b) => (M.projectKey(a) + M.displayName(a)).localeCompare(M.projectKey(b) + M.displayName(b)) || (a.session < b.session ? -1 : 1));
    const holos = seats.map((a) => (stateKey(a.state) === "offline" ? null
      : { color: PROJECT_COLORS[L.desks.get(a.session)?.color ?? 0], look: D.looks(a.session), opacity: M.agentOpacity(a.state, filter) }));
    const k = JSON.stringify(holos);
    if (k === hallKey) return;
    hallKey = k;
    hallG.innerHTML = D.hallInterior(L, holos, { pal, id });
  }

  function syncCounts() {
    const n = (s) => agents.filter((a) => stateKey(a.state) === s).length;
    const counts = { needs: n("needs"), working: n("working"), idle: n("idle"), offline: n("offline") }, waiting = counts.needs;
    for (const el of labelsEl.querySelectorAll("[data-n]")) {
      const v = String(el.dataset.n === "hall" ? agents.length - counts.offline : counts[el.dataset.n]);
      setText(el, v);
    }
    labelsEl.querySelector(".o3-sign")?.classList.toggle("is-on", waiting > 0);
    const sk = `${waiting > 0}|${theme}`;
    if (!L.empty && sk !== spotKey) {
      spotKey = sk;
      underG.innerHTML = D.spotlight(L, waiting > 0, { pal, id });
      mapShapes.querySelector(".o3-map-spot")?.setAttribute("fill", waiting ? pal.amber : pal.off);
    }
    syncStatus(counts);
  }

  /** HUD, summary and dimming for the data status, plus the centre overlay: loading, an error with nothing to show, or the empty office. */
  function syncStatus(counts = lastCounts) {
    lastCounts = counts;
    const mode = M.statusText(status, { asOf, replayAt }), hud = M.hudText(L.rooms.length, agents.length);
    for (const s of STATUSES) root.classList.toggle(`is-${s}`, status === s);
    root.classList.toggle("is-replay", replayAt != null);
    if (root.getAttribute("aria-busy") !== String(status === "loading")) root.setAttribute("aria-busy", String(status === "loading"));
    setText(q(".o3-hud-mode"), mode);
    setText(q(".o3-hud-meta"), status === "loading" ? "" : hud);
    setText(sumEl, status === "loading" ? "Loading the office." : `${mode}: ${hud}.` +
      (counts ? ` ${counts.needs} need you, ${counts.working} working, ${counts.idle} idle, ${counts.offline} offline.` : ""));
    const k = status === "loading" ? "loading" : status === "error" && !agents.length ? "error" : L.empty ? "empty" : "";
    if (k === overlayKey) return;
    overlayKey = k;
    emptyEl.hidden = !k;
    emptyEl.innerHTML = k === "loading" ? `<div class="o3-loading">${loadingState({ rows: 3, label: "Loading the office" })}</div>`
      : k === "error" ? errorState({ text: "Couldn't load the office. The server didn't answer.", action: onRetry ? { label: "Retry", attrs: { "data-retry": true } } : null })
        : k === "empty" ? emptyState({ icon: "office", text: "No agents yet. Start claude in any folder and it walks in here." }) : "";
  }

  // ---------- characters: walking, sitting, standing ----------
  function move(c, place, fromEntrance, snap) {
    const prev = c.place;
    c.place = place;
    if (prev && same(prev, place)) return;
    if (snap || reduced || !booted || (!prev && !fromEntrance)) return settle(c);
    const from = prev || { kind: "gone", ...L.entrance };
    if (!c.walk && from.kind === "gone" && place.kind === "gone") return settle(c);
    const path = M.walkPath(from, place, L, c.walk ? c.pos : null), len = M.pathLength(path);
    if (!c.walk) c.pos = { ...path[0] };
    c.walk = { path, d: 0, len, speed: Math.max(3.2, len / 2.8) };
    walkers.add(c);
    c.li.classList.add("is-walking");
    show(c, "walk");
  }

  function settle(c) {
    c.walk = null;
    walkers.delete(c);
    c.li.classList.remove("is-walking");
    const p = c.place;
    c.pos = { x: p.x, y: p.y };
    c.flip.removeAttribute("transform");
    if (p.kind === "desk") {
      setPose(c, "seat");
      const u = desks.get(c.a.session);
      if (c.g.parentNode !== u.slot) u.slot.append(c.g);
      c.g.style.display = "";
      placeG(c);
    } else if (p.kind === "gone") {
      c.g.style.display = "none";
    } else show(c, p.pose);
    placeLi(c);
    renderLinks(c);
  }

  function show(c, pose) {
    setPose(c, pose);
    c.g.style.display = "";
    placeG(c);
    sortIn(c);
  }

  function setPose(c, pose) {
    if (c.pose === pose) return;
    c.pose = pose;
    c.g.setAttribute("class", `o3-char o3-pose-${pose}`);
    c.body.innerHTML = (pose === "wave" ? D.halo(pal) : "") + D.figure({ look: D.looks(c.a.session), shirt: c.shirt, pal, pose, shadowId: `${id}-shadow` });
  }

  const placeG = (c) => { const [x, y] = M.project(c.pos.x, c.pos.y); c.g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`); };

  /** Painter's order for a standing or walking character: just before the first fixed item in front of it. */
  function sortIn(c) {
    const k = c.pos.x + c.pos.y;
    let lo = 0, hi = keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] <= k) lo = m + 1; else hi = m; }
    let ref = statics[lo]?.g || null;
    for (let p = ref ? ref.previousSibling : itemsG.lastChild; p && p !== c.g && p.__k > k; p = p.previousSibling) ref = p;
    c.g.__k = k;
    if (c.g.parentNode !== itemsG || c.g.nextSibling !== ref) itemsG.insertBefore(c.g, ref);
  }

  /** The button sits over the character; offline agents keep theirs over the empty chair. */
  function placeLi(c) {
    const gone = c.place?.kind === "gone" && !c.walk;
    const p = gone ? L.desks.get(c.a.session) : c.pos, pose = gone ? "gone" : c.place?.kind === "desk" && !c.walk ? "seat" : "stand";
    const [x, y] = W(M.project(p.x, p.y)), [bw, bh] = BOX[pose];
    const lift = c.place?.kind === "queue" && !c.walk ? c.place.index : 0, k = `${x.toFixed(1)},${y.toFixed(1)},${pose},${lift}`;
    if (k === c.liKey) return;
    c.liKey = k;
    c.li.style.cssText = `transform:translate(${x.toFixed(1)}px,${y.toFixed(1)}px);--bw:${bw}px;--bh:${bh}px;--lift:${lift};z-index:${Math.round((p.x + p.y) * 10)}`;
    c.li.classList.toggle("is-gone", gone);
  }

  /** Dashed teal lines from each running intern's head to its parent's head while the parent sits at its desk. */
  function renderLinks(c) {
    const u = desks.get(c.a.session);
    if (!u || !u.heads.length || c.place?.kind !== "desk" || c.walk) { if (c.links.firstChild) c.links.textContent = ""; return; }
    const head = M.project(c.pos.x, c.pos.y, HEAD.seat);
    c.links.innerHTML = u.heads.map((h) => `<path class="o3-link" d="${D.linkPath(h, head)}"/>`).join("");
  }

  // ---------- animation loop: only while someone walks or the view glides ----------
  function kick() { if (!raf && (walkers.size || tween)) raf = requestAnimationFrame(frame); }

  function frame(t) {
    raf = 0;
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;
    for (const c of walkers) {
      const w = c.walk;
      w.d = Math.min(w.len, w.d + w.speed * dt);
      const p = M.pointAlong(w.path, w.d), sdx = p.dx - p.dy;
      c.pos = { x: p.x, y: p.y };
      if (Math.abs(sdx) > 1e-6) c.flip.setAttribute("transform", sdx > 0 ? "scale(-1 1)" : "scale(1 1)");
      placeG(c);
      sortIn(c);
      placeLi(c);
      renderLinks(c);
      if (w.d >= w.len) settle(c);
    }
    if (tween) {
      tween.t0 ??= t;
      const k = Math.min(1, (t - tween.t0) / 320), e = 1 - (1 - k) ** 3, a = tween.from, b = tween.to;
      setView({ z: a.z + (b.z - a.z) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e });
      if (k >= 1) tween = null;
    }
    if (walkers.size) repositionCard();
    if (walkers.size || tween) raf = requestAnimationFrame(frame);
    else last = 0;
  }

  // ---------- view: pan, zoom, fit, minimap ----------
  function setView(v) {
    view = M.clampPan({ z: M.clampZoom(v.z), x: v.x, y: v.y }, scene, vp);
    world.style.transform = `translate(${view.x.toFixed(2)}px,${view.y.toFixed(2)}px) scale(${view.z.toFixed(4)})`;
    world.style.setProperty("--tag-s", M.tagScale(view.z).toFixed(4));
    world.style.setProperty("--iz", (1 / view.z).toFixed(4));
    world.style.setProperty("--qgap", `${M.queueTagGap(view.z).toFixed(2)}px`);
    root.classList.toggle("is-far", view.z < 0.5); // zoomed far out, only needs-you tags stay
    root.classList.add("is-moving");
    clearTimeout(moveT);
    moveT = setTimeout(() => root.classList.remove("is-moving"), 160);
    if (mapT) {
      const r = M.viewRect(view, vp), a = M.sceneToMap(r.x, r.y, mapT), b = M.sceneToMap(r.x + r.w, r.y + r.h, mapT);
      const cl = (v, hi) => Math.max(0, Math.min(hi, v)), x0 = cl(a.x, MAP.w), y0 = cl(a.y, MAP.h);
      mapView.setAttribute("x", x0.toFixed(1));
      mapView.setAttribute("y", y0.toFixed(1));
      mapView.setAttribute("width", Math.max(2, cl(b.x, MAP.w) - x0).toFixed(1));
      mapView.setAttribute("height", Math.max(2, cl(b.y, MAP.h) - y0).toFixed(1));
    }
    repositionCard();
  }

  function glide(v) {
    if (reduced || !vp.w) { tween = null; setView(v); return; }
    tween = { from: { ...view }, to: v, t0: null };
    kick();
  }

  function fit(animate = true) {
    fitted = true;
    const v = M.focusRect({ x: 0, y: 0, w: scene.w, h: scene.h }, vp, PAD);
    animate ? glide(v) : setView(v);
  }

  function userView(v) { fitted = false; tween = null; setView(v); }

  function repositionCard() {
    const card = cardsEl.querySelector(".ao-hovercard:not([hidden])");
    const a = card && root.querySelector(`[data-hovercard="${card.id}"]`);
    if (a) positionHoverCard(card, a, root);
  }

  // ---------- input ----------
  let drag = null, swallow = false;
  const onDown = (e) => {
    swallow = false;
    if (e.button !== 0 || e.target.closest(".o3-zoom, .o3-map, .ao-hovercard")) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      try { root.setPointerCapture(e.pointerId); } catch {} // keeps the drag going outside the office
      root.classList.add("is-dragging");
    }
    userView({ z: view.z, x: drag.vx + dx, y: drag.vy + dy });
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) { swallow = true; root.classList.remove("is-dragging"); }
    drag = null;
  };
  const onClickCapture = (e) => { if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault(); } };
  const onClick = (e) => {
    const t = e.target.closest?.("button");
    if (!t || !root.contains(t)) return;
    if (t.matches(".o3-agent")) onSelect(t.dataset.session);
    else if (t.matches("[data-room]")) focusRoom(t.dataset.room);
    else if (t.matches("[data-retry]")) onRetry?.();
    else if (t.dataset.zoom === "fit") fit();
    else if (t.dataset.zoom) { fitted = false; glide(M.zoomAt(view, t.dataset.zoom === "in" ? 1.3 : 1 / 1.3, vp.w / 2, vp.h / 2)); }
  };
  const onWheel = (e) => {
    e.preventDefault();
    const r = root.getBoundingClientRect(), dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    userView(M.zoomAt(view, Math.exp(-dy * 0.0015), e.clientX - r.left, e.clientY - r.top));
  };
  const onMap = (e) => {
    if (!mapT) return;
    const r = mapSvg.getBoundingClientRect(), p = M.mapToScene(e.clientX - r.left, e.clientY - r.top, mapT);
    fitted = false;
    glide(M.centerOn(p, view.z, vp));
  };
  const PAN = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  const onKey = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    let v = null;
    if (PAN[e.key]) v = { z: view.z, x: view.x + PAN[e.key][0] * 80, y: view.y + PAN[e.key][1] * 80 };
    else if (e.key === "+" || e.key === "=") v = M.zoomAt(view, 1.25, vp.w / 2, vp.h / 2);
    else if (e.key === "-" || e.key === "_") v = M.zoomAt(view, 0.8, vp.w / 2, vp.h / 2);
    else if (e.key === "0") { e.preventDefault(); fit(); return; }
    if (!v) return;
    e.preventDefault();
    fitted = false;
    glide(v);
  };
  const onOver = (e) => { const b = e.target.closest?.(".o3-agent"); if (b) onHover?.(b.dataset.session); };
  const onOut = (e) => { if (e.target.closest?.(".o3-agent") && !e.relatedTarget?.closest?.(".o3-agent")) onHover?.(null); };
  const onTheme = () => {
    const t = getTheme() === "light" ? "light" : "dark";
    if (t === theme) return;
    theme = t;
    pal = D.PALETTE[t];
    root.classList.toggle("ao-dark", t === "dark");
    root.classList.toggle("ao-light", t === "light");
    key = null;
    render();
  };
  const onVisible = () => root.classList.toggle("o3-paused", document.hidden);
  const onMotion = (e) => { reduced = e.matches; if (reduced) for (const c of [...walkers]) settle(c); };

  root.classList.add(theme === "light" ? "ao-light" : "ao-dark");
  const unbind = bind(root);
  const listeners = [["pointerdown", onDown], ["pointermove", onMove], ["pointerup", onUp], ["pointercancel", onUp], ["click", onClick],
    ["keydown", onKey], ["pointerover", onOver], ["pointerout", onOut]];
  for (const [t, fn] of listeners) root.addEventListener(t, fn);
  root.addEventListener("click", onClickCapture, true);
  root.addEventListener("wheel", onWheel, { passive: false });
  q(".o3-map").addEventListener("click", onMap);
  document.addEventListener("ao-theme", onTheme);
  document.addEventListener("visibilitychange", onVisible);
  mq?.addEventListener?.("change", onMotion);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    const w = root.clientWidth, h = root.clientHeight;
    if (w === vp.w && h === vp.h) return;
    vp = { w, h };
    if (fitted) fit(false); else setView(view);
  }) : null;
  ro?.observe(root);
  vp = { w: root.clientWidth, h: root.clientHeight };

  // ---------- public API ----------
  function update(list = [], o = {}) {
    if (o.filter !== undefined) filter = M.normFilter(o.filter);
    if (o.offlineAfterMin) offlineMin = o.offlineAfterMin;
    replayAt = o.replayAt ?? null;
    now = o.now != null ? +new Date(o.now) : replayAt != null ? +new Date(replayAt) : Date.now();
    agents = Array.isArray(list) ? list : [];
    if (status === "loading" || status === "error") status = "live"; // data arrived; "stale" waits for setStatus("live")
    render();
  }

  /** Data status from the caller: "live", "stale" (asOf = time of the last data), "error", or "loading". */
  function setStatus(s, at = null) {
    status = STATUSES.has(s) ? s : "live";
    asOf = at;
    syncStatus();
  }

  function render() {
    const k = `${theme}|${M.layoutKey(agents)}`;
    if (k !== key) {
      key = k;
      rebuild();
      if (fitted || !booted) fit(false); else setView(view);
    }
    refresh();
    booted = true;
  }

  function focusAgent(session) {
    const c = chars.get(session);
    if (!c) return;
    const p = c.place?.kind === "gone" && !c.walk ? L.desks.get(session) : c.pos;
    const [x, y] = W(M.project(p.x, p.y, 1));
    fitted = false;
    glide(M.centerOn({ x, y }, Math.max(view.z, 1.6), vp));
    c.li.classList.remove("is-pulse");
    void c.li.offsetWidth;
    c.li.classList.add("is-pulse");
    clearTimeout(c.pulseT);
    c.pulseT = setTimeout(() => c.li.classList.remove("is-pulse"), 2400);
  }

  function focusRoom(project) {
    const r = L.rooms.find((x) => x.project === project);
    if (!r) return;
    const pts = [[r.x, r.y, 2.8], [r.x + r.w, r.y, 0], [r.x, r.y + r.d, 0], [r.x + r.w, r.y + r.d, 0]].map(([x, y, z]) => W(M.project(x, y, z)));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    fitted = false;
    glide(M.focusRect({ x: Math.min(...xs), y: Math.min(...ys) - 20, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) + 20 }, vp, PAD, 2));
  }

  function destroy() {
    cancelAnimationFrame(raf);
    clearTimeout(moveT);
    for (const c of chars.values()) clearTimeout(c.pulseT);
    unbind();
    for (const [t, fn] of listeners) root.removeEventListener(t, fn);
    root.removeEventListener("click", onClickCapture, true);
    root.removeEventListener("wheel", onWheel);
    document.removeEventListener("ao-theme", onTheme);
    document.removeEventListener("visibilitychange", onVisible);
    mq?.removeEventListener?.("change", onMotion);
    ro?.disconnect();
    container.innerHTML = "";
  }

  syncStatus();
  return { update, setStatus, setFilter: (states) => { filter = M.normFilter(states); refresh(); }, focusAgent, focusRoom, fit: () => fit(), destroy };
}
