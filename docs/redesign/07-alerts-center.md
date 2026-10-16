# Prompt 7: Alerts Center

Source spec for module **M10**.

```text
Build the Alerts Center. Header: title + History / Rules tabs.
Channel cards: "Slack · #agent-office" (Healthy, last delivery, delivered count) and "Discord · #ops" (red "Failing · HTTP 404 since 15:36 · the webhook may have been deleted" + [Fix webhook]), each with [Send test].

HISTORY (last 7 days) with filter chips All / Needs you / Budget / Errors (with counts). Table: When (time + day), Type pill (Needs you amber; Over budget red; Budget warning neutral; Errors red), alert text ("refund flow has waited 3 min to edit a file" + context line), Status ("still waiting · 9m" with hand icon, or "answered after 7m"), Slack delivery (✓ Delivered 15:41), Discord delivery (✕ Failed · HTTP 404 → [Retry], which turns into "Retrying…" then "Delivered 15:43 (retried)"), and [Open] / [Cost report].

RULES: four cards, each with an on/off switch, a number input, Slack/Discord checkboxes and a note:
"Alert when an agent has waited longer than [3] minutes" (repeats every 15 min until answered), "Alert when one session costs more than $[3.50]", "Warn when today's spend reaches [80]% of the daily budget, and again at 100%", "Alert when an agent fails [3] tool calls in a row". Send alerts from the server through SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL and store delivery status.
```
