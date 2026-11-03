// Live re-renders that keep your place: an element's markup is replaced only when it changed, and focus, each panel's
// scroll position, open code boxes and open disclosures survive. Shared by the shell, the agent detail and the work board.

export const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";
/** What a control is, so a re-render can find its twin: tag, classes, and what it acts on. */
const kindOf = (n) => [n.localName, n.getAttribute("class"), ...["data-copy", "data-expand", "data-retry", "data-close", "data-jump", "data-agent", "href"].map((k) => n.getAttribute(k))].join("|");

/** The element under root with this data-key, or null. */
export const byKey = (root, key) => (key ? [...root.querySelectorAll("[data-key]")].find((n) => n.getAttribute("data-key") === key) || null : null);

/** patch(el, html) for a document. */
export function createPatch(doc) {
  /** Where focus is inside el, to find it again after a re-render: its data-key, else its kind and position. */
  function focusSpot(el) {
    const a = doc.activeElement;
    if (!a || a === el || !el.contains(a)) return null;
    return { key: a.getAttribute("data-key"), kind: kindOf(a), index: [...el.querySelectorAll(FOCUSABLE)].indexOf(a) };
  }

  /** Focus the same control in el's new markup: by key, else the nearest one of the same kind, else whatever now sits
   *  in its place, else the panel's heading. Focus never falls back to the page. */
  function refocus(el, spot) {
    const all = [...el.querySelectorAll(FOCUSABLE)], at = (n) => Math.abs(all.indexOf(n) - spot.index);
    let n = byKey(el, spot.key);
    if (!n) n = all.filter((x) => kindOf(x) === spot.kind).sort((x, y) => at(x) - at(y))[0] || all[Math.min(spot.index, all.length - 1)] || null;
    if (!n && (n = el.querySelector("h1, h2, h3"))) n.setAttribute("tabindex", "-1");
    n?.focus({ preventScroll: true });
  }

  /** Replaces el's markup only when it changed, keeping focus, each panel's scroll position (by position), the scroll of
   *  boxes marked data-keep-scroll (a command's output, a diff: by their text), open code boxes (by their text) and open
   *  disclosures (by position). */
  return function patch(el, html) {
    if (el.__html === html) return;
    el.__html = html;
    const spot = focusSpot(el), scrolls = [...el.querySelectorAll(".ao-panel-body")].map((b) => b.scrollTop || 0);
    const boxes = new Map([...el.querySelectorAll("[data-keep-scroll]")].filter((b) => b.scrollTop || b.scrollLeft).map((b) => [b.textContent, [b.scrollTop, b.scrollLeft]]));
    const codes = new Set([...el.querySelectorAll(".ao-code")].filter((c) => c.classList.contains("is-open")).map((c) => c.textContent));
    const details = [...el.querySelectorAll("details")].map((d) => d.hasAttribute("open"));
    el.innerHTML = html;
    el.querySelectorAll(".ao-panel-body").forEach((b, i) => { if (scrolls[i]) b.scrollTop = scrolls[i]; });
    for (const b of el.querySelectorAll("[data-keep-scroll]")) if (boxes.has(b.textContent)) [b.scrollTop, b.scrollLeft] = boxes.get(b.textContent);
    for (const c of el.querySelectorAll(".ao-code")) {
      if (!codes.has(c.textContent)) continue;
      c.classList.add("is-open");
      c.querySelector("[data-expand]")?.setAttribute("aria-expanded", "true");
    }
    el.querySelectorAll("details").forEach((d, i) => { if (details[i]) d.setAttribute("open", ""); });
    if (spot) refocus(el, spot);
  };
}
