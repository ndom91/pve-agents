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
import type { DestroyPhase } from "../domain/workspace";
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
import { poolMembers } from "./proxmox-pool";
import {
	awaitTask,
	POLL_INTERVAL_MS,
	taskExpiry,
	type WorkspaceOperationRun,
	workspaceNode,
} from "./workspace-task";

// Prose for the operator, derived from the phase. Nothing branches on these.
const STEPS: Record<DestroyPhase, string> = {
	"delete-submitted": "delete task accepted",
	"shutdown-submitted": "shutdown task accepted",
	"shutdown-tried": "shutdown attempted; forcing a stop if still running",
	"stop-submitted": "stop task accepted",
};

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

	if (workspace.phase === "shutdown-submitted") {
		// A guest that ignores ACPI is ordinary, not an error, and a shutdown that reports success
		// without stopping the guest is the same situation. Both mean: try a forced stop next.
		advance(db, lease, "shutdown-tried", now);

		return { processed: 1, status: "awaiting_reconciliation" };
	}

	if (task.kind !== "succeeded") {
		haltWorkspaceDestroy(
			db,
			lease,
			workspace.phase === "delete-submitted"
				? "destroy_delete_failed"
				: "destroy_stop_failed",
			task.kind === "failed"
				? task.message
				: "proxmox teardown task did not finish before its deadline",
			now,
		);

		return { processed: 1, status: "destroy_halted" };
	}

	if (workspace.phase === "delete-submitted") {
		completeWorkspaceDestroy(
			db,
			lease,
			"proxmox confirmed the container was deleted",
			now,
		);

		return { processed: 1, status: "container_deleted" };
	}

	advance(db, lease, "shutdown-tried", now);

	return { processed: 1, status: "awaiting_reconciliation" };
}

// advance records a finished teardown task and lets the next pass act on the new phase.
function advance(
	db: Database.Database,
	lease: OperationLease,
	phase: DestroyPhase,
	now: Date,
): void {
	advanceWorkspaceDestroy(db, lease, phase, STEPS[phase], now);
	releaseWorkspaceOperation(db, lease, 0, now);
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
	if (container.kind === "forbidden") {
		const pool = await poolMembers(api, config.PROXMOX_POOL as string, fetcher);
		if (pool.kind === "failed") {
			releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

			return { processed: 1, status: "awaiting_reconciliation" };
		}
		if (pool.vmids.has(vmid)) {
			// In our pool but unreadable: a real permission problem, not an absent container.
			haltWorkspaceDestroy(
				db,
				lease,
				"destroy_forbidden",
				`container ${vmid} is in the pool but the controller token cannot read it`,
				now,
			);

			return { processed: 1, status: "destroy_halted" };
		}

		completeWorkspaceDestroy(
			db,
			lease,
			"container is no longer in the controller pool",
			now,
		);

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
		haltWorkspaceDestroy(
			db,
			lease,
			"destroy_ownership_mismatch",
			`container ${vmid} does not carry this workspace's ownership marker and was left untouched`,
			now,
		);

		return { processed: 1, status: "destroy_halted" };
	}

	const state = await containerState(api, vmid, fetcher);
	if (state.kind === "failed") {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_reconciliation" };
	}
	if (state.kind === "missing" || state.kind === "forbidden") {
		completeWorkspaceDestroy(db, lease, "container was already absent", now);

		return { processed: 1, status: "container_missing" };
	}

	if (state.kind === "running") {
		// Once shutdown has been tried, a still-running guest will not answer a second ACPI
		// request either: escalate rather than cycling.
		if (workspace.phase === "shutdown-tried") {
			return submitTeardownTask(
				db,
				lease,
				await stopContainer(api, vmid, fetcher),
				"stop-submitted",
				"stop_submitted",
				now,
			);
		}

		return submitTeardownTask(
			db,
			lease,
			await shutdownContainer(api, vmid, fetcher),
			"shutdown-submitted",
			"shutdown_submitted",
			now,
		);
	}

	return submitTeardownTask(
		db,
		lease,
		await deleteContainer(api, vmid, fetcher),
		"delete-submitted",
		"delete_submitted",
		now,
	);
}

function submitTeardownTask(
	db: Database.Database,
	lease: OperationLease,
	request: ProxmoxTaskRequest,
	phase: DestroyPhase,
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
		{
			expiresAt: taskExpiry(now),
			kind: "destroy",
			phase,
			step: STEPS[phase],
			upid: request.upid,
		},
		now,
	);
	if (recorded.kind !== "prepared") {
		return { processed: 1, status: "stale_operation" };
	}

	releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

	return { processed: 1, status };
}
