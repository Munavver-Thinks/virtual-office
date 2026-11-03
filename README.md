# Virtual Office

A live pixel office for your Claude Code sessions. Every `claude` session, in any folder or on any teammate's machine, appears as a person at a desk. Hover to see what it's doing, what it costs, and whether it needs you.

- **Live office floor.** Working agents type at desks with a bubble showing the tool (Edit, Bash, Read). Agents that need you raise a "!". Idle agents rest in the break area.
- **Hover details.** Task, tool, file or command, folder, machine, model, cost, tokens.
- **Answer from the dashboard.** When an agent asks for permission, approve it once, allow it for the session, deny it, or reply in your own words, without going to its terminal.
- **Agent detail.** Click any agent for its mission, your conversation with it, its plan, a step-by-step trace (sub-agents, waits for you, failed commands with their output, diffs) and the files it touched and what it cost. Message it from there: it gets your message the next time it stops.
- **Work board.** Today across all agents: a written summary you can copy, with done, in progress, needs you, planned, time waited on you and spend. Then every agent's to-do list as a Kanban (planned, in progress, needs you, done today), a card per project, and a swimlane per agent showing when it worked, waited on you, idled or went offline.
- **Meeting hall.** Each project's standup, written from every agent's own plan and activity: what it finished, what it's on, what blocks it and what's next. Replay it one speaker at a time, copy it, answer the decisions waiting on you, see which files two agents both edited today, and message the whole room at once.
- **Cost and tokens** per agent, per day and per project, from Claude Code's built-in OpenTelemetry.
- **Alerts.** Desktop notifications, plus Slack and Discord when an agent has waited on you too long, a session costs too much, today's spend nears the daily budget, or an agent's tool calls keep failing. The Alerts Center shows each alert's delivery per channel, with Retry and Send test.
- **Cost report.** Today, the last 7 days and the month so far against your daily budget, spend per day for 14 days, spend by project, model and agent, the 5 costliest sessions, and about what prompt caching saved (an estimate, shown with the list prices it uses). Export CSV gives one row per API request.
- **Team mode.** One shared server, teammates connect with a token.
- **No dependencies.** Plain Node 18+. Data stays on your machine (or your server).

## Quick start

```bash
git clone https://github.com/Munavver-Thinks/virtual-office.git && cd virtual-office
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
| `agent-office demo --scene quiet` | The demo with one agent; `busy` has 24 agents, `empty` none (the setup steps) |
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

Open **Settings** (the sliders button in the top bar). A nav on the left picks a section (`#/settings?section=<name>`), with notes like "1 offline" or "1 failing". Changes save as you make them; a change the server refuses says why next to the field and keeps what you typed.

- **Machines:** every machine that reported in the last 7 days: its name, OS and live sessions, and its hook's health as its newest event reported it. **Healthy**; **Retrying** with "2 failed sends in the last hour" in red, or while events wait in its spool; **Offline** with "No contact since 12:05" once it has no live session and nothing came for the offline timeout. The spool line says how many events wait on that machine; they go out with its next events once the server answers. A machine's spool keeps at most 50 MB: past that its oldest events are dropped, and the spool line says how many in red ("3,000 events dropped when its spool was full") for a day after the latest drop. **Ping** checks when the server last heard from a machine (the server can't reach machines; their hooks only send). **Add machine** shows the install command and the `settings.json` snippet, the token masked (Copy carries it whole). The offline timeout (minutes) is here too.
- **Token:** the workspace token, masked, with **Reveal**, **Copy** and **Rotate**, when it was created and when a hook or telemetry last used it (since the server started). Rotate asks first and says what it stops. See the note on rotating below.
- **Budgets:** the daily budget (the top bar's ring and the budget alert), the monthly budget (the cost report's month tile; 0 = the daily budget × the days in the month) and the per-session alert (the Alerts Center's session rule), each with what it used so far.
- **Projects:** a display name and a room colour per git folder (6 colours; amber and red are kept for "needs you" and errors). Every screen uses the name; renaming keeps the colour. Empty goes back to the folder's name.
- **Appearance:** theme (Dark, Light or System), Reduce motion and Show name tags, saved in this browser.
- **Notifications:** Slack and Discord as the Alerts Center sees them (changed there), desktop notifications when an agent needs you, and **quiet hours** (22:00–08:00 by default, off until you turn them on, by the server's clock). In quiet hours "needs you" alerts to Slack and Discord are held, without reminders, and go out as one digest per channel when they end, saying what became of each; desktop notifications pause too. Budget, cost and error alerts still go out.

**Rotating the token** takes effect at once. Every machine still using the old one is refused: its hooks keep their events in their spool (nothing reaches the server, so after the offline timeout Machines shows it offline; past 50 MB the oldest are dropped) until you run `agent-office install --url <url> --token <new token>` there; then the spooled events follow. Hooks on the computer that runs the server read the token from its `~/.agent-office/config.json` and switch by themselves; its cost tracking (telemetry carries the token in `~/.claude/settings.json`) stops until you run `agent-office install` again. In team mode everyone signed in must sign in again with the new token, and every open dashboard's live updates are cut off; the browser that rotated it gets the new sign-in. Rotate it whenever it may have leaked: anyone who can open the dashboard can read it. Rotating needs the dashboard's own page and, on a local dashboard, a local host name.

Rename an agent in its detail (click it in the office or in Live activity, edit the name at the top, press Enter); the name sticks to that session. Leave it empty to go back to the automatic name.

Environment variables: `PORT` (default 4380), `HOST` (default 127.0.0.1; use 0.0.0.0 for team mode), `AGENT_OFFICE_DIR` (default `~/.agent-office`), `SLACK_WEBHOOK_URL` and `DISCORD_WEBHOOK_URL` (the alert webhooks, read when the server starts; they win over the ones set in the dashboard, which then can't change them), `AGENT_NAME` (set before starting `claude` to name that session), `AGENT_OFFICE_DETAIL=0` (send names, paths and counts only; see below), `AGENT_OFFICE_HOLD` (seconds a permission request waits for an answer in the dashboard, default 120, at most 600; `0` = answer in the terminal only; see below), `AGENT_OFFICE_INBOX=0` (sessions on this machine never take messages from the dashboard; see below).

## The Alerts Center

Open **Alerts** in the top bar. At the top, a card per channel: **Slack** and **Discord**, each with its own incoming webhook (a single webhook URL from an older version moves to the one its address belongs to). A card says whether the channel is healthy, when it last delivered and how many alerts it delivered in 7 days, or that it's failing, since when, and what that may mean ("HTTP 404 · the webhook may have been deleted"). **Send test** posts a test message; **Fix webhook** (or **Set up**, **Change webhook**) takes a new URL and an optional channel name for the card. The server only ever shows a webhook masked (`hooks.slack.com/…k3Vd`).

**History** lists the last 7 days of alerts, filtered by type (Needs you, Budget, Errors), with what happened since (still waiting · 9m, answered after 7m, working again) and each channel's delivery: Delivered 15:41, or Failed · HTTP 404 with **Retry**, which turns into "Delivered 15:43 (retried)" once it goes through. **Open** shows the agent; **Cost report** the spend.

**Rules** has four, each with an on/off switch, its number, and which channels it sends to. Changes save as you make them.

- An agent has waited on you longer than **3** minutes. It repeats every 15 minutes until the agent is answered.
- One session costs more than **$3.50**. Once per session; raise the limit and it alerts again past the new one.
- Today's spend reaches **80%** of the daily budget, and again at 100%. Once each a day.
- An agent fails **3** tool calls in a row. A sub-agent's calls are counted on their own, and a call you interrupted doesn't count either way. Once per run of failures; it counts again after a call of that agent works.

The server checks the rules every 15 seconds, whether or not a dashboard is open, and sends from the server itself. A rule you turn on or change starts from how things are now: a session already over the new limit doesn't alert at once (a wait already over its minutes does, since it still needs you).

## The agent detail

Click an agent in the office, its name in Live activity or the meeting hall, or open `#/<screen>?agent=<session id>` on any screen. The panel slides in from the right; Esc or **Back to office** closes it. It shows:

- **Header:** the name (edit it and press Enter), state, project root (click to copy), the folder it's working in, Copy session ID, and project, machine, model, how long it has run and what it cost compared with your other sessions.
- **Mission:** your first prompt, when you asked it, the file open in your editor, and your follow-ups.
- **Conversation:** your prompts and messages, its questions (amber while they wait on you), your answers (from here or in the terminal) and what it said at the end of each turn. While it needs you, the answer buttons are right there.
- **Plan:** its to-do list, with when each item was done or started.
- **Trace:** every step in order, with how long it took and what it cost (≈, an estimate per step), sub-agents as nested branches, the time it waited for you and idle spells. Expand a step for the full command and the end of its output, or the diff. Filter by commands, edits, reads, web or sub-agents, failed steps only, or one file.
- **Files & usage:** the files it edited (Steps filters the trace to one), cost per 10 minutes, tokens, and about how much the prompt cache saved (an estimate from list prices; the panel says how it's worked out).

### Messaging an agent

Type in **Message this agent** and send. The message waits until the agent stops (its turn ends); then its Stop hook hands it over and Claude carries on with it, as if you had said "New message from your lead: …". An agent that is working gets it when its current turn ends; an idle one only after its next turn, so for an idle agent the terminal is quicker. At most 10 messages wait per agent, up to 1,000 characters each. Waiting messages survive a server restart; if the session ends first they are marked "Not delivered". An offline machine can't be messaged.

The hook never hands over messages while Claude is already carrying on because of a Stop hook (`stop_hook_active`), so a message can't keep an agent going in a loop; anything sent meanwhile waits for its next stop. Only this version of the hook asks for messages, so an older hook never takes one it can't deliver; when an agent's last stop didn't ask (an older hook, or `AGENT_OFFICE_INBOX=0` on its machine), the message box says it may never get your message.

## The meeting hall

Open **Meeting hall** in the top bar and pick a room (one per git project) or All rooms. Agents don't talk to each other: Virtual Office writes each line from what it already knows. The host opens with the room's tasks done, spend and time waited on you today. Then each agent: **Done** (the last two items it finished today), **Now** (the step in progress, or what it's doing), **Blocked** (a question waiting on you, or its machine went offline), **Waiting** (idle, with the last thing it said), **Team** (sub-agents) and **Next** (its first step not started). The host closes with the decisions waiting on you and the files more than one agent edited today. **Replay standup** reveals it one speaker at a time; **Copy summary** copies it as text.

The rail lists **Decisions for you** (Answer opens that agent's conversation; once the answer arrives the row says what you decided), **Where agents overlap** (the same file edited by two agents today, compared by its path in the project, and agents sharing a machine) and the room's scorecard.

**Message the room** sends your message to every agent at the table, as if you messaged each one: each gets it the next time it stops. Before you send, and on your message afterwards, a line per agent says where it stands: a working agent gets it when this turn ends, one waiting on you after you answer and its turn ends, an idle one after its next turn; an offline machine or an ended session can't get it, and the line says so.

## Answering an agent

Press **Answer** on a "Needs you" card or toast. The dialog shows your prompt, the agent's question with the command or file, and its plan step. Choose **Approve once**, **Allow for this session**, **Deny**, or type a reply: your text goes to the agent with a "no", and it adjusts. Ctrl+Enter (⌘+Enter on a Mac) sends the reply. The dialog then says when the answer was delivered.

How it works: on a permission request the hook sends the request and waits up to `AGENT_OFFICE_HOLD` seconds for your answer. If nobody answers, or the server is down, the hook ends quietly and Claude Code asks in the terminal as usual. If nobody has the dashboard open, the hook doesn't wait at all, except for a tool you allowed for the session. Your answer takes effect when the hook picks it up, which a waiting hook does at once; if it never arrives, the agent stays on "Needs you" and the terminal asks. Questions that only the terminal can answer (Claude asking you something, plan approval, sub-agents, MCP tools, or a command or search too long to show in full) say "Answer in the Claude Code terminal on <machine>" instead.

- While the hook waits, Claude Code doesn't show its own prompt in the terminal yet. If you mostly answer in the terminal, set a shorter wait (`AGENT_OFFICE_HOLD=20`) or `0`.
- To wait longer than 120 seconds, set `AGENT_OFFICE_HOLD` before running `agent-office install`. The installer gives Claude Code's hook timeout 10 seconds more than the wait, and the hook never waits longer than the installer set up. Installs from before this feature never wait: run `agent-office install` again (`agent-office doctor` reports them as outdated).

Each agent is named "<git project folder> · <2–3 words from your first prompt>", for example "supermarket-pos · basket bill". A name you set yourself wins.

## Privacy and security

What the hook sends to your Virtual Office server, per event:

- **With detail capture off, only names, paths and counts:**
  - names: the session id, machine and user name, the machine's operating system (`os`, with SessionStart only), `AGENT_NAME` if you set it, model, tool names and ids, notification and error types, how the session started and ended, the opened file's name, the slash command you typed, a 2–3 word label from your prompt (the agent's name), Claude's one-line name for each command, sub-agent and plan item, skill names and web page hosts
  - paths: the folder and git root, and the files read, edited or searched in
  - counts: lines added and removed per edit, success or failure, exit codes, durations, whether a file was created, and usage numbers from telemetry
  - the machine's sends (`health`, with every event while there's something to report): the times of its sends to the server that failed in the last hour (at most 20), how many events wait in its spool, and how many events its spool dropped in the last day because it passed 50 MB, with the time of the latest drop. Settings shows them as each machine's hook health.
- **With detail capture on (the default), also:** the prompt (first 600 characters, after IDE and system tags are removed), commands (first 500), search patterns, file filters and web searches, full URLs, the question text when Claude asks you something, the text of notifications (including messages from MCP servers that ask for input) and of API errors, the old and new text of each edit (up to 4 KB per side), the last 1.5 KB of command output and error text, and Claude's last message at the end of each turn (1.5 KB). Diffs and output can contain secrets from your files, such as values in a `.env` file.
- **Turn detail capture off** per machine with `AGENT_OFFICE_DETAIL=0` in the environment that starts `claude`, or `"captureDetail": false` in `~/.agent-office/config.json` on that machine (`"false"`, `0`, `"off"` and `"no"` work too).
- **How long it's kept:** data lives in `~/.agent-office/data` as daily files. Diffs and output tails are removed after 2 days, from memory and from the saved files. Everything else (names, paths, counts, plans, costs, prompts, commands and Claude's last message per turn) is deleted after 30 days.
- All writes need the token. Settings changes and answers are protected against cross-site requests and, on a local dashboard, against web pages that point their own name at your computer.
- **Answering runs commands on the agent's machine.** Approving a request lets Claude Code run that command or edit that file on its machine, as the user running `claude`. Keep that in mind for who can open your dashboard:
  - **Who can answer:** anyone who can open the dashboard. On a local dashboard (the default) that is anything on this computer that can reach `127.0.0.1:4380`, including other user accounts on a shared computer. Answers must come from the dashboard's own page (a same-origin header) under a local host name, so other web pages, including ones that point their own name at your computer, can't answer. In team mode, anyone signed in can answer for every machine that reports to the server. To keep a machine's requests in its terminal, set `AGENT_OFFICE_HOLD=0` there.
  - **What an answer can do:** only allow, or deny with a message, and only for the request the dialog shows: an answer is tied to the question raised by that exact request (the whole command, URL or file change, not just its first 140 characters), and a request that can't be told apart from another is left to the terminal. The hook builds its reply to Claude Code itself and ignores anything else the server sends, so a server can't change the command. "Allow for this session" approves every later request for the same tool in that session without asking (for commands: any command) until the session ends or restarts, and only while the hook is waiting.
  - **What you see first:** in-app answering is offered only with detail capture on, and only when the event carries the whole command or URL (500 characters) or search pattern, file filter or web query (200 characters, on one line) exactly as given, so you never approve a part you can't see. For a file edit the dialog shows the file and how many lines change, not the change itself; check the terminal if that matters.
  - **Ask ids:** each waiting request gets a random 144-bit id. The hook long-polls `GET /api/decision/<id>` with the workspace token; a dashboard sign-in isn't enough. Ids live in the server's memory only, stop working when the hook stops waiting, and are never saved. Hook events can't carry answers: only `POST /api/answer` from the dashboard can.
  - **What's kept:** your answers, including reply text (up to 1,000 characters), are saved with the events and deleted after 30 days.
- **Messages tell an agent what to do.** Claude reads a message from the dashboard as an instruction from you and acts on it with the session's own permissions; its permission prompts still apply to whatever it then tries.
  - **Who can message:** the same people who can answer. Messages, and renaming an agent, must come from the dashboard's own page (a same-origin header) and, on a local dashboard, under a local host name. In team mode anyone signed in can message any session that reports to the server. To keep a machine's sessions closed to messages, set `AGENT_OFFICE_INBOX=0` in the environment that starts `claude` there.
  - **A message to a room** (Meeting hall) is one message per agent of that project, under the same rules, reaching at most 50 agents. Offline machines, ended sessions and agents with 10 messages already waiting are skipped, and the hall says so.
  - **Only the dashboard:** hook events and the spool can't carry messages, deliveries, names or answers; the server drops them. The hook builds what it prints itself (`{"decision":"block","reason":"New message from your lead: …"}`) from plain text only, so a server can't make it print anything else.
  - **What's kept:** message text is saved with the events and deleted after 30 days. "Delivered" means the agent's Stop hook received it from the server.
- The dashboard can read the workspace token from the server at any time (`GET /api/setup`), and shows it, masked with a Copy button, in the setup steps of an empty office. On a local dashboard the server only answers same-origin requests whose host is `localhost`, `127.0.0.1` or `[::1]`, so a web page that points its own name at your computer can't fetch it; in team mode it answers anyone signed in. Anyone who can open your dashboard can therefore get the token.
- Telemetry events go only to your Virtual Office server, which keeps just the usage numbers. Claude Code leaves prompt text out of telemetry by default.
- Cost figures come from Claude Code's telemetry and are estimates. For billing, check your Claude Console or cloud provider. What the cache saved is a further estimate from list prices, and the cost report says so.
- **Alerts leave your server.** Each alert sent to Slack or Discord carries the agent's name, project and machine, and, depending on the rule, the command or file (relative to the project) it waits on or that failed last, a session's cost, or today's spend. The alert history in `~/.agent-office/data/alerts.json` keeps the same for 7 days, with only a fingerprint of each webhook URL. The URLs themselves are in `config.json` (readable by your user only) or the environment, and the dashboard only ever shows them masked. Changing a webhook, sending a test and retrying need the dashboard's own page and, on a local dashboard, a local host name, so a web page can't point your alerts at its own webhook. The server never follows a redirect when it posts an alert.
- **The cost report's CSV** has one row per API request of today or the last 7 days: time, day, agent name, project, machine, model, tokens, cost and session id. Anyone who can open the dashboard can download it. The server keeps at most 100,000 requests in memory for it (the export says when older ones are missing). Text that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe.

## Troubleshooting

| Problem | Fix |
|---|---|
| No agents appear | Run `agent-office doctor`. Restart `claude` sessions after install. |
| Doctor says "Hooks are from an older version" | Run `agent-office install` again. It adds the newer hook events and keeps your own hooks. |
| Agents show no plan | Claude Code only keeps a to-do list by default on Opus 4.7, Sonnet 4.6, Haiku 4.5 and earlier. Run `agent-office install --with-plans` for newer models. |
| An agent shows "Needs you" for a long time | It stays there until you answer, the session ends, or 8 hours pass. After 30 minutes without news the question is marked as possibly stale. |
| Agents appear but cost is $0 | Cost needs telemetry. If you already send telemetry elsewhere, install warns and leaves it alone. |
| The Answer dialog says "Answer in the Claude Code terminal" | The hook isn't waiting: its wait passed, nobody had the dashboard open when the request came, `AGENT_OFFICE_HOLD=0`, detail capture is off, the command is too long to show in full, or the hooks are from an older install (run `agent-office install` again). |
| A message says "Waiting for its next stop" for a long time | It's handed over when the agent's turn ends. A working agent may run a while; an idle one only stops again after you prompt it in the terminal. `AGENT_OFFICE_INBOX=0` on its machine keeps messages from ever arriving. |
| "Port already in use" | `PORT=4381 agent-office start`, then reinstall so hooks use the new port. |
| Server was down for a while | Hooks save events to `~/.agent-office/spool`. A server on the same machine loads them on start; hooks on other machines send them a batch at a time with their next events once the server answers. Settings → Machines shows what still waits. Nothing is lost unless a machine's spool passes 50 MB (a server down, or refusing that machine's token, for a long time): then its oldest events are dropped, and Machines says how many. |

## Development

```bash
npm test          # Node's built-in runner, no dependencies
npm run demo
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.
