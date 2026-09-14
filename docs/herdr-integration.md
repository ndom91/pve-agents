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

## Remote Workspace Creation

Herdr commands are scoped to the server where they run. After the container is reachable, create the workspace remotely:

```bash
ssh -T agent-7f2a \
  '$HOME/.local/bin/herdr --session agents workspace create --cwd /workspace/repo --label plain --no-focus'
```

The JSON response returns the workspace, first tab, and root pane IDs. Persist these IDs as observed state, but rediscover them after server replacement or reconciliation rather than assuming examples such as `w1:p1`.

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

Agent names are unique only within one Herdr server. Controller-level identities should include the workspace ID:

```text
<workspace-id>:<agent-name>
```

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
