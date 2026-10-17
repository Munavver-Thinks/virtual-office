"use strict";
// Per-session state-change log, and the segments and 10-minute buckets built from it.
// The log stores working / waiting / idle and "ended" (SessionEnd). Offline is never stored:
// segments compute it from "ended" and from silences longer than the offline timeout.

const BUCKET = 10 * 60000;
const PRIORITY = ["waiting", "working", "idle"];

/** Records an event's state. A new entry starts on a state change or after a silence longer than timeoutMs. */
function record(log, t, state, timeoutMs, cap = 1000) {
  const ms = Date.parse(t), last = log[log.length - 1];
  if (last && ms < Date.parse(last.t)) return;
  if (last && last.state === state && ms - Date.parse(last.last) <= timeoutMs) {
    if (ms > Date.parse(last.last)) last.last = t;
    return;
  }
  log.push({ t, state, last: t });
  if (log.length > cap) log.splice(0, log.length - cap);
}

/**
 * State segments between from and to (ms). Offline segments carry lastContact, the time of the last event.
 * A silence turns into offline after timeoutMs, except while waiting on you: that lasts up to waitCapMs.
 * @returns {{state: string, from: number, to: number, lastContact?: string}[]}
 */
function segments(log, { from, to, timeoutMs, waitCapMs = timeoutMs }) {
  const out = [];
  const add = (state, a, b, lastContact) => {
    a = Math.max(a, from); b = Math.min(b, to);
    if (b <= a) return;
    const prev = out[out.length - 1];
    if (prev && prev.state === state && prev.to === a) { prev.to = b; return; }
    out.push(lastContact ? { state, from: a, to: b, lastContact } : { state, from: a, to: b });
  };
  for (let i = 0; i < log.length; i++) {
    const e = log[i], start = Date.parse(e.t);
    if (start >= to) break;
    const next = i + 1 < log.length ? Date.parse(log[i + 1].t) : to;
    if (next <= from) continue;
    if (e.state === "ended") { add("offline", start, next, e.t); continue; }
    const silent = Date.parse(e.last) + (e.state === "waiting" ? waitCapMs : timeoutMs);
    if (silent < next) { add(e.state, start, silent); add("offline", silent, next, e.last); }
    else add(e.state, start, next);
  }
  return out;
}

/** Milliseconds per state: activeMs (working), waitedMs, idleMs, offlineMs. */
function totals(segs) {
  const t = { activeMs: 0, waitedMs: 0, idleMs: 0, offlineMs: 0 };
  const key = { working: "activeMs", waiting: "waitedMs", idle: "idleMs", offline: "offlineMs" };
  for (const s of segs) t[key[s.state]] += s.to - s.from;
  return t;
}

/** 10-minute buckets: how many sessions were mostly working / waiting / idle in each (ties favour waiting). */
function buckets(segLists, from, to, size = BUCKET) {
  const n = Math.max(0, Math.ceil((to - from) / size));
  const out = Array.from({ length: n }, (_, i) => ({ t: new Date(from + i * size).toISOString(), working: 0, waiting: 0, idle: 0 }));
  for (const segs of segLists) {
    const acc = new Map();
    for (const s of segs) {
      if (s.state === "offline") continue;
      for (let b = Math.max(0, Math.floor((s.from - from) / size)); b < n && from + b * size < s.to; b++) {
        const ov = Math.min(s.to, from + (b + 1) * size) - Math.max(s.from, from + b * size);
        if (ov <= 0) continue;
        if (!acc.has(b)) acc.set(b, { working: 0, waiting: 0, idle: 0 });
        acc.get(b)[s.state] += ov;
      }
    }
    for (const [b, ms] of acc) out[b][PRIORITY.reduce((best, k) => (ms[k] > ms[best] ? k : best))]++;
  }
  return out;
}

module.exports = { BUCKET, record, segments, totals, buckets };
