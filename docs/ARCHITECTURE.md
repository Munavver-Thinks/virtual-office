# Architecture

```
 claude session (any machine)
   │  hook events (prompt, tool, needs-you, stop)      OpenTelemetry logs (cost, tokens)
   ▼                                                    │
 hooks/hook.js ──POST /api/events──┐                    │ POST /v1/logs (http/json)
   │ server down?                  ▼                    ▼
   └─► ~/.agent-office/spool ──► src/server.js ◄────────┘
                                   │  token check
                                   ▼
                               src/store.js ──► data/events-YYYY-MM-DD.jsonl
                                   │  change / transition / budget events
                     ┌─────────────┼───────────────┐
                     ▼             ▼               ▼
               SSE /api/stream  src/alerts.js   /api/report
                     │          (Slack/Discord)
                     ▼
     public/ (app.js + office.js canvas)
```

## Parts

| File | Job |
|---|---|
| `hooks/hook.js` | Runs on every Claude Code hook. Builds a small event, POSTs it, falls back to the spool. Never blocks Claude. |
| `hooks/install.js` | Merges our hooks and telemetry env into `~/.claude/settings.json` and removes them cleanly. |
| `src/server.js` | HTTP server: ingest, OTLP receiver, state, SSE stream, settings, login, static files. |
| `src/store.js` | In-memory state built from events. Appends every event to a daily file and replays them on start. |
| `src/otlp.js` | Turns Claude Code `api_request` log events into usage events. |
| `src/alerts.js` | Webhook messages for "needs you" and budget. |
| `src/config.js` | Config file, token, settings validation. |
| `public/office.js` | Canvas office: desks grow with agent count, people walk between desk and break area. |
| `public/app.js` | Live data, hover cards, list, rename, settings, report, desktop notifications. |

## Agent states

| Hook event | State |
|---|---|
| `SessionStart` | idle |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | working |
| `Notification` | waiting (needs you) |
| `Stop` | idle |
| `SessionEnd`, or no activity for the timeout | offline |

## Storage

Each event is one JSON line in `data/events-<date>.jsonl`. On start the server replays the last 30 days to rebuild state and totals, and deletes older files. This keeps the project dependency-free. If you outgrow it (many teams, months of history), swap `Store.persist`/`Store.replay` for SQLite or Postgres; nothing else needs to change.

## Ideas for later

- Desktop app wrapper (Electron or Tauri) with a tray icon
- Per-user accounts instead of one shared token
- Click a desk to open the folder in your editor
- Weekly email report
