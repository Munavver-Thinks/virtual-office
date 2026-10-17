# Agent Office redesign: workflow

The redesign is built one module at a time. The **senior-developer** agent builds each module and the **senior-reviewer** agent reviews it. The owner approves every module by hand before the next one starts. Each approved module is one local git commit.

```
senior-developer builds M<n>  →  senior-reviewer reviews the uncommitted diff
        ▲                                   │
        └── fix round (max 2) ◄── CHANGES REQUIRED (any Blocker or Major)
                                            │ PASS
main session verifies: npm test · npm run demo · curl endpoints · launch app
                                            │
             MANUAL GATE: summary posted, work stops
             "approve"     → git commit "M<n>: …" → next module
             "change: …"   → back to senior-developer
```

If Blocker or Major findings are still open after 2 fix rounds, the main session stops and asks the owner.

## Modules

| # | Module | Spec | Must be true to pass |
|---|---|---|---|
| M1 | Design system + base components | [00](00-design-system.md) | Tokens for `.ao-dark` / `.ao-light` in `public/ui/tokens.css`. Base components in `public/ui/components.js` + `components.css`: glass panel, buttons (primary teal, secondary, ghost, amber "Answer" only), filter chip (aria-pressed), state pill, segmented control, progress bar (solid done / striped in progress), budget ring, path chip (middle-truncate + copy), code box, avatar (project colour + initials), hover card. Theme toggle, saved in localStorage inside try/catch. `public/ui/gallery.html` shows every component in both themes and the 4 panel states. Existing app still works. |
| M2 | Data foundation | supports 01–08 | Hook adds: git root (walk up for `.git`, cached), `tool_use_id`, tool result ok/error + short output tail, TodoWrite todos, Task / SubagentStart / SubagentStop, PermissionRequest, Stop `last_assistant_message`. Everything size-bounded. Hook still fast and still exits 0. Store keeps per session: a bounded trace (Pre/Post paired with duration), plan, sub-agent tree, conversation, **state-change log**. New `GET /api/agents/:id` and `GET /api/timeline`. Shared ESM `public/lib/describe.js`: plain-English action mapper, prompt cleaner (strips system tags, extracts the opened-file chip), agent naming rule. Old JSONL files still replay. Demo shows 3 projects, 8 agents, 2 needs-you, sub-agents, plans, 1 offline machine, 1 failed tool call. README privacy section updated. Hook payload field names checked against current Claude Code hook docs. |
| M3 | Command Center: 3D office | [01](01-command-center.md) (3D OFFICE) | New `public/office3d.js` (SVG isometric) replaces `office.js`. 2:1 projection, 3 shaded faces, painter's sort, rooms per git root that grow with agents, all 4 state placements, Needs You spotlight queue, lounge, sub-agent interns with dashed links, meeting hall holograms, pan/zoom (0.45–2.6)/fit/minimap, HUD. Characters are real buttons in DOM order. Hover card stays 8px inside the viewport and opens on focus. Reduced motion respected. Matches `reference/command-center.png`. |
| M4 | Command Center: shell | [01](01-command-center.md) (rest) | Hash router for all screens. Top bar: nav, Alerts badge, filter chips (aria-pressed, non-matching agents dim to 16%), tokens one-liner, budget ring, Today/7d/30d, theme toggle, settings, avatar. Right rail: Needs you now, Today's progress, Live activity (aria-live). Day timeline with replay. Toast. Busy / quiet / empty-onboarding states. Rail stacks below the office under 1100px. Matches `reference/command-center.png`. |
| M5 | Answer an agent in the app | [02](02-answer-agent.md) | Asks with random askIds. `GET /api/decision/:askId` long-poll (ingest token). `POST /api/answer` (dashboard auth + same-origin header). Allow, deny-with-message, session auto-approve. No answer or server down → hook exits 0 silently. PermissionRequest hook timeout = HOLD + 10s in the installer. Answer modal per spec. Terminal fallback text. README notes the security implications. |
| M6 | Agent Detail slide-over | [03](03-agent-detail.md) | Header + facts, Mission, Conversation, Plan, Trace (filters, nested sub-agents, wait and idle gaps, expandable command/diff), Files & usage. Server inbox, delivered by the Stop hook, respecting `stop_hook_active` (no loops). Esc closes. Reusable from every screen. |
| M7 | Work Board | [04](04-work-board.md) | Summary + 6 KPIs + Copy. Kanban / Projects / Swimlanes. Swimlanes driven by the M2 state-change log. Every column has an empty state. Each swimlane row has an aria-label. |
| M8 | Meeting Hall | [05](05-meeting-hall.md) | Every line traces to real data. Replay ~1.1s per bubble. `POST /api/rooms/:project/message` queues to session inboxes. Delivery line per agent state. Decisions, overlaps, scorecard. |
| M9 | Cost Report | [06](06-cost-report.md) | KPI rings, 14-day bars (red only over budget), budget line, by project / model / agent, top-5 table, CSV export with toast. Cache savings labelled as an estimate, with the price table shown. |
| M10 | Alerts Center | [07](07-alerts-center.md) | Separate Slack and Discord URLs (migrated from `webhookUrl`; env `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL`). 4 rules with repeat behaviour. Delivery log per channel. Retry → "Delivered (retried)". Send test. |
| M11 | Settings | [08](08-settings.md) | Machines (health from hook-reported failed sends + spool backlog), token reveal/copy/rotate with confirm, daily/monthly/per-session budgets, project names + colours (6, no amber/red), appearance, notifications + quiet-hours digest. |
| M12 | Final self-review | [09](09-final-review.md) | Full Prompt 9 checklist across every screen. Every issue listed with what changed. |

## Definition of Done (senior-developer)

1. **No new npm dependencies and no build step.** Vanilla ES modules in `public/`, CommonJS in `src/` and `hooks/`. Must run on Node 18 (CI runs 18/20/22 on Linux, macOS and Windows).
2. `npm test` passes. New server, store and hook logic gets `node:test` tests in `test/`.
3. **The hook never blocks or crashes a Claude Code session.** Hard timeout, every error swallowed, always exits 0, spools when the server is down. The only allowed hold is the M5 permission long-poll, capped by `AGENT_OFFICE_HOLD`.
4. **Nothing invented.** Every number and line comes from hook events, TodoWrite, OTel or session info. Derived values (per-step cost, cache savings) are labelled "≈" / "estimate".
5. **Colour rules.** Teal is the only accent. Amber means "needs you", nothing else. Red means errors and over-budget, nothing else. Diff deletions are gray strikethrough.
6. **Text rules.** No raw hook names, absolute paths, or `<ide_…>` / `<system-reminder>` / `<command-…>` tags in the UI. Paths relative to the git root. Roots middle-truncated. Commands end-truncated. Prompts clamped to 2 lines. Tokens on one line.
7. **Every panel** has empty, loading, error and stale states. Both themes work.
8. **Accessibility.** 4.5:1 contrast, real buttons and inputs, 2px teal focus ring offset 2px, Esc closes overlays, state never shown by colour alone, `prefers-reduced-motion` respected, 44px targets on touch.
9. The module is viewable in `npm run demo`. Existing saved data and settings still load.
10. Match the existing code style: small pure functions, terse comments, no dead code, bounded memory.

## Review checklist (senior-reviewer)

| Severity | What counts |
|---|---|
| **Blocker** | Hook can block, hang or crash a session. Missing auth or CSRF check on a new write endpoint. Invented data shown as fact. `npm test` fails. Real user files touched (`~/.claude/settings.json`, `~/.agent-office`). |
| **Major** | A "must be true" item for the module is missing. Amber or red used outside its allowed meaning. Raw hook names, absolute paths or system tags in UI strings. Accessibility failure (div buttons, no aria-pressed/aria-live, no focus ring, no keyboard path, Esc doesn't close). A panel is missing a required state. |
| **Minor** | Truncation or polish gaps, small style mismatches, missing edge-case tests that aren't bugs. |

PASS = zero Blocker and zero Major.

## Safety rules for both agents

- Never edit or run the installer against the real `~/.claude/settings.json`. Tests use pure functions and temp dirs.
- For any manual run, set `AGENT_OFFICE_DIR` to a temp dir and use a free port (e.g. `PORT=4391`). Stop every server you start.
- Never commit, push, reset, stash or check out. The main session commits after the owner approves.

## Gate log

| Module | Review verdict | Fix rounds | Owner decision | Commit |
|---|---|---|---|---|
| Setup | n/a | n/a | approved 2026-10-16 | setup commit |
| M1 | PASS ([review](reviews/M1.md)) | 1 | approved 2026-10-17 | M1 commit |
| M2 | | | pending | |
