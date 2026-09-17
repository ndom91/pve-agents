import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import {
	advanceWorkspaceProvision,
	advanceWorkspaceStatus,
	completeWorkspaceOperation,
	confirmWorkspaceClone,
	failWorkspaceProvision,
	noteWorkspaceIssue,
	type OperationLease,
	prepareWorkspaceProvision,
	recordWorkspaceTask,
	releaseWorkspaceCandidateVMID,
	releaseWorkspaceOperation,
	type WorkspaceProvision,
	workspaceProvision,
} from "../db/workspace-repository";
import { containerAddress } from "./proxmox-address";
import { cloneWorkspace, nextProxmoxVMID } from "./proxmox-clone";
import {
	containerConfig,
	containerDescription,
	startContainer,
} from "./proxmox-container";
import type { Fetcher } from "./proxmox-http";
import { ownershipMatches, parseOwnershipMarker } from "./proxmox-ownership";
import { poolContainsVMID } from "./proxmox-pool";
import { runningCloneTask } from "./proxmox-task";
import {
	awaitTask,
	POLL_INTERVAL_MS,
	proxmoxCredentials,
	taskExpiry,
	type WorkspaceOperationRun,
	workspaceNode,
} from "./workspace-task";

// executeWorkspaceProvision advances one provision operation by exactly one durable step.
//
// Every step is chosen from persisted state rather than in-memory progress, so a controller that
// crashes mid-task resumes from the same decision the next pass would have made anyway.
export async function executeWorkspaceProvision(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const workspace = workspaceProvision(db, lease);
	if (workspace === undefined) {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "stale_operation" };
	}

	// Dispatch on the recorded phase, not on which columns happen to be set: current_task_upid is
	// one column shared by every task, so a start task and a clone task are otherwise identical.
	switch (workspace.phase) {
		case "clone-submitted":
			return workspace.taskUPID === undefined
				? reconcileCandidate(db, config, lease, workspace, fetcher, now)
				: pollClone(db, config, lease, workspace, fetcher, now);
		case "clone-confirmed":
			return submitStart(db, config, lease, workspace, fetcher, now);
		case "start-submitted":
			return pollStart(db, lease, workspace, config, fetcher, now);
		case "booted":
			return discoverAddress(db, config, lease, workspace, fetcher, now);
		case "addressed":
			// SSH readiness and bootstrap are not implemented, so there is no next step to release
			// the operation for. Reopen this when one exists.
			completeWorkspaceOperation(db, lease, now);

			return { processed: 1, status: "addressed" };
		default:
			// No phase yet. A VMID without one means a clone landed before phases existed, or a
			// candidate was persisted and the response lost.
			return workspace.vmid === undefined
				? submitClone(db, config, lease, workspace, fetcher, now)
				: reconcileCandidate(db, config, lease, workspace, fetcher, now);
	}
}

// discoverAddress records where the workspace can be reached.
//
// DHCP does not answer the instant a container boots, so an address that is not there yet is
// pending rather than a failure. The operation deadline bounds how long that is tolerated.
async function discoverAddress(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const api = workspaceNode(config, workspace);
	const found = await containerAddress(
		api,
		workspace.vmid as number,
		config.WORKSPACE_SUBNET,
		fetcher,
	);
	if (found.kind === "failed") {
		noteWorkspaceIssue(db, lease, found.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_address" };
	}
	if (found.kind === "pending") {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_address" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message: `workspace reachable at ${found.address}`,
				type: "workspace.addressed",
			},
			ip: found.address,
			phase: "addressed",
			step: `address ${found.address}`,
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "address_found" };
}

// submitStart boots the confirmed clone.
async function submitStart(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const api = workspaceNode(config, workspace);
	const start = await startContainer(api, workspace.vmid as number, fetcher);
	if (start.kind === "failed") {
		noteWorkspaceIssue(db, lease, start.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	const recorded = recordWorkspaceTask(
		db,
		lease,
		{
			expiresAt: taskExpiry(now),
			kind: "provision",
			phase: "start-submitted",
			step: "start task accepted",
			upid: start.upid,
		},
		now,
	);
	if (recorded.kind !== "prepared") {
		return { processed: 1, status: "stale_operation" };
	}

	// Booting begins when the task is accepted, not when it finishes: the container is no longer
	// merely provisioned from here.
	advanceWorkspaceStatus(db, lease, "booting", now);
	releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

	return { processed: 1, status: "start_submitted" };
}

// pollStart resolves the boot task.
async function pollStart(
	db: Database.Database,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	config: ControllerConfig,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const task = await awaitTask(
		config,
		workspace.taskUPID as string,
		workspace.taskExpiresAt,
		fetcher,
		now,
	);
	if (task.kind === "pending") {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_task" };
	}
	if (task.kind !== "succeeded") {
		failWorkspaceProvision(
			db,
			lease,
			task.kind === "failed" ? "start_task_failed" : "start_task_timeout",
			task.kind === "failed"
				? task.message
				: "proxmox start task did not finish before its deadline",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message: "proxmox confirmed the container booted",
				type: "workspace.booted",
			},
			phase: "booted",
			step: "container booted",
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "container_booted" };
}

// pollClone resolves a submitted clone task against Proxmox.
async function pollClone(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const task = await awaitTask(
		config,
		workspace.taskUPID as string,
		workspace.taskExpiresAt,
		fetcher,
		now,
	);

	if (task.kind === "succeeded") {
		return finishProvisioning(db, lease, now, "clone_confirmed");
	}
	if (task.kind === "failed") {
		failWorkspaceProvision(db, lease, "clone_task_failed", task.message, now);

		return { processed: 1, status: "task_failed" };
	}
	if (task.kind === "timed_out") {
		failWorkspaceProvision(
			db,
			lease,
			"clone_task_timeout",
			"proxmox clone task did not finish before its deadline",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

	return { processed: 1, status: "awaiting_task" };
}

// reconcileCandidate recovers from a lost clone response.
//
// A persisted VMID with no UPID means the controller stopped between recording the candidate and
// recording the clone task, so the clone may or may not have landed. Proxmox is the only source of
// truth here, and the container is never modified whatever the answer is.
async function reconcileCandidate(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const api = workspaceNode(config, workspace);
	const container = await containerConfig(
		api,
		workspace.vmid as number,
		fetcher,
	);

	if (container.kind === "failed") {
		noteWorkspaceIssue(db, lease, container.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_reconciliation" };
	}

	if (container.kind === "forbidden") {
		// A pool-scoped token cannot read a guest outside its pool, so this covers a VMID that is
		// free, deleted, or someone else's alike. None of them may be adopted.
		const membership = await poolContainsVMID(
			api,
			config.PROXMOX_POOL as string,
			workspace.vmid as number,
			fetcher,
		);
		if (membership.kind === "failed") {
			noteWorkspaceIssue(db, lease, membership.message, now);
			releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

			return { processed: 1, status: "awaiting_reconciliation" };
		}
		if (membership.kind === "outside") {
			releaseWorkspaceCandidateVMID(
				db,
				lease,
				"candidate VMID is not in the controller pool and was left untouched",
				now,
			);
			releaseWorkspaceOperation(db, lease, 0, now);

			return { processed: 1, status: "vmid_released" };
		}

		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_reconciliation" };
	}

	if (container.kind === "missing") {
		// "Does not exist" covers both a clone that never started and one still creating the
		// guest, so Proxmox's task list decides between them. Guessing wrong in this direction
		// orphans a real container wearing this workspace's ownership marker.
		const running = await runningCloneTask(
			api,
			workspace.vmid as number,
			fetcher,
		);
		if (running.kind === "failed") {
			releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

			return { processed: 1, status: "awaiting_reconciliation" };
		}
		if (running.kind === "found") {
			// The lost UPID is recoverable after all. Resume polling it instead of cloning again.
			recordWorkspaceTask(
				db,
				lease,
				{
					expiresAt: taskExpiry(now),
					kind: "provision",
					step: "clone task accepted",
					upid: running.upid,
				},
				now,
			);
			releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

			return { processed: 1, status: "task_recovered" };
		}

		// Nothing was created and nothing is being created. Allocate a fresh candidate rather than
		// reusing this VMID, which another Proxmox client may have taken in the meantime.
		releaseWorkspaceCandidateVMID(
			db,
			lease,
			"candidate VMID has no container and no running clone; a new candidate will be requested",
			now,
		);
		releaseWorkspaceOperation(db, lease, 0, now);

		return { processed: 1, status: "vmid_released" };
	}

	const marker = parseOwnershipMarker(containerDescription(container.config));
	if (
		!ownershipMatches(marker, {
			controllerID: config.CONTROLLER_ID as string,
			ownershipToken: workspace.ownershipToken,
			workspaceID: workspace.id,
		})
	) {
		// The container belongs to another controller, another workspace, or another tool. Walk
		// away from the VMID and leave the container entirely alone.
		releaseWorkspaceCandidateVMID(
			db,
			lease,
			"candidate VMID belongs to an unverified container and was left untouched",
			now,
		);
		releaseWorkspaceOperation(db, lease, 0, now);

		return { processed: 1, status: "vmid_released" };
	}

	return finishProvisioning(db, lease, now, "vmid_adopted");
}

// finishProvisioning records the confirmed clone and hands off to the boot step.
function finishProvisioning(
	db: Database.Database,
	lease: OperationLease,
	now: Date,
	status: WorkspaceOperationRun["status"],
): WorkspaceOperationRun {
	confirmWorkspaceClone(db, lease, now);
	advanceWorkspaceProvision(
		db,
		lease,
		{ phase: "clone-confirmed", step: "clone confirmed" },
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status };
}

// submitClone allocates a candidate VMID and submits the linked clone.
async function submitClone(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const api = proxmoxCredentials(config);
	const vmid = await nextProxmoxVMID(api, fetcher);
	if (vmid.kind === "failed") {
		noteWorkspaceIssue(db, lease, vmid.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	const prepared = prepareWorkspaceProvision(
		db,
		lease,
		api.node,
		vmid.vmid,
		now,
	);
	if (prepared.kind !== "prepared") {
		return { processed: 1, status: "stale_operation" };
	}

	const clone = await cloneWorkspace(
		api,
		{
			controllerID: config.CONTROLLER_ID as string,
			createdAt: now.toISOString(),
			hostname: workspace.hostname,
			node: api.node,
			ownershipToken: workspace.ownershipToken,
			pool: config.PROXMOX_POOL as string,
			templateVMID: config.PROXMOX_TEMPLATE_VMID as number,
			vmid: vmid.vmid,
			workspaceID: workspace.id,
		},
		fetcher,
	);
	if (clone.kind === "failed") {
		// The outcome is unknown: the clone may still have been accepted. The persisted VMID sends
		// the next pass through reconciliation rather than blindly retrying the clone.
		noteWorkspaceIssue(db, lease, clone.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	const recorded = recordWorkspaceTask(
		db,
		lease,
		{
			expiresAt: taskExpiry(now),
			kind: "provision",
			phase: "clone-submitted",
			step: "clone task accepted",
			upid: clone.upid,
		},
		now,
	);
	if (recorded.kind !== "prepared") {
		return { processed: 1, status: "stale_operation" };
	}

	releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

	return { processed: 1, status: "clone_submitted" };
}
