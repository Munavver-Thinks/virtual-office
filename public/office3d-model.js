// The 3D office, pure part: isometric projection, box faces, painter's sort, the office layout, where each agent
// belongs, walking paths, tag and card text, and pan/zoom maths. No DOM: safe to import in Node tests.
import { STATES, stateKey, projectColor, statePill, progressBar, avatar } from "./ui/components.js";
import { esc, waitTime, clock, costText } from "./ui/format.js";
import { icon } from "./ui/icons.js";
import { describeStep, describeTool, describeQuestion, offlineText } from "./lib/describe.js";

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const r2 = (n) => Math.round(n * 100) / 100;

// ---------- projection ----------
/** 2:1 isometric: x → (28, 14), y → (−28, 14), z → (0, −30) px. */
export function project(x, y, z = 0) {
  return [28 * x - 28 * y, 14 * x + 14 * y - 30 * z];
}

/** Face brightness. Light comes from above and the back. */
export const SHADE = { top: 1, left: 0.8, right: 0.63 };

/** "#rrggbb" times f, clamped to 0–255 per channel. */
export function shade(hex, f) {
  const n = parseInt(String(hex).slice(1, 7), 16) || 0;
  const ch = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return "#" + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("");
}

/** The three faces a box shows: top, left (its +y side) and right (its +x side), as screen polygons. */
export function boxFaces({ x, y, z = 0, w, d, h }) {
  const p = project, t = z + h;
  return [
    { face: "top", shade: SHADE.top, pts: [p(x, y, t), p(x + w, y, t), p(x + w, y + d, t), p(x, y + d, t)] },
    { face: "left", shade: SHADE.left, pts: [p(x, y + d, z), p(x + w, y + d, z), p(x + w, y + d, t), p(x, y + d, t)] },
    { face: "right", shade: SHADE.right, pts: [p(x + w, y, z), p(x + w, y + d, z), p(x + w, y + d, t), p(x + w, y, t)] },
  ];
}

/** Back to front: a smaller x + y is further away. Ties: lower z first, then input order. */
export function paintersSort(items) {
  return items.map((it, i) => [it, i])
    .sort(([a, i], [b, j]) => a.x + a.y - (b.x + b.y) || (a.z || 0) - (b.z || 0) || i - j)
    .map(([it]) => it);
}

// ---------- layout (world units; one desk is 2.4 wide) ----------
export const PITCH = 2.4;
const PER_ROW = 6, ROW_D = 4.6, PAD_L = 0.6, PAD_R = 1.4, PAD_BACK = 0.3;
const GAP = 1.2, CORRIDOR = 1.4, MARGIN = 0.9, SPOT_W = 4.8, COMMONS_D = 5.6, QUEUE_STEP = 1.6;

/** Rooms are per git project (the git root's folder name). */
export const projectKey = (a) => a.project || "Other";
const startOf = (a) => Date.parse(a.started) || 0;
const byStart = (a, b) => startOf(a) - startOf(b) || cmp(a.session, b.session);

/** Desks in up to 6 balanced columns. The width grows 2.4 per desk; there are never empty desks. */
export function roomSize(n) {
  const rows = Math.max(1, Math.ceil(n / PER_ROW)), cols = Math.max(1, Math.ceil(n / rows));
  return { rows, cols, w: r2(cols * PITCH + PAD_L + PAD_R), d: r2(rows * ROW_D + PAD_BACK) };
}

/** Colour index (0–5, see PROJECT_COLORS) per project: the one you picked in Settings (an agent's projectColor), else its
 *  hashed colour, or the next free one. Older projects pick first. */
export function projectColors(agents = []) {
  const order = [], out = new Map();
  for (const a of [...agents].sort(byStart)) {
    const p = projectKey(a);
    if (Number.isInteger(a.projectColor) && a.projectColor >= 0 && a.projectColor < 6) out.set(p, a.projectColor);
    if (!order.includes(p)) order.push(p);
  }
  const taken = new Set(out.values());
  for (const p of order) {
    if (out.has(p)) continue;
    let i = projectColor(p);
    for (let k = 0; k < 6 && taken.has(i); k++) i = (i + 1) % 6;
    taken.add(i);
    out.set(p, i);
  }
  return out;
}

/** Standing spots in a lounge of width w (relative to the lounge), nearest the coffee table first. */
function loungeSpots(w, d) {
  const tx = w / 2, ty = 3, fx = tx + 1, fy = ty + 0.3, out = [];
  for (let r = 0; 2.1 + r * 1.15 <= d - 0.5; r++) {
    for (let c = 0; 0.9 + c * 1.3 <= w - 0.9; c++) {
      const x = r2(0.9 + c * 1.3), y = r2(2.1 + r * 1.15);
      if (Math.abs(x - tx) > 1.2 || Math.abs(y - ty) > 0.9) out.push({ x, y });
    }
  }
  const dist = (p) => Math.hypot(p.x - fx, p.y - fy);
  // Nearest the table first, but skip a spot where the person or their name tag would overlap someone already there.
  const left = out.sort((a, b) => dist(a) - dist(b) || a.x - b.x || a.y - b.y), order = [];
  const clash = (a, b) => {
    const dx = Math.abs(28 * (a.x - a.y - b.x + b.y)), dy = Math.abs(14 * (a.x + a.y - b.x - b.y));
    return (dx < 124 && dy < 24) || (dx < 36 && dy < 64);
  };
  while (left.length) {
    const i = Math.max(0, left.findIndex((p) => !order.some((q) => clash(p, q))));
    order.push(left.splice(i, 1)[0]);
  }
  return order;
}

/**
 * The office plan. Depends only on which agents exist (projects, counts, start order), never on their state.
 * Rooms are packed in rows at the back, flush against a corridor that runs from the Needs You spotlight (by the
 * entrance) up the right side; `hub` is where it meets the front hallway. In front are the lounge, the meeting hall
 * and the spotlight. The floor is one slab made of bands, one per row, so wide rows don't leave empty floor behind them.
 */
export function layoutOffice(agents = []) {
  const n = agents.length;
  if (!n) {
    const slab = { x: -MARGIN, y: -MARGIN, w: 12 + 2 * MARGIN, d: 8 + 2 * MARGIN };
    return { empty: true, rooms: [], desks: new Map(), lounge: null, hall: null, spot: null, slab, floor: [slab], outline: { x: 2.5, y: 1.5, w: 7, d: 5 } };
  }
  const colors = projectColors(agents), groups = new Map();
  for (const a of [...agents].sort(byStart)) {
    if (!groups.has(projectKey(a))) groups.set(projectKey(a), []);
    groups.get(projectKey(a)).push(a);
  }
  // Meeting hall: tables of 8 to 12 seats, one more table row per 12 agents.
  const side = Math.min(6, Math.max(4, Math.ceil(n / 2))), tables = Math.ceil(n / (2 * side)), tableLen = r2(side * 1.15 + 0.4);
  const hw = n >= 2 ? r2(tableLen + 3.2) : 0, CD = r2(Math.max(COMMONS_D, hw ? tables * 2.9 + 1.4 : 0));
  let lw = 6.4;
  while (loungeSpots(lw, CD).length < n) lw = r2(lw + 1.3);
  const commonsW = lw + CORRIDOR + (hw ? hw + CORRIDOR : 0) + SPOT_W;

  const sizes = [...groups].map(([project, list]) => ({ project, list, ...roomSize(list.length) }));
  const area = sizes.reduce((s, r) => s + (r.w + GAP) * (r.d + CORRIDOR), 0);
  const limit = Math.max(...sizes.map((r) => r.w), Math.sqrt(area * 1.4), commonsW - SPOT_W / 2 - 0.9);
  const rows = [];
  for (const r of sizes) {
    let row = rows.at(-1);
    if (!row || row.w + GAP + r.w > limit + 1e-9) rows.push((row = { rooms: [], w: -GAP, d: 0 }));
    r.x = r2(row.w + GAP);
    row.w = r2(r.x + r.w);
    row.d = Math.max(row.d, r.d);
    row.rooms.push(r);
  }
  let y = 0;
  for (const row of rows) { row.y = y; y = r2(y + row.d + CORRIDOR); }
  const y0 = y, W = r2(Math.max(commonsW, Math.max(...rows.map((r) => r.w)) + 0.9 + SPOT_W / 2));
  const cx = r2(W - SPOT_W / 2), hub = { x: cx, y: r2(y0 - CORRIDOR / 2) }, right = r2(cx - CORRIDOR / 2 - 0.2);
  for (const row of rows) {
    row.x0 = r2(right - row.w);
    for (const r of row.rooms) r.x = r2(r.x + row.x0);
  }
  // The last band is full width: the lounge's path to the corridor runs along its hallway.
  const floor = rows.map((row, i) => {
    const x = i === rows.length - 1 ? -MARGIN : r2(row.x0 - MARGIN), top = i ? row.y : -MARGIN;
    return { x, y: top, w: r2(W + MARGIN - x), d: r2(row.y + row.d + CORRIDOR - top) };
  });
  floor.push({ x: -MARGIN, y: y0, w: r2(W + 2 * MARGIN), d: r2(CD + MARGIN) });

  const desks = new Map(), rooms = [];
  for (const row of rows) {
    for (const { project, list, rows: nr, cols, w, d, x } of row.rooms) {
      const room = { project, color: colors.get(project), x, y: row.y, w, d, rows: nr, cols, agents: list.length,
        doorX: r2(x + w - 0.7), corridorY: r2(row.y + row.d + CORRIDOR / 2), desks: [] };
      list.forEach((a, i) => {
        const r = Math.floor(i / cols), c = i % cols, dx = r2(x + PAD_L + PITCH / 2 + c * PITCH), top = row.y + PAD_BACK + r * ROW_D;
        const desk = { session: a.session, project, color: room.color, row: r, col: c, x: dx, y: r2(top + 0.9),
          gapX: r2(dx + PITCH / 2), aisleY: r2(top + 4.2), doorX: room.doorX, corridorY: room.corridorY };
        room.desks.push(desk);
        desks.set(a.session, desk);
      });
      rooms.push(room);
    }
  }

  const lounge = { x: 0, y: y0, w: lw, d: CD, exitX: r2(lw + CORRIDOR / 2),
    spots: loungeSpots(lw, CD).map((s) => ({ x: s.x, y: r2(y0 + s.y) })), table: { x: r2(lw / 2), y: r2(y0 + 3) } };
  let hall = null;
  if (hw) {
    const hx = r2(lw + CORRIDOR), first = y0 + CD / 2 - 0.25 - (tables - 1) * 1.45;
    const list = Array.from({ length: tables }, (_, t) => ({ x: r2(hx + 1.6), y: r2(first + t * 2.9), w: tableLen, d: 0.9 }));
    const seat = (t, i, back) => ({ x: r2(hx + 1.8 + 1.15 * (i + 0.5)), y: r2(back ? t.y - 0.55 : t.y + 1.45), back, table: list.indexOf(t) });
    hall = { x: hx, y: y0, w: hw, d: CD, tables: list,
      seats: list.flatMap((t) => [...Array.from({ length: side }, (_, i) => seat(t, i, true)), ...Array.from({ length: side }, (_, i) => seat(t, i, false))]) };
  }
  const cy = r2(y0 + CD / 2 + 0.3);
  const spot = { x: r2(W - SPOT_W), y: y0, w: SPOT_W, d: CD, cx, cy, r: 1.35, lamp: { x: r2(cx - 2), y: r2(cy + 0.2) } };
  return {
    empty: false, rooms, desks, lounge, hall, spot, hub, W, y0, floor,
    corridor: { x: r2(cx - CORRIDOR / 2), y: -MARGIN, w: CORRIDOR, d: r2(y0 + MARGIN) },
    entrance: { x: cx, y: r2(y0 + CD + 0.35) },
    slab: { x: -MARGIN, y: -MARGIN, w: r2(W + 2 * MARGIN), d: r2(y0 + CD + 2 * MARGIN) },
  };
}

// ---------- labels ----------
/** Screen box (px) of a label of `chars` characters whose bottom centre sits at world point (x, y, z). */
function labelBox(x, y, z, chars) {
  const [px, py] = project(x, y, z), w = (chars * 7.4 + 44) * 1.1;
  return { x: px - w / 2, y: py - 30, w, h: 30 };
}
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Screen boxes that labels must keep clear of: every place a person, their tag, a monitor badge or an intern can be. */
function busyBoxes(L) {
  const out = [], n = L.desks.size;
  const at = (x, y, z, w, up, down = 0) => { const [px, py] = project(x, y, z); out.push({ x: px - w / 2, y: py - up, w, h: up + down }); };
  for (const d of L.desks.values()) {
    at(d.x, d.y, 0, 132, 88);
    at(d.x, d.y + 1, 0, 70, 78, 12);
    at(d.x, d.y + 2.1, 0, 104, 40, 14);
  }
  for (const s of L.lounge.spots.slice(0, n)) at(s.x, s.y, 0, 132, 92);
  for (let i = 0; i < Math.min(n, 8); i++) { const q = queueSlot(L, i, n); at(q.x, q.y, 0, 132, 92); }
  for (const seat of L.hall?.seats || []) at(seat.x, seat.y, 0, 44, 52);
  out.push(labelBox(L.spot.lamp.x, L.spot.lamp.y, 3.55, 14));
  return out;
}

/**
 * Where each room label (and the meeting hall's) floats: the first of a few spots around the room whose box stays clear
 * of people, tags and other labels, or the least crowded one. Keyed by project; the hall is "#hall".
 */
export function labelSpots(L) {
  const out = new Map();
  if (L.empty) return out;
  const busy = busyBoxes(L);
  const place = (key, r, chars, spots) => {
    let best = null;
    for (const [x, y, z] of spots) {
      const b = labelBox(x, y, z, chars), score = busy.reduce((s, o) => s + overlapArea(b, o), 0);
      if (!best || score < best.score - 1e-6) best = { x, y, z, score, b };
      if (!score) break;
    }
    busy.push(best.b);
    out.set(key, { x: best.x, y: best.y, z: best.z });
  };
  for (const r of L.rooms) {
    const chars = r.project.length + String(r.agents).length + 8;
    place(r.project, r, chars, [[r.x, r.y, 1.35], [r.x + r.w / 2, r.y, 2.3], [r.x, r.y + r.d / 2, 2.3], [r.x, r.y, 2.7],
      [r.x + r.w, r.y + r.d / 2, 1.1], [r.x + r.w / 2, r.y + r.d, 1.1], [r.x, r.y + r.d, 1.1], [r.x + r.w, r.y, 1.1]]);
  }
  if (L.hall) {
    const h = L.hall;
    place("#hall", h, 36, [[h.x + 1.2, h.y + 0.3, 2.45], [h.x + h.w * 0.3, h.y, 2.6], [h.x, h.y + h.d / 2, 2.3], [h.x + h.w / 2, h.y + h.d, 0.6], [h.x, h.y + h.d, 1.1]]);
  }
  return out;
}

// ---------- where agents go ----------
/** Agents waiting on you, longest wait first. */
export function queueOrder(agents) {
  const t = (a) => Date.parse(a.waitingSince) || Infinity;
  return agents.filter((a) => stateKey(a.state) === "needs").sort((a, b) => t(a) - t(b) || cmp(a.session, b.session));
}

/** Queue slot i of n: the first stands on the spotlight disc, the rest line up the corridor behind. */
export function queueSlot(L, i, n = i + 1) {
  const s = L.spot, room = s.cy + MARGIN - 0.6, step = n > 1 ? Math.min(QUEUE_STEP, room / (n - 1)) : QUEUE_STEP;
  return { x: s.cx, y: r2(s.cy - i * step) };
}

/** Lounge spot per idle agent: agents keep their spot, newcomers take the lowest free one. */
export function assignLounge(ids, prev = new Map(), capacity = Infinity) {
  const out = new Map(), used = new Set();
  for (const id of ids) {
    const i = prev.get(id);
    if (i != null && i < capacity && !used.has(i)) { out.set(id, i); used.add(i); }
  }
  let next = 0;
  for (const id of ids) {
    if (out.has(id)) continue;
    while (used.has(next)) next++;
    out.set(id, next);
    used.add(next);
  }
  return out;
}

/** Working: seated at the desk. Needs you: in the spotlight queue. Idle: in the lounge. Offline: gone out the entrance. */
export function placeOf(a, L, { queue = new Map(), lounge = new Map() } = {}) {
  const k = stateKey(a.state);
  if (k === "needs" && queue.has(a.session)) {
    const i = queue.get(a.session);
    return { kind: "queue", pose: "wave", index: i, ...queueSlot(L, i, queue.size) };
  }
  if (k === "idle") {
    const spots = L.lounge.spots, s = spots[(lounge.get(a.session) ?? 0) % spots.length];
    return { kind: "lounge", pose: "cup", x: s.x, y: s.y };
  }
  if (k === "offline") return { kind: "gone", pose: "walk", x: L.entrance.x, y: L.entrance.y };
  const desk = L.desks.get(a.session);
  return { kind: "desk", pose: "seat", x: desk.x, y: desk.y, desk };
}

function toHub(p, L) {
  const h = L.hub;
  if (p.kind === "desk") {
    const d = p.desk;
    return [[d.x, d.y], [d.gapX, d.y], [d.gapX, d.aisleY], [d.doorX, d.aisleY], [d.doorX, d.corridorY], [h.x, d.corridorY], [h.x, h.y]];
  }
  if (p.kind === "lounge") { const ex = L.lounge.exitX; return [[p.x, p.y], [ex, p.y], [ex, h.y], [h.x, h.y]]; }
  return [[p.x, p.y], [h.x, h.y]]; // the queue and the entrance share the hub's column
}

/** Floor path between two places through doors and corridors. `at` = a point mid-walk to start from instead. */
export function walkPath(from, to, L, at = null) {
  const back = toHub(to, L).reverse();
  const raw = at ? [[at.x, at.y], [L.hub.x, L.hub.y], ...back]
    : from.kind === to.kind && (to.kind === "queue" || to.kind === "lounge") ? [[from.x, from.y], [to.x, to.y]]
      : [...toHub(from, L), ...back];
  const out = [];
  for (const [x, y] of raw) if (!out.length || Math.hypot(x - out.at(-1).x, y - out.at(-1).y) > 1e-6) out.push({ x, y });
  return out;
}

export function pathLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
}

/** The point `dist` along a path, with the direction of travel (dx, dy). */
export function pointAlong(pts, dist) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], len = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist <= len || i === pts.length - 1) {
      const t = len ? Math.min(1, Math.max(0, dist / len)) : 1;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: b.x - a.x, dy: b.y - a.y };
    }
    dist -= len;
  }
  return { x: pts[0].x, y: pts[0].y, dx: 0, dy: 0 };
}

// ---------- text ----------
/** The label from "<project> · <label>" ("refund flow"). A name the user set stays whole. */
export function displayName(a) {
  return a.label && a.name === `${a.project} · ${a.label}` ? a.label : a.name || a.label || "Agent";
}

const waitMs = (a, now) => (stateKey(a.state) === "needs" && a.waitingSince ? Math.max(0, now - Date.parse(a.waitingSince)) : null);

/** Name tag: "refund flow", or "refund flow · 9m" while it waits on you. */
export function tagText(a, now = Date.now()) {
  const w = waitMs(a, now);
  return w == null ? displayName(a) : `${displayName(a)} · ${waitTime(w)}`;
}

/** "refund flow, checkout-api, Needs you, waiting 9m. Press Enter for details" */
export function agentAria(a, now = Date.now()) {
  const k = stateKey(a.state), w = waitMs(a, now);
  return `${displayName(a)}, ${projectKey(a)}, ${STATES[k].label}${w == null ? "" : `, waiting ${waitTime(w)}`}. Press Enter for details`;
}

const URGENCY = { needs: 0, working: 1, idle: 2, offline: 3 };
/** Tab order of the character buttons: most urgent state, then project, then name. */
export function domOrder(agents) {
  return [...agents].sort((a, b) => URGENCY[stateKey(a.state)] - URGENCY[stateKey(b.state)] ||
    cmp(projectKey(a), projectKey(b)) || cmp(displayName(a), displayName(b)) || cmp(a.session, b.session));
}

/** HUD status: "Loading…", "Live", "As of 15:40" (stale), "Can't reach the server", or "Replaying 11:40". */
export function statusText(status, { asOf = null, replayAt = null } = {}) {
  if (replayAt != null) return `Replaying ${clock(replayAt)}`;
  if (status === "loading") return "Loading…";
  if (status === "stale") return clock(asOf) ? `As of ${clock(asOf)}` : "Not live";
  if (status === "error") return "Can't reach the server";
  return "Live";
}

/** HUD count: "3 rooms · 8 agents". */
export function hudText(rooms, agents) {
  return `${rooms} ${rooms === 1 ? "room" : "rooms"} · ${agents} ${agents === 1 ? "agent" : "agents"}`;
}

// ---------- filter dimming ----------
export const DIM = 0.16, OFFLINE_DESK = 0.55;
/** States to show (store or design names), or null for all. */
export const normFilter = (states) => (states && states.length ? new Set([...states].map(stateKey)) : null);
export const agentOpacity = (state, filter) => (filter && !filter.has(stateKey(state)) ? DIM : 1);
/** An offline desk is dimmed to 55%; a filtered-out one to 16%. */
export const deskOpacity = (state, filter) => (filter && !filter.has(stateKey(state)) ? DIM : stateKey(state) === "offline" ? OFFLINE_DESK : 1);

// ---------- hover card ----------
/** What paths are shown relative to: the git root, else the folder the session started in. */
export const rootOf = (a) => a.root || a.gitRoot || null;

/** What the agent is doing now, in plain English: { text, target (relative path or command), icon }. */
export function actionOf(a, { offlineMin = 30 } = {}) {
  const k = stateKey(a.state), root = rootOf(a), steps = a.recent || [];
  if (k === "needs" && a.question) {
    const q = a.question;
    const target = q.tool ? describeTool({ tool: q.tool, target: q.target, detail: q.detail }, { root }).target : q.target || null;
    return { text: describeQuestion(q), target, icon: "hand" };
  }
  if (k === "offline") return { text: a.ended ? "Ended the session" : offlineText(offlineMin), target: null, icon: "power" };
  if (k === "working") {
    // A new prompt and no tool yet: it's working on that prompt, not still on the last turn's tool.
    const last = steps.at(-1);
    if (last?.kind === "prompt") return { text: last.command ? "Running a slash command" : "Working on your prompt", target: last.command || null, icon: "chat" };
    const step = steps.findLast((s) => s.kind === "tool");
    if (step) return describeStep(step, { root });
    if (a.tool) return describeTool({ tool: a.tool, target: a.target }, { root, running: true });
    return { text: "Working", target: null, icon: "pulse" };
  }
  const last = steps.findLast((s) => s.kind !== "notice");
  return last ? describeStep(last, { root }) : { text: STATES[k].label, target: null, icon: STATES[k].icon };
}

/** Hover card body: name, project · machine, state pill, current action, plan progress, cost.
 *  replay: the office shows a past moment, of which only the state is known, so the card says so instead. */
export function cardHTML(a, { now = Date.now(), color, offlineMin, replay = false } = {}) {
  const name = displayName(a), head = `<div class="o3-card-head">${avatar({ name, project: projectKey(a), color, size: "sm", decorative: true })}<div class="o3-card-id"><div class="o3-card-name">${esc(name)}</div><div class="ao-meta">${esc(projectKey(a))}${a.host ? ` · ${esc(a.host)}` : ""}</div></div></div>`;
  if (replay) return `<div class="o3-card">${head}<div>${statePill(a.state, { waitMs: waitMs(a, now) })}</div><div class="ao-meta">State at ${esc(clock(now))}. Actions, plan and cost show live data only.</div></div>`;
  const act = actionOf(a, { offlineMin }), p = a.plan || {};
  const total = (p.done || 0) + (p.inProgress || 0) + (p.pending || 0);
  const sub = a.subagents || {}, subs = [sub.running && `${sub.running} running`, sub.finished && `${sub.finished} finished`].filter(Boolean);
  const subRows = (Array.isArray(sub.list) ? sub.list : []).map((x) =>
    `<div class="o3-card-subrow">${icon(x.status === "running" ? "sub-agent" : "check", { size: 13 })}<span>${esc(x.description || "Sub-agent")}</span></div>`).join("");
  const plan = a.hasPlan
    ? `${progressBar({ done: p.done, doing: p.inProgress, total, label: `Plan: ${p.done || 0} of ${total} done` })}<span class="o3-card-num">${p.done || 0}/${total}</span>`
    : `<span class="ao-meta">No plan</span>`;
  return `<div class="o3-card">
    ${head}
    <div>${statePill(a.state, { waitMs: waitMs(a, now) })}</div>
    <div class="o3-card-act">${icon(act.icon, { size: 14 })}<span>${esc(act.text)}</span></div>
    ${act.target ? `<code class="o3-card-target" title="${esc(act.target)}">${esc(act.target)}</code>` : ""}
    <div class="o3-card-plan">${plan}</div>
    ${subs.length ? `<div class="o3-card-sub"><div class="ao-meta">Sub-agents: ${subs.join(" · ")}</div>${subRows}</div>` : ""}
    <div class="o3-card-foot"><span class="ao-meta">Cost</span><b>${esc(costText(a))}</b></div>
  </div>`;
}

// ---------- view: pan, zoom, fit, minimap ----------
export const ZOOM_MIN = 0.45, ZOOM_MAX = 2.6;
export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z) || 1));

/** Zooms by `factor` around a viewport point, keeping the scene point under it in place. */
export function zoomAt(v, factor, px, py) {
  const z = clampZoom(v.z * factor), k = z / v.z;
  return { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

/** Keeps at least `keep` px of the scene inside the viewport on each axis. */
export function clampPan(v, scene, vp, keep = 80) {
  const axis = (pos, size, view) => {
    const k = Math.min(keep, view / 2, size * v.z);
    return Math.min(view - k, Math.max(k - size * v.z, pos));
  };
  return { z: v.z, x: axis(v.x, scene.w, vp.w), y: axis(v.y, scene.h, vp.h) };
}

/** Centres a scene rectangle in the padded viewport, as large as fits (up to `max`). */
export function focusRect(r, vp, pad = {}, max = ZOOM_MAX) {
  const { top = 24, right = 24, bottom = 24, left = 24 } = pad;
  const aw = Math.max(1, vp.w - left - right), ah = Math.max(1, vp.h - top - bottom);
  const z = Math.min(max, clampZoom(Math.min(aw / r.w, ah / r.h)));
  return { z, x: left + aw / 2 - (r.x + r.w / 2) * z, y: top + ah / 2 - (r.y + r.h / 2) * z };
}

/** A scene point in the middle of the viewport at zoom z. */
export const centerOn = (pt, z, vp) => ({ z: clampZoom(z), x: vp.w / 2 - pt.x * clampZoom(z), y: vp.h / 2 - pt.y * clampZoom(z) });

/** The part of the scene the viewport shows, in scene px. */
export const viewRect = (v, vp) => ({ x: -v.x / v.z, y: -v.y / v.z, w: vp.w / v.z, h: vp.h / v.z });

/** Scale and offset that fit the scene into the minimap. */
export function mapFit(scene, map, pad = 6) {
  const k = Math.min((map.w - 2 * pad) / scene.w, (map.h - 2 * pad) / scene.h);
  return { k, ox: (map.w - scene.w * k) / 2, oy: (map.h - scene.h * k) / 2 };
}
export const sceneToMap = (x, y, f) => ({ x: f.ox + x * f.k, y: f.oy + y * f.k });
export const mapToScene = (x, y, f) => ({ x: (x - f.ox) / f.k, y: (y - f.oy) / f.k });

/** On-screen size of tags and labels follows the zoom only a little; this is the scale to apply inside the zoomed world. */
export const tagScale = (z) => Math.min(1.1, Math.max(0.9, z)) / z;

/** Extra lift (tag px) per place in the queue so queue tags stay apart when zoomed out: the slots get closer, the tags do not. */
export function queueTagGap(z) {
  const cz = Math.min(1.1, Math.max(0.9, z));
  return Math.max(0, (21 * cz + 3 - 14 * QUEUE_STEP * z) / cz);
}

/** Screen box of the whole office (slab, walls and labels), in projected px. */
export function sceneBounds(L, pad = 40) {
  const xs = [], ys = [];
  for (const s of L.floor) {
    for (const [x, y] of [[s.x, s.y], [s.x + s.w, s.y], [s.x, s.y + s.d], [s.x + s.w, s.y + s.d]]) {
      for (const z of [-0.5, 3.4]) { const [px, py] = project(x, y, z); xs.push(px); ys.push(py); }
    }
  }
  const x = Math.floor(Math.min(...xs) - pad), y = Math.floor(Math.min(...ys) - pad);
  return { x, y, w: Math.ceil(Math.max(...xs) + pad - x), h: Math.ceil(Math.max(...ys) + pad + 24 - y) };
}

/** Changes only when agents join or leave, or move project, or a project's colour is picked: the trigger for a new layout. */
export const layoutKey = (agents) => [...agents].sort(byStart).map((a) => `${a.session}\u0001${projectKey(a)}\u0001${a.projectColor ?? ""}`).join("\u0002");
