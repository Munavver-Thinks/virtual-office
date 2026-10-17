# Agent Office

A live pixel office for your Claude Code sessions. Every `claude` session, in any folder or on any teammate's machine, appears as a person at a desk. Hover to see what it's doing, what it costs, and whether it needs you.

- **Live office floor.** Working agents type at desks with a bubble showing the tool (Edit, Bash, Read). Agents that need you raise a "!". Idle agents rest in the break area.
- **Hover details.** Task, tool, file or command, folder, machine, model, cost, tokens.
- **Cost and tokens** per agent, per day and per project, from Claude Code's built-in OpenTelemetry.
- **Alerts.** Desktop notifications, plus Slack or Discord when an agent needs you or the daily budget is passed.
- **Cost report.** Last 14 days with a per-project breakdown.
- **Team mode.** One shared server, teammates connect with a token.
- **No dependencies.** Plain Node 18+. Data stays on your machine (or your server).

## Quick start

```bash
git clone <your-repo> && cd agent-office
npm run demo                 # fake agents at http://localhost:4380

npm run install-hooks        # connect Claude Code (backs up ~/.claude/settings.json)
npm start                    # real sessions at http://localhost:4380
```

Restart running `claude` sessions after installing. Then run `npm run doctor` to check everything is connected.

To make the `agent-office` command available everywhere: `npm link` (or `npm install -g .`).

## Commands

| Command | What it does |
|---|---|
| `agent-office start` | Start the dashboard |
| `agent-office demo` | Start with fake agents |
| `agent-office install` | Add hooks and cost tracking to Claude Code |
| `agent-office install --no-telemetry` | Hooks only, no cost tracking |
| `agent-office install --with-plans` | Also make newer models keep a to-do list, so the dashboard can show planned and done (sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`; uninstall removes it) |
| `agent-office install --url <url> --token <token>` | Send to a team server |
| `agent-office uninstall` | Remove everything from Claude Code settings (data kept) |
| `agent-office doctor` | Check hooks, telemetry and server |
| `agent-office token` | Print the access token |

## Team mode

On the server:

```bash
docker build -t agent-office .
docker run -d -p 4380:4380 -v agent-office-data:/data --name agent-office agent-office
docker exec agent-office node bin/agent-office.js token    # share this with your team
```

Or without Docker: `HOST=0.0.0.0 agent-office start`. In team mode the dashboard asks for the token.

On each teammate's machine:

```bash
agent-office install --url https://office.yourcompany.com --token <token>
```

Put the server behind HTTPS (a reverse proxy like Caddy or nginx) before using it over the internet, since the token travels with every request.

## Settings

Open **Settings** in the dashboard for daily budget, offline timeout, webhook URL and alerts. Rename an agent by clicking it in the list; the name sticks to that folder.

Environment variables: `PORT` (default 4380), `HOST` (default 127.0.0.1; use 0.0.0.0 for team mode), `AGENT_OFFICE_DIR` (default `~/.agent-office`), `AGENT_NAME` (set before starting `claude` to name that session), `AGENT_OFFICE_DETAIL=0` (send names, paths and counts only; see below).

Each agent is named "<git project folder> · <2–3 words from your first prompt>", for example "supermarket-pos · basket bill". A name you set yourself wins.

## Privacy and security

What the hook sends to your Agent Office server, per event:

- **With detail capture off, only names, paths and counts:**
  - names: the session id, machine and user name, `AGENT_NAME` if you set it, model, tool names and ids, notification and error types, how the session started and ended, the opened file's name, the slash command you typed, a 2–3 word label from your prompt (the agent's name), Claude's one-line name for each command, sub-agent and plan item, skill names and web page hosts
  - paths: the folder and git root, and the files read, edited or searched in
  - counts: lines added and removed per edit, success or failure, exit codes, durations, whether a file was created, and usage numbers from telemetry
- **With detail capture on (the default), also:** the prompt (first 600 characters, after IDE and system tags are removed), commands (first 500), search patterns, file filters and web searches, full URLs, the question text when Claude asks you something, the text of notifications (including messages from MCP servers that ask for input) and of API errors, the old and new text of each edit (up to 4 KB per side), the last 1.5 KB of command output and error text, and Claude's last message at the end of each turn (1.5 KB). Diffs and output can contain secrets from your files, such as values in a `.env` file.
- **Turn detail capture off** per machine with `AGENT_OFFICE_DETAIL=0` in the environment that starts `claude`, or `"captureDetail": false` in `~/.agent-office/config.json` on that machine (`"false"`, `0`, `"off"` and `"no"` work too).
- **How long it's kept:** data lives in `~/.agent-office/data` as daily files. Diffs and output tails are removed after 2 days, from memory and from the saved files. Everything else (names, paths, counts, plans, costs, prompts, commands and Claude's last message per turn) is deleted after 30 days.
- All writes need the token. Settings changes are protected against cross-site requests.
- Telemetry events go only to your Agent Office server, which keeps just the usage numbers. Claude Code leaves prompt text out of telemetry by default.
- Cost figures come from Claude Code's telemetry and are estimates. For billing, check your Claude Console or cloud provider.

## Troubleshooting

| Problem | Fix |
|---|---|
| No agents appear | Run `agent-office doctor`. Restart `claude` sessions after install. |
| Doctor says "Hooks are from an older version" | Run `agent-office install` again. It adds the newer hook events and keeps your own hooks. |
| Agents show no plan | Claude Code only keeps a to-do list by default on Opus 4.7, Sonnet 4.6, Haiku 4.5 and earlier. Run `agent-office install --with-plans` for newer models. |
| An agent shows "Needs you" for a long time | It stays there until you answer, the session ends, or 8 hours pass. After 30 minutes without news the question is marked as possibly stale. |
| Agents appear but cost is $0 | Cost needs telemetry. If you already send telemetry elsewhere, install warns and leaves it alone. |
| "Port already in use" | `PORT=4381 agent-office start`, then reinstall so hooks use the new port. |
| Server was down for a while | Nothing is lost. Hooks save events to `~/.agent-office/spool` and the server loads them on start. |

## Development

```bash
npm test          # Node's built-in runner, no dependencies
npm run demo
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.
