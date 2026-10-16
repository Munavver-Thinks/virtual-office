# Prompt 2: Answer an agent in the app (two-way conversation)

Source spec for module **M5**.

```text
Add in-app answering. "Answer" on a needs-you item opens a modal titled "<label> needs you" with "project · machine · waiting 4m".

Body = a conversation:
- your original prompt as a right-aligned bubble (teal tint, "You · 11:20"),
- the agent's question as a left-aligned amber bubble with the command or file in a code box and "Working on step 3 of 6: Install the printer filter package".

Answer box (amber border): buttons [Approve once] (primary) [Allow for this session] [Deny], plus a textarea "Or reply in your own words. Your text is sent with a 'no' and the agent adjusts", with Ctrl/⌘+Enter to send and a disabled-until-typed [Send reply].

After answering: your answer appears as a bubble ("You · just now · from Agent Office: Denied: use the package without sudo"), a teal status says "<label> is working again / got your answer · Delivered to <machine>", the agent leaves the queue, its character walks back to its desk, and the feed logs it. A "Prefer the terminal?" disclosure shows `claude --resume <session>` with copy. If the in-app window has passed, or the ask came only from a Notification, say "Answer in the Claude Code terminal on <machine>" instead of showing buttons.

Wire it to the backend: on PermissionRequest the hook posts the event, gets an askId, and long-polls GET /api/decision/:askId for up to AGENT_OFFICE_HOLD seconds (default 120). The dashboard POSTs /api/answer {askId, kind: approve|session|deny|reply, text}. The hook then prints
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
or {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"<your text>"}}}.
"Allow for this session" auto-approves later requests for the same tool in that session. If nobody answers, the hook exits 0 silently so the normal terminal prompt appears. The hook must never block or crash a session.
```
