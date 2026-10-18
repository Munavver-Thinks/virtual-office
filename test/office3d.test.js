"use strict";
// The 3D office (public/office3d.js): projection, faces, painter's sort, layout, placement, text and view maths.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { pathToFileURL } = require("url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "public", "office3d.js")).href);
const M = 60000, NOW = Date.parse("2026-10-17T15:42:00Z");
const iso = (minAgo) => new Date(NOW - minAgo * M).toISOString();

/** One agent per entry of counts[p] in project p; states cycle so every kind of place is used. */
function office(counts, states = ["working", "waiting", "idle", "offline"]) {
  const out = [];
  counts.forEach((n, p) => {
    for (let i = 0; i < n; i++) {
      const k = out.length, state = states[k % states.length];
      out.push({ session: `s${p}-${i}`, project: `project-${p}`, label: `task ${k}`, name: `project-${p} · task ${k}`, state,
        started: iso(600 - k), waitingSince: state === "waiting" ? iso(5 + k) : null });
    }
  });
  return out;
}

const inside = (p, r, m = 0) => p.x > r.x + m && p.x < r.x + r.w - m && p.y > r.y + m && p.y < r.y + r.d - m;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d;
const within = (a, s) => a.x >= s.x - 1e-9 && a.y >= s.y - 1e-9 && a.x + a.w <= s.x + s.w + 1e-9 && a.y + a.d <= s.y + s.d + 1e-9;
const onFloor = (p, L) => L.floor.some((b) => p.x >= b.x - 1e-9 && p.x <= b.x + b.w + 1e-9 && p.y >= b.y - 1e-9 && p.y <= b.y + b.d + 1e-9);

test("projection is 2:1 isometric: x → (28,14), y → (−28,14), z → (0,−30)", async () => {
  const { project } = await load();
  assert.deepEqual(project(1, 0, 0), [28, 14]);
  assert.deepEqual(project(0, 1, 0), [-28, 14]);
  assert.deepEqual(project(0, 0, 1), [0, -30]);
  assert.deepEqual(project(2, 3, 0.5), [28 * 2 - 28 * 3, 14 * 2 + 14 * 3 - 15]);
  assert.deepEqual(project(4, 4), [0, 112], "z defaults to the floor");
});

test("boxes show three faces shaded top 1.0, left 0.8, right 0.63", async () => {
  const { boxFaces, shade, project } = await load();
  const faces = boxFaces({ x: 1, y: 2, z: 0, w: 2, d: 1, h: 1 });
  assert.deepEqual(faces.map((f) => [f.face, f.shade]), [["top", 1], ["left", 0.8], ["right", 0.63]]);
  assert.deepEqual(faces[0].pts, [project(1, 2, 1), project(3, 2, 1), project(3, 3, 1), project(1, 3, 1)]);
  assert.deepEqual(faces[1].pts[0], project(1, 3, 0), "left face is the +y side");
  assert.deepEqual(faces[2].pts[0], project(3, 2, 0), "right face is the +x side");
  assert.equal(shade("#808080", 0.5), "#404040");
  assert.equal(shade("#A78BFA", 1), "#a78bfa");
  assert.equal(shade("#A78BFA", 0.63), "#69589e");
  assert.equal(shade("#F0F0F0", 2), "#ffffff", "clamped");
});

test("painter's sort draws far (small x + y) first, then lower z, then input order", async () => {
  const { paintersSort } = await load();
  const items = [{ id: "front", x: 5, y: 5 }, { id: "back", x: 0, y: 1 }, { id: "high", x: 2, y: 2, z: 1 }, { id: "low", x: 3, y: 1 }, { id: "tie", x: 1, y: 3 }];
  assert.deepEqual(paintersSort(items).map((i) => i.id), ["back", "low", "tie", "high", "front"]);
  assert.equal(items[0].id, "front", "does not sort in place");
});

test("rooms grow 2.4 per desk, wrap past 6 desks, and never have empty desks", async () => {
  const { roomSize, layoutOffice, PITCH } = await load();
  for (let n = 1; n < 6; n++) assert.ok(Math.abs(roomSize(n + 1).w - roomSize(n).w - PITCH) < 1e-9, `${n} → ${n + 1} desks`);
  assert.deepEqual([roomSize(6).rows, roomSize(7).rows, roomSize(7).cols, roomSize(13).rows], [1, 2, 4, 3]);
  for (const n of [1, 4, 7, 12, 30]) {
    const L = layoutOffice(office([n]));
    assert.equal(L.rooms[0].desks.length, n);
    assert.ok(L.rooms[0].rows * L.rooms[0].cols - n < L.rooms[0].cols, "only the last row is short");
    for (const d of L.rooms[0].desks) assert.ok(inside(d, L.rooms[0], 0.3), "desk inside its room");
  }
});

test("layout: rooms, lounge, hall, spotlight and corridor never overlap (1–12 projects, up to 30 agents)", async () => {
  const { layoutOffice, queueSlot } = await load();
  const cases = [];
  for (let p = 1; p <= 12; p++) {
    cases.push(Array(p).fill(1), Array.from({ length: p }, (_, i) => 1 + (i * 7) % 4));
    cases.push(Array.from({ length: p }, (_, i) => Math.max(1, Math.round(30 / p) - (i % 2))).map((n, i, a) => (a.slice(0, i).reduce((s, x) => s + x, 0) + n > 30 ? 1 : n)));
  }
  cases.push([30], [12, 12, 6], [1, 29]);
  for (const counts of cases) {
    const L = layoutOffice(office(counts)), tag = JSON.stringify(counts);
    const zones = [...L.rooms.map((r) => ({ ...r, name: r.project })), { ...L.lounge, name: "lounge" }, { ...L.spot, name: "spotlight" }, { ...L.corridor, name: "corridor" }];
    if (L.hall) zones.push({ ...L.hall, name: "hall" });
    for (let i = 0; i < zones.length; i++) {
      assert.ok(within(zones[i], L.slab), `${tag}: ${zones[i].name} on the slab`);
      if (zones[i].name !== "corridor") assert.ok(L.floor.some((b) => within(zones[i], b)), `${tag}: ${zones[i].name} on one floor band`);
      for (let j = i + 1; j < zones.length; j++) {
        if (zones[i].name + zones[j].name === "spotlightcorridor") continue; // the corridor ends at the spotlight
        assert.ok(!overlap(zones[i], zones[j]), `${tag}: ${zones[i].name} overlaps ${zones[j].name}`);
      }
    }
    const n = counts.reduce((s, x) => s + x, 0);
    assert.ok(L.lounge.spots.length >= n, `${tag}: a lounge spot for everyone`);
    for (const s of L.lounge.spots) assert.ok(inside(s, L.lounge), `${tag}: spot inside the lounge`);
    if (L.hall) assert.ok(L.hall.seats.length >= n && L.hall.seats.length >= 8, `${tag}: a hall seat for everyone, 8 at least`);
    for (let i = 0; i < n; i++) {
      const q = queueSlot(L, i, n);
      assert.ok(q.y > L.slab.y && q.y < L.slab.y + L.slab.d, `${tag}: queue slot ${i} on the slab`);
      for (const r of L.rooms) assert.ok(!inside(q, r), `${tag}: queue slot ${i} not inside ${r.project}`);
    }
    assert.equal(L.rooms.length, counts.length);
  }
});

test("layout is deterministic, ignores state, and gives each project a stable colour (never amber or red)", async () => {
  const { layoutOffice, projectColors } = await load();
  const { PROJECT_COLORS } = await import(pathToFileURL(path.join(__dirname, "..", "public", "ui", "components.js")).href);
  const a = office([4, 3, 1]), b = office([4, 3, 1], ["idle"]);
  const strip = (L) => JSON.stringify({ rooms: L.rooms, lounge: L.lounge, hall: L.hall, spot: L.spot });
  assert.equal(strip(layoutOffice(a)), strip(layoutOffice(b)), "state does not move rooms");
  assert.equal(strip(layoutOffice(a)), strip(layoutOffice([...a].reverse())), "input order does not matter");
  for (let p = 1; p <= 6; p++) {
    const colors = projectColors(office(Array(p).fill(1)));
    assert.equal(new Set(colors.values()).size, p, `${p} projects get ${p} different colours`);
  }
  const before = projectColors(office([2, 2]));
  const after = projectColors([...office([2, 2]), { session: "new", project: "zzz-new", started: iso(1), state: "working" }]);
  for (const [p, i] of before) assert.equal(after.get(p), i, `${p} keeps its colour when a project joins`);
  for (const hex of PROJECT_COLORS) {
    const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b2), d = max - Math.min(r, g, b2);
    const hue = d === 0 ? 0 : max === r ? (60 * ((g - b2) / d) + 360) % 360 : max === g ? 60 * ((b2 - r) / d) + 120 : 60 * ((r - g) / d) + 240;
    assert.ok(d < 0.15 || (hue > 60 && hue < 330), `${hex} is not amber, orange or red`);
  }
});

test("one agent: only its room, no meeting hall; no agents: an empty office", async () => {
  const { layoutOffice } = await load();
  const one = layoutOffice(office([1]));
  assert.equal(one.rooms.length, 1);
  assert.equal(one.hall, null);
  const none = layoutOffice([]);
  assert.equal(none.empty, true);
  assert.deepEqual(none.rooms, []);
  assert.ok(within(none.outline, none.slab));
});

test("state places: desk, Needs You queue, lounge, out the entrance", async () => {
  const { layoutOffice, placeOf, queueOrder, assignLounge } = await load();
  const agents = office([2, 2]), L = layoutOffice(agents);
  const queue = new Map(queueOrder(agents).map((a, i) => [a.session, i]));
  const lounge = assignLounge(agents.filter((a) => a.state === "idle").map((a) => a.session));
  const place = (a) => placeOf(a, L, { queue, lounge });
  const [working, waiting, idle, offline] = agents;
  assert.deepEqual([place(working).kind, place(working).pose], ["desk", "seat"]);
  assert.deepEqual({ x: place(working).x, y: place(working).y }, { x: L.desks.get(working.session).x, y: L.desks.get(working.session).y });
  assert.deepEqual([place(waiting).kind, place(waiting).pose, place(waiting).x, place(waiting).y], ["queue", "wave", L.spot.cx, L.spot.cy]);
  assert.deepEqual([place(idle).kind, place(idle).pose], ["lounge", "cup"]);
  assert.deepEqual({ x: place(idle).x, y: place(idle).y }, L.lounge.spots[0]);
  assert.deepEqual([place(offline).kind, place(offline).x, place(offline).y], ["gone", L.entrance.x, L.entrance.y]);
});

test("the Needs You queue is ordered by longest wait and lines up behind the spotlight", async () => {
  const { layoutOffice, queueOrder, queueSlot } = await load();
  const agents = [
    { session: "b", state: "waiting", waitingSince: iso(4) }, { session: "a", state: "waiting", waitingSince: iso(9) },
    { session: "w", state: "working" }, { session: "c", state: "needs", waitingSince: iso(1) }, { session: "d", state: "waiting" },
  ].map((a) => ({ project: "p", started: iso(60), ...a }));
  assert.deepEqual(queueOrder(agents).map((a) => a.session), ["a", "b", "c", "d"]);
  const L = layoutOffice(agents);
  assert.deepEqual(queueSlot(L, 0, 4), { x: L.spot.cx, y: L.spot.cy });
  const ys = [0, 1, 2, 3].map((i) => queueSlot(L, i, 4).y);
  assert.ok(ys.every((y, i) => i === 0 || y < ys[i - 1]), "each next agent stands further back");
});

test("lounge spots stay put: agents keep their spot and newcomers take the lowest free one", async () => {
  const { assignLounge } = await load();
  const first = assignLounge(["a", "b", "c"]);
  assert.deepEqual([...first], [["a", 0], ["b", 1], ["c", 2]]);
  const second = assignLounge(["c", "d"], first);
  assert.deepEqual([...second], [["c", 2], ["d", 0]]);
});

test("walking paths go through doors and corridors, never through another room", async () => {
  const { layoutOffice, placeOf, queueOrder, walkPath, pointAlong, pathLength } = await load();
  const agents = office([4, 3, 1, 5, 2], ["working"]), L = layoutOffice(agents);
  const needs = { ...agents[5], state: "waiting", waitingSince: iso(3) };
  const queue = new Map(queueOrder([needs]).map((a, i) => [a.session, i]));
  for (const a of agents) {
    const from = placeOf(a, L), to = placeOf({ ...a, state: "waiting", waitingSince: iso(3) }, L, { queue: new Map([[a.session, 0]]) });
    const pts = walkPath(from, to, L), len = pathLength(pts), own = L.rooms.find((r) => r.project === a.project);
    assert.deepEqual([pts[0], pts.at(-1)], [{ x: from.x, y: from.y }, { x: to.x, y: to.y }]);
    for (let d = 0; d <= len; d += 0.1) {
      const p = pointAlong(pts, d);
      for (const r of L.rooms) if (r !== own) assert.ok(!inside(p, r, 0.05), `${a.session} walks through ${r.project}`);
      assert.ok(onFloor(p, L), `${a.session} walks off the floor at ${p.x},${p.y}`);
    }
  }
  assert.ok(queue.size === 1);
  agents.forEach((a, i) => {
    const pts = walkPath(placeOf(a, L), placeOf({ ...a, state: "idle" }, L, { lounge: new Map([[a.session, i]]) }), L);
    const own = L.rooms.find((r) => r.project === a.project);
    for (let d = 0; d <= pathLength(pts); d += 0.1) {
      const p = pointAlong(pts, d);
      assert.ok(onFloor(p, L), `${a.session} to the lounge stays on the floor`);
      for (const r of L.rooms) if (r !== own) assert.ok(!inside(p, r, 0.05), `${a.session} walks to the lounge through ${r.project}`);
      if (L.hall) assert.ok(!inside(p, L.hall, 0.05), `${a.session} walks to the lounge through the meeting hall`);
    }
  });
  const lounge = placeOf({ ...agents[0], state: "idle" }, L, { lounge: new Map([[agents[0].session, 3]]) });
  const moved = placeOf({ ...agents[0], state: "idle" }, L, { lounge: new Map([[agents[0].session, 0]]) });
  assert.equal(walkPath(lounge, moved, L).length, 2, "moving within the lounge is a straight step");
  assert.deepEqual(pointAlong([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], 3), { x: 2, y: 1, dx: 0, dy: 2 });
});

test("name tags, aria labels and the button order", async () => {
  const { tagText, agentAria, domOrder, displayName } = await load();
  const refund = { session: "r", project: "checkout-api", label: "refund flow", name: "checkout-api · refund flow", state: "waiting", waitingSince: iso(9) };
  assert.equal(tagText(refund, NOW), "refund flow · 9m");
  assert.equal(agentAria(refund, NOW), "refund flow, checkout-api, Needs you, waiting 9m. Press Enter for details");
  const basket = { session: "b", project: "supermarket-pos", label: "basket bill", name: "supermarket-pos · basket bill", state: "working" };
  assert.equal(tagText(basket, NOW), "basket bill");
  assert.equal(agentAria(basket, NOW), "basket bill, supermarket-pos, Working. Press Enter for details");
  assert.equal(displayName({ ...basket, name: "Till fixer" }), "Till fixer", "a user-set name stays whole");
  assert.equal(agentAria({ ...basket, state: "offline", project: null, name: "session 1a2b3c" }, NOW), "session 1a2b3c, Other, Offline. Press Enter for details");
  const list = [
    { session: "1", project: "b", label: "z", name: "b · z", state: "idle" }, { session: "2", project: "b", label: "a", name: "b · a", state: "working" },
    { session: "3", project: "a", label: "y", name: "a · y", state: "offline" }, { session: "4", project: "c", label: "q", name: "c · q", state: "waiting" },
    { session: "5", project: "a", label: "m", name: "a · m", state: "working" },
  ];
  assert.deepEqual(domOrder(list).map((a) => a.session), ["4", "5", "2", "1", "3"]);
});

test("filter dims non-matching agents to 16%; offline desks are 55%", async () => {
  const { normFilter, agentOpacity, deskOpacity } = await load();
  const f = normFilter(["working"]);
  assert.equal(agentOpacity("working", f), 1);
  assert.equal(agentOpacity("waiting", f), 0.16);
  assert.equal(agentOpacity("idle", null), 1);
  assert.equal(normFilter([]), null);
  assert.equal(agentOpacity("waiting", normFilter(["needs"])), 1, "store and design state names both work");
  assert.equal(deskOpacity("offline", null), 0.55);
  assert.equal(deskOpacity("offline", normFilter(["offline"])), 0.55);
  assert.equal(deskOpacity("offline", f), 0.16);
  assert.equal(deskOpacity("working", f), 1);
});

test("hover card: plain-English action with a relative target, plan progress or No plan, cost", async () => {
  const { cardHTML, actionOf } = await load();
  const root = "/Users/mk/code/checkout-api";
  const refund = { session: "r", project: "checkout-api", label: "refund flow", name: "checkout-api · refund flow", host: "thinkpad-x1", state: "waiting",
    gitRoot: root, waitingSince: iso(9), cost: 2.05, hasPlan: true, plan: { done: 3, inProgress: 1, pending: 5 },
    question: { qkind: "permission", tool: "Edit", target: `${root}/.env.production`, detail: { path: `${root}/.env.production` } } };
  assert.deepEqual(actionOf(refund), { text: "Wants permission to edit a file", target: ".env.production", icon: "hand" });
  const html = cardHTML(refund, { now: NOW, color: 1 });
  for (const s of ["refund flow", "checkout-api · thinkpad-x1", "Needs you · 9m", "Wants permission to edit a file", ".env.production", "3/9", "$2.05"]) assert.ok(html.includes(s), s);
  assert.ok(!html.includes(root), "no absolute paths");
  const working = { ...refund, state: "working", question: null, hasPlan: false, recent: [{ kind: "tool", tool: "Edit", status: "running", target: `${root}/src/a.ts`, detail: { path: `${root}/src/a.ts` } }] };
  assert.deepEqual(actionOf(working), { text: "Editing a.ts", target: "src/a.ts", icon: "file-edit" });
  assert.ok(cardHTML(working, { now: NOW }).includes("No plan"));
  assert.equal(actionOf({ ...working, state: "offline" }).text, "Went offline · no events for 30 min");
  assert.equal(actionOf({ ...working, state: "idle", recent: [{ kind: "stop" }, { kind: "notice", notificationType: "idle_prompt" }] }).text, "Finished turn");
  assert.ok(!cardHTML({ ...working, name: "<img src=x onerror=alert(1)>", label: null }).includes("<img"), "escaped");
  // A new prompt: working on it, not still on the last turn's tool.
  const prompted = { ...working, tool: null, recent: [...working.recent, { kind: "prompt", t: iso(0) }] };
  assert.deepEqual(actionOf(prompted), { text: "Working on your prompt", target: null, icon: "chat" });
  // No telemetry: "No cost data", not $0.00.
  assert.ok(cardHTML({ ...working, cost: 0, requests: 0 }).includes("No cost data"));
  assert.ok(cardHTML({ ...working, cost: 0, requests: 2 }).includes("$0.00"));
  // Sub-agents: counts plus each listed one with what it does.
  const subs = cardHTML({ ...working, subagents: { running: 1, finished: 1, list: [{ id: "1", description: "Write bill tests", status: "running" }, { id: "2", description: "Explore loyalty rules", status: "finished" }] } });
  assert.ok(subs.includes("Sub-agents: 1 running · 1 finished") && subs.includes("Write bill tests") && subs.includes("Explore loyalty rules"));
});

test("status text: loading, live, stale with the time of the last data, error, replay", async () => {
  const { statusText } = await load();
  const at = new Date(2026, 9, 17, 15, 40);
  assert.equal(statusText("loading"), "Loading…");
  assert.equal(statusText("live"), "Live");
  assert.equal(statusText("stale", { asOf: at }), "As of 15:40");
  assert.equal(statusText("stale"), "Not live");
  assert.equal(statusText("error"), "Can't reach the server");
  assert.equal(statusText("live", { replayAt: new Date(2026, 9, 17, 11, 40) }), "Replaying 11:40");
});

test("queue tags get extra lift only when zoomed out far enough to collide", async () => {
  const { queueTagGap } = await load();
  assert.ok(queueTagGap(1) < 2 && queueTagGap(1.2) === 0 && queueTagGap(2) === 0);
  assert.ok(queueTagGap(0.6) > 5 && queueTagGap(0.45) > queueTagGap(0.6));
});

test("view maths: zoom 0.45–2.6 around the cursor, pan clamping, fit and the minimap", async () => {
  const o = await load();
  assert.equal(o.clampZoom(10), 2.6);
  assert.equal(o.clampZoom(0.1), 0.45);
  const v = o.zoomAt({ x: 100, y: 50, z: 1 }, 2, 300, 200);
  assert.deepEqual(v, { z: 2, x: -100, y: -100 });
  const before = { x: (300 - 100) / 1, y: (200 - 50) / 1 }, after = { x: (300 - v.x) / v.z, y: (200 - v.y) / v.z };
  assert.deepEqual(after, before, "the scene point under the cursor stays put");
  assert.equal(o.zoomAt({ x: 0, y: 0, z: 2.5 }, 2, 0, 0).z, 2.6);
  const scene = { w: 1200, h: 700 }, vp = { w: 800, h: 600 };
  assert.deepEqual(o.clampPan({ x: 5000, y: -5000, z: 1 }, scene, vp), { z: 1, x: 720, y: -620 });
  const fit = o.focusRect({ x: 0, y: 0, ...scene }, vp, { top: 64, right: 24, bottom: 24, left: 24 });
  assert.ok(Math.abs(fit.z - 752 / 1200) < 1e-9);
  assert.ok(fit.x >= 24 && fit.x + scene.w * fit.z <= 776 + 1e-9 && fit.y >= 64 - 1e-9);
  const f = o.mapFit(scene, { w: 200, h: 120 });
  const r = o.viewRect({ x: -300, y: -100, z: 2 }, vp);
  assert.deepEqual(r, { x: 150, y: 50, w: 400, h: 300 });
  const m = o.sceneToMap(r.x, r.y, f);
  assert.deepEqual(o.mapToScene(m.x, m.y, f), { x: 150, y: 50 });
  const c = o.centerOn({ x: 600, y: 350 }, 1, vp);
  assert.deepEqual(c, { z: 1, x: -200, y: -50 });
  assert.equal(o.tagScale(0.5), 0.9 / 0.5);
  assert.equal(o.tagScale(1), 1);
  assert.equal(o.tagScale(2), 1.1 / 2);
});

// ---------- the controller (createOffice) on a tiny fake DOM ----------
/**
 * Just enough DOM for createOffice() and bind(): parses the markup it generates, simple selectors (tag, #id, .class,
 * [attr], [attr="v"], :not(), comma lists), events with capture and bubbling, and counts every write.
 */
function fakeDom({ width = 1200, height = 800 } = {}) {
  const SVG = "http://www.w3.org/2000/svg", dom = { writes: 0 };
  let doc = null;
  const ENT = { amp: "&", lt: "<", gt: ">", quot: "\u0022", "#39": "\u0027" };
  const decode = (t) => t.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENT[e]);
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  class Node {
    constructor() { this.parentNode = null; }
    get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] || null : null; }
    get previousSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) - 1] || null : null; }
    remove() { if (!this.parentNode) return; const s = this.parentNode.childNodes; s.splice(s.indexOf(this), 1); this.parentNode = null; dom.writes++; }
  }
  class Text extends Node { constructor(t) { super(); this.data = t; } get textContent() { return this.data; } }
  const style = () => {
    const p = {};
    return new Proxy({}, {
      get(_, k) {
        if (k === "setProperty") return (n, v) => { p[n] = String(v); dom.writes++; };
        if (k === "cssText") return Object.entries(p).map(([a, b]) => `${a}:${b}`).join(";");
        return p[kebab(String(k))] ?? "";
      },
      set(_, k, v) {
        dom.writes++;
        if (k === "cssText") {
          for (const x of Object.keys(p)) delete p[x];
          for (const part of String(v).split(";")) { const i = part.indexOf(":"); if (i > 0) p[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
        } else if (v === "" || v == null) delete p[kebab(String(k))];
        else p[kebab(String(k))] = String(v);
        return true;
      },
    });
  };
  class El extends Node {
    constructor(tag, ns) {
      super();
      Object.assign(this, { localName: tag.toLowerCase(), ns, attrs: new Map(), childNodes: [], listeners: {}, style: style(), ownerDocument: doc });
    }
    get tagName() { return this.localName.toUpperCase(); }
    get children() { return this.childNodes.filter((n) => n instanceof El); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes.at(-1) || null; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children.at(-1) || null; }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return this.attrs.has(k); }
    setAttribute(k, v) { this.attrs.set(k, String(v)); dom.writes++; }
    removeAttribute(k) { if (this.attrs.delete(k)) dom.writes++; }
    get id() { return this.getAttribute("id") || ""; }
    get className() { return this.getAttribute("class") || ""; }
    set className(v) { this.setAttribute("class", v); }
    get classList() {
      const el = this, list = () => el.className.split(/\s+/).filter(Boolean);
      const set = (l) => el.setAttribute("class", l.join(" "));
      return {
        contains: (c) => list().includes(c),
        add: (...cs) => { const l = list(), add = cs.filter((c) => !l.includes(c)); if (add.length) set([...l, ...add]); },
        remove: (...cs) => { const l = list(); if (cs.some((c) => l.includes(c))) set(l.filter((x) => !cs.includes(x))); },
        toggle(c, force) { const on = force === undefined ? !list().includes(c) : !!force; if (on) this.add(c); else this.remove(c); return on; },
      };
    }
    get dataset() {
      const el = this;
      return new Proxy({}, { get: (_, k) => el.getAttribute("data-" + kebab(String(k))) ?? undefined, set: (_, k, v) => (el.setAttribute("data-" + kebab(String(k)), v), true) });
    }
    get hidden() { return this.hasAttribute("hidden"); }
    set hidden(v) { if (v) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
    append(...ns) { for (const n of ns) this.insertBefore(n, null); }
    appendChild(n) { return this.insertBefore(n, null); }
    insertBefore(n, ref) {
      if (n.parentNode) n.remove();
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
      n.parentNode = this;
      dom.writes++;
      return n;
    }
    contains(n) { for (let e = n; e; e = e.parentNode) if (e === this) return true; return false; }
    get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
    set textContent(v) { for (const c of [...this.childNodes]) c.remove(); if (v) this.append(new Text(String(v))); dom.writes++; }
    set innerHTML(html) { for (const c of [...this.childNodes]) c.remove(); parse(String(html), this); dom.writes++; }
    get innerHTML() { return this.childNodes.map((n) => (n instanceof Text ? n.data : `<${n.localName}>${n.innerHTML}</${n.localName}>`)).join(""); }
    insertAdjacentHTML(_, html) { parse(String(html), this); }
    matches(sel) { return sel.split(",").some((s) => match(this, s.trim())); }
    closest(sel) { for (let e = this; e instanceof El; e = e.parentNode) if (e !== doc && e.matches(sel)) return e; return null; }
    querySelectorAll(sel) { const out = [], walk = (e) => { for (const c of e.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(t, fn, o) { (this.listeners[t] ||= []).push({ fn, cap: o === true || !!o?.capture }); }
    removeEventListener(t, fn, o) { const cap = o === true || !!o?.capture; this.listeners[t] = (this.listeners[t] || []).filter((l) => l.fn !== fn || l.cap !== cap); }
    dispatchEvent(e) {
      const path = [];
      for (let n = this; n; n = n.parentNode) path.push(n);
      let stop = false;
      Object.assign(e, { target: this, stopPropagation: () => (stop = true), preventDefault: () => (e.defaultPrevented = true) });
      for (const n of [...path].reverse()) for (const l of n.listeners[e.type] || []) if (l.cap && !stop) l.fn(e);
      for (const n of path) { for (const l of n.listeners[e.type] || []) if (!l.cap && !stop) l.fn(e); if (stop) break; }
    }
    click() { this.dispatchEvent({ type: "click", button: 0 }); }
    focus() { doc.activeElement = this; this.dispatchEvent({ type: "focusin" }); }
    get clientWidth() { return this.classList.contains("o3") || this === doc.documentElement ? width : 0; }
    get clientHeight() { return this.classList.contains("o3") || this === doc.documentElement ? height : 0; }
    get offsetWidth() { return 280; }
    get offsetHeight() { return 160; }
    get offsetParent() { return null; }
    getBoundingClientRect() {
      return this.classList.contains("o3") ? { left: 0, top: 0, right: width, bottom: height, width, height } : { left: 500, top: 400, right: 540, bottom: 460, width: 40, height: 60 };
    }
  }
  function match(el, s) {
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:not\(([^)]*)\)/g;
    let m, pos = 0;
    while ((m = re.exec(s))) {
      if (m.index !== pos) throw new Error(`fake DOM: unsupported selector ${s}`);
      pos = re.lastIndex;
      if (m[1] && el.localName !== m[1].toLowerCase()) return false;
      if (m[2] && el.id !== m[2]) return false;
      if (m[3] && !el.classList.contains(m[3])) return false;
      if (m[4] && (!el.hasAttribute(m[4]) || (m[5] !== undefined && el.getAttribute(m[4]) !== m[5]))) return false;
      if (m[6] && match(el, m[6])) return false;
    }
    if (pos !== s.length) throw new Error(`fake DOM: unsupported selector ${s}`);
    return true;
  }
  function parse(html, parent) {
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
    let cur = parent, m;
    while ((m = re.exec(html))) {
      if (m[1]) { let e = cur; while (e !== parent && e.localName !== m[1].toLowerCase()) e = e.parentNode; if (e !== parent) cur = e.parentNode; }
      else if (m[2]) {
        const el = new El(m[2], m[2] === "svg" || cur.ns === SVG ? SVG : null);
        for (const a of m[3].matchAll(/([^\s=/>]+)(?:\s*=\s*"([^"]*)")?/g)) el.attrs.set(a[1], a[2] === undefined ? "" : decode(a[2]));
        cur.append(el);
        if (!m[4]) cur = el;
      } else if (m[5]) cur.append(new Text(decode(m[5])));
    }
  }
  doc = new El("#document", null);
  Object.assign(doc, {
    hidden: false, activeElement: null,
    createElement: (t) => new El(t, null), createElementNS: (ns, t) => new El(t, ns),
    getElementById: (id) => doc.querySelector(`#${id}`),
  });
  doc.ownerDocument = null;
  const html = new El("html", null), body = new El("body", null);
  doc.append(html);
  html.append(body);
  doc.documentElement = html;
  doc.body = body;
  dom.document = doc;
  dom.fire = (el, type, props = {}) => el.dispatchEvent({ type, ...props });
  return dom;
}

/** Installs a fake DOM as the globals createOffice() uses; restore() puts the old ones back. */
function withDom(opts) {
  const dom = fakeDom(opts), keys = ["document", "requestAnimationFrame", "cancelAnimationFrame"], saved = keys.map((k) => globalThis[k]);
  globalThis.document = dom.document;
  globalThis.requestAnimationFrame = () => 1; // frames never run here: walks start but stay put
  globalThis.cancelAnimationFrame = () => {};
  dom.restore = () => keys.forEach((k, i) => { if (saved[i] === undefined) delete globalThis[k]; else globalThis[k] = saved[i]; });
  return dom;
}

/** Demo-like office: basket bill works with two interns (one running), two wait on you, one idles, one works with no tool yet, one is offline. */
function demoAgents() {
  const a = (session, project, label, state, extra = {}) => ({ session, project, label, name: `${project} · ${label}`, state, started: iso(300 - session.length), host: "thinkpad-x1",
    gitRoot: `/code/${project}`, tool: state === "working" ? "Edit" : null, cost: 1.5, requests: 10, hasPlan: true, plan: { done: 2, inProgress: 1, pending: 3 },
    subagents: { running: 0, finished: 0, list: [] }, recent: [], waitingSince: null, ...extra });
  return [
    a("basket", "supermarket-pos", "basket bill", "working", { subagents: { running: 1, finished: 1, list: [
      { id: "s1", description: "Write bill tests", status: "running" }, { id: "s2", description: "Explore loyalty rules", status: "finished" }] } }),
    a("receipt", "supermarket-pos", "receipt printer", "waiting", { waitingSince: iso(4), question: { qkind: "permission", tool: "Bash", target: "sudo apt install cups-filters" } }),
    a("login", "supermarket-pos", "login fix", "idle"),
    a("refund", "checkout-api", "refund flow", "waiting", { waitingSince: iso(9), question: { qkind: "permission", tool: "Edit", target: "/code/checkout-api/.env.production" } }),
    a("rate", "checkout-api", "rate limiter", "working", { tool: null }),
    a("webhook", "checkout-api", "webhook retries", "offline"),
  ];
}

test("office DOM: loading, live, links and intern tags that survive a layout change and a theme change, destroy", async () => {
  const dom = withDom();
  try {
    const { createOffice } = await load();
    const container = dom.document.createElement("div");
    dom.document.body.append(container);
    const selected = [];
    const office = createOffice(container, { onSelect: (id) => selected.push(id) });
    const root = container.firstElementChild, hud = () => root.querySelector(".o3-hud-mode").textContent;
    assert.equal(hud(), "Loading…", "not Live before the first snapshot");
    assert.ok(root.querySelector(".ao-loading") && root.getAttribute("aria-busy") === "true", "the M1 loading look");

    const agents = demoAgents();
    office.update(agents, { now: NOW });
    assert.equal(hud(), "Live");
    assert.equal(root.querySelector(".o3-empty").hidden, true);
    const links = () => root.querySelectorAll(".o3-link").length, itags = () => root.querySelectorAll(".o3-itag").map((t) => t.textContent);
    assert.equal(links(), 1, "one running intern, one dashed link");
    assert.deepEqual(itags(), ["Write bill tests", "Explore loyalty rules"]);
    assert.equal(root.querySelectorAll(".o3-itag--done").length, 1, "the finished one has the done look");

    const buttons = root.querySelectorAll(".o3-agent");
    assert.deepEqual(buttons.map((b) => b.dataset.session), ["refund", "receipt", "rate", "basket", "login", "webhook"], "urgency, then project, then name");
    assert.ok(buttons.every((b) => b.tagName === "BUTTON" && /Press Enter for details$/.test(b.getAttribute("aria-label"))));
    buttons[0].click();
    assert.deepEqual(selected, ["refund"]);
    const badges = root.querySelectorAll(".o3-badge").length;
    assert.equal(badges, 3, "badges on basket bill (tool) and the two waiting desks, none on rate limiter (no tool yet)");

    // Same snapshot again: nothing is written.
    dom.writes = 0;
    office.update(agents, { now: NOW });
    assert.equal(dom.writes, 0, "an update with the same snapshot writes nothing");

    // A new project starts (new layout): the links and tags come back.
    office.update([...agents, { ...agents[4], session: "docs", project: "docs-site", label: "tokens page", name: "docs-site · tokens page", started: iso(1) }], { now: NOW });
    assert.equal(links(), 1, "links survive a layout change");
    assert.equal(itags().length, 2);
    // Theme change: everything is rebuilt in the light palette, links included.
    dom.document.documentElement.className = "ao-light";
    dom.fire(dom.document, "ao-theme", { detail: { theme: "light" } });
    assert.ok(root.classList.contains("ao-light") && !root.classList.contains("ao-dark"));
    assert.equal(links(), 1, "links survive a theme change");

    office.destroy();
    assert.equal(container.childNodes.length, 0);
    dom.fire(dom.document, "ao-theme", { detail: { theme: "dark" } });
    assert.ok(!(dom.document.listeners["ao-theme"] || []).length && !(dom.document.listeners.visibilitychange || []).length, "document listeners removed");
  } finally { dom.restore(); }
});

test("office DOM: stale, error with Retry, replay time, filter dimming, and crowds of movers snap", async () => {
  const dom = withDom();
  try {
    const { createOffice } = await load();
    const container = dom.document.createElement("div");
    dom.document.body.append(container);
    let retried = 0;
    const office = createOffice(container, { onRetry: () => retried++ });
    const root = container.firstElementChild, hud = () => root.querySelector(".o3-hud-mode").textContent;

    office.setStatus("error");
    assert.equal(hud(), "Can't reach the server");
    const retry = root.querySelector("[data-retry]");
    assert.ok(root.querySelector(".ao-state--error") && retry, "the M1 error look with one action");
    retry.click();
    assert.equal(retried, 1);

    const agents = demoAgents();
    office.update(agents, { now: NOW });
    assert.equal(hud(), "Live", "data arriving ends the error");
    office.setStatus("stale", new Date(2026, 9, 17, 15, 40));
    assert.equal(hud(), "As of 15:40");
    assert.ok(root.classList.contains("is-stale") && !root.classList.contains("is-live"), "dimmed and still");
    office.update(agents, { now: NOW });
    assert.equal(hud(), "As of 15:40", "stale until the caller says live again");
    office.setStatus("live");
    assert.equal(hud(), "Live");

    // Replay: wait times are counted at the replayed moment, not now.
    office.update(agents, { replayAt: NOW - 2 * M });
    assert.match(hud(), /^Replaying \d\d:\d\d$/);
    const refund = root.querySelectorAll(".o3-agent").find((b) => b.dataset.session === "refund");
    assert.match(refund.getAttribute("aria-label"), /waiting 7m/);
    office.update(agents, { now: NOW });

    // Filter: the others dim to 16%.
    office.setFilter(["working"]);
    const dims = root.querySelectorAll(".o3-a").map((li) => [li.querySelector(".o3-agent").dataset.session, li.style.opacity || "1"]);
    assert.deepEqual(Object.fromEntries(dims), { refund: "0.16", receipt: "0.16", basket: "1", rate: "1", login: "0.16", webhook: "0.16" });
    office.setFilter(null);

    // Two newcomers walk in; a crowd of seven (a reconnect) snaps into place.
    const more = (n, tag) => Array.from({ length: n }, (_, i) => ({ ...agents[2], session: `${tag}${i}`, label: `${tag} ${i}`, name: `supermarket-pos · ${tag} ${i}`, started: iso(2) }));
    const walking = () => root.querySelectorAll(".o3-a").filter((li) => li.classList.contains("is-walking")).length;
    office.update([...agents, ...more(2, "pair")], { now: NOW });
    assert.equal(walking(), 2, "newcomers walk in from the entrance");
    office.update([...agents, ...more(2, "pair"), ...more(7, "crowd")], { now: NOW });
    assert.equal(walking(), 0, "more than six movers at once snap");
    office.destroy();
  } finally { dom.restore(); }
});
