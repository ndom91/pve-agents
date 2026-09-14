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
herdr 0.9.0
openssh-server
normal shell and build tooling
```

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
11. Start or verify the named Herdr server.
12. Create the Herdr workspace rooted at `/workspace/repo`.
13. Ask the user's local bridge to register the remote machine.
14. Mark the workspace ready after both remote setup and required client registration succeed.

Suggested clone parameters:

```text
newid=<candidate VMID>
full=0
hostname=agent-<short workspace id>
pool=disposable-workspaces
description=<ownership marker>
```

Do not pass `storage` for linked clones. Keep the template and clones on one node for v0.

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
3. Ask local bridges to remove the Herdr machine profile.
4. Gracefully shut down the LXC with a bounded timeout.
5. Force-stop it if necessary.
6. Verify controller ownership from the LXC description.
7. Delete with `purge=1` and wait for the task.
8. Treat an already absent LXC as success.
9. Mark the workspace destroyed.

Do not use `destroy-unreferenced-disks` for v0.

## Failure Handling

| Failure | Response |
| --- | --- |
| Clone response lost | Inspect candidate VMID and ownership marker before retrying. |
| Clone task failed | Store task log and clean up only verified partial resources. |
| Boot failed | Retain failed state for diagnosis; allow retry or delete. |
| No DHCP address | Keep booting failure explicit and retry bounded discovery. |
| SSH unavailable | Retry with backoff; do not report ready. |
| Repository clone failed | Remove temporary Git credentials and mark failed. |
| Herdr setup failed | Keep the LXC and retry only the Herdr step. |
| Client registration failed | Keep remote Herdr running and report registration failure. |
| Controller restarted | Resume from persisted desired state, UPID, and observed resources. |
| Duplicate delete | Treat missing Herdr profiles and Proxmox 404 as success. |

## Reconciliation

On startup and periodically:

- Resume unfinished database records.
- Inspect persisted UPIDs.
- Query candidate/current VMIDs even when a UPID is missing.
- Adopt resources only when all ownership markers match.
- Compare the dedicated Proxmox pool with controller records.
- Report unknown or orphaned resources without automatically deleting them in v0.
- Continue pending destruction until the LXC is absent.

## Archive Direction

Prefer source-control-native persistence:

- Record branch and HEAD.
- Push committed work when possible.
- Capture a Git bundle for unpushed commits.
- Capture a binary patch for tracked uncommitted changes.
- Optionally capture explicitly included untracked files.
- Store workspace and agent metadata with the archive.

Full LXC snapshots should be a temporary diagnostic tool, not the normal archive format.
