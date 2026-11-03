"use strict";
// CSV for spreadsheets: RFC 4180 quoting, CRLF line ends, and a byte order mark so Excel reads names as UTF-8.
// Text a spreadsheet would run as a formula (it starts with = + - @, a tab or a carriage return) gets a leading
// apostrophe, so a project, agent or model name can't run in the file you open.

const FORMULA = /^[=+\-@\t\r]/;

/** One cell: finite numbers as they are; text neutralised, then quoted when it holds a comma, a quote or a line break. */
function cell(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = FORMULA.test(String(v)) ? `'${v}` : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** columns = [[header, row => value]]. */
function toCsv(columns, rows) {
  const line = (cells) => cells.map(cell).join(",");
  return `﻿${[line(columns.map((c) => c[0])), ...rows.map((r) => line(columns.map((c) => c[1](r))))].join("\r\n")}\r\n`;
}

const usd = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
/** The cost report's export: one row per API request (see Store#requestRows). Day = the local day it counts toward. */
const REQUEST_COLUMNS = [
  ["Time (UTC)", (r) => r.t], ["Day", (r) => r.date], ["Agent", (r) => r.name], ["Project", (r) => r.project], ["Machine", (r) => r.host],
  ["Model", (r) => r.model], ["Input tokens", (r) => r.input], ["Output tokens", (r) => r.output], ["Cache read tokens", (r) => r.cacheRead],
  ["Cache write tokens", (r) => r.cacheWrite], ["Cost (USD)", (r) => usd(r.cost)], ["Session id", (r) => r.session],
];
const requestsCsv = (rows) => toCsv(REQUEST_COLUMNS, rows);

module.exports = { cell, toCsv, requestsCsv };
