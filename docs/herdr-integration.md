# Herdr Integration

## Confirmed Version

The initial investigation used Herdr 0.9.0 installed on the user's Mac.

Herdr provides:

- Saved SSH machines shown alongside Local in one TUI.
- A server per machine and session.
- Structured CLI commands for workspaces, tabs, panes, and agents.
- A newline-delimited JSON socket API.
- Agent lifecycle states and event subscriptions.
- JSON machine listing for automation.

References:

- [Connecting machines](https://herdr.dev/docs/connecting-machines/)
- [CLI reference](https://herdr.dev/docs/cli-reference/)
- [Socket API](https://herdr.dev/docs/socket-api/)

`herdr --skill` prints Herdr's own agent-control guide from the installed binary. It is written
for an agent running *inside* a Herdr pane, so its `HERDR_ENV` check, `--current` targeting, and
caller-context variables do not apply to this controller, which drives a remote server from
outside. Its constraints on names, IDs, lifecycle states, and failure responses do apply, and are
recorded below.

## Running Herdr Over SSH

**`ssh` does not preserve argument boundaries.** The client joins the command it is given with
spaces and hands the result to the remote login shell, which splits it again and interprets every
metacharacter. An array of arguments is not an array by the time it arrives.

Everything the controller sends is therefore quoted by `quoteRemote` in `src/services/ssh.ts`
before it leaves. Without that, a workspace label containing a space becomes two arguments, and
one containing a semicolon runs as a second command under the controller's key.

The same fact shapes how a script is sent. A fixed script with data supplied positionally is safe
once quoted:

```bash
sh -c 'printf %s "$2" > "$HOME/.claude.json"' sh <cwd> <json>
```

The script text never varies, so nothing a caller supplies is ever parsed as shell.

## Claude Code's First-Run Gates

Three separate gates stand between a fresh container and an agent that accepts a prompt. They were
found one at a time, each only after the previous was closed.

1. **Theme picker** — gated on `hasCompletedOnboarding` in `~/.claude.json`.
2. **Folder trust** — gated on `projects["<cwd>"].hasTrustDialogAccepted`. Recorded **per
   directory**, so seeding it for the wrong path leaves the dialog in place.
3. **Login** — avoided entirely by `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`. That is
   the subscription path; it is not an API key.

Herdr classifies these inconsistently, which is the important part. The trust dialog is reported
as `blocked`. The theme picker is reported as `idle` with `interactive_ready: true` and
`agent start` exits 0. **Neither the status nor the pane text alone detects both**, so the
controller reads both and refuses the workspace if either says it is waiting.

`agent start` on a name that already exists returns `agent_name_taken`, not success. A pass that
started an agent and then lost its release must inspect what is there rather than start it again.

## Verified On Hardware

The whole chain runs unattended against real hardware (template 114, Herdr 0.9.0). A workspace
goes from `requested` to `ready` in roughly one minute:

```
requested -> clone -> booted -> addressed -> reachable
          -> bootstrapped -> session-started -> herdr-registered -> agent-started
```

At `ready` the container holds a detached Herdr server, a workspace rooted at `/workspace/repo`,
and a Claude Code agent reporting `agent_status: idle` with `interactive_ready: true`.

Proven by prompting that agent and getting an answer, so the subscription token authenticates.
Note that the answer itself was **not** readable through `agent read`: Claude Code draws on the
terminal's alternate screen, whose rows never enter Herdr's scrollback. The evidence was the
terminal title, which Claude sets from the conversation. Anything that needs an agent's output
will have to have it written to a file.

## Remote Machine Registration

Register a prepared SSH machine with:

```bash
herdr machine add \
  ssh://agent@10.50.0.27 \
  --label "plain · round-robin bug" \
  --remote-session agents
```

`machine add` verifies the remote binary and server, starts a compatible background server, and saves a local profile. An open Herdr client normally notices the profile within a second.

Machine profiles contain an opaque profile ID, label, SSH target, optional remote session, and enabled state. Herdr does not store SSH passwords or private keys in the profile.

List and remove profiles with:

```bash
herdr machine list --json
herdr machine remove <profile-id>
```

Removing a profile disconnects and forgets the machine locally. It does not stop remote sessions or agents.

## Registration Automation Constraint

`herdr machine add` has no `--yes` flag. It can run without interaction only when:

- SSH host trust is already established.
- SSH authentication does not prompt.
- A compatible Herdr binary is already installed remotely.
- No incompatible running server requires approval to stop or restart.

The LXC template should therefore contain a pinned compatible Herdr version. Closing stdin makes an unexpected prompt fail instead of hanging:

```bash
herdr machine add ... </dev/null
```

The official supported interface is the `herdr machine` CLI. Direct editing of Herdr's internal machine catalog is technically possible in 0.9.0 but is not a public API and would bypass setup checks, validation, and atomic writes. The prototype should not depend on its schema.

## Controller As A Permanent Machine

The controller host runs an always-on Herdr server with a named session such as `controller`. It hosts the organiser agent and controller operational panes.

Each user adds that controller as a normal permanent saved machine from their own Herdr client:

```bash
herdr machine add controller \
  --label "Agent Controller" \
  --remote-session controller
```

This lets the local Herdr TUI display and interact with the organiser as though it were another local workspace. It is the recommended initial human-control path.

## Federation Limitation

Saved-machine profiles belong to the Herdr client that renders the UI. They are not server-owned session state, and machine connections are not recursive.

If the controller's own Herdr client has registered workspace LXC `agent-7f2a`, adding only `controller` on the Mac does not cause `agent-7f2a` to appear in the Mac's sidebar. The Mac sees the controller server's own workspaces and agents, including the organiser, but not the controller client's machine catalog.

This does not block v0. The organiser calls the controller API and the controller operates each workspace's remote Herdr server. Direct LXC terminal access from the Mac is a later enhancement.

## Optional Client Registration Bridge

If direct LXC workspaces in each user's local Herdr sidebar are required, add a small bridge on that client machine:

```text
bridge -> controller: authenticate and subscribe
controller -> bridge: desired machine profile set
bridge -> Herdr CLI: add/remove/rename profiles
bridge -> controller: observed profile IDs and errors
```

The bridge reconciles desired state rather than blindly executing messages. It holds no Proxmox, GitHub, or model-provider credentials and is outside the initial controller critical path.

## Remote Server Startup

A named session has no server until one is started. `herdr --session agents status` reports
`not running` on a freshly booted workspace, and every workspace or agent command fails until a
server exists.

The headless server starts fine over a non-interactive SSH command. It needs no TTY, no dbus, and
no writable state outside `~/.config/herdr`:

```bash
setsid nohup herdr --session agents server > /tmp/herdr-server.log 2>&1 < /dev/null &
```

`setsid` is what makes it outlive the SSH connection. Without it the server dies with the session
that spawned it.

Each named session gets its own socket, so the session name is part of the address:

```text
~/.config/herdr/sessions/agents/herdr.sock
```

Poll `herdr --session agents status` for `status: running` rather than sleeping a fixed interval.
Do not run bare `herdr server`: that starts the *default* session, not `agents`.

Every command must repeat `--session agents`. IDs and agent names are scoped to a single server,
so a command without the flag silently addresses a different session.

## Remote Workspace Creation

Herdr commands are scoped to the server where they run. After the container is reachable, create the workspace remotely:

```bash
ssh -T agent-7f2a \
  '$HOME/.local/bin/herdr --session agents workspace create --cwd /workspace/repo --label plain --no-focus'
```

The JSON response returns the workspace, first tab, and root pane IDs. Persist these IDs as observed state, but rediscover them after server replacement or reconciliation rather than assuming examples such as `w1:p1`.

### `--cwd` fails silently

A `--cwd` that does not exist is **ignored without any error**. The command exits 0, reports
`workspace_created`, and puts the pane in the user's home directory instead. An agent then starts
in `/home/agent` and finds no repository, with nothing in any log to explain it.

The controller must therefore create the directory first, and then verify the echoed path:

```text
.result.root_pane.cwd == the requested --cwd
```

Treat a mismatch as a failed step. The exit status alone proves nothing here.

`workspace create` also accepts `--env KEY=VALUE`, which is the injection point for
model-provider credentials once that decision is made.

## Agent Operations

The remote Herdr CLI supports the intended organiser operations:

```bash
herdr --session agents agent start investigator-backend --kind codex --pane <pane-id>
herdr --session agents agent prompt investigator-backend "Investigate the race" --wait
herdr --session agents agent list
herdr --session agents agent get investigator-backend
herdr --session agents agent read investigator-backend --source recent-unwrapped --lines 120
herdr --session agents agent wait investigator-backend --until blocked --timeout 120000
```

Additional agents require additional panes. Create topology explicitly with `pane split`, then use `agent start` in the returned pane.

### Agent names are constrained

Herdr enforces `[a-z][a-z0-9_-]{0,31}` on agent names, and requires uniqueness only among *live*
agents on one server.

A workspace UUID therefore cannot be used, nor can the `<workspace-id>:<agent-name>` form this
document previously recommended: the colon is not in the allowed set, and the result exceeds 32
characters. Derive the name from the same short slug already used for the hostname instead, such
as `agent-596a`. One server hosts one controller-managed workspace, so that slug is unique by
construction, and the server-scoping problem does not arise.

The constraint is worth enforcing controller-side, because a bad name is rejected at `agent start`
only after the container, the session, and the workspace all exist.

A name is not a durable handle. It follows the current pane occupant and is cleared when that
agent exits, is released, or is replaced. Persist the pane ID for durability: closed pane and tab
IDs are never reused.

### Lifecycle states

`idle` and `done` both mean the agent is ready for input; they differ only in whether the server
has seen the completion. `blocked` means Herdr recognised an approval or question dialog.

`unknown` means an agent is present but Herdr cannot classify it. It does **not** prove
completion, so the controller must not treat it as a finished turn.

### Failure responses

Server errors arrive as JSON on stderr with exit status 1. CLI syntax errors exit 2. The two need
different handling: exit 2 is a controller bug and will never succeed on retry.

Three named responses matter to the state machine:

- `agent_not_ready` — the agent was blocked during startup. The name still resolves, so
  `agent read` and `agent send-keys` work. Wait for idle rather than restarting.
- `agent_blocked` — a prompt was refused because the agent sits at a dialog. No input was sent.
- `agent_prompt_stalled` — submitted, but no `working` or `blocked` activity within five seconds.

A `timeout` or a stall does not prove the prompt was never delivered. Re-sending blindly can
double-submit; read the pane first.

### Reading output

Prefer `--source recent-unwrapped` for transcripts. Raising `--lines` cannot recover output from
an agent drawing on the terminal's alternate screen, because those rows never enter Herdr's
scrollback. When a read comes back short for that reason, the fallback is to have the agent write
its response to a file and read the file.

## Overview Data

The hosted application can provide an agent overview without rendering terminals.

Useful data comes from:

- `herdr api snapshot` for initial workspace, pane, and agent state.
- `herdr agent list` for simple polling.
- `events.subscribe` for long-lived updates from a remote helper.
- `agent read` only when the user explicitly requests recent output.

For v0, periodic polling over SSH is simpler than maintaining one event stream per LXC. The UI can show:

- Workspace provisioning and reachability state.
- Repository and ref.
- Agent name and kind.
- Herdr lifecycle state: working, idle, done, blocked, or unknown.
- Last state transition and last activity time.
- Dirty/clean Git summary.

Do not stream or persist complete terminal contents by default. Herdr remains the place for interactive and detailed terminal access.

## Current Herdr Gaps

- No global CLI or socket API spans all saved machines.
- Selecting a remote machine in the TUI does not retarget CLI calls.
- Remote control requires running Herdr's CLI on the remote host, currently over SSH.
- Machine registration is local to each client installation.
- Initial `machine add` setup has no explicit unattended flag.
- Removing a saved machine does not stop its remote server.

These gaps require adapters, but do not block the proposed experience.
