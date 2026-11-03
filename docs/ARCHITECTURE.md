# Architecture

```
 claude session (any machine)
   │  hook events (prompt, tools, questions, sub-agents, stop)    OpenTelemetry logs (cost, tokens)
   ▼                                                               │
 hooks/hook.js ──POST /api/events──┐                               │ POST /v1/logs (http/json)
   │ ▲ permission request: askId   │                               │
   │ ▲ Stop: the reply carries your messages from the dashboard (printed as a block)
   │ └─GET /api/decision/:askId────┤ (long-poll, up to AGENT_OFFICE_HOLD; the dashboard answers via POST /api/answer)
   │ server down?                  ▼                               ▼
   └─► ~/.agent-office/spool ──► src/server.js ◄───────────────────┘
                                   │  token check
                                   ▼
                               src/store.js ──► data/events-YYYY-MM-DD.jsonl
                                   │  change / transition events; watch() every 15 s for the alert rules
                     ┌─────────────┼───────────────┬──────────────────────┐
                     ▼             ▼               ▼                      ▼
               SSE /api/stream  src/alerts.js   /api/cost (+ CSV)   /api/agents/:id · /api/timeline · /api/board · /api/rooms · /api/machines · /api/projects
                     │          (Slack and Discord webhooks, data/alerts.json, /api/alerts)
                     ▼
     public/ (shell.js Command Center around the office3d.js 3D office; public/ui design system; public/lib/describe.js)
```

## Parts

| File | Job |
|---|---|
| `hooks/hook.js` | Runs on every Claude Code hook. Builds a small, size-bounded event (tool detail, results, git root, and its machine's send health), POSTs it, falls back to the spool, and after a quick send that went through flushes one spooled batch. Never blocks Claude and prints nothing, except a permission request (it may wait for the dashboard's answer and print it) and a Stop whose reply carries your messages (it prints them as a block); see below. |
| `hooks/text.js` | Prompt cleaning, the agent naming rule, relative paths, permission phrases. Shared by the hook and the server. |
| `hooks/install.js` | Merges our hooks and telemetry env into `~/.claude/settings.json` and removes them cleanly. The PermissionRequest hook gets `--hold=N` and a timeout of N + 10 s. |
| `src/server.js` | HTTP server: ingest, OTLP receiver, state, SSE stream, agent detail, messages to an agent or a room and an agent's name, timeline, work board, meeting hall, cost report and its CSV export, settings, machines (`GET /api/machines`: each host's hook health, as its newest event reported it) and projects (`GET /api/projects`: name, colour, roots), setup (the token and settings.json snippet), token rotation (`POST /api/token/rotate`: saved first, then the old token is refused; in team mode a new cookie for whoever rotated it and every live stream ends), the hook's decision long-poll and the dashboard's answers, login, the spool of hooks on this machine, static files. |
| `src/store.js` | In-memory state built from events: per session a trace, plan, sub-agent tree, conversation, files touched, a state-change log, cost per 10 minutes, its inbox of your messages and the name you gave it, plus open asks (in memory only); per day, spend by project, model and session, and the last 7 days of API requests for the CSV export. Appends every event to a daily file and replays them on start. |
| `src/plan.js` | The agent's plan from TodoWrite or TaskCreate / TaskUpdate, with observed start and finish times. |
| `src/timeline.js` | State-change log, state segments (offline computed), 10-minute buckets. |
| `src/otlp.js` | Turns Claude Code `api_request` log events into usage events. |
| `src/alerts.js` | The Alerts Center's engine: four rules (an agent waiting on you, again every 15 minutes; one session's cost; today's spend at a share of the daily budget and at 100%; failed tool calls in a row) checked every 15 seconds against `Store#watch`, sent to the Slack and the Discord incoming webhook (`SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL` win over the settings), each delivery kept per channel with Retry, Send test, each channel's health, and 7 days of history in `data/alerts.json` (URL fingerprints only). A rule turned on or changed starts from how things are now. |
| `src/csv.js` | CSV for spreadsheets (quoting, CRLF, a byte order mark, formula injection neutralised) and the cost report's request columns. |
| `src/config.js` | Config file, token, settings validation, the alert rules' defaults and ranges, and the move of an older single `webhookUrl` to Slack or Discord. |
| `src/demo.js` | A deterministic demo day (3 projects, 8 agents) built from raw hook payloads through the real `build()`. |
| `public/lib/describe.js` | Plain-English text for every action ("Edited Basket.tsx", "Wants permission to run a command"), icon keys, and the browser copy of `hooks/text.js`. |
| `public/ui/` | Design tokens, base components, icons, formatters (M1). |
| `public/office3d.js` | The 3D office (M3): an SVG isometric floor with a glass room per git project, characters as real buttons, pan, zoom and minimap. Pure layout and geometry in `office3d-model.js`, SVG drawing in `office3d-draw.js`. |
| `public/shell.js` | The Command Center (M4), started by `app.js`: hash router, top bar (filter chips, spend for today / 7 / 30 days), right rail (Needs you now, Today's progress, Live activity), day timeline with replay, toasts, onboarding and the answer dialog (M5). Pure data in `shell-model.js`, markup in `shell-view.js`. |
| `public/agent-detail.js` | The Agent Detail slide-over (M6), in a dialog the shell owns: opened by any `data-agent` button on any screen, or `#/<screen>?agent=<session>`. Header and facts, mission, conversation (answer or message the agent), plan, trace, files and usage. Pure data in `agent-detail-model.js`, markup in `agent-detail-view.js`. Re-renders keep focus through `public/ui/patch.js`; `public/lib/prices.js` holds the list prices behind the cache-savings estimate. |
| `public/board.js` | The Work Board (M7) at `#/board`: the auto-written daily summary with six KPIs and Copy summary, then Kanban (Planned, In progress, Needs you, Done today) from each agent's to-do list (`GET /api/board`), Projects from the snapshot, and Swimlanes from each session's state-change log (`GET /api/timeline`). A view whose data is behind is drawn as of its "As of" time. Cards and rows open the Agent Detail; the top bar's state chips dim other agents here too. Pure data in `board-model.js`, markup in `board-view.js`. |
| `public/hall.js` | The Meeting Hall (M8) at `#/hall`: room tabs, who is at the table, each room's standup written from the agents' plans and activity (`GET /api/rooms` for plan items, shared files and room messages; the snapshot for the rest), Replay standup (a bubble every 1.1 s, read out through a polite log) and Copy summary, Message the room (`POST /api/rooms/:project/message`) with a delivery line per agent, and a rail with Decisions for you, Where agents overlap and the room's scorecard. Answer and Trace open the Agent Detail at that section (`data-agent-at`). Pure data in `hall-model.js`, markup in `hall-view.js`. |
| `public/cost.js` | The Cost Report (M9) at `#/cost` (`GET /api/cost`): "Updated", a Today / 7 days switch and Export CSV (`GET /api/cost/export`, today or 7 days, saved as a file, then a toast with its name); KPI rings for today, 7 days and the month against the daily budget (× 7, × the days in the month) and what caching saved over 7 days; 14 days of bars (red only over budget, today striped "so far") with the dashed budget line and a text summary; by project, by model, cache savings (an estimate from `public/lib/prices.js`, shown with its price table and the token mix); by agent and the 5 costliest sessions, which open the Agent Detail (View trace at its trace). Pure data in `cost-model.js`, markup in `cost-view.js`. |
| `public/alerts.js` | The Alerts Center (M10) at `#/alerts` (`GET /api/alerts`, again when the live data's `alertsRev` changes): a card per channel (health, last delivery, Send test via `POST /api/alerts/test`, the webhook form via `PUT /api/alerts`), then History (7 days, filtered by type, with each delivery per channel and Retry via `POST /api/alerts/:id/retry`) or Rules (switch, number and channels per rule, saved as you change them). Open goes to the Agent Detail; budget alerts link to the Cost Report. Pure data in `alerts-model.js`, markup in `alerts-view.js`. |
| `public/settings.js` | Settings (M11) at `#/settings?section=<id>`, one section at a time from a left nav with notes ("1 offline", "1 retrying", "1 failing"): Machines (`GET /api/machines`: health pill, failed sends in the last hour, spool backlog and what a full spool dropped, Ping, Add machine; the offline timeout), Token (`GET /api/setup`; Reveal, Copy, Rotate with an inline confirm via `POST /api/token/rotate`), Budgets (daily and monthly via `PUT /api/settings`, the per-session alert via `PUT /api/alerts`), Projects (`GET /api/projects`; name and room colour via `PUT /api/settings`), Appearance (theme, reduce motion, name tags: this browser, `public/ui/prefs.js`) and Notifications (the channels from `GET /api/alerts`, desktop notifications, quiet hours). Changes save as you make them, with Saving…, Saved or why not. Pure data in `settings-model.js`, markup in `settings-view.js`. |

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

The hook adds `gitRoot` (walk up from `cwd` to a `.git` folder or file, cached 10 minutes per cwd in `spool/gitroots.json`), `os` (`process.platform`) on SessionStart, and `health` on every event while there's something to report: `fails`, the times of this machine's sends that failed in the last hour (at most 20), `backlog`, the events waiting in its spool (`more`: some not counted yet), and `dropped`, the events its spool dropped in the last day for lack of room (`droppedAt`: the latest drop; the store shows them until a day after it). A failed send is one line appended to `spool/fails.log`, so parallel hooks never lose one; past 4 KB a hook rewrites it with the newest 20 (a temp file, then a rename). The spool itself is `spool/pending.jsonl`, sealed past 256 KB into batch files of at most 500 events named with their count; files are claimed by renaming them, so parallel hooks and the server never take the same events. After each seal the hook adds up the spool's files: past 50 MB (a server that refuses every send, say after the token was rotated) it deletes the oldest batch files until they're under 45 MB, never a batch on its way or what's still to be sealed, and appends `<time> <events>` to `spool/drops.log` (past 1 KB rewritten as one line, the last day's added up). Everything is bounded: commands 500 chars, prompts 600 (cleaned before truncation), diffs 4 KB per side, output tails and last messages 1.5 KB, 50 plan items of 200 chars. Prompt cleaning reads up to 1 MB and the agent label the first 1,000 characters; every pattern is bounded so both run in linear time (a 1 MB adversarial prompt costs under 100 ms).

## Agent states

| What happened | State |
|---|---|
| `SessionStart` (not after a compaction) | idle |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart` | working |
| `PermissionRequest`; `Notification` of type `permission_prompt`, `elicitation_dialog`, `agent_needs_input`; `AskUserQuestion` | waiting (needs you) |
| `Stop`; `StopFailure` (adds a red error step); a background sub-agent finishing after the turn | idle |
| `Notification` of type `idle_prompt` from the main agent | idle: the turn is over (this covers interrupts and denials, which send no Stop) |
| `SessionEnd`, or no events for the timeout (30 min); an agent waiting on you only after 8 hours without events | offline (computed, never stored) |

A question stays open until any `PostToolUse` or `PostToolUseFailure` for the same call (the tool ran, so it was approved), an answer from the dashboard, or any later `UserPromptSubmit`, `Stop`, or `PreToolUse` from the same agent (a sub-agent's tool call doesn't answer the main agent's question). While a hook still waits on a question (an open ask), a `PreToolUse` or an `idle_prompt` doesn't close it: Claude Code is waiting for that hook, so the permission is still pending. An `idle_prompt` ends the main agent's turn: its open questions close with `resolvedBy: "turn-ended"` and no outcome, and its unfinished steps close as `unknown`. The `permission_prompt` reminder joins the open question for that call (a PermissionRequest or an AskUserQuestion) instead of adding a second one, and reopens it if a parallel tool call cleared it while the dialog was still up. A wait alerts once its question has waited past the rule's minutes, then every 15 minutes until that question is answered; a question that reopens keeps its alerts. A waiting agent stays "Needs you" through silence (people answer late); after the 30-minute timeout its question gets `stale: true` in the snapshot ("may be stale").

## Per-session data (`GET /api/agents/:id`)

- **trace**: last 1000 entries. Tool steps pair Pre/Post by `tool_use_id` (older events: oldest open call of the same tool) with start, end, `durationMs`, status `running` / `ok` / `error` / `unknown` (the turn ended with no result), detail and result. Diffs, plan lists and output are kept on the newest 200 steps, and only for 2 days. Non-tool entries: prompt, question, stop (`status: "error"` and `failure` for StopFailure), subagent start/stop, notice, session start/end. Each model call's cost is added to the step open at that time, marked `costEstimated: true`.
- **hasPlan** (snapshot): false until the agent writes a plan. Newer models only plan with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, which `agent-office install --with-plans` sets (and uninstall removes when it set it).
- **plan**: current items with `inProgressSince` / `completedAt` (only when we saw the change), and `earlier` completed items from replaced lists. Counts: `done` / `inProgress` / `pending` describe the current list; `doneToday` counts items whose `completedAt` falls on today, so items already finished when first seen never count as done today.
- **subagents**: one node per Agent/Task call, linked to `SubagentStart` by type, with status, `finishedAt`, `lastMessage`, `parentAgentId`.
- **conversation**: prompts (with `openedFile`), questions (`qkind` permission / notification / ask, status, `answeredAt`, `resolvedBy`, `outcome`), turn-finished messages, and answers from the dashboard (`kind: "answer"`, `choice` approve / session / deny / reply / auto, `text`, `delivered` once the hook picked it up). Answers are also trace entries, so the live feed shows them. A call denied from the dashboard never runs: its step closes with `status: "denied"`.
- **stateLog** and **segments**: transitions, and the computed segments including offline with `lastContact`.
- **files**: path, relative path, edits, lines added and removed, last edit, created, `createdBy` (sub-agent id).
- **mission**: the first real prompt, its time and opened file, `followUpCount` and the later prompts still kept. **usage**: cost and tokens per 10 minutes (the newest 300 buckets). **avgCost**: the average cost of the other sessions that reported any (null with fewer than 3), for "2.2× your avg".
- **conversation** also holds your messages (`kind: "message"`, status `queued` / `delivered` with `deliveredAt` / `undelivered`), and the trace an `inbox` entry where a Stop handed them over. The snapshot adds `queued` (messages waiting) and `root` (the git root, else the folder the session started in: what paths are shown relative to).

`GET /api/timeline?date=YYYY-MM-DD` returns each session's segments for that local day and 10-minute buckets that count each session once, in the state that filled most of the bucket (ties go to waiting). The SSE snapshot stays lean: per agent the project, label, question, plan counts and current step, sub-agent counts, the last 5 steps without diffs, and today's active / waited / idle time. Its totals add spend, requests and tokens for today, 7 and 30 days (`periods`), and today's plan per project (`projects`, counted like the overall done / in progress / planned). `lastEvent` is the newest event still kept (up to retention), so an empty office can tell a first run from a quiet day.

`GET /api/board` returns the work board's plan items, counted like those totals: per agent of the last 24 hours, the items it finished today (earlier lists included, with `completedAt`) and, if it was active today, its open items with their step and `inProgressSince`. The snapshot carries only `planAt` (when each plan last changed), so the board fetches the items again when a plan changes, and only while it is on screen. Its totals also carry `todayByProject` (today's spend per project, keyed like the cost report: `unknown` for a session with no folder).

`GET /api/cost` returns the cost report: spend and requests per local day (the last 14, or since the 1st once the month is longer), and for today and the last 7 days the totals, tokens by type, and spend by project (null = no folder), by model (`unknown` = not reported; a day tallies at most 50 models, the rest as `other`) and by session, costliest first (at most 50, with name, project, machine, main model, state and times; `sessionCount` and `avgCost`, null under 3). Days are calendar days, so a daylight-saving change never repeats or skips one. `GET /api/cost/export?range=today|7d` is the same data one row per API request, as CSV (`Content-Disposition` names the file, `X-Rows` counts the rows, `X-Partial: 1` when the oldest requests of the period were dropped). The server keeps requests for the export in memory for 7 days, at most 100,000, rebuilt from the saved events on start. Both need the dashboard sign-in.

## Answering from the dashboard

1. **The hook waits only when it can be answered well.** On a `PermissionRequest`, with detail capture on, for a built-in tool whose request the dashboard shows (commands, file edits and reads, searches, web; not LS), and only when the event carries the whole command or URL (500 characters) or search pattern, file filter or web query (200, on one line) exactly as given, the hook adds `hold` (seconds) to the event. The hold is the installer's `--hold=N`, lowered by `AGENT_OFFICE_HOLD`; without `--hold` (an older install, whose Claude Code timeout is 5 s) it is 0.
2. **The server opens an ask, on exactly that request's question.** `POST /api/events` with that single event calls `store.applyHeld()`: it applies the event and puts a random id (18 bytes, base64url) on the question that shows this request, and returns `{ accepted, askId }`. A PermissionRequest has no `tool_use_id`, so it is linked to the newest running call asking exactly the same thing (a hash of tool, target and the whole detail: the full command or URL, the file and its change), else one whose details agree, else the newest call of that tool not already asking (its PreToolUse may be late). It joins an existing question only when that question shows exactly the same request; joined to any other question (an AskUserQuestion, another command) it gets no ask and goes to the terminal. With no dashboard connected there is no ask either, and the event is saved as one that doesn't wait, unless the tool is allowed for this session. The snapshot offers the ask as `question.ask = { id, until }`; once it's gone, `question.windowClosed` is true. Asks live in memory only (at most 500, forgotten 10 minutes after their window).
3. **The hook long-polls** `GET /api/decision/:askId?wait=N` with the workspace token, N ≤ 25 s per request, until its hold runs out. Replies: `{ status: "pending" }`, `{ status: "answered", decision }` or `{ status: "closed" }`. Anything else, an error, or no server, and the hook exits 0 without output, so Claude Code asks in the terminal. If the hook hangs up mid-poll, the ask closes.
4. **The dashboard answers** with `POST /api/answer { askId, kind: approve | session | deny | reply, text }`: dashboard auth, the same-origin header, and on a local dashboard a local `Host`. The last 2 s of a window take no answers, so the decision always reaches a hook that is still waiting. Any waiting long-poll gets the decision at once, and handing it over is what applies it: an `answer` event (saved and replayed; hook events can't carry one) closes the question by its id. An answer the hook never picks up (it hung up, or the window passed) is dropped and the question stays open, for the terminal. On replay the saved `hold` keeps the question open through parallel calls as it was live, and an answer event closes its own question even if a replay saw it closed another way.
5. **The hook prints the decision**, built from `behavior` and `message` only: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` or `…{"behavior":"deny","message":"<your text>"}`.
6. **Allow for this session** adds the tool to the session's `allowed` list (cleared by `SessionEnd` and any `SessionStart` but a compaction). A later `PermissionRequest` for that tool whose hook waits gets no question: the store logs an `auto` answer and the ask is decided at once.

Any other way a question ends (the tool ran, a new prompt, Stop, the session ended) closes its ask, and the waiting hook exits quietly.

## Messages from the dashboard

1. **You queue it.** `POST /api/agents/:id/message { text }`: dashboard auth, the same-origin header, and on a local dashboard a local `Host`, like an answer. At most 10 wait per session, 1,000 characters each; an ended session gets 409. It is saved as a `message` event, so a restart keeps it queued.
2. **The Stop hook asks for it.** On a `Stop` with `stop_hook_active` not set, and unless `AGENT_OFFICE_INBOX=0`, the hook adds `inbox: true` to the event. Only that single event, sent to `POST /api/events`, goes through `store.applyStop()`: it applies the Stop, hands over every queued message oldest first, saves a `delivered` event stamped with server time, and the reply is `{ accepted, messages: [text…] }`. The agent goes back to working (Claude carries on). Older hooks, spooled copies, batches and Stops with `stopActive` never take messages. Each Stop without `stopActive` also records whether it asked (`takesMessages` in the snapshot: true, false, or null before any Stop), so the dashboard can warn that a machine with `AGENT_OFFICE_INBOX=0` or an older hook may never get a message. While Claude carries on with messages it just got, the snapshot's `carryingOn` is true: the Stop that ends that turn hands over nothing, so a message sent now arrives a turn later, and the dashboard says so.
3. **The hook prints them** as `{"decision":"block","reason":"New message from your lead: …"}` (several become a list), built from plain strings only, at most 10 of 1,000 characters, and exits 0. Every hook request has an absolute deadline (1.5 s for a send) besides the socket's idle timeout, so a server that trickles bytes can't hold it. A reply cut off after a 2xx status line counts as taken: the server had already applied the event, so it isn't spooled again. "Delivered" means the server handed the messages to the hook; one that dies before printing loses them (no retry).
4. **No loops:** when Claude stops again after a block, `stop_hook_active` is true, so nothing is handed over until a later Stop. `SessionEnd` marks waiting messages `undelivered`.

**A message to a room** (`POST /api/rooms/:project/message { text, sessions? }`, same rules as above) is one copy per agent of that project in the last 24 hours (`sessions` narrows it to the agents the hall shows; at most 50), through the same inboxes. An agent that can't take it now (offline, ended, or 10 already waiting) is skipped. Every copy is saved as a `message` event with the room message's random `room` id and who was skipped and why (`skipped`), so the whole delivery list survives a restart and any one copy aging out of its conversation. The hall sends at most 50 agents: the ones that can take it first. Nobody reachable is a 409. `GET /api/rooms` returns the work board's plan items, the files two or more agents of one project edited today (by their path relative to each one's root, so two clones of a repo count; files outside the project don't), and today's room messages with each copy's status. Hook events and the spool can't carry a room message any more than a plain one.

`POST /api/agents/:id/name { name }` (same-origin, and a local `Host` on a local dashboard, like messages) saves a `name` event: that session's name wins over folder aliases and `AGENT_NAME`; empty goes back to the automatic name. `message`, `name` and `release` events don't count as contact, so they never bring an offline agent back. Hook events and the spool can't carry `answer`, `message`, `delivered`, `name` or `release` events. A `release` is saved when an ask closes before its window ends while its question is still open (the hook hung up, or the ask was dropped), so a replay stops treating that question as held at the same moment.

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
