// Appearance, per browser (Settings): Reduce motion and Show name tags. Sets .ao-reduce-motion and .ao-no-tags on <html>
// and fires "ao-prefs" { reduceMotion, nameTags } on the document. Saved when storage works, else kept in memory.
// The system's own reduced-motion setting always wins (tokens.css follows it too).

const KEYS = { reduceMotion: "ao-motion", nameTags: "ao-tags" };
const ON = { reduceMotion: "reduce", nameTags: "on" }, OFF = { reduceMotion: "", nameTags: "off" };
let prefs = null;

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
/** The system asks for less motion. */
export const systemReduced = () => typeof matchMedia === "function" && !!matchMedia("(prefers-reduced-motion: reduce)").matches;

/** { reduceMotion, nameTags }: motion is full and tags show unless you changed them. */
export function getPrefs() {
  if (!prefs) prefs = { reduceMotion: read(KEYS.reduceMotion) === ON.reduceMotion, nameTags: read(KEYS.nameTags) !== OFF.nameTags };
  return { ...prefs };
}

/** Motion is reduced when you asked for it here or the system asks. */
export const motionReduced = () => getPrefs().reduceMotion || systemReduced();

export function applyPrefs() {
  const p = getPrefs(), root = document.documentElement;
  root.classList.toggle("ao-reduce-motion", p.reduceMotion);
  root.classList.toggle("ao-no-tags", !p.nameTags);
  document.dispatchEvent(new CustomEvent("ao-prefs", { detail: p }));
  return p;
}

/** Sets one ("reduceMotion" or "nameTags") and applies it. */
export function setPref(key, on) {
  if (!Object.hasOwn(KEYS, key)) return getPrefs();
  getPrefs();
  prefs[key] = !!on;
  try { localStorage.setItem(KEYS[key], on ? ON[key] : OFF[key]); } catch {}
  return applyPrefs();
}

let watching = false;
/** Call once per page: applies the saved choices and follows other tabs' changes. */
export function initPrefs() {
  if (!watching) {
    watching = true;
    addEventListener("storage", (e) => { if (Object.values(KEYS).includes(e.key)) { prefs = null; applyPrefs(); } });
  }
  return applyPrefs();
}
