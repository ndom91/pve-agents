import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import {
	failedTranscriptCaptures,
	hasWorkspaceTranscript,
	saveWorkspaceTranscript,
	TRANSCRIPT_UNSAVED,
} from "../db/transcript-repository";
import {
	advanceWorkspaceDestroy,
	completeWorkspaceDestroy,
	haltWorkspaceDestroy,
	type OperationLease,
	recordWorkspaceNote,
	recordWorkspaceTask,
	releaseWorkspaceOperation,
	type WorkspaceTeardown,
	workspaceTeardown,
} from "../db/workspace-repository";
import type { DestroyPhase } from "../domain/workspace";
import { LEGACY_SNAPSHOT_HARNESS } from "../harness";
import { runnerTranscript } from "./agent-runner";
import { stopWorkspaceForwards } from "./port-forward";
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
import { poolContainsVMID } from "./proxmox-pool";
import { forgetHost, runSsh, type SshRunner } from "./ssh";
import {
	awaitTask,
	retry,
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

// TRANSCRIPT_ATTEMPTS is how many passes may fail to read the conversation before the destroy goes
// ahead without it.
//
// Bounded, not "until it works". A runner that has crashed will never answer, and refusing to
// destroy until it does would turn one dead process into a container nobody can remove, reaper
// included. Three passes rides out a slow ssh or a runner mid-restart; anything longer is not
// coming back. The loss is written to the timeline either way, so it is never silent.
const TRANSCRIPT_ATTEMPTS = 3;

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
	ssh: SshRunner = runSsh,
): Promise<WorkspaceOperationRun> {
	const workspace = workspaceTeardown(db, lease);
	if (workspace === undefined) {
		return retry(db, lease, now, { status: "stale_operation" });
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

	return teardownContainer(db, config, lease, workspace, fetcher, now, ssh);
}

// keepTranscript saves the agent's conversation before its container is shut down.
//
// "retry" means try again next pass and do not shut anything down yet. Everything else means go
// ahead: the conversation is saved, was saved on an earlier pass, cannot be reached at all, or has
// failed to arrive often enough that waiting longer would only hold the container hostage.
async function keepTranscript(
	db: Database.Database,
	config: ControllerConfig,
	workspace: WorkspaceTeardown,
	ssh: SshRunner,
	now: Date,
): Promise<"proceed" | "retry"> {
	// No address means provisioning never got as far as a runner, so there is nothing to keep.
	if (
		config.WORKSPACE_SSH_KEY_PATH === undefined ||
		workspace.ip === undefined ||
		hasWorkspaceTranscript(db, workspace.id)
	) {
		return "proceed";
	}

	const failures = failedTranscriptCaptures(db, workspace.id);
	if (failures >= TRANSCRIPT_ATTEMPTS) {
		return "proceed";
	}

	const snapshot = await runnerTranscript(
		{
			address: workspace.ip,
			keyPath: config.WORKSPACE_SSH_KEY_PATH,
			user: config.WORKSPACE_SSH_USER,
		},
		ssh,
	);
	if (snapshot !== undefined) {
		saveWorkspaceTranscript(
			db,
			workspace.id,
			{
				harness: snapshot.harness ?? LEGACY_SNAPSHOT_HARNESS,
				messages: snapshot.messages,
				sessionId: snapshot.sessionId,
			},
			now,
		);
		recordWorkspaceNote(
			db,
			workspace.id,
			"workspace.transcript_saved",
			`conversation saved: ${snapshot.messages.length} messages`,
			now,
		);

		return "proceed";
	}

	const attempt = failures + 1;
	const final = attempt >= TRANSCRIPT_ATTEMPTS;
	recordWorkspaceNote(
		db,
		workspace.id,
		TRANSCRIPT_UNSAVED,
		final
			? "the agent did not answer; destroying without its conversation"
			: `the agent did not answer (attempt ${attempt} of ${TRANSCRIPT_ATTEMPTS}); trying again before destroying`,
		now,
	);

	return final ? "proceed" : "retry";
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
		return retry(db, lease, now, { status: "awaiting_task" });
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
		await forgetWorkspaceHost(config, workspace);
		// The tunnels die on their own when the container goes -- ssh loses its connection and the
		// registry forgets the child on exit. This makes it prompt and certain rather than a side
		// effect: an ssh that hangs on a dead host would hold its allocated port until it noticed.
		stopWorkspaceForwards(workspace.id);
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

// forgetWorkspaceHost drops the destroyed workspace's pinned SSH host key.
//
// Left pinned, the next workspace handed this address fails host verification, and the error
// names a key mismatch rather than the recycled address that actually caused it.
async function forgetWorkspaceHost(
	config: ControllerConfig,
	workspace: WorkspaceTeardown,
): Promise<void> {
	if (
		config.WORKSPACE_SSH_KEY_PATH === undefined ||
		workspace.ip === undefined
	) {
		return;
	}

	await forgetHost(config.WORKSPACE_SSH_KEY_PATH, workspace.ip);
}

// teardownContainer verifies ownership, then takes the next teardown action.
async function teardownContainer(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceTeardown,
	fetcher: Fetcher,
	now: Date,
	ssh: SshRunner,
): Promise<WorkspaceOperationRun> {
	// The workspace records the node its clone actually landed on, which need not be the node this
	// controller is configured to clone onto.
	const api = workspaceNode(config, workspace);
	const vmid = workspace.vmid as number;

	const container = await containerConfig(api, vmid, fetcher);
	if (container.kind === "failed") {
		return retry(db, lease, now, {
			message: container.message,
			status: "awaiting_reconciliation",
		});
	}
	if (container.kind === "missing") {
		// Already gone, whether this controller removed it or someone else did. Destruction is
		// idempotent, so a repeated request is success rather than an error.
		completeWorkspaceDestroy(db, lease, "container was already absent", now);

		return { processed: 1, status: "container_missing" };
	}
	if (container.kind === "forbidden") {
		const membership = await poolContainsVMID(
			api,
			config.PROXMOX_POOL as string,
			vmid,
			fetcher,
		);
		if (membership.kind === "failed") {
			return retry(db, lease, now, {
				message: membership.message,
				status: "awaiting_reconciliation",
			});
		}
		if (membership.kind === "inside") {
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
		return retry(db, lease, now, {
			message: state.message,
			status: "awaiting_reconciliation",
		});
	}
	if (state.kind === "missing" || state.kind === "forbidden") {
		completeWorkspaceDestroy(db, lease, "container was already absent", now);

		return { processed: 1, status: "container_missing" };
	}

	if (state.kind === "running") {
		// The conversation lives only in the runner, so this is the last moment it can be read.
		// After ownership is re-proved, deliberately: reading a transcript off a container this
		// controller does not own would be keeping somebody else's conversation.
		if (
			workspace.phase === undefined &&
			(await keepTranscript(db, config, workspace, ssh, now)) === "retry"
		) {
			return retry(db, lease, now, { status: "awaiting_transcript" });
		}

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
		return retry(db, lease, now, {
			message: request.message,
			status: "request_failed",
		});
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

	return retry(db, lease, now, { status });
}
