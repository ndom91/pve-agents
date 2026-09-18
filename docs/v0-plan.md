# v0 Plan

> **Historical.** This plan was written before the system was built and has been executed. It is
> kept because it records the reasoning at the time, not because it describes what exists. Several
> things here were abandoned on contact with reality, most notably the organiser agent and the
> split between a read-only web UI and an interactive Herdr client.
>
> For the system as built, read `architecture.md`.

## Success Criterion

From one API call, create an isolated repository environment on Proxmox and make it ready for an agent to start working. The user accesses the always-on organiser through the controller's Herdr session.

Direct registration of each ephemeral LXC into every user's local Herdr sidebar is a subsequent milestone because Herdr machine catalogs are client-owned and non-recursive.

## API Surface

Initial provisioning API:

```text
POST   /workspaces
GET    /workspaces
GET    /workspaces/:id
DELETE /workspaces/:id
POST   /workspaces/:id/retry
```

Agent-control API backed by remote Herdr:

```text
GET  /agents
GET  /agents/:id
POST /workspaces/:id/agents
POST /agents/:id/messages
GET  /workspaces/:id/git/status
GET  /workspaces/:id/git/diff
```

Archive can remain unimplemented until create and destroy are reliable:

```text
POST /workspaces/:id/archive
```

`POST /workspaces` accepts an `Idempotency-Key` header and returns `202 Accepted` with the persisted workspace. Reusing a key returns the same workspace.

Example request:

```json
{
  "repository": "git@github.com:plainhq/plain.git",
  "ref": "main",
  "purpose": "Investigate round-robin race condition"
}
```

## Proposed Workspace Record

```ts
interface Workspace {
  id: string
  ownershipToken: string

  desiredState: "present" | "destroyed"
  status:
    | "requested"
    | "provisioning"
    | "booting"
    | "bootstrapping"
    | "registering"
    | "ready"
    | "failed"
    | "destroying"
    | "destroyed"

  activity: "active" | "idle" | "blocked" | "unknown"

  node?: string
  vmid?: number
  hostname: string
  ip?: string

  repository: string
  ref: string
  purpose?: string

  herdrSession: string
  herdrWorkspaceId?: string

  currentStep?: string
  currentTaskUpid?: string
  error?: {
    code: string
    message: string
    retryable: boolean
    occurredAt: string
  }

  createdAt: string
  updatedAt: string
  readyAt?: string
  lastActivityAt?: string
  destroyedAt?: string
}
```

Herdr client registrations are separate because multiple users or devices may register the same workspace:

```ts
interface WorkspaceRegistration {
  workspaceId: string
  deviceId: string
  desired: boolean
  status: "pending" | "registered" | "failed" | "removed"
  herdrProfileId?: string
  error?: string
  updatedAt: string
}
```

## Web Application

The hosted UI should initially provide operational visibility rather than terminal emulation.

Workspace list:

- Repository, ref, and purpose.
- Provisioning state and current step.
- Hostname and reachability.
- Agent count and state summary.
- Dirty/clean Git status.
- Age and last activity.
- Create, retry, open in Herdr, and destroy actions.

Workspace detail:

- Provisioning timeline and errors.
- LXC identity and resource usage.
- Herdr agents with working, blocked, done, idle, or unknown state.
- Recent agent summary or explicitly requested terminal excerpt.
- Git status and diff summary.
- Credential classes injected, without secret values.

The initial "Open in Herdr" action opens the controller's organiser session. Direct workspace registration and focus on the current user device is a later bridge capability.

## Implementation Stages

### Stage 1: Infrastructure Probe

- Confirm Proxmox version, node, template VMID, storage, and bridge.
- Verify linked clone behavior and timing manually.
- Verify DHCP address discovery through the API.
- Verify SSH and unique host keys after cloning.
- Validate the restricted Proxmox role and token.

### Stage 2: Controller Core

- Create the hosted HTTP service and minimal web UI.
- Add SQLite persistence and migrations.
- Implement workspace desired state and idempotency keys.
- Implement Proxmox UPID polling.
- Implement create, inspect, start, stop, and delete.
- Add restart reconciliation and structured operation logs.

### Stage 3: Bootstrap

- Build the golden LXC template.
- Add bounded SSH readiness checks.
- Add idempotent remote bootstrap.
- Add short-lived GitHub repository authentication.
- Clone to `/workspace/repo` and checkout the requested ref.

### Stage 4: Herdr Remote Control

- Verify pinned Herdr compatibility.
- Start the `agents` named session.
- Create the repository Herdr workspace.
- Implement agent start, prompt, list, status, read, and wait adapters.
- Poll Herdr state into the controller overview.

### Stage 5: Controller Herdr Session

- Run a supervised named `controller` Herdr server on the controller host.
- Create an organiser workspace and operational panes.
- Add the controller to the Mac once using `herdr machine add`.
- Verify the local Herdr client can interact with the organiser after detach/reconnect.

### Stage 6: End-To-End Proof

Run and record:

```text
POST /workspaces
→ linked clone
→ boot and DHCP
→ repository checkout
→ remote Herdr workspace
→ controller organiser observes workspace readiness
→ start and prompt an agent
→ observe its state in web UI and controller Herdr
→ DELETE /workspaces/:id
→ LXC destroyed
```

### Stage 7: Direct Workspace Registration (Optional)

- Build the local client registration bridge.
- Reconcile disposable LXC profiles into the Mac's local Herdr catalog.
- Let a user select any direct remote workspace from their local sidebar.
- Remove profiles during workspace destruction.

## Deliberately Deferred

- Multi-node placement.
- Queues and autoscaling.
- Automatic idle destruction.
- Full archive implementation.
- Proxmox snapshots as persistence.
- Browser terminal streaming.
- Multi-tenant authorization beyond basic device/user ownership.
- Credential broker infrastructure.
- Tailscale node enrollment per workspace.

## Inputs Needed Before Implementation

- Proxmox API URL and version.
- Target node name.
- Golden template VMID or plan to build it.
- Storage backend and linked-clone support.
- Bridge/VLAN and DHCP details.
- Where the hosted controller will run and how it reaches Proxmox and the agent subnet.
- GitHub App availability or alternative repository authentication.
- Which coding agent should be supported first.
- Initial model-provider authentication approach.
