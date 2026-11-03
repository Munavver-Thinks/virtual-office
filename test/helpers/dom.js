"use strict";
// A tiny fake DOM for the page controllers (createOffice, createShell). No tests here: node --test runs this file
// only because it sits under test/.

/**
 * Just enough DOM: parses the markup the controllers generate, simple selectors (tag, #id, .class, [attr], [attr="v"],
 * :not(), comma lists, no descendant combinators), events with capture and bubbling, dialogs, input values, and a count
 * of every write.
 */
function fakeDom({ width = 1200, height = 800 } = {}) {
  const SVG = "http://www.w3.org/2000/svg", dom = { writes: 0 };
  let doc = null;
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
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
    // Inputs: value and checked start from their attributes.
    get value() { return this._value ?? this.getAttribute("value") ?? ""; }
    set value(v) { this._value = String(v); dom.writes++; }
    get checked() { return this._checked ?? this.hasAttribute("checked"); }
    set checked(v) { this._checked = !!v; }
    // Dialogs: showModal() and close(), which fires "close" like the real one.
    get open() { return this.hasAttribute("open"); }
    showModal() { this.setAttribute("open", ""); }
    close() { if (!this.open) return; this.removeAttribute("open"); this.dispatchEvent({ type: "close" }); }
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
    dispatchEvent(ev) {
      // A real Event (CustomEvent on Node 19+) has a read-only target: listeners get a plain copy.
      const e = typeof Event === "function" && ev instanceof Event ? { type: ev.type, detail: ev.detail, bubbles: ev.bubbles } : ev;
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
    const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);
    let cur = parent, m;
    while ((m = re.exec(html))) {
      if (m[1]) { let e = cur; while (e !== parent && e.localName !== m[1].toLowerCase()) e = e.parentNode; if (e !== parent) cur = e.parentNode; }
      else if (m[2]) {
        const el = new El(m[2], m[2] === "svg" || cur.ns === SVG ? SVG : null);
        for (const a of m[3].matchAll(/([^\s=/>]+)(?:\s*=\s*"([^"]*)")?/g)) el.attrs.set(a[1], a[2] === undefined ? "" : decode(a[2]));
        cur.append(el);
        if (!m[4] && !VOID.has(el.localName)) cur = el;
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

/** Installs a fake DOM as the globals the page code uses; restore() puts the old ones back. Frames never run. */
function withDom(opts) {
  const dom = fakeDom(opts), keys = ["document", "requestAnimationFrame", "cancelAnimationFrame", "addEventListener", "CustomEvent"];
  const saved = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));
  globalThis.document = dom.document;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.addEventListener = () => {}; // theme.js listens for other tabs' theme changes
  // Node 18 has no global CustomEvent.
  if (typeof globalThis.CustomEvent !== "function") globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.bubbles = !!init.bubbles; } };
  dom.restore = () => keys.forEach((k, i) => { if (saved[i]) Object.defineProperty(globalThis, k, saved[i]); else delete globalThis[k]; });
  return dom;
}

module.exports = { fakeDom, withDom };
