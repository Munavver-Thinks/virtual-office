// Pixel office renderer. Draws desks, a break area, and one person per agent.
const T = 16, COLS = 26, PX = 4, DESKS_PER_ROW = 4, ROW_H = 72, TOP = 44;
export const COLORS = { working: "#2E9E6B", waiting: "#D9931C", idle: "#8A97A3", offline: "#C3CBD2" };
const SHIRTS = ["#3E7CB1", "#C2554B", "#4E9A6A", "#8A5BB0", "#D38B2C", "#2F8F9D", "#B05A86", "#5A6B7D"];
const HAIR = ["#2B1D14", "#5A3A22", "#A8722C", "#1B1B1B", "#7A7A7A", "#C9A15B"];
const SKIN = ["#F2C9A0", "#D9A273", "#A86F45", "#7A4B2C", "#EAC2A0"];

export function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }

export class Office {
  constructor(canvas, { onHover, onClick } = {}) {
    this.cv = canvas; this.ctx = canvas.getContext("2d");
    this.people = new Map(); this.hoverId = null; this.selectedId = null;
    this.reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.onHover = onHover; this.onClick = onClick;
    this.layout(3);
    canvas.addEventListener("mousemove", (e) => this.mouse(e));
    canvas.addEventListener("mouseleave", () => { this.hoverId = null; this.onHover?.(null); });
    canvas.addEventListener("click", () => { if (this.hoverId) this.onClick?.(this.hoverId); });
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  layout(deskRows) {
    if (deskRows === this.deskRows) return;
    this.deskRows = deskRows;
    this.W = COLS * T;
    this.H = TOP + deskRows * ROW_H + 40;
    this.cv.width = this.W * PX; this.cv.height = this.H * PX;
    this.ctx.imageSmoothingEnabled = false;
    this.desks = [];
    for (let r = 0; r < deskRows; r++) for (let c = 0; c < DESKS_PER_ROW; c++) {
      const x = 24 + c * 64, y = TOP + r * ROW_H;
      this.desks.push({ x, y, seat: { x: x + 16, y: y + 30 } });
    }
    const H = this.H;
    this.idleSpots = [
      { x: 330, y: 70 }, { x: 352, y: 76 }, { x: 374, y: 70 },
      { x: 330, y: H / 2 }, { x: 370, y: H / 2 + 6 },
      { x: 322, y: H - 58 }, { x: 350, y: H - 52 }, { x: 380, y: H - 58 },
    ];
  }

  rect(x, y, w, h, c) { this.ctx.fillStyle = c; this.ctx.fillRect(Math.round(x) * PX, Math.round(y) * PX, w * PX, h * PX); }

  drawRoom() {
    const { W, H } = this, r = this.rect.bind(this);
    for (let y = 0; y < Math.ceil(H / T); y++) for (let x = 0; x < COLS; x++) r(x * T, y * T, T, T, (x + y) % 2 ? "#8FA8B8" : "#87A0B0");
    r(0, 0, W, 14, "#2E4057"); r(0, 14, W, 3, "#24344A");
    for (let i = 0; i < 4; i++) { r(30 + i * 64, 3, 28, 8, "#BFD7E6"); r(43 + i * 64, 3, 2, 8, "#2E4057"); }
    r(296, 17, 3, H - 17, "#5D7183");
    r(306, 22, 100, 18, "#C9CFD4"); r(306, 38, 100, 4, "#9AA4AD");
    r(312, 14, 12, 16, "#3B3B3B"); r(315, 18, 6, 4, "#D9931C");
    r(388, 12, 16, 30, "#E6EAED"); r(389, 24, 14, 1, "#9AA4AD");
    r(312, H - 30, 80, 14, "#B9C5CE"); r(310, H - 22, 84, 18, "#6D5A8F"); r(310, H - 28, 84, 6, "#7D6AA0");
    [[290, 24], [6, H - 22], [290, H - 22]].forEach(([x, y]) => { r(x, y + 8, 8, 8, "#8B5A3C"); r(x - 2, y, 12, 9, "#3F8A4F"); r(x + 1, y - 3, 6, 4, "#57A866"); });
    this.desks.forEach((d) => {
      r(d.x, d.y + 10, 40, 14, "#A9744F"); r(d.x, d.y + 22, 40, 3, "#7E5236");
      r(d.x + 12, d.y, 16, 11, "#253445"); r(d.x + 14, d.y + 2, 12, 7, "#3B5470");
      r(d.x + 18, d.y + 11, 4, 2, "#253445"); r(d.x + 30, d.y + 13, 6, 4, "#EEF2F4");
    });
  }

  setAgents(agents) {
    const onFloor = agents.filter((a) => a.state !== "offline");
    this.layout(Math.max(3, Math.ceil(onFloor.length / DESKS_PER_ROW)));
    const seen = new Set();
    // Stable desk per agent: sort by start time so desks don't shuffle.
    [...onFloor].sort((a, b) => a.started.localeCompare(b.started)).forEach((a, i) => {
      seen.add(a.session);
      let p = this.people.get(a.session);
      const h = hash(a.session);
      if (!p) {
        p = { x: 300, y: this.H - 6, shirt: SHIRTS[h % SHIRTS.length], hair: HAIR[(h >> 3) % HAIR.length], skin: SKIN[(h >> 6) % SKIN.length] };
        this.people.set(a.session, p);
      }
      p.agent = a;
      p.target = a.state === "idle" ? this.idleSpots[h % this.idleSpots.length] : this.desks[i % this.desks.length].seat;
    });
    for (const id of this.people.keys()) if (!seen.has(id)) this.people.delete(id);
  }

  bubble(cx, by, text, color, t) {
    const ctx = this.ctx;
    ctx.font = `${7 * PX}px Silkscreen, monospace`;
    const w = Math.ceil(ctx.measureText(text).width / PX) + 6, bob = this.reduceMotion ? 0 : Math.round(Math.sin(t / 300));
    const x = Math.round(cx - w / 2), y = by - 10 + bob;
    this.rect(x, y, w, 10, color); this.rect(cx - 1, y + 10, 2, 2, color);
    ctx.fillStyle = "#FFFFFF"; ctx.textBaseline = "top"; ctx.fillText(text, (x + 3) * PX, (y + 1.5) * PX);
  }

  drawPerson(p, t) {
    const r = this.rect.bind(this), a = p.agent;
    const moving = Math.hypot(p.target.x - p.x, p.target.y - p.y) > 1;
    const x = p.x - 4, y = p.y - 16, leg = moving && !this.reduceMotion ? Math.floor(t / 150) % 2 : 0;
    r(x + 1, y + 16, 6, 2, "rgba(0,0,0,.18)");
    r(x + 1, y + 12, 2, 4 - leg, "#2E3640"); r(x + 5, y + 12, 2, 3 + leg, "#2E3640");
    r(x, y + 6, 8, 7, p.shirt);
    const typing = a.state === "working" && !moving && !this.reduceMotion && Math.floor(t / 200) % 2;
    r(x - 1, y + 7 + (typing ? 1 : 0), 1, 4, p.skin); r(x + 8, y + 7 + (typing ? 0 : 1), 1, 4, p.skin);
    r(x + 1, y, 6, 6, p.skin); r(x + 1, y, 6, 2, p.hair); r(x, y + 1, 1, 3, p.hair);
    r(x + 2, y + 3, 1, 1, "#1E2B38"); r(x + 5, y + 3, 1, 1, "#1E2B38");
    if (a.session === this.hoverId || a.session === this.selectedId) {
      this.ctx.strokeStyle = "#FFFFFF"; this.ctx.lineWidth = PX; this.ctx.strokeRect((x - 3) * PX, (y - 3) * PX, 14 * PX, 24 * PX);
    }
    if (moving) return;
    if (a.state === "waiting") this.bubble(p.x, y - 4, "!", COLORS.waiting, t);
    else if (a.state === "working" && a.tool) this.bubble(p.x, y - 4, a.tool.slice(0, 10), COLORS.working, t);
    else if (a.state === "idle") this.bubble(p.x, y - 4, "zz", COLORS.idle, t);
  }

  frame(t) {
    const dt = Math.min(50, t - this.last) / 1000; this.last = t;
    this.drawRoom();
    const list = [...this.people.values()].sort((a, b) => a.y - b.y);
    for (const p of list) {
      const dx = p.target.x - p.x, dy = p.target.y - p.y, d = Math.hypot(dx, dy);
      if (d > 1) { const s = this.reduceMotion ? d : Math.min(d, 45 * dt); p.x += (dx / d) * s; p.y += (dy / d) * s; }
      else { p.x = p.target.x; p.y = p.target.y; }
    }
    list.forEach((p) => this.drawPerson(p, t));
    requestAnimationFrame((n) => this.frame(n));
  }

  mouse(e) {
    const r = this.cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (this.W / r.width), my = (e.clientY - r.top) * (this.H / r.height);
    let hit = null;
    for (const p of this.people.values()) if (mx > p.x - 7 && mx < p.x + 7 && my > p.y - 20 && my < p.y + 2) hit = p;
    this.hoverId = hit ? hit.agent.session : null;
    this.cv.style.cursor = hit ? "pointer" : "default";
    this.onHover?.(hit ? hit.agent : null, e);
  }
}
