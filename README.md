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

Environment variables: `PORT` (default 4380), `HOST` (default 127.0.0.1; use 0.0.0.0 for team mode), `AGENT_OFFICE_DIR` (default `~/.agent-office`), `AGENT_NAME` (set before starting `claude` to name that session).

## Privacy and security

- Stored: the first 200 characters of each prompt, tool names, file paths or commands, and usage numbers. Nothing else from your code.
- Data lives in `~/.agent-office/data` as daily files and is deleted after 30 days.
- All writes need the token. Settings changes are protected against cross-site requests.
- Telemetry events go only to your Agent Office server, which keeps just the usage numbers. Claude Code leaves prompt text out of telemetry by default.
- Cost figures come from Claude Code's telemetry and are estimates. For billing, check your Claude Console or cloud provider.

## Troubleshooting

| Problem | Fix |
|---|---|
| No agents appear | Run `agent-office doctor`. Restart `claude` sessions after install. |
| Agents appear but cost is $0 | Cost needs telemetry. If you already send telemetry elsewhere, install warns and leaves it alone. |
| "Port already in use" | `PORT=4381 agent-office start`, then reinstall so hooks use the new port. |
| Server was down for a while | Nothing is lost. Hooks save events to `~/.agent-office/spool` and the server loads them on start. |

## Development

```bash
npm test          # 22 tests, Node's built-in runner
npm run demo
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.
