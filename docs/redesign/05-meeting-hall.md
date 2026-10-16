# Prompt 5: Meeting Hall standups

Source spec for module **M8**.

```text
Build the Meeting Hall screen: each room's standup, written by Agent Office from each agent's plan and activity (agents don't talk to each other; every line must trace to real data).

Header: "Meeting hall" + room tabs (All rooms / one per project, with color dots) + [Replay standup] + [Copy summary].
"At the table" strip: every agent in the room as a pill (avatar with a soft hologram glow, label, state icon); offline ones at 60% opacity; the current speaker marked "speaking" during replay.

Transcript (aria-live log):
- Agent Office (host) opens: "Standup for checkout-api · 3 agents. 9 of 20 planned tasks are done, $3.63 spent, and agents have waited on you 32m today."
- Then one bubble per agent with rows: ✓ Done (last 2 completed items + "+N more"), ◐ Now (in-progress item), ✋ Blocked (amber; question + target + wait) or ⏻ Blocked (offline machine) or ☕ Waiting (idle), sub-agent Team line, ○ Next (first pending). It also shows a state pill, "tasks · cost", and [Answer] (amber, only when blocked) + [Trace].
- The host closes with the decisions waiting on you and file overlaps.
Replay reveals bubbles one at a time (~1.1s) with a "<name> is up next" typing indicator.

Message the room: a textarea + "Send to N agents". Your message appears as a bubble with per-agent delivery lines: waiting → "got it now", working → "gets it when it next stops", idle → "gets it as its next prompt", offline → "gets it when <machine> reconnects". Backend: POST /api/rooms/:project/message queues it into each session's inbox; the Stop hook delivers it.

Right rail: "Decisions for you" (blocked agents with [Answer] → Agent Detail at the conversation, turning to "Approved once" after), "Where agents overlap" (same file edited by two agents today; same machine, flagged red only if that machine has failed sends), and a room scorecard (tasks done, spend, waited on you, blocked now).
```
