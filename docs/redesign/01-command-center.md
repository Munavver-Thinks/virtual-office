# Prompt 1: Command Center (main screen)

Source spec for modules **M3** (3D office) and **M4** (shell: top bar, right rail, timeline, toast, states).
Visual target: `docs/redesign/reference/command-center.png`.

```text
Build the Command Center screen using the Agent Office design system already in this project. Layout at 1920×1080: top bar, then the 3D office (65% width) beside a right rail (35%), then a day timeline at the bottom. At <1100px the rail stacks under the office.

TOP BAR: logo + "Agent Office"; nav (Office, Work board, Meeting hall, Cost report, Alerts with an amber count badge); four status chips Working / Needs you / Idle / Offline with live counts that act as filters (aria-pressed; non-matching agents dim to 16% in the office); tokens one-liner; today's cost with a budget ring (teal, red only when over 100%) and "55% of $25 today"; Today / 7d / 30d segmented switch; theme toggle; settings; avatar.

3D OFFICE: stylized isometric low-poly (Two Point Hospital / Monument Valley feel), soft lighting, real soft shadows, subtle ambient motion. Draw it as SVG polygons with 2:1 isometric projection (x→(28,14), y→(-28,14), z→(0,-30) px), three shaded faces per box (top 1.0, left 0.8, right 0.63), painter's sort by x+y, and a blur filter for shadows/glows.
- A floating floor slab. Each git project is a glass-walled room (glass walls at 13% opacity, colored rim in the project color, mullions every 2.4 units) labeled with a clickable glass label "supermarket-pos · 4 agents". Rooms grow with agent count (2.4 units per desk). No empty desks.
- Each agent: low-poly character at a desk (shirt = project color, octagon head with a lit facet, hair cap, two eye pixels). The monitor's top edge glows teal (working) or amber (needs you), and a small floating badge above the monitor shows the current tool icon (terminal, file, search, globe, sub-agent).
- Name tag above each character: [state icon] label (+ "· 9m" for needs-you, amber pill). Hover/focus → hover card; click → Agent Detail.
- Needs you: character stands in the amber "Needs You" spotlight (glowing floor disc + lamp + "NEEDS YOU · 2" sign) near the entrance, in a queue ordered by longest wait, hand raised and waving, amber halo pulsing.
- Idle: character stands in the lounge (rug, sofa, coffee table, coffee machine with rising steam, plants that sway) holding a cup, bobbing slowly.
- Offline: desk dimmed, empty chair, monitor off, dashed name tag.
- Sub-agents: smaller "intern" characters at a side table in the parent's room with glowing laptops (closed laptop when finished), linked to the parent's head by a thin animated dashed teal line.
- Meeting hall: a teal glass room with a long table, 8 chairs and a glowing wall screen. Every active agent sits there as a translucent project-colored hologram (they keep working at their desks). Its label links to the Meeting Hall screen.
- Controls: drag to pan, wheel to zoom (0.45–2.6), zoom +/–/fit buttons, click a room label to zoom into it, a minimap bottom-left with a viewport rectangle. HUD top-left: "● Live · 3 rooms · 8 agents".
- Hover card: max 280px, shows name, project · machine, state pill, current action in plain English with mono target, plan progress bar "5/8", cost. Place it above the agent; flip below if it would cross the top; clamp 8px inside the office viewport on every side; also opens on keyboard focus.

RIGHT RAIL:
1. "Needs you now" queue, longest wait first. Card: avatar, agent label, project · machine, amber "waiting 9m" pill, the question in plain English ("Wants permission to edit a file"), the target in a code box, "Working on: <in-progress plan step>", buttons [Answer] (amber) and [Jump] (zooms the office to that agent and pulses its tag). Empty: teal check "Nobody is waiting on you".
2. "Today's progress": big "26 of 50 planned tasks done", segmented bar (done solid teal, in progress striped), legend with ✓ ◐ ○ icons, one row per project with its bar and "14/25", plus "Waited on you 52m today".
3. "Live activity": plain-English feed grouped per agent (avatar, label, project, state pill, last 3 actions with icon, mono target, time), newest first, aria-live log.

BOTTOM: day timeline 08:00–16:00. A ribbon of 10-minute buckets stacked working (teal) / needs you (hatched amber) / idle (gray), a "now" marker, and a range slider that replays the office at any past moment ("Replaying 11:40 · Back to live").

TOAST: when an agent starts waiting, show an amber toast top-right in the office: "receipt printer needs you · Wants permission to run a command" [Open] [Dismiss].

STATES: busy (many agents), quiet (1 agent: only its room, nobody in the spotlight), empty (onboarding card in the office: 1. copy workspace token, 2. add the hook to ~/.claude/settings.json (show the snippet), 3. "Listening for the first event…" with a pulsing dot; rail panels show their empty states).
```
