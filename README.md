# Pi Supervisor

Supervises multiple persistent interactive Pi coding-agent sessions running inside tmux — the Pi-to-Pi counterpart of `claude-supervisor`. Use it to run several Pi agents side by side with different models (deepseek, grok, gpt, kimi, …) and manage them from a single Pi.

## Features

- Polls every supervised tmux pane concurrently every five seconds.
- Classifies Pi-specific UI states: `working` (`Thinking...` / `⠇ Working...` spinners), `dialog` (selectors, confirmations, `ask_user_question`, trust prompts), `idle`, and `missing`.
- Debounces stable panes and deduplicates events.
- Publishes a durable tmux pane signal from Pi's `agent_settled` event, so completion cannot be missed when another extension immediately queues follow-up work.
- Wakes the supervising Pi automatically when a supervised Pi needs attention.
- Flags destructive, deployment, production, credential, and security-sensitive dialog content for explicit user approval.
- Provides a persistent footer status and widget.
- Sends messages through a mode-0600 temporary tmux buffer; newlines are flattened to spaces because Pi's input box is single-line.
- `spawn` launches a new Pi tmux session with any configured model and starts supervising it.
- Restores all selected sessions after Pi reloads or resumes the current conversation.

## Commands

```text
/pi-supervise                    # add another tmux session
/pi-supervise <session>          # start supervising a session
/pi-supervise status             # show all statuses
/pi-supervise stop <session>     # stop one monitor
/pi-supervise stop               # stop all monitors
/pi-send <message>               # send when only one session is watched
/pi-send <session> :: <text>     # send when multiple sessions are watched
/pi-spawn -m <model> [-n <name>] [-d <dir>]   # spawn a Pi session with a model
```

The agent can use the `pi_supervisor` tool with these actions:

- `list` — all tmux sessions; `(pi?)` marks sessions that look like a Pi TUI
- `start`
- `status`
- `capture`
- `send`
- `stop`
- `spawn` — `model` required; optional `name` (tmux session), `dir` (cwd)

## Installation

Install it as a Pi package from GitHub:

```bash
pi install git:github.com/ygncode/pi-supervisor
```

To try it for one run without installing:

```bash
pi -e https://github.com/ygncode/pi-supervisor
```

## Activation

The extension is also auto-discovered when installed globally at:

```text
~/.pi/agent/extensions/pi-supervisor/index.ts
```

After installing or updating, run `/reload`, then:

```text
/pi-spawn -m gpt-5.6-luna -d ~/project
/pi-supervise <existing-pi-session>
```

## How supervised sessions are started

```bash
tmux new-session -d -s pi-grok "pi -m grok-4.5 -n pi-grok"
```

Any already-running Pi in tmux can be added with `/pi-supervise <session>`.

## Safety model

Routine supervision is autonomous. The extension does not directly fabricate answers: it wakes the supervising Pi agent with the supervised pane, and that agent inspects and responds through the tool. Dialog content flagged `dangerous` must be approved by the user before Pi sends acceptance.

Note: Pi has no per-command permission prompts (its trust model is filesystem-based). `dialog` covers selectors/confirmations rendered by Pi itself and by extensions.

## Test

```bash
npx --yes tsx ~/.pi/agent/extensions/pi-supervisor/classifier.test.ts

# After changing the extension, reload each already-running Pi process:
# /reload
```
