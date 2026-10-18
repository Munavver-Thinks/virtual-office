// Pure text formatters shared by every screen. No DOM, safe to import in Node tests.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Escapes text for HTML content and attribute values. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const num = (n) => (Number.isFinite(+n) ? +n : 0) || 0;

/** 950 → "950", 2000 → "2k", 48210 → "48.2k", 1210000 → "1.21M" (3 significant digits). */
export function compact(n) {
  n = Math.max(0, num(n));
  if (Math.round(n) < 1000) return String(Math.round(n));
  const units = ["k", "M", "B", "T"];
  for (let i = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log10(n) / 3) - 1)); ; i++) {
    const s = String(+(n / 1000 ** (i + 1)).toPrecision(3));
    if (+s < 1000 || i === units.length - 1) return s + units[i];
  }
}

/** One line, always: "in 2k · out 231k · cache 34.4M". Cache = read + write. */
export function tokensLine(t = {}) {
  return `in ${compact(t.input)} · out ${compact(t.output)} · cache ${compact(num(t.cacheRead) + num(t.cacheWrite))}`;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** 13.72 → "$13.72". trim drops a whole-dollar ".00" ("$25"). Tiny non-zero amounts read "<$0.01". */
export function money(n, { trim = false } = {}) {
  n = num(n);
  if (n > 0 && n < 0.005) return "<$0.01";
  const s = USD.format(n);
  return trim ? s.replace(/\.00$/, "") : s;
}

/** An agent's cost, or "No cost data" when no API request was ever reported (telemetry off), instead of a misleading $0.00. */
export function costText({ cost, requests } = {}) {
  return !num(requests) && !num(cost) ? "No cost data" : money(cost);
}

/** Keeps the start and the end: "/Users/me/…/supermarket-pos". Paths keep whole folder names. */
export function middleTruncate(s, max = 36) {
  s = String(s ?? "");
  if (s.length <= max) return s;
  const sep = s.includes("/") ? "/" : s.includes("\\") ? "\\" : "";
  if (sep) {
    const parts = s.replace(/[\\/]+$/, "").split(sep), tail = parts.pop();
    for (let k = Math.min(3, parts.length - 1); k >= 1; k--) {
      const out = parts.slice(0, k).join(sep) + sep + "…" + sep + tail;
      if (out.length <= max) return out;
    }
    if (tail.length + 2 <= max) return "…" + sep + tail;
  }
  const keep = Math.max(1, max - 1), head = Math.ceil(keep / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - (keep - head));
}

/** "npm run test -- --watch" → "npm run te…" */
export function endTruncate(s, max = 60) {
  s = String(s ?? "");
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

/** Two letters for an avatar. Uses the label after " · " in agent names: "supermarket-pos · basket bill" → "BB". */
export function initials(name) {
  const words = String(name ?? "").split(" · ").pop().split(/[\s\-_./\\]+/).filter(Boolean);
  const first = (w) => Array.from(w)[0] || "";
  const out = words.length > 1 ? first(words[0]) + first(words[1]) : Array.from(words[0] || "").slice(0, 2).join("");
  return out.toUpperCase() || "?";
}

/** 9120000 → "2h 32m". Under a minute shows seconds; over a day shows days and hours. */
export function duration(ms) {
  ms = Math.max(0, num(ms));
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return mm ? `${h}h ${mm}m` : `${h}h`;
  return `${mm}m`;
}

/** How long an agent has waited on you: "9m", "1h 5m", "<1m". */
export function waitTime(ms) {
  return num(ms) < 60000 ? "<1m" : duration(ms);
}

/** Local 24-hour clock time: "15:40". Empty for missing or invalid input. */
export function clock(t) {
  if (t == null || t === "") return "";
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
