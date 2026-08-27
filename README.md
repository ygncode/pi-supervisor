# Pi Supervisor

Run and manage multiple [Pi](https://github.com/earendil-works/pi-mono) coding agents from one Pi session.

Pi Supervisor uses [tmux](https://github.com/tmux/tmux) to keep Pi sessions running in the background. It watches their terminal output, shows which agents are working or waiting, and wakes your current Pi session when an agent needs attention.

You do **not** need any other supervisor extension. Pi Supervisor works on its own.

## What it does

- Run several Pi agents side by side, each with its own model and project directory.
- Monitor sessions for working, idle, dialog, and missing states.
- Notify the supervising Pi when an agent finishes or asks a question.
- Capture a supervised session's recent output.
- Send follow-up instructions to a specific agent.
- Start new Pi sessions directly from Pi and mark them as supervisor-managed.
- Close validated completed agents instead of leaking tmux sessions.
- Auto-close clean, unattached managed sessions after a 30-minute idle grace period.
- Preview and interactively clean up completed legacy Pi sessions.
- Show a persistent status widget in the Pi footer.
- Warn and require explicit approval before responses to potentially dangerous dialogs.
- Restore your monitored sessions after Pi reloads or resumes.

## Requirements

- [Pi](https://github.com/earendil-works/pi-mono) installed and available as `pi`.
- [tmux](https://github.com/tmux/tmux) installed and available as `tmux`.
- At least one Pi model configured and authenticated.

Check that both commands are available:

```bash
pi --version
tmux -V
```

## Install

Install from GitHub:

```bash
pi install git:github.com/ygncode/pi-supervisor
```

Restart Pi or run `/reload` after installation.

To try it without installing permanently:

```bash
pi -e https://github.com/ygncode/pi-supervisor
```

## Quick start

### Start a new agent

From your main Pi session, run:

```text
/pi-spawn -m <model> -n code-review -d ~/project
```

For example:

```text
/pi-spawn -m openai-codex/gpt-5.6-luna -n code-review -d ~/project
```

Use a model available in your own Pi configuration. The new agent starts in a detached tmux session and is supervised automatically.

### Supervise an existing agent

If a Pi session is already running inside tmux:

```text
/pi-supervise <tmux-session-name>
```

To see available tmux sessions:

```text
/pi-supervise
```

If there is more than one session to choose from, Pi shows a selector.

### Check status and communicate

```text
/pi-supervise status
/pi-send code-review :: Run the tests and report any failures.
/pi-supervise close code-review
```

`close` succeeds only for an unattached supervisor-managed session that is idle and does not show a dialog or unresolved failure. The supervising model is also instructed to close an agent after validating successful completion.

When only one session is supervised, the session name is optional:

```text
/pi-send Run the tests and summarize the result.
```

## Commands

| Command | Description |
| --- | --- |
| `/pi-supervise` | Choose an existing tmux session to monitor |
| `/pi-supervise <session>` | Start monitoring a named session |
| `/pi-supervise status` | Show state, ownership, and auto-close status |
| `/pi-supervise close <session>` | Close a validated completed managed session |
| `/pi-supervise cleanup` | Preview legacy cleanup, then request confirmation |
| `/pi-supervise stop <session>` | Stop monitoring one session without closing it |
| `/pi-supervise stop` | Stop monitoring all sessions without closing them |
| `/pi-send <message>` | Send a message when one session is monitored |
| `/pi-send <session> :: <message>` | Send a message to a named session |
| `/pi-spawn -m <model> [-n <name>] [-d <dir>]` | Start and monitor a new Pi session |

## The `pi_supervisor` tool

Pi can call the `pi_supervisor` tool to manage sessions without slash commands. It supports:

- `list` — list tmux sessions and identify likely Pi sessions
- `start` — start monitoring a session
- `status` — get all monitored-session statuses
- `capture` — inspect recent output from a session
- `send` — send a response or instruction
- `close` — close one validated completed managed session
- `cleanup` — preview eligible legacy sessions without deleting anything
- `stop` — stop one or all monitors without closing sessions
- `spawn` — start a new managed Pi session with a selected model

## How monitoring works

Pi Supervisor checks monitored tmux panes every five seconds and reports these states:

| State | Meaning |
| --- | --- |
| `working` | The agent is actively processing a task |
| `idle` | The agent is ready for another instruction |
| `dialog` | The agent is waiting for a selection, confirmation, or answer |
| `missing` | The tmux session no longer exists |

The supervising Pi is notified when a session reaches a stable waiting state or finishes a turn. Routine follow-up can be handled automatically, while potentially destructive, deployment, production, credential, or security-related decisions are left for you to approve.

Sessions created by `pi-spawn` carry tmux ownership metadata. After a clean settled session has remained idle and unattached for 30 minutes, its owning supervisor closes it automatically. Working agents, dialogs, likely questions, unresolved failures, attached sessions, manually started sessions, and sessions owned by another supervisor are preserved.

For older unmarked sessions, `/pi-supervise cleanup` performs a conservative scan. It lists the exact eligible sessions and asks for interactive confirmation before closing anything. The `pi_supervisor cleanup` tool is always preview-only.

## Important notes

- All supervised agents must run inside tmux.
- Each agent uses its own Pi configuration, model access, and working directory.
- Messages sent by Pi Supervisor are entered into Pi's single-line input box, so line breaks are converted to spaces.
- Status and unresolved-failure detection are based on terminal output and intentionally err toward preserving sessions.
- Sensitive-dialog protection is reinforced through supervisor instructions; inspect the pane before approving sensitive actions.
- Stopping supervision does not stop or delete the underlying tmux session; use `close` for validated managed sessions.
- Automatic cleanup never closes unmarked legacy sessions.

## Troubleshooting

### `tmux: command not found`

Install tmux using your operating system's package manager, then restart Pi.

### `pi: command not found` when using `/pi-spawn`

Make sure the directory containing the Pi executable is in the `PATH` inherited by tmux.

### A session is not detected

Confirm that it exists and that it is a Pi session:

```bash
tmux list-sessions
tmux capture-pane -p -t <session-name> -S -40
```

Then run `/reload` and try `/pi-supervise <session-name>` again.

## Development

Run the classifier and lifecycle tests from a checkout:

```bash
npm test
```

After changing the extension, run `/reload` in each already-running Pi process.

## License

MIT
