# Architecture

```
 claude session (any machine)
   │  hook events (prompt, tools, questions, sub-agents, stop)    OpenTelemetry logs (cost, tokens)
   ▼                                                               │
 hooks/hook.js ──POST /api/events──┐                               │ POST /v1/logs (http/json)
   │ server down?                  ▼                               ▼
   └─► ~/.agent-office/spool ──► src/server.js ◄───────────────────┘
                                   │  token check
                                   ▼
                               src/store.js ──► data/events-YYYY-MM-DD.jsonl
                                   │  change / transition / budget events
                     ┌─────────────┼───────────────┬──────────────────────┐
                     ▼             ▼               ▼                      ▼
               SSE /api/stream  src/alerts.js   /api/report   /api/agents/:id · /api/timeline
                     │          (Slack/Discord)
                     ▼
     public/ (app.js + office.js canvas; public/ui design system; public/lib/describe.js)
```

## Parts

| File | Job |
|---|---|
| `hooks/hook.js` | Runs on every Claude Code hook. Builds a small, size-bounded event (tool detail, results, git root), POSTs it, falls back to the spool. Never blocks Claude, never prints. |
| `hooks/text.js` | Prompt cleaning, the agent naming rule, relative paths, permission phrases. Shared by the hook and the server. |
| `hooks/install.js` | Merges our hooks and telemetry env into `~/.claude/settings.json` and removes them cleanly. |
| `src/server.js` | HTTP server: ingest, OTLP receiver, state, SSE stream, agent detail, timeline, settings, login, static files. |
| `src/store.js` | In-memory state built from events: per session a trace, plan, sub-agent tree, conversation, files touched and a state-change log. Appends every event to a daily file and replays them on start. |
| `src/plan.js` | The agent's plan from TodoWrite or TaskCreate / TaskUpdate, with observed start and finish times. |
| `src/timeline.js` | State-change log, state segments (offline computed), 10-minute buckets. |
| `src/otlp.js` | Turns Claude Code `api_request` log events into usage events. |
| `src/alerts.js` | Webhook messages for "needs you" and budget. |
| `src/config.js` | Config file, token, settings validation. |
| `src/demo.js` | A deterministic demo day (3 projects, 8 agents) built from raw hook payloads through the real `build()`. |
| `public/lib/describe.js` | Plain-English text for every action ("Edited Basket.tsx", "Wants permission to run a command"), icon keys, and the browser copy of `hooks/text.js`. |
| `public/ui/` | Design tokens, base components, icons, formatters (M1). |
| `public/office.js`, `public/app.js` | The current canvas office and list (replaced from M3). |

`hooks/text.js` and `public/lib/describe.js` hold the same four functions because the hook must stay CommonJS on Node 18 and the browser needs ES modules, with no build step. `test/describe.test.js` runs both copies over the same inputs and fails if they ever disagree.

## Hook payload fields

Checked against the Claude Code hooks reference (code.claude.com/docs/en/hooks), the tools reference, and the Agent SDK todo-tracking page on 2026-10-17. Older Claude Code versions send fewer fields, so the hook and store treat every field as optional.

| Event | Fields we read | In the docs? |
|---|---|---|
| all | `session_id`, `cwd`, `hook_event_name` | Yes |
| all (in a sub-agent) | `agent_id`, `agent_type`. Tool events fired inside a sub-agent carry them too. | Yes |
| SessionStart | `source` (`startup`, `resume`, `clear`, `compact`), `model` (optional) | Yes |
| UserPromptSubmit | `prompt`. Slash commands arrive as typed (`/deploy staging`). | Yes |
| UserPromptSubmit | `<ide_opened_file>`, `<ide_selection>`, `<system-reminder>`, `<command-*>` blocks inside `prompt` | No: added by the IDE extension and seen in practice, so we strip them |
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id` | Yes |
| PreToolUse inputs | Bash/PowerShell `command`, `description`, `run_in_background`; Edit `file_path`, `old_string`, `new_string`; Write `file_path`, `content`; Read `file_path`; Grep/Glob `pattern`, `path`, `glob`; WebFetch `url`; WebSearch `query`; Agent `description`, `subagent_type`; AskUserQuestion `questions[]` | Yes |
| PreToolUse inputs | TodoWrite `todos[]` (`content`, `status`, `activeForm`) | Yes, in the tools reference and Agent SDK page. TodoWrite is off by default since v2.1.268, so we also read TaskCreate `subject`, `activeForm` and TaskUpdate `taskId`, `status` (Agent SDK page) |
| PreToolUse inputs | MultiEdit `edits[]`, NotebookEdit `new_source`, Agent `run_in_background`, the old `Task` tool name | No: older or undocumented. Read only if present |
| PermissionRequest | `tool_name`, `tool_input`. It has **no** `tool_use_id`, so the store links it to the newest running call of that tool. | Yes |
| PostToolUse | `tool_response` (Bash `stdout`, `stderr`, `interrupted`; Write `type: "create"`; TaskCreate `task.id`), `tool_use_id`, `duration_ms` (optional) | Yes. `task.id` is from the Agent SDK page |
| PostToolUse | `exitCode`, `is_error` in `tool_response` | No: tolerated if present |
| PostToolUseFailure | `error` (Bash starts with `Exit code N`), `is_interrupt`, `duration_ms`, `tool_use_id` | Yes |
| Notification | `message`, `title`, `notification_type` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, …) | Yes. `permission_prompt` comes about 6 s after PermissionRequest; `idle_prompt` about 60 s after a turn ends |
| Stop | `last_assistant_message`, `stop_hook_active` | Yes |
| SubagentStart | `agent_id`, `agent_type` | Yes |
| SubagentStop | `agent_id`, `agent_type`, `last_assistant_message`, `stop_hook_active` | Yes |
| StopFailure | `error` (`rate_limit`, `overloaded`, `billing_error`, …), `error_details`, `last_assistant_message` (the API error text, not Claude's reply) | Yes |
| SessionEnd | `reason` | Yes |

What the docs say about when events do **not** fire, which shapes the state rules below:

- **Stop is skipped on an interrupt** (Esc). The turn just ends.
- **A denied permission fires no `PostToolUse` or `PostToolUseFailure`**, and cancelling a running tool doesn't fire `PostToolUseFailure` either.
- **StopFailure** replaces Stop when the turn ends on an API error.
- **PermissionRequest is skipped for sandbox network prompts**: those only send a `permission_prompt` Notification.
- **Task tools are model-dependent.** TodoWrite, TaskCreate, TaskUpdate, TaskList and TaskGet are on by default only for Opus 4.7, Sonnet 4.6, Haiku 4.5 and earlier models (TaskCreate/TaskUpdate, or TodoWrite with `CLAUDE_CODE_ENABLE_TASKS=0`). Newer models need `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`; without it they write no plan, so their agents show no plan items.

The hook adds `gitRoot` (walk up from `cwd` to a `.git` folder or file, cached 10 minutes per cwd in `spool/gitroots.json`). Everything is bounded: commands 500 chars, prompts 600 (cleaned before truncation), diffs 4 KB per side, output tails and last messages 1.5 KB, 50 plan items of 200 chars. Prompt cleaning reads up to 1 MB and the agent label the first 1,000 characters; every pattern is bounded so both run in linear time (a 1 MB adversarial prompt costs under 100 ms).

## Agent states

| What happened | State |
|---|---|
| `SessionStart` (not after a compaction) | idle |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart` | working |
| `PermissionRequest`; `Notification` of type `permission_prompt`, `elicitation_dialog`, `agent_needs_input`; `AskUserQuestion` | waiting (needs you) |
| `Stop`; `StopFailure` (adds a red error step); a background sub-agent finishing after the turn | idle |
| `Notification` of type `idle_prompt` from the main agent | idle: the turn is over (this covers interrupts and denials, which send no Stop) |
| `SessionEnd`, or no events for the timeout (30 min); an agent waiting on you only after 8 hours without events | offline (computed, never stored) |

A question stays open until any `PostToolUse` or `PostToolUseFailure` for the same call (the tool ran, so it was approved), or any later `UserPromptSubmit`, `Stop`, or `PreToolUse` from the same agent (a sub-agent's tool call doesn't answer the main agent's question). An `idle_prompt` ends the main agent's turn: its open questions close with `resolvedBy: "turn-ended"` and no outcome, and its unfinished steps close as `unknown`. The `permission_prompt` reminder joins the open question for that call (a PermissionRequest or an AskUserQuestion) instead of adding a second one, and reopens it if a parallel tool call cleared it while the dialog was still up. Alerts go out once per question. A waiting agent stays "Needs you" through silence (people answer late); after the 30-minute timeout its question gets `stale: true` in the snapshot ("may be stale").

## Per-session data (`GET /api/agents/:id`)

- **trace**: last 1000 entries. Tool steps pair Pre/Post by `tool_use_id` (older events: oldest open call of the same tool) with start, end, `durationMs`, status `running` / `ok` / `error` / `unknown` (the turn ended with no result), detail and result. Diffs, plan lists and output are kept on the newest 200 steps, and only for 2 days. Non-tool entries: prompt, question, stop (`status: "error"` and `failure` for StopFailure), subagent start/stop, notice, session start/end. Each model call's cost is added to the step open at that time, marked `costEstimated: true`.
- **hasPlan** (snapshot): false until the agent writes a plan. Newer models only plan with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, which `agent-office install --with-plans` sets (and uninstall removes when it set it).
- **plan**: current items with `inProgressSince` / `completedAt` (only when we saw the change), and `earlier` completed items from replaced lists. Counts: `done` / `inProgress` / `pending` describe the current list; `doneToday` counts items whose `completedAt` falls on today, so items already finished when first seen never count as done today.
- **subagents**: one node per Agent/Task call, linked to `SubagentStart` by type, with status, `finishedAt`, `lastMessage`, `parentAgentId`.
- **conversation**: prompts (with `openedFile`), questions (`qkind` permission / notification / ask, status, `answeredAt`, `resolvedBy`, `outcome`), turn-finished messages. M5 adds answers.
- **stateLog** and **segments**: transitions, and the computed segments including offline with `lastContact`.
- **files**: path, relative path, edits, lines added and removed, last edit, created, `createdBy` (sub-agent id).

`GET /api/timeline?date=YYYY-MM-DD` returns each session's segments for that local day and 10-minute buckets that count each session once, in the state that filled most of the bucket (ties go to waiting). The SSE snapshot stays lean: per agent the project, label, question, plan counts and current step, sub-agent counts, the last 5 steps without diffs, and today's active / waited / idle time.

## Storage

Each event is one JSON line in `data/events-<date>.jsonl`. On start the server replays the last 30 days to rebuild state and totals, deletes older files and drops sessions past retention. After 2 days, diffs and output tails are dropped: from steps in memory, and from the saved files, which are rewritten as `events-<date>.lite.jsonl` (plan lists stay, so plans still replay). Names, paths, counts, plans, costs, prompts and the trace stay for the full retention; a session idle for more than 2 days keeps its last 200 steps in memory.

The rewrite is crash-safe and lock-safe:
1. It writes the day's events, deduplicated and stripped, to `events-<date>.lite.jsonl.tmp`.
2. It removes the original.
3. It renames the temp file over the `.lite` file.

Replay reads a day as the union of `.lite`, `.tmp` and the original, in that order. An event found in more than one file (with or without its diffs) counts once, so an interrupted rewrite never double-counts. A late event added to an old day's original is kept. If a file is locked (EBUSY on Windows), that day is skipped with a warning and retried at the next hourly prune. Neither startup nor the timer can throw. Old (v1) event lines still replay. This keeps the project dependency-free. If you outgrow it (many teams, months of history), swap `Store.persist`/`Store.replay` for SQLite or Postgres; nothing else needs to change.

## Ideas for later

- Desktop app wrapper (Electron or Tauri) with a tray icon
- Per-user accounts instead of one shared token
- Click a desk to open the folder in your editor
- Weekly email report
