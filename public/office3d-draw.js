// The 3D office, drawing part: SVG strings for the floor, walls, furniture and people. Pure: no DOM.
// Every solid is a box with three shaded faces (top 1.0, left 0.8, right 0.63). Glows on the floor use a blur
// filter (drawn once); glows that sit near animated people use gradients, which repaint cheaply.
import { project, boxFaces, shade } from "./office3d-model.js";
import { ICONS } from "./ui/icons.js";

const f1 = (n) => Math.round(n * 10) / 10;
const pt = ([x, y]) => `${f1(x)} ${f1(y)}`;
const P = project;

/** Scene colours per theme. Project colours come from the design tokens; teal and amber keep their meaning. */
export const PALETTE = {
  dark: {
    slab: "#17233B", grid: "rgba(140,170,210,.06)", edge: "rgba(140,170,210,.32)", shadow: 0.55, floor: 0.13, glass: 0.13,
    desk: "#3C4D72", chair: "#2A3753", monitor: "#111A2D", key: "#5D7096", pants: "#2A3552",
    lounge: "rgba(169,182,203,.06)", rug: "#203660", rugIn: "#284171", sofa: "#4C5F8E", wood: "#56668C", counter: "#2C3A58", machine: "#141D31", cup: "#E8EEF8",
    leaf: "#3E9E63", leaf2: "#2D7C4D", pot: "#7E5B45", lamp: "#46536F", badge: "#0F192C", screen: "#0B1424",
    teal: "#2DD4BF", amber: "#FBBF24", off: "#56637C", mat: "#22304D",
  },
  light: {
    slab: "#F3F6FA", grid: "rgba(20,40,80,.07)", edge: "rgba(255,255,255,.9)", shadow: 0.2, floor: 0.17, glass: 0.13,
    desk: "#D3DCE8", chair: "#9AAAC2", monitor: "#2B3548", key: "#B8C3D4", pants: "#4A5876",
    lounge: "rgba(82,99,122,.06)", rug: "#D6DFEC", rugIn: "#E4EAF3", sofa: "#93A3BE", wood: "#C3CEDC", counter: "#C8D2E0", machine: "#3B4659", cup: "#FFFFFF",
    leaf: "#47AE6E", leaf2: "#378F5A", pot: "#B4865F", lamp: "#8291A9", badge: "#FFFFFF", screen: "#1E2A3E",
    teal: "#14B8A6", amber: "#F59E0B", off: "#B3BFD0", mat: "#DFE6F0",
  },
};

const SKIN = ["#F3CDA8", "#E2B48C", "#C58C62", "#9A6544", "#6B4430"];
const HAIR = ["#2A1E17", "#4B3326", "#8A5A35", "#1C1C22", "#8C8F99", "#C9A15B"];
const EYE = "#0B1220";

/** Skin, hair colour and hair style picked from the session id, so a person always looks the same. */
export function looks(session) {
  let h = 2166136261;
  for (const ch of String(session ?? "")) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return { skin: SKIN[h % SKIN.length], hair: HAIR[(h >>> 5) % HAIR.length], style: (h >>> 11) % 4 };
}

export const poly = (pts) => "M" + pts.map(pt).join("L") + "Z";
const line = (a, b, attrs) => `<path d="M${pt(a)}L${pt(b)}" ${attrs}/>`;
const rect = (x, y, w, d, z = 0) => [P(x, y, z), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z)];

/** A solid box: three faces shaded from one colour. */
export function box(b, color) {
  return boxFaces(b).map((f) => `<path d="${poly(f.pts)}" fill="${shade(color, f.shade)}"/>`).join("");
}

// ---------- defs ----------
export function defs(id, pal) {
  const radial = (name, color, stops) => `<radialGradient id="${id}-${name}">${stops.map(([o, a]) => `<stop offset="${o}" stop-color="${color}" stop-opacity="${a}"/>`).join("")}</radialGradient>`;
  return `<defs>
    <filter id="${id}-blur-lg" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
    ${radial("shadow", "#000", [[0, 0.42], [1, 0]])}
    ${radial("teal", pal.teal, [[0, 0.55], [0.5, 0.18], [1, 0]])}
    ${radial("amber", pal.amber, [[0, 0.6], [0.5, 0.22], [1, 0]])}
    ${radial("disc", pal.amber, [[0, 0.75], [0.55, 0.35], [1, 0]])}
    <linearGradient id="${id}-cone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.amber}" stop-opacity=".05"/><stop offset="1" stop-color="${pal.amber}" stop-opacity=".28"/></linearGradient>
  </defs>`;
}

// ---------- the floor layer (z = 0 only, so it never hides anything) ----------
/** Slab, its blurred shadow, the tile grid, room and hall floors, rug, entrance mat, and glow lines under the glass. */
export function drawFloor(L, { id, pal, color }) {
  const s = L.slab, bands = L.floor, out = [defs(id, pal)];
  const shadow = bands.map((b) => poly(rect(b.x, b.y, b.w, b.d).map(([x, y]) => [x, y + 44]))).join("");
  out.push(`<path d="${shadow}" fill="#000" opacity="${pal.shadow}" filter="url(#${id}-blur-lg)"/>`);
  for (const b of bands) out.push(box({ x: b.x, y: b.y, z: -0.5, w: b.w, d: b.d, h: 0.5 }, pal.slab));
  let g = "";
  for (const b of bands) {
    for (let x = s.x + 1.2; x < b.x + b.w; x += 2.4) if (x > b.x) g += `M${pt(P(x, b.y))}L${pt(P(x, b.y + b.d))}`;
    for (let y = s.y + 1.2; y < b.y + b.d; y += 2.4) if (y > b.y) g += `M${pt(P(b.x, y))}L${pt(P(b.x + b.w, y))}`;
  }
  out.push(`<path d="${g}" stroke="${pal.grid}" stroke-width="1" fill="none"/>`);
  out.push(`<path d="M${pt(P(s.x, s.y + s.d))}L${pt(P(s.x + s.w, s.y + s.d))}L${pt(P(s.x + s.w, s.y))}" stroke="${pal.edge}" stroke-width="1.2" fill="none"/>`);
  if (L.empty) {
    const o = L.outline;
    out.push(`<path d="${poly(rect(o.x, o.y, o.w, o.d))}" fill="none" stroke="${pal.off}" stroke-width="1.5" stroke-dasharray="6 6"/>`);
    return out.join("");
  }
  const glowEdge = (r, c, a) => `<path d="${poly(rect(r.x, r.y, r.w, r.d))}" fill="none" stroke="${c}" stroke-width="5" opacity="${a}" filter="url(#${id}-blur)"/>`;
  for (const r of L.rooms) {
    const c = color(r.color);
    out.push(`<path d="${poly(rect(r.x, r.y, r.w, r.d))}" fill="${c}" fill-opacity="${pal.floor}"/>`, glowEdge(r, c, 0.55));
  }
  const lg = L.lounge;
  out.push(`<path d="${poly(rect(lg.x, lg.y, lg.w, lg.d))}" fill="${pal.lounge}"/>`,
    `<path d="${poly(rect(lg.x + 1, lg.y + 1.6, lg.w - 2, 2.9))}" fill="${pal.rug}"/>`, `<path d="${poly(rect(lg.x + 1.25, lg.y + 1.85, lg.w - 2.5, 2.4))}" fill="${pal.rugIn}"/>`);
  if (L.hall) out.push(`<path d="${poly(rect(L.hall.x, L.hall.y, L.hall.w, L.hall.d))}" fill="${pal.teal}" fill-opacity=".07"/>`, glowEdge(L.hall, pal.teal, 0.45));
  const e = L.entrance;
  out.push(`<path d="${poly(rect(e.x - 0.9, s.y + s.d - 0.75, 1.8, 0.75))}" fill="${pal.mat}"/>`);
  return out.join("");
}

// ---------- glass walls (split per mullion, so each panel sorts with the people near it) ----------
const H_BACK = 2, H_FRONT = 0.9;

function glass(a, b, h, c, pal, { post = true, end = false } = {}) {
  const q = [P(a[0], a[1]), P(b[0], b[1]), P(b[0], b[1], h), P(a[0], a[1], h)];
  return `<path d="${poly(q)}" fill="${c}" fill-opacity="${pal.glass}"/>` +
    line(q[0], q[1], `stroke="${c}" stroke-opacity=".5" stroke-width="1"`) +
    (post ? line(q[0], q[3], `stroke="${c}" stroke-opacity=".6" stroke-width="1.2"`) : "") +
    (end ? line(q[1], q[2], `stroke="${c}" stroke-opacity=".6" stroke-width="1.2"`) : "") +
    line(q[3], q[2], `stroke="${c}" stroke-opacity=".25" stroke-width="5"`) +
    line(q[3], q[2], `stroke="${c}" stroke-width="1.6"`);
}

/** Splits [from, to] at every 2.4 from `from`, leaving out the gap. */
function spans(from, to, gap) {
  const out = [];
  for (let a = from; a < to - 1e-6; a += 2.4) {
    const b = Math.min(to, a + 2.4);
    if (gap && b > gap[0] && a < gap[1]) {
      if (gap[0] > a + 0.05) out.push([a, gap[0], false]);
      if (gap[1] < b - 0.05) out.push([gap[1], b, true]);
    } else out.push([a, b, false]);
  }
  return out;
}

/** Glass walls of a room or the hall as sortable items: tall at the back, low at the front, a door gap in front. */
export function wallItems(r, c, pal, { door = null } = {}) {
  const items = [], x1 = r.x + r.w, y1 = r.y + r.d;
  const add = (key, svg) => items.push({ x: key[0], y: key[1], svg });
  spans(r.x, x1).forEach(([a, b], i, all) => add([(a + b) / 2, r.y], glass([a, r.y], [b, r.y], H_BACK, c, pal, { end: i === all.length - 1 })));
  spans(r.y, y1).forEach(([a, b], i, all) => add([r.x, (a + b) / 2], glass([r.x, a], [r.x, b], H_BACK, c, pal, { end: i === all.length - 1 })));
  const gap = door == null ? null : [door - 0.6, door + 0.6];
  for (const [a, b, afterGap] of spans(r.x, x1, gap)) add([(a + b) / 2, y1], glass([a, y1], [b, y1], H_FRONT, c, pal, { post: a > r.x || afterGap }));
  spans(r.y, y1).forEach(([a, b], i, all) => add([x1, (a + b) / 2], glass([x1, a], [x1, b], H_FRONT, c, pal, { end: i === all.length - 1 })));
  if (gap) for (const gx of gap) add([gx, y1], box({ x: gx - 0.05, y: y1 - 0.05, z: 0, w: 0.1, d: 0.1, h: H_FRONT }, c));
  return items;
}

// ---------- people ----------
/** Octagon head with a lit facet, a hair cap and two eye pixels (looking down-left, towards the viewer). */
function head(cx, cy, r, { skin, hair, style }, { eyes = true, mono = null } = {}) {
  const v = (i, k = r, ox = 0, oy = 0) => [cx + ox + k * Math.cos(Math.PI / 8 + (i * Math.PI) / 4), cy + oy + k * Math.sin(Math.PI / 8 + (i * Math.PI) / 4)];
  const oct = (k, ox, oy) => poly([0, 1, 2, 3, 4, 5, 6, 7].map((i) => v(i, k, ox, oy)));
  const sk = mono || skin, hr = mono ? shade(mono, 0.72) : hair;
  let s = `<path d="${oct(r)}" fill="${shade(sk, 0.8)}"/><path d="${oct(r * 0.86, -0.7, -0.7)}" fill="${sk}"/>`;
  s += `<path d="${poly([v(4, r * 0.86, -0.7, -0.7), v(5, r * 0.86, -0.7, -0.7), [cx - r * 0.2, cy - r * 0.15]])}" fill="${shade(sk, 1.14)}"/>`;
  const L = [cx - r * 1.04, cy - r * 0.05], R = [cx + r * 1.04, cy - r * 0.05];
  const top = [4, 5, 6, 7].map((i) => v(i, r * 1.07));
  const fringe = [[cx + r * 0.55, cy - r * 0.32], [cx - r * 0.25, cy - r * 0.42]];
  const caps = [
    [L, ...top, R, ...fringe],
    [L, ...top, R, [cx + r * 1.0, cy + r * 0.5], [cx + r * 0.62, cy + r * 0.62], [cx + r * 0.5, cy - r * 0.3], fringe[1]],
    [L, ...top, R, ...fringe],
    [[cx - r * 1.0, cy + r * 0.35], L, ...top, R, [cx + r * 1.0, cy + r * 0.8], [cx + r * 0.68, cy + r * 0.75], [cx + r * 0.55, cy - r * 0.32], fringe[1], [cx - r * 0.72, cy - r * 0.1], [cx - r * 0.8, cy + r * 0.35]],
  ];
  s += `<path d="${poly(caps[style % 4])}" fill="${hr}"/>`;
  if (style % 4 === 2) s += `<path d="${oct(r * 0.36, r * 0.32, -r * 1.08)}" fill="${hr}"/>`;
  if (eyes) {
    const e = Math.max(1.6, r * 0.24);
    s += `<rect x="${f1(cx - r * 0.58)}" y="${f1(cy + r * 0.02)}" width="${f1(e)}" height="${f1(e)}" fill="${EYE}"/><rect x="${f1(cx - r * 0.06)}" y="${f1(cy + r * 0.28)}" width="${f1(e)}" height="${f1(e)}" fill="${EYE}"/>`;
  }
  return s;
}

/**
 * A low-poly person with the feet at (0, 0). pose: seat (typing), stand, walk, cup (holding a coffee), wave
 * (hand raised). shirt = project colour. mono = hologram colour (one translucent colour, no face).
 */
export function figure({ look, shirt, pal, pose = "stand", s = 1, mono = null, shadowId = null }) {
  const B = (x, y, z, w, d, h, c) => box({ x: x * s, y: y * s, z: z * s, w: w * s, d: d * s, h: h * s }, mono || c);
  const g = (cls, body) => `<g class="${cls}">${body}</g>`;
  const skin = look.skin, pants = mono ? shade(mono, 0.75) : pal.pants, sleeve = shirt;
  let out = shadowId ? `<ellipse cx="0" cy="0" rx="${f1(14 * s)}" ry="${f1(6.5 * s)}" fill="url(#${shadowId})"/>` : "";
  if (pose === "seat") {
    out += B(-0.2, -0.05, 0.36, 0.4, 0.46, 0.1, pants) + B(-0.2, 0.33, 0, 0.4, 0.12, 0.36, pants);
    out += B(-0.35, -0.06, 0.58, 0.11, 0.12, 0.36, sleeve);
    out += B(-0.24, -0.13, 0.42, 0.48, 0.26, 0.56, shirt);
    out += g("o3-hand-l", B(-0.34, 0.02, 0.62, 0.1, 0.4, 0.09, sleeve) + B(-0.34, 0.4, 0.62, 0.1, 0.1, 0.09, skin));
    out += B(0.24, -0.06, 0.58, 0.11, 0.12, 0.36, sleeve);
    out += g("o3-hand-r", B(0.24, 0.02, 0.62, 0.1, 0.4, 0.09, sleeve) + B(0.24, 0.4, 0.62, 0.1, 0.1, 0.09, skin));
    const [hx, hy] = P(0, 0, 1.27 * s);
    return out + head(hx, hy, 8.6 * s, look, { eyes: !mono, mono });
  }
  out += B(-0.36, -0.06, 0.66, 0.12, 0.12, 0.46, sleeve) + B(-0.36, -0.06, 0.56, 0.12, 0.12, 0.1, skin);
  out += g("o3-leg-l", B(-0.19, -0.07, 0, 0.15, 0.14, 0.6, pants)) + g("o3-leg-r", B(0.04, -0.07, 0, 0.15, 0.14, 0.6, pants));
  out += B(-0.24, -0.13, 0.58, 0.48, 0.26, 0.56, shirt);
  if (pose === "cup") {
    out += B(0.24, -0.06, 0.86, 0.12, 0.12, 0.26, sleeve) + B(0.22, 0, 0.8, 0.12, 0.3, 0.1, sleeve);
    out += B(0.2, 0.26, 0.72, 0.17, 0.17, 0.2, mono || pal.cup) + B(0.23, 0.29, 0.92, 0.11, 0.11, 0.005, "#6B4A33");
  } else if (pose !== "wave") {
    out += B(0.24, -0.06, 0.66, 0.12, 0.12, 0.46, sleeve) + B(0.24, -0.06, 0.56, 0.12, 0.12, 0.1, skin);
  }
  const [hx, hy] = P(0, 0, 1.43 * s);
  out += head(hx, hy, 8.8 * s, look, { eyes: !mono, mono });
  if (pose === "wave") out += g("o3-wave", B(0.25, -0.06, 1.04, 0.12, 0.12, 0.46, sleeve) + B(0.24, -0.07, 1.5, 0.14, 0.14, 0.15, skin));
  return out;
}

// ---------- desks ----------
/** The chair: tucked in, or pushed out while its agent is away. */
export function chairSVG(d, away, pal) {
  const x = d.x + (away ? 0.5 : 0), y = d.y - (away ? 0.2 : 0);
  return box({ x: x - 0.05, y: y - 0.05, z: 0, w: 0.1, d: 0.1, h: 0.36 }, pal.chair) +
    box({ x: x - 0.29, y: y - 0.38, z: 0.42, w: 0.58, d: 0.09, h: 0.62 }, pal.chair) +
    box({ x: x - 0.29, y: y - 0.29, z: 0.36, w: 0.58, d: 0.58, h: 0.08 }, pal.chair);
}

/** Small floating tile with the current tool's icon. */
function badge(cx, cy, name, c, pal) {
  const body = ICONS[name];
  if (!body) return "";
  return `<g class="o3-badge"><rect x="${f1(cx - 9)}" y="${f1(cy - 9)}" width="18" height="18" rx="5" fill="${pal.badge}" stroke="${c}" stroke-width="1.3"/>` +
    `<g transform="translate(${f1(cx - 6.5)} ${f1(cy - 6.5)}) scale(.54)" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${body}</g></g>`;
}

/**
 * Desk, keyboard and monitor (we see its back; its top edge glows teal while working, amber while it waits on you),
 * the tool badge (none while no tool runs), and the sub-agent interns' side table. vis.list = the snapshot's
 * sub-agents (running first); without it the counts decide. Returns the SVG, each running intern's head (for the
 * links) and where the interns' tags stack, with each description and status.
 */
export function deskBody(d, vis, { pal, id, look: lookOf, shirt }) {
  const { x, y } = d, glow = vis.glow === "working" ? pal.teal : vis.glow === "needs" ? pal.amber : null;
  let s = box({ x: x - 0.86, y: y + 0.46, z: 0, w: 0.08, d: 0.74, h: 0.68 }, pal.desk) +
    box({ x: x + 0.78, y: y + 0.46, z: 0, w: 0.08, d: 0.74, h: 0.68 }, pal.desk) +
    box({ x: x - 0.8, y: y + 1.12, z: 0.22, w: 1.6, d: 0.06, h: 0.46 }, pal.desk) +
    box({ x: x - 0.9, y: y + 0.42, z: 0.68, w: 1.8, d: 0.82, h: 0.07 }, pal.desk) +
    box({ x: x - 0.32, y: y + 0.52, z: 0.75, w: 0.64, d: 0.18, h: 0.02 }, pal.key) +
    box({ x: x - 0.06, y: y + 0.98, z: 0.75, w: 0.12, d: 0.08, h: 0.14 }, pal.monitor);
  if (glow) {
    const [gx, gy] = P(x, y + 0.7, 1.12);
    s += `<ellipse cx="${f1(gx)}" cy="${f1(gy)}" rx="30" ry="15" fill="url(#${id}-${vis.glow === "needs" ? "amber" : "teal"})"/>`;
  }
  s += box({ x: x - 0.46, y: y + 0.95, z: 0.88, w: 0.92, d: 0.08, h: 0.5 }, pal.monitor);
  if (glow) {
    const a = P(x - 0.46, y + 0.99, 1.38), b = P(x + 0.46, y + 0.99, 1.38);
    s += line(a, b, `stroke="${glow}" stroke-opacity=".35" stroke-width="6" stroke-linecap="round"`) + line(a, b, `stroke="${glow}" stroke-width="2" stroke-linecap="round"`);
    const [bx, by] = P(x - 0.1, y + 1, 2.02);
    if (vis.icon) s += badge(bx, by, vis.icon, glow, pal);
  }
  const heads = [], interns = [], list = vis.list || [];
  const n = list.length || Math.min(3, vis.running + vis.finished);
  const open = (i) => (list.length ? list[i].status === "running" : i < vis.running);
  if (n) {
    const xs = [[0], [-0.4, 0.4], [-0.6, 0, 0.6]][n - 1], iy = y + 2.02;
    for (let i = 0; i < n; i++) {
      const ix = x + xs[i], [px, py] = P(ix, iy);
      s += box({ x: ix - 0.12, y: iy - 0.12, z: 0, w: 0.24, d: 0.24, h: 0.24 }, pal.chair);
      s += `<g transform="translate(${f1(px)} ${f1(py)})">${figure({ look: lookOf(i), shirt, pal, pose: "seat", s: 0.62 })}</g>`;
      if (open(i)) heads.push(P(ix, iy, 0.8));
      if (list[i]) interns.push({ head: P(x, iy, 0.95), text: list[i].description || "Sub-agent", running: open(i) }); // stacked over the table
    }
    s += box({ x: x - 0.86, y: y + 2.36, z: 0, w: 0.08, d: 0.42, h: 0.4 }, pal.desk) + box({ x: x + 0.78, y: y + 2.36, z: 0, w: 0.08, d: 0.42, h: 0.4 }, pal.desk);
    s += box({ x: x - 0.92, y: y + 2.3, z: 0.4, w: 1.84, d: 0.52, h: 0.06 }, pal.desk);
    for (let i = 0; i < n; i++) {
      const lx = x + xs[i] - 0.16;
      s += box({ x: lx, y: y + 2.36, z: 0.46, w: 0.32, d: 0.22, h: open(i) ? 0.02 : 0.045 }, pal.key);
      if (open(i)) {
        s += box({ x: lx, y: y + 2.56, z: 0.48, w: 0.32, d: 0.03, h: 0.22 }, pal.monitor);
        const a = P(lx, y + 2.575, 0.7), b = P(lx + 0.32, y + 2.575, 0.7);
        s += line(a, b, `stroke="${pal.teal}" stroke-opacity=".35" stroke-width="5" stroke-linecap="round"`) + line(a, b, `stroke="${pal.teal}" stroke-width="1.6" stroke-linecap="round"`);
      }
    }
    const more = vis.running + vis.finished - n;
    if (more > 0) { const [tx, ty] = P(x + 0.95, y + 2.6, 0.5); s += `<text x="${f1(tx)}" y="${f1(ty)}" class="o3-more">+${more}</text>`; }
  }
  return { svg: s, heads, interns };
}

// ---------- the lounge ----------
export function plant(x, y, pal, h = 1) {
  const [cx, cy] = P(x, y, 0.42 + 0.35 * h);
  const leaf = (dx, dy, w, hh, c) => `<path d="${poly([[cx + dx, cy + dy - hh], [cx + dx + w, cy + dy], [cx + dx, cy + dy + hh * 0.45], [cx + dx - w, cy + dy]])}" fill="${c}"/>`;
  return box({ x: x - 0.2, y: y - 0.2, z: 0, w: 0.4, d: 0.4, h: 0.42 }, pal.pot) +
    `<g class="o3-sway">${leaf(-6, 2, 9, 14 * h, pal.leaf2)}${leaf(6, 3, 9, 13 * h, pal.leaf2)}${leaf(0, -4, 10, 18 * h, pal.leaf)}${leaf(-2, 6, 7, 9, pal.leaf)}</g>`;
}

export function sofa(L, pal) {
  const lg = L.lounge, x = lg.x + lg.w / 2 - 1.5, y = lg.y + 0.4;
  return box({ x, y: y - 0.05, z: 0.36, w: 3, d: 0.3, h: 0.62 }, pal.sofa) +
    box({ x, y, z: 0, w: 3, d: 0.95, h: 0.38 }, pal.sofa) +
    box({ x: x + 0.15, y: y + 0.3, z: 0.38, w: 1.32, d: 0.6, h: 0.1 }, shade(pal.sofa, 1.12)) +
    box({ x: x + 1.53, y: y + 0.3, z: 0.38, w: 1.32, d: 0.6, h: 0.1 }, shade(pal.sofa, 1.12)) +
    box({ x: x - 0.25, y: y - 0.05, z: 0, w: 0.25, d: 1, h: 0.62 }, pal.sofa) +
    box({ x: x + 3, y: y - 0.05, z: 0, w: 0.25, d: 1, h: 0.62 }, pal.sofa);
}

export function coffeeTable(L, pal) {
  const t = L.lounge.table;
  return box({ x: t.x - 0.55, y: t.y - 0.28, z: 0, w: 1.1, d: 0.56, h: 0.3 }, shade(pal.wood, 0.8)) +
    box({ x: t.x - 0.7, y: t.y - 0.4, z: 0.3, w: 1.4, d: 0.8, h: 0.07 }, pal.wood) +
    box({ x: t.x + 0.2, y: t.y - 0.15, z: 0.37, w: 0.14, d: 0.14, h: 0.16 }, pal.cup);
}

/** Counter with the coffee machine; the steam is separate so only it animates. */
export function coffeeBar(L, pal) {
  const x = L.lounge.x + 0.35, y = L.lounge.y + 0.3;
  return box({ x, y, z: 0, w: 1.7, d: 0.72, h: 0.82 }, pal.counter) +
    box({ x: x + 0.2, y: y + 0.08, z: 0.82, w: 0.5, d: 0.44, h: 0.6 }, pal.machine) +
    box({ x: x + 0.3, y: y + 0.42, z: 1.12, w: 0.3, d: 0.12, h: 0.08 }, shade(pal.machine, 1.6)) +
    box({ x: x + 0.38, y: y + 0.48, z: 0.82, w: 0.14, d: 0.14, h: 0.14 }, pal.cup) +
    box({ x: x + 1.1, y: y + 0.2, z: 0.82, w: 0.16, d: 0.16, h: 0.18 }, pal.cup);
}

export function steam(L) {
  const [cx, cy] = P(L.lounge.x + 0.8, L.lounge.y + 0.55, 1.05);
  const puff = (dx, i) => `<path class="o3-steam o3-steam-${i}" d="M${f1(cx + dx)} ${f1(cy)}c-3 -5 3 -8 0 -13c-3 -5 3 -8 0 -12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`;
  return puff(-3, 1) + puff(1, 2) + puff(5, 3);
}

// ---------- the meeting hall ----------
function hallChair(x, y, back, pal) {
  const by = back ? y - 0.36 : y + 0.27;
  return box({ x: x - 0.05, y: y - 0.05, z: 0, w: 0.1, d: 0.1, h: 0.36 }, pal.chair) +
    (back ? box({ x: x - 0.27, y: by, z: 0.42, w: 0.54, d: 0.09, h: 0.55 }, pal.chair) : "") +
    box({ x: x - 0.27, y: y - 0.27, z: 0.36, w: 0.54, d: 0.54, h: 0.08 }, pal.chair) +
    (back ? "" : box({ x: x - 0.27, y: by, z: 0.42, w: 0.54, d: 0.09, h: 0.55 }, pal.chair));
}

/** Long tables, a chair per seat, and a translucent project-coloured hologram for every active agent. */
export function hallInterior(L, holos, { pal, id }) {
  const h = L.hall, seats = h.seats;
  const holo = (seat, x) => {
    if (!x) return "";
    const [px, py] = P(seat.x, seat.y);
    return `<g class="o3-holo" opacity="${x.opacity}"><ellipse cx="${f1(px)}" cy="${f1(py)}" rx="17" ry="8" fill="url(#${id}-teal)"/>` +
      `<g transform="translate(${f1(px)} ${f1(py)})" opacity=".62">${figure({ look: x.look, shirt: x.color, pal, pose: "seat", mono: x.color })}</g></g>`;
  };
  let s = "";
  h.tables.forEach((t, k) => {
    seats.forEach((seat, i) => { if (seat.table === k && seat.back) s += hallChair(seat.x, seat.y, true, pal) + holo(seat, holos[i]); });
    s += box({ x: t.x + 0.4, y: t.y + 0.25, z: 0, w: t.w - 0.8, d: 0.4, h: 0.6 }, shade(pal.desk, 0.85));
    s += box({ x: t.x, y: t.y, z: 0.6, w: t.w, d: t.d, h: 0.08 }, pal.desk);
    seats.forEach((seat, i) => { if (seat.table === k && !seat.back) s += holo(seat, holos[i]) + hallChair(seat.x, seat.y, false, pal); });
  });
  return s;
}

/** The glowing wall screen on the hall's back wall. */
export function hallScreen(L, pal) {
  const h = L.hall, w = Math.min(3.8, h.w - 2.4), x0 = h.x + h.w / 2 - w / 2, y = h.y + 0.04;
  const q = (a, b, z0, z1) => poly([P(a, y, z0), P(b, y, z0), P(b, y, z1), P(a, y, z1)]);
  let s = `<path d="${q(x0 - 0.12, x0 + w + 0.12, 0.78, 2.02)}" fill="${pal.teal}" fill-opacity=".16"/>`;
  s += `<path d="${q(x0, x0 + w, 0.88, 1.92)}" fill="${pal.screen}" stroke="${pal.teal}" stroke-width="1.4"/>`;
  [0.5, 0.8, 0.35, 0.65, 0.9, 0.55].forEach((v, i) => {
    const a = x0 + 0.35 + i * ((w - 0.7) / 6), b = a + (w - 0.7) / 6 - 0.12;
    s += `<path d="${q(a, b, 1.0, 1.0 + 0.75 * v)}" fill="${pal.teal}" fill-opacity="${0.35 + 0.5 * v}"/>`;
  });
  return s;
}

// ---------- the Needs You spotlight ----------
/** Lamp post with an arm reaching over the disc. */
export function lampPost(L, pal) {
  const { lamp } = L.spot, hx = L.spot.cx + 0.05;
  return box({ x: lamp.x - 0.07, y: lamp.y - 0.07, z: 0, w: 0.14, d: 0.14, h: 3 }, pal.lamp) +
    box({ x: lamp.x - 0.18, y: lamp.y - 0.18, z: 0, w: 0.36, d: 0.36, h: 0.12 }, pal.lamp) +
    box({ x: Math.min(lamp.x, hx), y: lamp.y - 0.04, z: 2.92, w: Math.abs(lamp.x - hx), d: 0.08, h: 0.08 }, pal.lamp) +
    box({ x: hx - 0.17, y: lamp.y - 0.17, z: 2.68, w: 0.34, d: 0.34, h: 0.24 }, shade(pal.lamp, 1.15));
}

/** Floor disc, light cone and bulb: amber while someone waits on you, unlit otherwise. */
export function spotlight(L, waiting, { pal, id }) {
  const sp = L.spot, rx = sp.r * 28 * Math.SQRT2, ry = sp.r * 14 * Math.SQRT2, [cx, cy] = P(sp.cx, sp.cy);
  if (!waiting) return `<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(rx)}" ry="${f1(ry)}" fill="none" stroke="${pal.off}" stroke-width="1.5" stroke-dasharray="5 5"/>`;
  const [bx, by] = P(sp.cx + 0.05, sp.lamp.y, 2.68);
  const cone = poly([[bx - 7, by], [bx + 7, by], [cx + rx * 0.72, cy], [cx - rx * 0.72, cy]]);
  return `<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(rx * 1.5)}" ry="${f1(ry * 1.5)}" fill="url(#${id}-disc)" opacity=".55"/>` +
    `<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(rx)}" ry="${f1(ry)}" fill="url(#${id}-disc)"/>` +
    `<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(rx)}" ry="${f1(ry)}" fill="none" stroke="${pal.amber}" stroke-width="1.5" stroke-opacity=".8"/>` +
    `<path d="${cone}" fill="url(#${id}-cone)"/>` +
    `<ellipse cx="${f1(bx)}" cy="${f1(by + 3)}" rx="16" ry="9" fill="url(#${id}-amber)"/>`;
}

/** Pulsing amber ring at the feet of an agent who waits on you. */
export const halo = (pal) => `<ellipse class="o3-halo" cx="0" cy="0" rx="22" ry="11" fill="none" stroke="${pal.amber}" stroke-width="2"/>`;

/** Dashed teal line from an intern's head to its parent's head. */
export const linkPath = (a, b) => `M${pt(a)}Q${f1((a[0] + b[0]) / 2)} ${f1(Math.min(a[1], b[1]) - 14)} ${pt(b)}`;
