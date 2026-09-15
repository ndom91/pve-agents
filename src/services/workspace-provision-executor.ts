import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import {
	confirmWorkspaceClone,
	failWorkspaceProvision,
	prepareWorkspaceProvision,
	recordWorkspaceTask,
	releaseWorkspaceCandidateVMID,
	releaseWorkspaceOperation,
	type WorkspaceProvision,
	workspaceProvision,
} from "../db/workspace-repository";
import { cloneWorkspace, nextProxmoxVMID } from "./proxmox-clone";
import { containerConfig, containerDescription } from "./proxmox-container";
import type { Fetcher } from "./proxmox-http";
import { ownershipMatches, parseOwnershipMarker } from "./proxmox-ownership";
import {
	awaitTask,
	POLL_INTERVAL_MS,
	proxmoxCredentials,
	taskExpiry,
	type WorkspaceOperationRun,
} from "./workspace-task";

// executeWorkspaceProvision advances one provision operation by exactly one durable step.
//
// Every step is chosen from persisted state rather than in-memory progress, so a controller that
// crashes mid-task resumes from the same decision the next pass would have made anyway.
export async function executeWorkspaceProvision(
	db: Database.Database,
	config: ControllerConfig,
	operationID: string,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const workspace = workspaceProvision(db, operationID);
	if (workspace === undefined) {
		releaseWorkspaceOperation(db, operationID, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "stale_operation" };
	}

	if (workspace.taskUPID !== undefined) {
		return pollClone(db, config, operationID, workspace, fetcher, now);
	}
	if (workspace.vmid !== undefined) {
		return reconcileCandidate(db, config, operationID, workspace, fetcher, now);
	}

	return submitClone(db, config, operationID, workspace, fetcher, now);
}

// pollClone resolves a submitted clone task against Proxmox.
async function pollClone(
	db: Database.Database,
	config: ControllerConfig,
	operationID: string,
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
		confirmWorkspaceClone(db, operationID, now);
		releaseWorkspaceOperation(db, operationID, 0, now);

		return { processed: 1, status: "clone_confirmed" };
	}
	if (task.kind === "failed") {
		failWorkspaceProvision(
			db,
			operationID,
			"clone_task_failed",
			task.message,
			now,
		);

		return { processed: 1, status: "task_failed" };
	}
	if (task.kind === "timed_out") {
		failWorkspaceProvision(
			db,
			operationID,
			"clone_task_timeout",
			"proxmox clone task did not finish before its deadline",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	releaseWorkspaceOperation(db, operationID, POLL_INTERVAL_MS, now);

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
	operationID: string,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const api = proxmoxCredentials(config);
	const container = await containerConfig(
		api.apiURL,
		api.tokenID,
		api.tokenSecret,
		workspace.node ?? api.node,
		workspace.vmid as number,
		fetcher,
	);

	if (container.kind === "failed") {
		releaseWorkspaceOperation(db, operationID, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_reconciliation" };
	}

	if (container.kind === "missing") {
		// The clone never landed. Allocate a fresh candidate rather than reusing this VMID, which
		// another Proxmox client may have taken in the meantime.
		releaseWorkspaceCandidateVMID(
			db,
			operationID,
			"candidate VMID has no container; a new candidate will be requested",
			now,
		);
		releaseWorkspaceOperation(db, operationID, 0, now);

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
			operationID,
			"candidate VMID belongs to an unverified container and was left untouched",
			now,
		);
		releaseWorkspaceOperation(db, operationID, 0, now);

		return { processed: 1, status: "vmid_released" };
	}

	confirmWorkspaceClone(db, operationID, now);
	releaseWorkspaceOperation(db, operationID, 0, now);

	return { processed: 1, status: "vmid_adopted" };
}

// submitClone allocates a candidate VMID and submits the linked clone.
async function submitClone(
	db: Database.Database,
	config: ControllerConfig,
	operationID: string,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const api = proxmoxCredentials(config);
	const vmid = await nextProxmoxVMID(
		api.apiURL,
		api.tokenID,
		api.tokenSecret,
		fetcher,
	);
	if (vmid.kind === "failed") {
		releaseWorkspaceOperation(db, operationID, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	const prepared = prepareWorkspaceProvision(
		db,
		operationID,
		api.node,
		vmid.vmid,
		now,
	);
	if (prepared.kind !== "prepared") {
		return { processed: 1, status: "stale_operation" };
	}

	const clone = await cloneWorkspace(
		api.apiURL,
		api.tokenID,
		api.tokenSecret,
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
		releaseWorkspaceOperation(db, operationID, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	const recorded = recordWorkspaceTask(
		db,
		operationID,
		{
			expiresAt: taskExpiry(now),
			kind: "provision",
			step: "clone task accepted",
			upid: clone.upid,
		},
		now,
	);
	if (recorded.kind !== "prepared") {
		return { processed: 1, status: "stale_operation" };
	}

	releaseWorkspaceOperation(db, operationID, POLL_INTERVAL_MS, now);

	return { processed: 1, status: "clone_submitted" };
}
