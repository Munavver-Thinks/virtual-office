"use strict";
// Plain-text helpers shared by the hook and the server.
// public/lib/describe.js keeps an ESM copy of cleanPrompt, agentLabel, relPath and permissionPhrase
// for the browser (no build step on Node 18); test/describe.test.js checks both copies agree.
// The hook runs these on prompts of up to 1 MB, so every pattern is bounded and runs in linear time.

const MAX_RAW = 1000000, LABEL_SCAN = 1000, FILE_SCAN = 1000;
// System blocks Claude Code and the IDE add around a prompt. An unclosed block runs to the end.
const BLOCK = /<(ide_[a-z_]{1,40}|system-reminder|command-[a-z-]{1,40}|local-command-[a-z-]{1,40})(?=[\s>])[^<>]{0,100}>([\s\S]*?)(?:<\/\1\s{0,10}>|$)/gi;
const STRAY = /<\/?(?:ide_[a-z_]{1,40}|system-reminder|command-[a-z-]{1,40}|local-command-[a-z-]{1,40})(?=[\s>])[^<>]{0,100}>/gi;

const baseName = (p) => String(p).split(/[\\/]+/).filter(Boolean).pop() || null;

/** The file named at the start of an <ide_opened_file> or <ide_selection> block. */
function fileIn(body) {
  const text = body.slice(0, FILE_SCAN);
  const m = /opened the file (.+?) in the IDE/i.exec(text) || /\bfrom (\S+?):(?:\s|$)/.exec(text) ||
    /((?:[a-z]:)?[\w.~-]*[\\/][^\s"'<>]*\.\w{1,10}|[\w-]+\.\w{1,10})(?=[\s"'<>:,]|$)/i.exec(text);
  return m ? baseName(m[1].trim()) : null;
}

/**
 * Strips IDE and system blocks from a prompt, before any truncation.
 * @returns {{text: string, openedFile: string|null, command: string|null}} command = the slash command typed, if any
 */
function cleanPrompt(raw) {
  let openedFile = null, command = null, looked = false;
  const s = String(raw ?? "").slice(0, MAX_RAW).replace(BLOCK, (all, tag, body) => {
    const t = tag.toLowerCase();
    if (!looked && (t === "ide_opened_file" || t === "ide_selection")) { looked = true; openedFile = fileIn(body); }
    if (!command && t === "command-name") command = body.slice(0, 200).trim().split(/\s+/)[0] || null;
    return " ";
  });
  const text = s.replace(STRAY, " ").replace(/\s+/g, " ").trim();
  if (!command && text.startsWith("/")) command = text.slice(0, 100).split(" ")[0];
  return { text, openedFile, command };
}

// Words that never make a good agent label.
const STOP = new Set(("a an the and or but nor to for of in on at by with from into onto about as is are was were be been being am " +
  "it its it's this that these those there here my our your their his her me us them i you we he she they what which who whom whose " +
  "why how when where do does did done doing have has had not no yes some any all each every more most very really so than too up out " +
  "over under again same other such only own just also then if else because while should would could can will may might must shall " +
  "need needs want wants let lets let's please pls thanks thank ok okay hi hey hello now new etc e.g i.e via per").split(" "));
// Leading verbs ("Fix the…", "Can you add…") say what to do, not what it's about.
const LEAD = new Set(("fix add make build create implement write update change refactor improve check look see find get set use run " +
  "debug investigate figure try start continue finish work handle review clean tidy remove delete rename move setup support enable " +
  "allow ensure help explain show tell give go do redo rewrite").split(" "));
const DETERMINER = new Set("a an the this that these those my our your their its".split(" "));

/** Lower-case words of the start of a prompt. Paths become their file name, URLs and file extensions go. */
function labelWords(text) {
  const out = [];
  for (let tok of text.slice(0, LABEL_SCAN).split(" ")) {
    if (/^https?:\/\//i.test(tok)) continue;
    if (tok.includes("/") || tok.includes("\\")) tok = tok.split(/[\\/]+/).filter(Boolean).pop() || "";
    tok = tok.replace(/([\p{L}\p{N}_-])\.[a-z0-9]{1,5}(?![\p{L}\p{N}])/giu, "$1").replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").toLowerCase();
    for (let w of tok.split(/[^\p{L}\p{N}'-]+/u)) {
      w = w.replace(/^['-]+|['-]+$/g, "");
      if (w && w.length <= 24 && !/^\d+$/.test(w)) out.push(w);
    }
  }
  return out;
}

/** "Add a rate limiter to the API" → "rate limiter". Null for slash commands and empty or system-only prompts. Reads the first 1,000 characters. */
function agentLabel(prompt) {
  const { text, command } = cleanPrompt(String(prompt ?? "").slice(0, LABEL_SCAN));
  if (!text || command) return null;
  const out = [];
  let leading = true, prev = "";
  for (const w of labelWords(text)) {
    if (STOP.has(w) || out.includes(w)) { prev = w; continue; }
    if (leading && LEAD.has(w) && !DETERMINER.has(prev)) { prev = w; continue; }
    leading = false; prev = w;
    out.push(w);
    if (out.length === 3 || (out.length === 2 && out[0].length + out[1].length >= 8)) break;
  }
  return out.length ? out.join(" ") : null;
}

const norm = (p) => String(p).replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
const isWin = (p) => /^[a-z]:\//i.test(p) || p.startsWith("//");

/** Path relative to the git root: "src/Basket.tsx". Outside the root: "…/parent/file". Root itself: ".". */
function relPath(p, root) {
  if (p == null || p === "") return null;
  const P = norm(p);
  if (!/^(\/|[a-z]:\/)/i.test(P)) return P;
  if (root) {
    const R = norm(root), cmp = isWin(R) ? (x) => x.toLowerCase() : (x) => x;
    if (cmp(P) === cmp(R)) return ".";
    const pre = R.endsWith("/") ? R : R + "/";
    if (cmp(P).startsWith(cmp(pre))) return P.slice(pre.length);
  }
  const parts = P.split("/").filter(Boolean);
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : P;
}

/** What a permission request is for: "run a command", "edit a file". */
function permissionPhrase(tool) {
  const t = String(tool || "").slice(0, 200);
  if (t === "Bash" || t === "PowerShell") return "run a command";
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(t)) return "edit a file";
  if (/^(Read|Glob|Grep|LS)$/.test(t)) return "read files";
  if (t === "WebFetch") return "read a web page";
  if (t === "WebSearch") return "search the web";
  if (t === "Agent" || t === "Task") return "start a sub-agent";
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(t);
  if (m) return `use ${m[1].replace(/[_-]+/g, " ")}`;
  return "use a tool";
}

module.exports = { cleanPrompt, agentLabel, relPath, permissionPhrase, baseName };
