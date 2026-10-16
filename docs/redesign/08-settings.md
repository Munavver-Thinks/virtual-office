# Prompt 8: Settings

Source spec for module **M11**.

```text
Build Settings: a left section nav (Machines "1 offline", Token, Budgets, Projects, Appearance, Notifications "1 failing") and "Changes save automatically".

MACHINES: table of machine (hostname mono + OS + live sessions), hook health pill (Healthy ✓ / Retrying ↻ with "2 failed sends in the last hour" in red / Offline ⏻ "No contact since 12:05"), spool backlog bar + "143 events · queued on the machine, sends on reconnect", last event, sessions today, [Ping]. [Add machine] reveals the settings.json snippet with the workspace token.
TOKEN: masked "ao_live_Rk81••••••••3f9c", Reveal / Copy / Rotate (inline neutral confirm: "All 5 machines stop reporting until their token is updated"), created / last used.
BUDGETS: daily ($25), monthly ($750) and per-session alert ($3.50) inputs, each with a usage bar and "$13.72 spent today".
PROJECTS: per git root: display-name input, middle-truncated root chip with copy, a color radiogroup of the 6 room colors (no amber/red), "4 agents today".
APPEARANCE: Theme Dark / Light / System, Reduce motion switch, Show name tags switch.
NOTIFICATIONS: Slack webhook (masked, "Working" pill), Discord webhook (red border + "Discord says this webhook no longer exists…"), quiet hours 22:00–08:00 switch (needs-you alerts held and sent as one 08:00 digest), link to alert rules.
```
