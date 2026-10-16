"use strict";
// Parses OpenTelemetry (OTLP/HTTP JSON) log exports from Claude Code.
// Each `api_request` log event carries the session id, cost, tokens and model
// of one model call, so we turn each one into a "usage" event.

function anyValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("boolValue" in v) return !!v.boolValue;
  return null;
}

function attrs(list) {
  const o = {};
  for (const a of list || []) if (a && a.key) o[a.key] = anyValue(a.value);
  return o;
}

function timeOf(rec) {
  const ns = rec.timeUnixNano || rec.observedTimeUnixNano;
  if (ns) {
    try { return new Date(Number(BigInt(ns) / 1000000n)).toISOString(); } catch {}
  }
  return new Date().toISOString();
}

function parseLogs(body) {
  const out = [];
  for (const rl of (body && body.resourceLogs) || []) {
    const res = attrs(rl.resource && rl.resource.attributes);
    for (const sl of rl.scopeLogs || []) {
      for (const rec of sl.logRecords || []) {
        const a = { ...res, ...attrs(rec.attributes) };
        const name = String(a["event.name"] || anyValue(rec.body) || "");
        if (!/(^|\.)api_request$/.test(name)) continue;
        const session = a["session.id"];
        if (!session) continue;
        out.push({
          type: "usage",
          t: a["event.timestamp"] || timeOf(rec),
          session: String(session),
          cost: Number(a.cost_usd) || 0,
          input: Number(a.input_tokens) || 0,
          output: Number(a.output_tokens) || 0,
          cacheRead: Number(a.cache_read_tokens) || 0,
          cacheWrite: Number(a.cache_creation_tokens) || 0,
          model: a.model || null,
        });
      }
    }
  }
  return out;
}

module.exports = { parseLogs, attrs, anyValue };
