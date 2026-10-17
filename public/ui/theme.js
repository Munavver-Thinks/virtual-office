// Theme: "dark" (default), "light" or "system". Sets .ao-dark / .ao-light on <html>.
// The choice is saved per browser when storage works, and kept in memory when it doesn't.

const KEY = "ao-theme";
export const THEME_PREFS = ["dark", "light", "system"];
let pref = null;

const systemQuery = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null);

/** "system" follows the OS; anything else falls back to dark. */
export function resolveTheme(p, systemLight) {
  return p === "light" || (p === "system" && systemLight) ? "light" : "dark";
}

export function themePref() {
  if (pref) return pref;
  try {
    const v = localStorage.getItem(KEY);
    if (THEME_PREFS.includes(v)) return (pref = v);
  } catch {}
  return (pref = "dark");
}

/** The theme in effect: "dark" or "light". */
export function currentTheme() {
  return document.documentElement.classList.contains("ao-light") ? "light" : "dark";
}

export function applyTheme() {
  const p = themePref(), theme = resolveTheme(p, !!systemQuery()?.matches), root = document.documentElement;
  root.classList.toggle("ao-dark", theme === "dark");
  root.classList.toggle("ao-light", theme === "light");
  document.dispatchEvent(new CustomEvent("ao-theme", { detail: { pref: p, theme } }));
  return theme;
}

export function setTheme(p) {
  if (!THEME_PREFS.includes(p)) return currentTheme();
  pref = p;
  try { localStorage.setItem(KEY, p); } catch {}
  return applyTheme();
}

let watching = false;
/** Call once per page: applies the saved theme and follows OS and other-tab changes. */
export function initTheme() {
  if (!watching) {
    watching = true;
    systemQuery()?.addEventListener?.("change", () => { if (themePref() === "system") applyTheme(); });
    addEventListener("storage", (e) => { if (e.key === KEY) { pref = null; applyTheme(); } });
  }
  return applyTheme();
}
