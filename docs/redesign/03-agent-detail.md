# Prompt 3: Agent Detail slide-over

Source spec for module **M6**.

```text
Replace the old tooltip with an Agent Detail slide-over (760px wide, full height, from the right over a dim scrim; Esc or "Back to office" closes it). It's reused from the Command Center, Work Board, Meeting Hall and Cost Report.

HEADER: large avatar with a state badge, editable name ("supermarket-pos · basket bill", saves on Enter), state pill, git-root path chip (middle-truncated, click to copy, shows "Copied"), "working in dist/", a copy-session-id button, then a 5-column facts row: Project, Machine, Model (mono), Duration "2h 32m since 13:10", Cost "$3.84 · 2.2× your avg". Section links: Mission · Conversation · Plan · Trace · Files & usage.

MISSION: the cleaned original prompt, "You asked at 13:10", the editor-file chip, "+1 follow-up" and the follow-ups.

CONVERSATION: the you ↔ agent thread in order: your prompts (right, teal), the agent's questions (left; amber while pending), your answers ("Approved · in the terminal" or "from Agent Office"), and the agent's "Finished turn" messages (from Stop's last_assistant_message). While it waits: Approve once / Allow for this session / Deny + reply box. Otherwise a message box: "Message this agent. It gets it the next time it stops" (delivered by the Stop hook returning {"decision":"block","reason":"New message from your lead: …"}). Offline: "<machine> is offline, so messages can't reach this session right now."

PLAN (from TodoWrite): progress bar and "5 of 8 done"; rows with ✓ completed (with completion time), ◐ in progress (teal row, "since 15:14"), ○ pending (muted).

TRACE TIMELINE (the core): every step in order. Row = time | tool icon tile | plain-English title + mono target + one-line note | duration bar (sqrt scale) + "38s" | ✓/✕/live-dot status with sr text | "$0.06 · 3.9k" | chevron. Expanding a row shows a command + output tail, or a diff (+ teal lines, − gray strikethrough), or the plan. Failed rows have a red tint. A running row has a teal tint. Sub-agents are expandable nested branches with a teal tree line, their own steps, and "Finished 15:36 / Running". Waiting periods are amber dashed gaps: "Waited 4m for you · Asked permission to run npm install · You approved at 13:44". Idle periods are dotted gray gaps. Filters: segmented All / Commands / Edits / Reads / Web / Sub-agents with counts, an "Errors only" chip, and a file dropdown. Empty filter result: "No steps match these filters · Clear filters".

FILES & USAGE: files touched (relative paths, "3 edits · +71 −12 · last 15:41", "created by sub-agent", a [Steps] button that filters the trace) and a cost-per-10-minutes sparkline with peak, tokens one-liner and "Cache saved about $9.30".
```
