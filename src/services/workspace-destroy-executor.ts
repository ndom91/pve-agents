import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import {
	advanceWorkspaceDestroy,
	completeWorkspaceDestroy,
	haltWorkspaceDestroy,
	type OperationLease,
	recordWorkspaceTask,
	releaseWorkspaceOperation,
	type WorkspaceTeardown,
	workspaceTeardown,
} from "../db/workspace-repository";
import {
	containerConfig,
	containerDescription,
	containerState,
	deleteContainer,
	shutdownContainer,
	stopContainer,
} from "./proxmox-container";
import type { Fetcher, ProxmoxTaskRequest } from "./proxmox-http";
import { ownershipMatches, parseOwnershipMarker } from "./proxmox-ownership";
import {
	awaitTask,
	POLL_INTERVAL_MS,
	taskExpiry,
	type WorkspaceOperationRun,
	workspaceNode,
} from "./workspace-task";

// Steps are persisted on the workspace and are the only record of how far teardown has progressed.
const SHUTDOWN_SUBMITTED = "shutdown task accepted";
const STOP_SUBMITTED = "stop task accepted";
const DELETE_SUBMITTED = "delete task accepted";
const SHUTDOWN_CONFIRMED = "shutdown confirmed";
const STOP_REQUIRED = "clean shutdown failed; force stop required";

// executeWorkspaceDestroy advances one destroy operation by exactly one durable step.
//
// Destruction is idempotent by design: an absent container is success, however often it is asked
// for, and no Proxmox action is taken before ownership is re-proved from the LXC description.
export async function executeWorkspaceDestroy(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const workspace = workspaceTeardown(db, lease);
	if (workspace === undefined) {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "stale_operation" };
	}

	if (workspace.vmid === undefined) {
		// No clone was ever recorded, so there is nothing on Proxmox to remove.
		completeWorkspaceDestroy(
			db,
			lease,
			"workspace had no container to destroy",
			now,
		);

		return { processed: 1, status: "container_missing" };
	}

	if (workspace.taskUPID !== undefined) {
		return pollTeardownTask(db, config, lease, workspace, fetcher, now);
	}

	return teardownContainer(db, config, lease, workspace, fetcher, now);
}

// pollTeardownTask resolves whichever teardown task the last pass submitted.
async function pollTeardownTask(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceTeardown,
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

	if (workspace.currentStep === SHUTDOWN_SUBMITTED) {
		// A guest that ignores ACPI is ordinary, not an error. Either outcome moves teardown
		// forward; only the next action differs.
		const step = task.kind === "succeeded" ? SHUTDOWN_CONFIRMED : STOP_REQUIRED;
		advanceWorkspaceDestroy(db, lease, step, now);
		releaseWorkspaceOperation(db, lease, 0, now);

		return { processed: 1, status: "awaiting_reconciliation" };
	}

	if (task.kind !== "succeeded") {
		return haltTeardown(
			db,
			lease,
			workspace.currentStep === DELETE_SUBMITTED
				? "destroy_delete_failed"
				: "destroy_stop_failed",
			task.kind === "failed"
				? task.message
				: "proxmox teardown task did not finish before its deadline",
			now,
		);
	}

	if (workspace.currentStep === DELETE_SUBMITTED) {
		completeWorkspaceDestroy(
			db,
			lease,
			"proxmox confirmed the container was deleted",
			now,
		);

		return { processed: 1, status: "container_deleted" };
	}

	advanceWorkspaceDestroy(db, lease, "container stopped", now);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "awaiting_reconciliation" };
}

// teardownContainer verifies ownership, then takes the next teardown action.
async function teardownContainer(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceTeardown,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	// The workspace records the node its clone actually landed on, which need not be the node this
	// controller is configured to clone onto.
	const api = workspaceNode(config, workspace);
	const vmid = workspace.vmid as number;

	const container = await containerConfig(api, vmid, fetcher);
	if (container.kind === "failed") {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_reconciliation" };
	}
	if (container.kind === "missing") {
		// Already gone, whether this controller removed it or someone else did. Destruction is
		// idempotent, so a repeated request is success rather than an error.
		completeWorkspaceDestroy(db, lease, "container was already absent", now);

		return { processed: 1, status: "container_missing" };
	}

	// Ownership is re-proved before every action, shutdown included. Shutting down a container this
	// controller does not own is itself destructive, so verification cannot wait until delete.
	const marker = parseOwnershipMarker(containerDescription(container.config));
	if (
		!ownershipMatches(marker, {
			controllerID: config.CONTROLLER_ID as string,
			ownershipToken: workspace.ownershipToken,
			workspaceID: workspace.id,
		})
	) {
		return haltTeardown(
			db,
			lease,
			"destroy_ownership_mismatch",
			`container ${vmid} does not carry this workspace's ownership marker and was left untouched`,
			now,
		);
	}

	// A guest still running after its shutdown task reported success will never respond to a
	// second ACPI request either. Escalating here is what stops shutdown -> confirm -> shutdown
	// cycling until the operation deadline.
	const shutdownAlreadyTried =
		workspace.currentStep === STOP_REQUIRED ||
		workspace.currentStep === SHUTDOWN_CONFIRMED;

	if (workspace.currentStep === STOP_REQUIRED) {
		return submitTeardownTask(
			db,
			lease,
			await stopContainer(api, vmid, fetcher),
			STOP_SUBMITTED,
			"stop_submitted",
			now,
		);
	}

	const state = await containerState(api, vmid, fetcher);
	if (state.kind === "failed") {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_reconciliation" };
	}
	if (state.kind === "missing") {
		completeWorkspaceDestroy(db, lease, "container was already absent", now);

		return { processed: 1, status: "container_missing" };
	}

	if (state.kind === "running") {
		if (shutdownAlreadyTried) {
			return submitTeardownTask(
				db,
				lease,
				await stopContainer(api, vmid, fetcher),
				STOP_SUBMITTED,
				"stop_submitted",
				now,
			);
		}

		return submitTeardownTask(
			db,
			lease,
			await shutdownContainer(api, vmid, fetcher),
			SHUTDOWN_SUBMITTED,
			"shutdown_submitted",
			now,
		);
	}

	return submitTeardownTask(
		db,
		lease,
		await deleteContainer(api, vmid, fetcher),
		DELETE_SUBMITTED,
		"delete_submitted",
		now,
	);
}

function submitTeardownTask(
	db: Database.Database,
	lease: OperationLease,
	request: ProxmoxTaskRequest,
	step: string,
	status: WorkspaceOperationRun["status"],
	now: Date,
): WorkspaceOperationRun {
	if (request.kind === "failed") {
		// The action may still have been accepted, so the next pass re-inspects the container
		// rather than assuming the request never landed.
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	const recorded = recordWorkspaceTask(
		db,
		lease,
		{ expiresAt: taskExpiry(now), kind: "destroy", step, upid: request.upid },
		now,
	);
	if (recorded.kind !== "prepared") {
		return { processed: 1, status: "stale_operation" };
	}

	releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

	return { processed: 1, status };
}

function haltTeardown(
	db: Database.Database,
	lease: OperationLease,
	code: string,
	message: string,
	now: Date,
): WorkspaceOperationRun {
	haltWorkspaceDestroy(db, lease, code, message, now);

	return { processed: 1, status: "destroy_halted" };
}
