# Implementation Plan

## Initial Deployment

Deploy the controller on a trusted, always-on homelab host that can reach Proxmox and the private workspace network. It runs two separate processes under one service account:

- Workspace controller: HTTP API, web UI, worker, database access, Proxmox API access, and SSH workspace adapters.
- Controller Herdr server: named `controller` session with the organiser agent and controller operational panes.

Each user adds the controller once from their normal Herdr client:

```bash
herdr machine add controller --label "Agent Controller" --remote-session controller
```

## Recommended Initial Stack

Use one TypeScript monolith. The API, web UI, worker, and infrastructure adapters share one durable state model.

- Runtime: Node.js 22 LTS.
- API and UI: TanStack Start.
- Validation: Zod.
- Database: SQLite with Drizzle migrations.
- Tests: Vitest; add Playwright when the web UI has meaningful flows.
- Deployment: dedicated unprivileged Debian LXC or VM, supervised by systemd.

Do not introduce queues, Redis, microservices, or a scheduler until the controller lifecycle is proven.

## Module Boundaries

```text
src/
  routes/               TanStack Start API routes and UI routes
  domain/               State machine and policies
  db/                   Schema, migrations, repositories
  worker/               Reconciliation and durable operation loop
  adapters/
    proxmox/            REST client and UPID polling
    ssh/                Safe SSH runner and readiness checks
    git/                Checkout and status operations
    herdr/              Remote Herdr CLI JSON adapter
  services/             Provision, destroy, and agent orchestration
  config/               Validated environment configuration
```

Dependencies point inward. Domain code must not import HTTP, database, shell, Proxmox, or Herdr code.

## Persistent Model

Start with five tables:

```text
workspaces
workspace_operations
workspace_events
idempotency_keys
agents
```

- `workspaces`: desired and observed state, Proxmox identity, request data, remote Herdr identity, and current error.
- `workspace_operations`: durable operation, attempt number, UPID, step, next run time, and worker lease.
- `workspace_events`: redacted, append-only human-readable timeline.
- `idempotency_keys`: key and canonical request hash mapped to one workspace.
- `agents`: cached controller-level identity and latest Herdr observation. Herdr remains authoritative.

## State And Worker

Store two independent dimensions:

```text
desired: present | destroyed
status:  requested | provisioning | booting | bootstrapping |
         registering | ready | failed | destroying | destroyed
```

The worker claims one due database operation using a lease, observes actual Proxmox/remote state, then executes only the next missing transition. It does not trust in-memory progress after a crash.

Provision checkpoints:

```text
workspace persisted
VMID allocated
clone UPID persisted
clone confirmed
LXC configured
start UPID persisted
SSH reachable
credentials bootstrapped
repository checked out
remote Herdr workspace created
ready
```

The same loop resumes unfinished UPIDs, refreshes ready workspace agent/Git summaries, continues destruction, and reports ownership-verified orphans without deleting them in v0.

## Adapter Contracts

Services depend on small interfaces, not shell commands or HTTP details:

```ts
interface Proxmox {
  nextVmid(): Promise<number>
  cloneContainer(input: CloneInput): Promise<Task>
  getTask(task: Task): Promise<TaskStatus>
  getContainer(vmid: number): Promise<Container | null>
  updateContainer(input: UpdateContainerInput): Promise<void>
  startContainer(vmid: number): Promise<Task>
  getContainerAddresses(vmid: number): Promise<string[]>
  shutdownContainer(vmid: number): Promise<Task>
  stopContainer(vmid: number): Promise<Task>
  deleteContainer(vmid: number): Promise<Task | null>
}

interface RemoteHerdr {
  createWorkspace(input: CreateHerdrWorkspaceInput): Promise<HerdrWorkspace>
  listAgents(target: SshTarget): Promise<HerdrAgent[]>
  startAgent(input: StartAgentInput): Promise<HerdrAgent>
  promptAgent(input: PromptAgentInput): Promise<void>
  readAgent(input: ReadAgentInput): Promise<string>
}
```

The initial Herdr adapter invokes the pinned remote Herdr CLI over SSH and parses JSON. It must use fixed argument arrays and avoid constructing shell commands from repository, prompt, or agent input.

## Work Chunks

### Chunk 0: Repository And Local Development

- Initialize the TypeScript project, linting, formatting, tests, and CI.
- Add `.env.example`, configuration validation, and secret-safe structured logging.
- Document local development without real infrastructure credentials.

Acceptance: fresh checkout passes typecheck, lint, tests, and migration checks.

### Chunk 1: Domain, Database, And Workspace API

- Implement migrations, workspace state machine, event timeline, and idempotency keys.
- Implement create, list, get, destroy, and retry endpoints.
- Build database-backed workspace list/detail UI with no infrastructure calls.

Acceptance: duplicate create calls with one idempotency key create one workspace; invalid state transitions are rejected; state survives restart.

### Chunk 2: Proxmox Lifecycle

- Implement token authentication, UPID polling, VMID conflict recovery, linked clone, inspect, config, start, stop, and delete.
- Require exact ownership-marker verification before every destructive operation.
- Add a manual infrastructure probe command.

Acceptance: API clone-start-destroy works against a disposable template; controller restart during clone never deletes a non-owned LXC.

### Chunk 3: Template And Bootstrap

- Build and document a reproducible golden template.
- Implement DHCP address discovery, SSH readiness, bootstrap, repository credential injection, clone, and ref checkout to `/workspace/repo`.

Acceptance: a requested repository/ref is a clean checkout in a uniquely identified LXC.

### Chunk 4: Remote Herdr And Agents

- Verify/start the remote named `agents` session.
- Create `/workspace/repo` Herdr workspace.
- Implement pane split, agent start, prompt, list, read, and wait.
- Persist agent observations and show agent/Git summary in web UI.

Acceptance: one API call provisions; a second starts named Codex and submits a prompt; API/UI reflect its status.

### Chunk 5: Controller Herdr Session

- Add a systemd unit for the controller `controller` session.
- Bootstrap organiser workspace and operational panes.
- Give organiser a controller API tool or skill.
- Document Mac setup with `herdr machine add controller`.

Acceptance: organiser survives Mac disconnects and remains usable through the normal Mac Herdr UI.

### Chunk 6: Hardening And End-To-End Proof

- Add web/API authentication, health checks, metrics, backups, and runbook.
- Test controller restart, SSH failure, checkout failure, Herdr failure, and duplicate delete.

Acceptance: every documented failure produces a clear state and a safe retry/destroy path.

### Chunk 7: Optional Direct Workspace Registration

- Add client-local bridge and device authorization.
- Reconcile LXC profiles into the Mac Herdr catalog.

Acceptance: direct LXC workspaces appear and disappear from the Mac sidebar without manual `herdr machine` commands.

## First Vertical Slice

Implement Chunks 0 through 2 first:

```text
POST workspace
-> controller persists intent
-> linked clone from known template
-> controller restarts during task
-> controller adopts owned LXC
-> DELETE workspace
-> only the owned LXC is removed
```

This proves the highest-risk state and infrastructure behavior before adding repository credentials, agents, or rich UI.

## Decisions Needed Before Coding

- Controller hostname and deployment form: LXC or VM.
- Proxmox endpoint, node, template VMID, storage, bridge/VLAN, and resource pool.
- LXC isolation requirements.
- Repository auth: GitHub App is recommended.
- First supported agent: Codex is recommended.
- Initial model-provider credential method.
- Controller web/API authentication: single-user Tailscale or identity provider.
