# Prompt 4: Work Board

Source spec for module **M7**.

```text
Build the Work Board screen (what's done and what's planned, across all agents). Header: "Work board" + "From every agent's own to-do list · <date>" + a segmented switch Kanban / Projects / Swimlanes.

DAILY SUMMARY card (auto-written): "8 agents across 3 projects completed 26 of 50 planned tasks, spent $13.72 (55% of the $25 budget) and waited on you 52 min. Right now 2 are waiting for you, and <agent> has been offline since 12:05." Plus 6 KPI tiles (Done, In progress, Needs you, Planned, Waited on you, Spend) and [Copy summary].

KANBAN: four scrollable columns: Planned (pending items), In progress (one per agent; "stalled · offline" if its agent is offline), Needs you (in-progress items of waiting agents, amber cards, "waiting 9m"), Done today (newest first, "done 15:12"). Card = 2-line task text, agent avatar + "project · label", meta with icon. Clicking a card opens that agent's Agent Detail. Each column has an empty state.

PROJECTS: one card per project: name + color, "last activity", goal = its agents' missions (2-line clamp each), progress bar, spend today, waited on you, and the agent list with state pills and cost (click → detail).

SWIMLANES: one row per agent over 08:00–16:00. Segments: working = solid teal (label the duration when ≥60m), waiting on you = hatched amber ("waited 12m"), idle = dotted gray ("idle 50m"), offline = dashed outline ("offline since 12:05"), a now line, and row totals "active · waited · idle". Legend with icons. Each row has an aria-label summary. Record a per-session state-change log on the server to drive this.
```
