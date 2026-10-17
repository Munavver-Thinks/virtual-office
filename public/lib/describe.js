// Plain-English text for what agents do, shared by every screen. No DOM, safe to import in Node tests.
// cleanPrompt, agentLabel, relPath and permissionPhrase mirror hooks/text.js (the hook and server copy,
// which must stay CommonJS on Node 18); test/describe.test.js checks the two copies agree.
// Every pattern is bounded and runs in linear time, even on a 1 MB prompt.

const MAX_RAW = 1000000, LABEL_SCAN = 1000, FILE_SCAN = 1000;
const BLOCK = /<(ide_[a-z_]{1,40}|system-reminder|command-[a-z-]{1,40}|local-command-[a-z-]{1,40})(?=[\s>])[^<>]{0,100}>([\s\S]*?)(?:<\/\1\s{0,10}>|$)/gi;
const STRAY = /<\/?(?:ide_[a-z_]{1,40}|system-reminder|command-[a-z-]{1,40}|local-command-[a-z-]{1,40})(?=[\s>])[^<>]{0,100}>/gi;

/** Last part of a path: "src/Basket.tsx" → "Basket.tsx". */
export const baseName = (p) => String(p).split(/[\\/]+/).filter(Boolean).pop() || null;

function fileIn(body) {
  const text = body.slice(0, FILE_SCAN);
  const m = /opened the file (.+?) in the IDE/i.exec(text) || /\bfrom (\S+?):(?:\s|$)/.exec(text) ||
    /((?:[a-z]:)?[\w.~-]*[\\/][^\s"'<>]*\.\w{1,10}|[\w-]+\.\w{1,10})(?=[\s"'<>:,]|$)/i.exec(text);
  return m ? baseName(m[1].trim()) : null;
}

/** Strips IDE and system blocks. openedFile feeds the "Open in your editor: Basket.tsx" chip. */
export function cleanPrompt(raw) {
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

const STOP = new Set(("a an the and or but nor to for of in on at by with from into onto about as is are was were be been being am " +
  "it its it's this that these those there here my our your their his her me us them i you we he she they what which who whom whose " +
  "why how when where do does did done doing have has had not no yes some any all each every more most very really so than too up out " +
  "over under again same other such only own just also then if else because while should would could can will may might must shall " +
  "need needs want wants let lets let's please pls thanks thank ok okay hi hey hello now new etc e.g i.e via per").split(" "));
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

/** 2–3 word label from a prompt: "Add a rate limiter to the API" → "rate limiter". Null for slash commands and empty prompts. Reads the first 1,000 characters. */
export function agentLabel(prompt) {
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

/** "<git project folder> · <label>". An alias (set by the user) wins. */
export function agentName({ project, label, alias } = {}) {
  return alias || (project && label ? `${project} · ${label}` : project || label || "Agent");
}

const norm = (p) => String(p).replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
const isWin = (p) => /^[a-z]:\//i.test(p) || p.startsWith("//");

/** Path relative to the git root: "src/Basket.tsx". Outside the root: "…/parent/file". Root itself: ".". */
export function relPath(p, root) {
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
export function permissionPhrase(tool) {
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

// ---------- actions ----------
const TESTS = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|npm\s+t|jest|vitest|pytest|mocha|phpunit|rspec|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\w*\s+test|node\s+--test|deno\s+test|ctest|tox)\b/i;
const INSTALL = /\b(?:(?:npm|pnpm|bun)\s+(?:i|install|add|ci)|yarn\s+(?:add|install)|pip3?\s+install|uv\s+(?:add|pip\s+install)|poetry\s+add|apt(?:-get)?\s+install|brew\s+install|dnf\s+install|yum\s+install|pacman\s+-S|apk\s+add|choco\s+install|winget\s+install|cargo\s+(?:add|install)|go\s+(?:get|install)|gem\s+install|composer\s+(?:require|install)|dotnet\s+add\s+package)\b/i;

const ICON = {
  Bash: "terminal", PowerShell: "terminal", BashOutput: "terminal", KillShell: "terminal", KillBash: "terminal",
  Read: "file", Edit: "file-edit", MultiEdit: "file-edit", Write: "file-edit", NotebookEdit: "file-edit",
  Grep: "search", Glob: "search", LS: "search", WebFetch: "globe", WebSearch: "globe",
  Agent: "sub-agent", Task: "sub-agent",
  TodoWrite: "plan", TaskCreate: "plan", TaskUpdate: "plan", TaskList: "plan", TaskGet: "plan", ExitPlanMode: "plan",
  AskUserQuestion: "hand",
};

/** Icon key from public/ui/icons.js for a tool. */
export function toolIcon(tool) {
  const t = String(tool || "");
  return ICON[t] || (t.startsWith("mcp__") ? "globe" : "terminal");
}

const words = (s) => String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
const quote = (s) => `“${s}”`;

/**
 * One tool call in plain English.
 * @param {{tool: string, target?: string, detail?: object, result?: object}} step
 * @param {{root?: string, running?: boolean}} opts root = git root for relative paths; running = still going
 * @returns {{text: string, target: string|null, icon: string}}
 */
export function describeTool(step = {}, { root = null, running = false } = {}) {
  const tool = String(step.tool || ""), d = step.detail || {}, r = step.result || {};
  const icon = toolIcon(tool), say = (done, now) => (running ? now : done);
  const file = relPath(d.path || step.target, root), name = file ? baseName(file) : "a file";
  switch (tool) {
    case "Bash": case "PowerShell": {
      const cmd = d.command || step.target || "";
      const text = TESTS.test(cmd) ? say("Ran tests", "Running tests") : INSTALL.test(cmd) ? say("Installed a package", "Installing a package") : say("Ran a command", "Running a command");
      return { text, target: cmd || null, icon };
    }
    case "Read": return { text: say(`Read ${name}`, `Reading ${name}`), target: file, icon };
    case "Edit": case "MultiEdit": case "NotebookEdit": return { text: say(`Edited ${name}`, `Editing ${name}`), target: file, icon };
    case "Write":
      return r.writeType === "update" ? { text: say(`Edited ${name}`, `Editing ${name}`), target: file, icon }
        : { text: say(`Created ${name}`, `Creating ${name}`), target: file, icon };
    case "Grep": { const p = d.pattern || step.target || ""; return { text: p ? say(`Searched code for ${quote(p)}`, `Searching code for ${quote(p)}`) : say("Searched code", "Searching code"), target: p || null, icon }; }
    case "Glob": { const p = d.pattern || step.target || ""; return { text: p ? say(`Looked for files matching ${quote(p)}`, `Looking for files matching ${quote(p)}`) : say("Looked for files", "Looking for files"), target: p || null, icon }; }
    case "LS": return { text: say("Listed a folder", "Listing a folder"), target: file, icon };
    case "WebFetch": {
      let host = d.host || null;
      if (!host) { try { host = new URL(d.url || step.target).host; } catch {} }
      return { text: say(`Read web page ${host || ""}`.trim(), `Reading web page ${host || ""}`.trim()), target: d.url || step.target || host, icon };
    }
    case "WebSearch": { const q = d.query || step.target || ""; return { text: q ? say(`Searched the web for ${quote(q)}`, `Searching the web for ${quote(q)}`) : say("Searched the web", "Searching the web"), target: q || null, icon }; }
    case "Agent": case "Task": {
      const what = d.description || step.target;
      return { text: say("Started a sub-agent", "Running a sub-agent") + (what ? `: ${what}` : ""), target: d.subagentType || null, icon };
    }
    case "TodoWrite": case "TaskCreate": case "TaskUpdate": return { text: say("Updated the plan", "Updating the plan"), target: d.subject || null, icon };
    case "TaskList": case "TaskGet": return { text: say("Checked the plan", "Checking the plan"), target: null, icon };
    case "ExitPlanMode": return { text: say("Proposed a plan", "Proposing a plan"), target: null, icon };
    case "AskUserQuestion": return { text: "Asked you a question", target: d.question || null, icon };
    case "BashOutput": return { text: say("Checked a running command", "Checking a running command"), target: null, icon };
    case "KillShell": case "KillBash": return { text: say("Stopped a running command", "Stopping a running command"), target: null, icon };
    case "Skill": return { text: say("Used a skill", "Using a skill"), target: step.target || null, icon };
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(tool);
      if (m) return { text: say(`Used ${words(m[1])}: ${words(m[2])}`, `Using ${words(m[1])}: ${words(m[2])}`), target: step.target || null, icon };
      return { text: say(`Used ${words(tool) || "a tool"}`, `Using ${words(tool) || "a tool"}`), target: step.target || null, icon };
    }
  }
}

/** A question an agent is waiting on: "Wants permission to run a command". */
export function describeQuestion(q = {}) {
  if (q.qkind === "permission") return `Wants permission to ${permissionPhrase(q.tool)}`;
  if (q.qkind === "ask") return "Asked you a question";
  if (q.notificationType === "idle_prompt") return "Waiting for your reply";
  return "Needs your input";
}

// StopFailure error types in plain English.
const FAILURE = {
  rate_limit: "hit the rate limit", overloaded: "the API was overloaded", authentication_failed: "sign-in failed",
  oauth_org_not_allowed: "this organisation isn't allowed", account_on_hold: "the account is on hold", billing_error: "a billing problem",
  invalid_request: "the request was rejected", model_not_found: "the model wasn't found", server_error: "an API server error",
  max_output_tokens: "the reply hit its length limit", cloud_credential_error: "cloud credentials failed",
};

/** "Went offline · no events for 30 min" */
export const offlineText = (minutes = 30) => `Went offline · no events for ${minutes} min`;

/**
 * Any trace entry (tool, prompt, question, stop, subagent, notice, session) in plain English.
 * @returns {{text: string, target: string|null, icon: string}}
 */
export function describeStep(x = {}, { root = null } = {}) {
  switch (x.kind) {
    case "tool": return describeTool(x, { root, running: x.status === "running" });
    case "prompt": return { text: x.command ? "Ran a slash command" : "You sent a prompt", target: x.command || null, icon: "chat" };
    case "question": return { text: describeQuestion(x), target: x.target || null, icon: "hand" };
    case "stop":
      return x.status === "error" ? { text: `Stopped: ${FAILURE[x.failure] || "the API returned an error"}`, target: null, icon: "alert" }
        : { text: "Finished turn", target: null, icon: "check" };
    case "subagent": {
      const what = x.description || x.agentType;
      return { text: (x.phase === "stop" ? "Sub-agent finished" : "Started a sub-agent") + (what ? `: ${what}` : ""), target: null, icon: "sub-agent" };
    }
    case "notice": return { text: x.notificationType === "idle_prompt" ? "Waiting for your reply" : "Sent a notification", target: null, icon: "bell" };
    case "session": return { text: x.phase === "end" ? "Ended the session" : "Started a session", target: null, icon: "power" };
    case "offline": return { text: offlineText(x.minutes), target: null, icon: "power" };
    default: return { text: "Did something", target: null, icon: "pulse" };
  }
}
