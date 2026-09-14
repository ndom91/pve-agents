# Architecture

## Goal

Build a small orchestration system where a task receives its own disposable development computer. A workspace is backed by a Proxmox LXC container, contains one repository checkout, can run multiple coding agents, and appears in the user's normal Herdr interface.

The user-facing abstraction is a `workspace`. The 1:1 mapping between a workspace and an LXC container is an implementation detail.

## System Boundaries

The system has three planes.

### Provisioning Plane

The workspace controller owns infrastructure lifecycle:

- Clone and configure a prepared Proxmox LXC template.
- Start, inspect, stop, and destroy containers.
- Discover workspace network addresses.
- Bootstrap credentials and repository contents.
- Reconcile partially completed operations after a crash.
- Register the controller-host organiser session as a normal remote Herdr machine.
- Optionally register disposable workspaces on individual client machines later.

The controller holds a restricted Proxmox API token. Organiser agents never receive Proxmox credentials.

### Agent Control Plane

Herdr remains the source of truth for terminal layout and live agent state inside each workspace.

The controller or organiser uses Herdr operations to:

- Create the repository workspace and panes.
- Start named coding agents.
- Prompt and follow up with agents.
- Read agent state and terminal output.
- Wait for idle, done, or blocked states.

Herdr 0.9.0 scopes its CLI and socket API to one server. Remote automation therefore executes the Herdr CLI on the target workspace over SSH.

### Human Interface

Herdr remains the primary terminal and session interface. A web application may provide infrastructure and fleet-level visibility, but should not attempt to reproduce interactive terminal sessions.

The desired division is:

```text
Provisioning and fleet overview: user/organiser -> workspace controller
Agent orchestration:             organiser -> remote Herdr server
Interactive agent sessions:      user -> Herdr
```

## Deployment Topology

The controller does not fundamentally need to run on the user's Mac. A self-hosted deployment is preferable for availability and multi-client access. The controller host also owns the always-on organiser Herdr session:

```text
Homelab server
└── Workspace controller
    ├── Web UI and HTTP API
    ├── SQLite/Postgres state
    ├── Proxmox adapter
    ├── SSH/bootstrap adapter
    ├── Herdr remote-control adapter
    ├── Event/reconciliation worker
    └── Herdr server, session: controller
        └── organiser agent

User Mac
└── Normal Herdr client
    └── saved machine: Agent Controller
```

The user adds the controller once through the normal supported Herdr interface:

```bash
herdr machine add controller --label "Agent Controller" --remote-session controller
```

This makes the organiser session available from the user's normal local Herdr client. The Mac is also eligible to be another remote machine registered by the controller, subject to deliberate SSH authorization.

Herdr 0.9.0 machine federation is client-owned and non-recursive. The controller's own saved LXC machines are not automatically flattened into the Mac's sidebar when the Mac adds `controller`. The initial human UX is therefore the controller workspace and organiser, not direct terminal views for every LXC.

An optional later bridge can register individual disposable LXCs in the Mac's local Herdr catalog. That restores direct workspace access in the Mac sidebar, but is not required to prove controller provisioning, agent orchestration, or the controller-host Herdr session.

## Hosted Controller Responsibilities

- Expose the workspace and agent API.
- Serve the fleet overview UI.
- Persist desired and observed workspace state.
- Perform Proxmox lifecycle operations.
- Reach workspace LXCs over SSH.
- Invoke the remote Herdr CLI for agent operations.
- Aggregate Herdr snapshots and events for overview purposes.

## Workspace Topology

One LXC normally corresponds to one repository and task, not one agent:

```text
agent-7f2a
└── /workspace/repo
    ├── investigator-backend
    ├── investigator-frontend
    └── implementer
```

The remote Herdr server uses a named session such as `agents`. It contains one primary Herdr workspace rooted at `/workspace/repo`, with one or more panes and agents.

## Controller Design

Use desired-state reconciliation rather than a long synchronous provisioning request.

`POST /workspaces` persists intent and returns `202 Accepted`. A worker advances the workspace through idempotent steps. On restart, the controller observes Proxmox and Herdr state and continues from the last confirmed step.

For v0, one controller instance with SQLite is sufficient. The data model should permit moving to Postgres and multiple workers later without introducing a scheduler now.

## Non-Goals For v0

- Autoscaling or placement across multiple Proxmox nodes.
- Kubernetes.
- A competing terminal/session UI.
- Automatic idle cleanup.
- Full-container archives as the primary persistence format.
- A general-purpose remote command execution platform.
- Per-client automatic registration of disposable LXCs.
