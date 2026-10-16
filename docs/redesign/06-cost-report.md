# Prompt 6: Cost Report

Source spec for module **M9**.

```text
Build the Cost Report screen from OpenTelemetry api_request data (persist per-day totals). Header: title + "updated 15:42" + Today / 7 days switch + [Export CSV] (one row per request; show a confirmation toast with the file name).

KPI tiles with rings: Today $13.72 (55% of $25), Last 7 days $84.10 (48% of $175 · 1 day over budget), Month to date $170.65 (23% of $750), Cache saved · 7 days.
Spend by day, last 14 days: bars (teal; red with "$27.40 · over" only when over budget; today striped "so far"), a dashed daily budget line labeled "budget $25", y-axis $0–$30, day labels, and a text tooltip/sr summary per bar.
Three cards: By project (horizontal bars in project colors with % share), By model (mono model names), Cache savings ("$34.50 saved by prompt caching · without cache this would have cost $X · 99.9% of input tokens were cache reads, billed at about a tenth of fresh input", plus a token mix bar and tokens one-liner).
By agent (bars, click → detail) and the Top 5 costliest sessions table: session (avatar, label, project · machine), model, duration, tokens one-liner, cost, "× vs avg", [View trace] → Agent Detail.
```
