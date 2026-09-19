# Proxmox Workspace Lifecycle

## Template Model

Start from an immutable, stopped, unprivileged LXC template. The template should be intentionally large enough to avoid package installation during provisioning.

Preinstall:

```text
git, gh
node, pnpm, bun
python, uv
go, rust
ripgrep, fd, jq
codex, claude-code, opencode
@anthropic-ai/claude-agent-sdk
openssh-server
normal shell and build tooling
```

Build it with `deploy/build-workspace-template.sh`, which clones an existing template, provisions
the clone, and converts that into a new one. Editing a template in place does not work: linked
clones come from its `@__base__` ZFS snapshot, so changes to the live dataset reach nothing.

Install the agent tooling as the workspace user, not root. Tooling under `/root` is not on the
workspace user's PATH, which makes it invisible to everything the controller does over SSH.

Do not include a project repository or secret credentials.

Use one non-root `agent` user and the predictable checkout path:

```text
/workspace/repo
```

## State Model

Provisioning lifecycle and agent activity should be separate. Agent activity can move repeatedly between active, blocked, and idle without changing infrastructure readiness.

```ts
type WorkspaceStatus =
  | "requested"
  | "provisioning"
  | "booting"
  | "bootstrapping"
  | "registering"
  | "ready"
  | "failed"
  | "destroying"
  | "destroyed"

type WorkspaceActivity =
  | "active"
  | "idle"
  | "blocked"
  | "unknown"
```

## Creation Flow

The controller should perform these idempotent steps:

1. Persist the requested workspace and ownership token.
2. Request a candidate VMID with `GET /cluster/nextid`.
3. Clone the template with `POST /nodes/{node}/lxc/{template-vmid}/clone`.
4. Persist and wait for the returned Proxmox UPID.
5. Read and update the cloned LXC configuration.
6. Start the container and wait for its UPID.
7. Poll the LXC interfaces endpoint for a usable address.
8. Verify SSH readiness.
9. Inject runtime credentials and run bootstrap.
10. Clone the requested repository and checkout the requested ref.
11. Install the agent runner and wait for its socket to answer.
12. Brief the agent with the request's purpose.
13. Mark the workspace ready, which means briefed and working rather than merely built.

Suggested clone parameters:

```text
newid=<candidate VMID>
full=0
hostname=agent-<short workspace id>
pool=disposable-workspaces
description=<ownership marker>
```

Do not pass `storage` for linked clones. Keep the template and clones on one node.

Linked clones should be tested on the actual storage backend before implementation assumes them. If reliability is poor, switch to full clones without changing the workspace API.

## Proxmox Tasks

Clone, start, shutdown, stop, and delete return a UPID. Poll:

```text
GET /nodes/{upid-node}/tasks/{encoded-upid}/status
```

A task succeeds only when:

```text
status=stopped
exitstatus=OK
```

Persist each UPID before continuing. A controller timeout or lost response means the operation outcome is unknown. Reconcile against Proxmox before retrying.

## VMID Allocation

`GET /cluster/nextid` finds a currently unused VMID but does not reserve it.

Use this process:

1. Persist the candidate VMID before clone.
2. Attempt the clone immediately.
3. Let Proxmox arbitrate conflicts.
4. Request another candidate after a definite already-in-use result.
5. After network uncertainty, inspect the original candidate before retrying.
6. Never adopt or destroy it unless its ownership marker matches.

Database serialization is useful if multiple controller workers are introduced, but it cannot prevent allocations made by other Proxmox clients.

## Ownership Markers

Use a dedicated pool and metadata on every managed LXC:

```text
pool=disposable-workspaces
tag=workspace-controller
description:
  managed-by=pve-herdr-agents
  controller-id=<deployment UUID>
  workspace-id=<workspace UUID>
  ownership-token=<random UUID>
  created-at=<RFC3339 timestamp>
```

The description is the primary ownership proof because it can be supplied during clone. Pool membership, hostname, and tags are useful for discovery but are not sufficient authorization for deletion.

## Destruction Flow

Deletion is idempotent:

1. Persist `desiredState=destroyed` and status `destroying`.
2. Reject new agent operations.
3. Gracefully shut down the LXC with a bounded timeout.
4. Force-stop it if necessary.
5. Verify controller ownership from the LXC description.
6. Delete with `purge=1` and wait for the task.
7. Treat an already absent LXC as success.
8. Mark the workspace destroyed.

Do not use `destroy-unreferenced-disks`: it reaches past the container being deleted, and the ownership marker only vouches for the container.

## Failure Handling

| Failure | Response |
| --- | --- |
| Clone response lost | Inspect candidate VMID and ownership marker before retrying. |
| Clone task failed | Store task log and clean up only verified partial resources. |
| Boot failed | Retain failed state for diagnosis; allow retry or delete. |
| No DHCP address | Keep booting failure explicit and retry bounded discovery. |
| SSH unavailable | Retry with backoff; do not report ready. |
| Repository clone failed | Remove temporary Git credentials and mark failed. |
| Agent runner did not come up | Keep the LXC and retry only the runner step. |
| Agent failed to start or brief | Keep the LXC and retry only that step; the container is the only copy of whatever went wrong. |
| Controller restarted | Resume from persisted desired state, UPID, and observed resources. |
| Duplicate delete | Treat a Proxmox 404 as success. |

## Reconciliation

On startup and periodically:

- Resume unfinished database records.
- Inspect persisted UPIDs.
- Query candidate/current VMIDs even when a UPID is missing.
- Adopt resources only when all ownership markers match.
- Compare the dedicated Proxmox pool with controller records.
- Report unknown or orphaned resources without automatically deleting them. Not a temporary
  caution: a restored or lost database makes every live workspace look orphaned, and a timer would
  then purge the fleet. It stays a scan and a click.
- Continue pending destruction until the LXC is absent.

## Archive Direction

> Mostly unbuilt. What exists is the first item: the UI commits everything and pushes it to a
> branch of the workspace's own, and the reaper refuses to destroy a workspace holding work that
> was never pushed. The rest is still the right shape for the cases that protection only postpones.

Prefer source-control-native persistence:

- Record branch and HEAD.
- Push committed work when possible.
- Capture a Git bundle for unpushed commits.
- Capture a binary patch for tracked uncommitted changes.
- Optionally capture explicitly included untracked files.
- Store workspace and agent metadata with the archive.

Full LXC snapshots should be a temporary diagnostic tool, not the normal archive format.
