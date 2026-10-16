# Prompt 0: Design system and rules

Source spec for module **M1**. Every other module must also follow this file.

```text
You are redesigning this project's UI as "Agent Office", a 3D virtual office and command center where a CEO monitors every Claude Code session across all machines and projects. First read the codebase and tell me in 5 bullets where the UI, the hook event ingestion and the data model live. Then apply the design system below as shared tokens and components. Don't build screens yet.

GOAL: the CEO answers in 5 seconds: who is working, who is blocked and needs me, what is done, what is planned next, what it costs. Details appear only on drill-in.

DATA YOU MAY USE (nothing invented):
- Hook events per session: SessionStart, UserPromptSubmit (prompt), PreToolUse/PostToolUse (tool name + input: Bash command, file path, search pattern, URL), PermissionRequest, Notification (agent waiting for a human), Stop (last_assistant_message), SubagentStart/SubagentStop, SessionEnd, plus an inactivity timeout (30 min = offline).
- TodoWrite tool input = the agent's plan (pending / in_progress / completed). This is the only source for "planned vs done".
- Task tool + SubagentStart/Stop = sub-agents of a parent.
- OpenTelemetry api_request logs: cost_usd, input/output/cache tokens, model, session.id.
- Session info: session id, machine (hostname), git project root, cwd, start time.
- States: working, needs (waiting for you), idle (turn finished), offline.

DESIGN TOKENS (CSS custom properties; support both themes via .ao-dark / .ao-light on the root):
.ao-dark{--bg:#0A1120;--bg-2:#0F192C;--glass:rgba(15,25,44,.78);--glass-2:rgba(17,28,49,.96);--line:rgba(140,170,210,.15);--line-2:rgba(140,170,210,.30);--hover:rgba(140,170,210,.08);--text:#E8EEF8;--text-2:#AEBCD1;--text-3:#8A9BB4;--teal:#2DD4BF;--teal-t:#5EEAD4;--teal-s:rgba(45,212,191,.14);--teal-btn:#2DD4BF;--on-teal:#032622;--amber:#FBBF24;--amber-t:#FCD34D;--amber-s:rgba(251,191,36,.13);--amber-b:rgba(251,191,36,.45);--on-amber:#2A1A00;--red:#F87171;--red-t:#FCA5A5;--red-s:rgba(248,113,113,.14);--idle:#A9B6CB;--off:#8C9AAF;--code:#070D19}
.ao-light{--bg:#EDF1F7;--bg-2:#FFFFFF;--glass:rgba(255,255,255,.84);--glass-2:rgba(255,255,255,.98);--line:rgba(20,40,80,.11);--line-2:rgba(20,40,80,.22);--hover:rgba(20,40,80,.05);--text:#0E1A2E;--text-2:#3E4E66;--text-3:#55657D;--teal:#14B8A6;--teal-t:#0F766E;--teal-s:rgba(13,148,136,.11);--teal-btn:#0F766E;--on-teal:#FFFFFF;--amber:#F59E0B;--amber-t:#8A3B07;--amber-s:rgba(245,158,11,.15);--amber-b:rgba(217,119,6,.5);--on-amber:#2A1A00;--red:#DC2626;--red-t:#B91C1C;--red-s:rgba(220,38,38,.09);--idle:#52637A;--off:#5F6E84;--code:#F3F6FA}
Project room colors (never amber, orange or red): #A78BFA violet, #60A5FA sky, #A3E635 lime, #F0ABFC pink, #818CF8 indigo, #94A3B8 slate.

TYPE: Inter for UI (400/500/600/700/800, tabular numbers on). JetBrains Mono only for commands, paths, models, tokens.
Scale: page title 26/800, agent name 20/750, big number 30/800, panel title 14/650, body 14, meta 12.5 in --text-2, label 11/600 uppercase +8% letter-spacing in --text-3, mono 12.5.

SURFACES: dark navy glassmorphism panels over the 3D scene: background var(--glass), backdrop-filter blur(18px) saturate(140%), 1px var(--line) border, 14px radius, soft shadow. Buttons 34px tall, 9px radius. Primary = teal. The amber button style is used ONLY for "Answer" on needs-you items.

COLOR RULES (hard):
- Teal is the only accent (working, done, primary actions).
- AMBER ONLY means "an agent needs you". Nowhere else.
- RED ONLY for errors (failed tool calls, failing webhooks) and over-budget. Diff deletions are neutral gray strikethrough, not red.

STATE LANGUAGE (never color alone; always icon + label + place):
- Working: teal, pulse-line icon, "Working". Seated at desk, teal monitor glow, typing animation.
- Needs you: amber, raised-hand icon, "Needs you" + wait time. Walks to the "Needs You" spotlight by the entrance, raised hand, pulsing amber beacon.
- Idle: gray-blue, coffee-cup icon, "Idle". Stands in the lounge holding a cup; chair pushed out.
- Offline: gray, power icon, "Offline", dashed outline. Desk dimmed to 55%, empty chair, monitor off.

TEXT RULES:
- Agent name = "<git project folder> · <2–3 word label from the first real prompt>" (e.g. "supermarket-pos · basket bill"). Never the last cd folder (no "dist"). Editable.
- Prompts: strip <ide_opened_file>, <ide_selection>, <system-reminder>, <command-*> tags. Show the opened file as a small chip "Open in your editor: Basket.tsx".
- Paths relative to the git root. Full roots middle-truncated ("/Users/me/…/supermarket-pos") with click-to-copy.
- Tokens always one line, compact: "in 2k · out 231k · cache 34.4M".
- Commands: end-truncate with the full text on expand or in a tooltip. Prompts: 2-line clamp.
- Never show raw hook names in the UI. Map them to plain English: Bash → "Ran a command" / "Ran tests" / "Installed a package"; Edit → "Edited <file>"; Write → "Created <file>"; Read → "Read <file>"; Grep → "Searched code for "x""; WebFetch → "Read web page <host>"; WebSearch → "Searched the web for"; Task → "Started a sub-agent"; TodoWrite → "Updated the plan"; PermissionRequest → "Wants permission to run a command / edit a file"; Notification idle → "Waiting for your reply"; Stop → "Finished turn"; timeout → "Went offline · no events for 30 min".

ACCESSIBILITY: 4.5:1 text contrast in both themes (amber always carries dark text). Every control is a real button/link/input with a visible 2px teal focus ring offset 2px. Characters in the 3D office are real buttons in DOM order (Enter opens details, Esc closes panels). Charts and swimlanes get text alternatives. Respect prefers-reduced-motion. Controls grow to 44px on touch screens.

EVERY PANEL has four states: empty (icon + one-line explanation + optional action), loading (skeleton shaped like the content), error (what failed + one action, red only here), offline/stale (keep last data dimmed + "As of 15:40").

Deliver: the tokens file, the base components (glass panel, buttons, filter chip with aria-pressed, state pill, segmented control, progress bar with solid=done/striped=in progress, budget ring, path chip, code box, avatar with project color + initials, hover card), a theme toggle, and a short list of what you changed.
```

## Visual reference

`docs/redesign/reference/command-center.png` is the target look for the Command Center (dark theme, 1920×1080). Match its density, glass panels, pill shapes, icon + label state chips, amber "Needs you" cards and teal accents.
