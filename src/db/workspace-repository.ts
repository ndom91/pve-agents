import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
	DEFAULT_WORKSPACE_ACTIVITY,
	DEFAULT_WORKSPACE_STATUS,
	type DestroyPhase,
	nextWorkspaceStatus,
	type WorkspaceActivity,
	type WorkspaceStatus,
	type WorkspaceTarget,
} from "../domain/workspace";

// CreateWorkspaceInput is the validated request used to persist a workspace.
export type CreateWorkspaceInput = {
	herdrSession: string;
	idempotencyKey: string;
	purpose?: string;
	repository: string;
	ref: string;
};

// Workspace is the controller's persisted workspace record.
export type Workspace = {
	activity: WorkspaceActivity;
	createdAt: string;
	currentStep: string;
	desiredState: WorkspaceTarget;
	herdrSession: string;
	hostname: string;
	id: string;
	purpose?: string;
	repository: string;
	ref: string;
	status: WorkspaceStatus;
	updatedAt: string;
};

// CreateWorkspaceResult distinguishes a newly persisted workspace from an idempotent replay.
export type CreateWorkspaceResult =
	| { kind: "created"; workspace: Workspace }
	| { kind: "existing"; workspace: Workspace }
	| { kind: "idempotency_conflict" };

export type WorkspaceOperation = {
	attemptCount: number;
	claimedAt?: string;
	completedAt?: string;
	createdAt: string;
	errorMessage?: string;
	id: string;
	kind: "destroy" | "provision";
	leaseExpiresAt?: string;
	nextRunAt?: string;
	status: "cancelled" | "completed" | "failed" | "queued" | "running";
	workspaceId: string;
};

// OperationLease identifies both the operation and the specific lease this worker holds on it.
//
// The id alone is not enough: a lease expires, another worker claims the same operation, and the
// original worker is still running. Only the token distinguishes them.
export type OperationLease = {
	id: string;
	token: string;
};

// WorkspaceOperationClaim is the result of attempting to lease the next operation.
export type WorkspaceOperationClaim =
	| { kind: "claimed"; lease: OperationLease; operation: WorkspaceOperation }
	| { kind: "empty" };

export type WorkspaceOperationResult =
	| { kind: "already_queued"; message: string }
	| { kind: "created"; operation: WorkspaceOperation; workspace: Workspace }
	| { kind: "invalid_transition"; message: string }
	| { kind: "not_found" };

// WorkspaceEvent is one entry in a workspace's redacted, append-only timeline.
export type WorkspaceEvent = {
	createdAt: string;
	eventType: string;
	message: string;
};

// WorkspaceMutation is the durable result of one guarded write against a leased operation.
export type WorkspaceMutation =
	| { kind: "prepared" }
	| { kind: "stale_operation" };

// WorkspaceTeardown is the private workspace data needed to destroy one LXC.
export type WorkspaceTeardown = WorkspaceProvision & {
	phase?: DestroyPhase;
};

// WorkspaceProvision is the private workspace data needed to submit one clone request.
export type WorkspaceProvision = {
	hostname: string;
	id: string;
	node?: string;
	ownershipToken: string;
	taskExpiresAt?: string;
	taskUPID?: string;
	vmid?: number;
};

type WorkspaceRow = {
	activity: WorkspaceActivity;
	created_at: string;
	current_step: string;
	desired_state: WorkspaceTarget;
	herdr_session: string;
	hostname: string;
	id: string;
	purpose: string | null;
	repository: string;
	ref: string;
	status: WorkspaceStatus;
	updated_at: string;
};

type WorkspaceOperationRow = {
	attempt_count: number;
	claimed_at: string | null;
	completed_at: string | null;
	created_at: string;
	error_message: string | null;
	id: string;
	kind: WorkspaceOperation["kind"];
	lease_expires_at: string | null;
	next_run_at: string | null;
	status: WorkspaceOperation["status"];
	workspace_id: string;
};

const OPERATION_LEASE_MS = 60_000;

// createWorkspace persists workspace intent and protects it with the supplied idempotency key.
export function createWorkspace(
	db: Database.Database,
	input: CreateWorkspaceInput,
): CreateWorkspaceResult {
	const requestHash = workspaceRequestHash(input);
	const persist = db.transaction((): CreateWorkspaceResult => {
		const existing = db
			.prepare(
				"SELECT request_hash, workspace_id FROM idempotency_keys WHERE key = ?",
			)
			.get(input.idempotencyKey) as
			| { request_hash: string; workspace_id: string }
			| undefined;

		if (existing !== undefined) {
			if (existing.request_hash !== requestHash) {
				return { kind: "idempotency_conflict" };
			}

			const workspace = workspaceById(db, existing.workspace_id);
			if (workspace === undefined) {
				throw new Error(
					"workspace-repository: idempotency key references a missing workspace",
				);
			}

			return { kind: "existing", workspace };
		}

		const now = new Date().toISOString();
		const id = randomUUID();
		const workspace: Workspace = {
			activity: DEFAULT_WORKSPACE_ACTIVITY,
			createdAt: now,
			currentStep: "workspace persisted",
			desiredState: "present",
			herdrSession: input.herdrSession,
			hostname: `agent-${id.slice(0, 4)}`,
			id,
			purpose: input.purpose,
			repository: input.repository,
			ref: input.ref,
			status: DEFAULT_WORKSPACE_STATUS,
			updatedAt: now,
		};

		db.prepare(
			`INSERT INTO workspaces (
				id, ownership_token, desired_state, status, activity, repository, ref, purpose,
				hostname, herdr_session, created_at, updated_at, current_step
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			workspace.id,
			randomUUID(),
			workspace.desiredState,
			workspace.status,
			workspace.activity,
			workspace.repository,
			workspace.ref,
			workspace.purpose,
			workspace.hostname,
			workspace.herdrSession,
			workspace.createdAt,
			workspace.updatedAt,
			workspace.currentStep,
		);
		db.prepare(
			"INSERT INTO idempotency_keys (key, request_hash, workspace_id) VALUES (?, ?, ?)",
		).run(input.idempotencyKey, requestHash, workspace.id);
		appendWorkspaceEvent(
			db,
			workspace.id,
			"workspace.requested",
			"workspace request accepted",
			now,
		);
		insertOperation(db, workspace.id, "provision", now);

		return { kind: "created", workspace };
	});

	return persist();
}

// claimWorkspaceOperation leases the next due operation of one kind for one worker.
//
// The kind filter keeps each executor to its own lifecycle. The provision executor must never
// claim a destroy operation, because destruction has its own ownership-verification rules.
export function claimWorkspaceOperation(
	db: Database.Database,
	kind: WorkspaceOperation["kind"],
	now: Date = new Date(),
): WorkspaceOperationClaim {
	const claim = db.transaction((): WorkspaceOperationClaim => {
		const nowText = now.toISOString();
		const row = db
			.prepare(
				`SELECT id, workspace_id, kind, status, attempt_count, created_at, claimed_at,
					lease_expires_at, completed_at, error_message, next_run_at
				 FROM workspace_operations
				 WHERE kind = ?
					AND (next_run_at IS NULL OR next_run_at <= ?)
					AND (status = 'queued' OR (status = 'running' AND lease_expires_at < ?))
				 ORDER BY created_at ASC LIMIT 1`,
			)
			.get(kind, nowText, nowText) as WorkspaceOperationRow | undefined;
		if (row === undefined) {
			return { kind: "empty" };
		}

		const leaseExpiresAt = new Date(
			now.getTime() + OPERATION_LEASE_MS,
		).toISOString();
		const leaseToken = randomUUID();
		const updated = db
			.prepare(
				`UPDATE workspace_operations
				 SET status = 'running', attempt_count = attempt_count + 1, claimed_at = ?,
					lease_expires_at = ?, lease_token = ?, error_message = NULL, next_run_at = NULL
				 WHERE id = ?`,
			)
			.run(nowText, leaseExpiresAt, leaseToken, row.id);
		if (updated.changes !== 1) {
			return { kind: "empty" };
		}

		return {
			kind: "claimed",
			lease: { id: row.id, token: leaseToken },
			operation: {
				...workspaceOperationFromRow({ ...row, next_run_at: null }),
				attemptCount: row.attempt_count + 1,
				claimedAt: nowText,
				leaseExpiresAt,
				status: "running",
			},
		};
	});

	return claim.immediate();
}

// completeWorkspaceOperation marks a successfully executed operation as durable history.
export function completeWorkspaceOperation(
	db: Database.Database,
	lease: OperationLease,
	now: Date = new Date(),
): void {
	db.prepare(
		`UPDATE workspace_operations
		 SET status = 'completed', completed_at = ?, lease_expires_at = NULL, lease_token = NULL
		 WHERE id = ? AND status = 'running' AND lease_token = ?`,
	).run(now.toISOString(), lease.id, lease.token);
}

// prepareWorkspaceProvision records a VMID before any Proxmox clone request is submitted.
export function prepareWorkspaceProvision(
	db: Database.Database,
	lease: OperationLease,
	node: string,
	vmid: number,
	now: Date = new Date(),
): WorkspaceMutation {
	return withRunningOperation(db, lease, "provision", (workspaceId) => {
		db.prepare(
			`UPDATE workspaces
			 SET node = ?, vmid = ?, status = 'provisioning', current_step = ?, updated_at = ?
			 WHERE id = ?`,
		).run(
			node,
			vmid,
			"candidate VMID persisted",
			now.toISOString(),
			workspaceId,
		);
	});
}

// recordWorkspaceTask stores the Proxmox UPID before the executor continues to another step.
//
// The deadline is persisted with the UPID so a task that never reaches a terminal Proxmox status
// still fails on a bounded wall clock instead of being polled forever.
export function recordWorkspaceTask(
	db: Database.Database,
	lease: OperationLease,
	input: {
		expiresAt: string;
		kind: WorkspaceOperation["kind"];
		phase?: DestroyPhase;
		step: string;
		upid: string;
	},
	now: Date = new Date(),
): WorkspaceMutation {
	return withRunningOperation(db, lease, input.kind, (workspaceId) => {
		db.prepare(
			`UPDATE workspaces
			 SET current_task_upid = ?, current_task_expires_at = ?, current_step = ?,
				destroy_phase = COALESCE(?, destroy_phase), updated_at = ?
			 WHERE id = ?`,
		).run(
			input.upid,
			input.expiresAt,
			input.step,
			input.phase ?? null,
			now.toISOString(),
			workspaceId,
		);
	});
}

// advanceWorkspaceDestroy clears a finished destroy task and records the next step.
export function advanceWorkspaceDestroy(
	db: Database.Database,
	lease: OperationLease,
	phase: DestroyPhase,
	step: string,
	now: Date = new Date(),
): WorkspaceMutation {
	return withRunningOperation(db, lease, "destroy", (workspaceId) => {
		db.prepare(
			`UPDATE workspaces
			 SET current_task_upid = NULL, current_task_expires_at = NULL, current_step = ?,
				destroy_phase = ?, updated_at = ?
			 WHERE id = ?`,
		).run(step, phase, now.toISOString(), workspaceId);
	});
}

// completeWorkspaceDestroy records that the workspace LXC is confirmed absent.
export function completeWorkspaceDestroy(
	db: Database.Database,
	lease: OperationLease,
	message: string,
	now: Date = new Date(),
): WorkspaceMutation {
	const nowText = now.toISOString();

	return withRunningOperation(db, lease, "destroy", (workspaceId) => {
		db.prepare(
			`UPDATE workspaces
			 SET status = 'destroyed', desired_state = 'destroyed', destroyed_at = ?,
				current_task_upid = NULL, current_task_expires_at = NULL, current_step = ?,
				destroy_phase = NULL, error_code = NULL, error_message = NULL, error_retryable = NULL,
				error_occurred_at = NULL, updated_at = ?
			 WHERE id = ?`,
		).run(nowText, "destroyed", nowText, workspaceId);
		finishOperation(db, lease, "completed", undefined, nowText);
		appendWorkspaceEvent(
			db,
			workspaceId,
			"workspace.destroyed",
			message,
			nowText,
		);
	});
}

// haltWorkspaceDestroy stops a destruction that must not be retried automatically.
//
// The status stays "destroying" on purpose. The state machine forbids destroying -> failed, and
// rightly so: the desired state is still "destroyed" and teardown is genuinely unfinished. The
// error fields carry the reason, and re-requesting a destroy remains permitted.
export function haltWorkspaceDestroy(
	db: Database.Database,
	lease: OperationLease,
	code: string,
	message: string,
	now: Date = new Date(),
): WorkspaceMutation {
	const nowText = now.toISOString();

	return withRunningOperation(db, lease, "destroy", (workspaceId) => {
		db.prepare(
			`UPDATE workspaces
			 SET current_task_upid = NULL, current_task_expires_at = NULL, error_code = ?,
				error_message = ?, error_retryable = 0, error_occurred_at = ?, updated_at = ?
			 WHERE id = ?`,
		).run(code, message, nowText, nowText, workspaceId);
		finishOperation(db, lease, "failed", message, nowText);
		appendWorkspaceEvent(
			db,
			workspaceId,
			"workspace.destroy_halted",
			message,
			nowText,
		);
	});
}

// confirmWorkspaceClone records a Proxmox-verified clone and clears its task checkpoint.
//
// The workspace stays in "provisioning": a confirmed clone is not a running container, and the
// status only advances to "booting" once a start task has been submitted.
export function confirmWorkspaceClone(
	db: Database.Database,
	lease: OperationLease,
	now: Date = new Date(),
): WorkspaceMutation {
	const nowText = now.toISOString();

	return withRunningOperation(db, lease, "provision", (workspaceId) => {
		db.prepare(
			`UPDATE workspaces
			 SET current_task_upid = NULL, current_task_expires_at = NULL, current_step = ?,
				updated_at = ?
			 WHERE id = ?`,
		).run("clone confirmed", nowText, workspaceId);
		appendWorkspaceEvent(
			db,
			workspaceId,
			"workspace.clone_confirmed",
			"Proxmox confirmed the workspace clone",
			nowText,
		);
	});
}

// releaseWorkspaceCandidateVMID abandons a candidate VMID this controller cannot prove it owns.
//
// This only clears the controller's own record. The Proxmox container, if one exists, is left
// completely untouched; an unverified LXC is never modified or deleted.
export function releaseWorkspaceCandidateVMID(
	db: Database.Database,
	lease: OperationLease,
	reason: string,
	now: Date = new Date(),
): WorkspaceMutation {
	const nowText = now.toISOString();

	return withRunningOperation(db, lease, "provision", (workspaceId) => {
		db.prepare(
			`UPDATE workspaces
			 SET vmid = NULL, current_task_upid = NULL, current_task_expires_at = NULL,
				current_step = ?, updated_at = ?
			 WHERE id = ?`,
		).run("candidate VMID released", nowText, workspaceId);
		appendWorkspaceEvent(
			db,
			workspaceId,
			"workspace.vmid_released",
			reason,
			nowText,
		);
	});
}

// failWorkspaceProvision records a terminal provisioning failure and closes its operation.
//
// The workspace is left retryable: the existing retry endpoint queues a fresh operation, which
// the state machine already permits from "failed".
export function failWorkspaceProvision(
	db: Database.Database,
	lease: OperationLease,
	code: string,
	message: string,
	now: Date = new Date(),
): WorkspaceMutation {
	const nowText = now.toISOString();

	return withRunningOperation(db, lease, "provision", (workspaceId) => {
		db.prepare(
			`UPDATE workspaces
			 SET status = 'failed', current_task_upid = NULL, current_task_expires_at = NULL,
				error_code = ?, error_message = ?, error_retryable = 1, error_occurred_at = ?,
				updated_at = ?
			 WHERE id = ?`,
		).run(code, message, nowText, nowText, workspaceId);
		finishOperation(db, lease, "failed", message, nowText);
		appendWorkspaceEvent(
			db,
			workspaceId,
			"workspace.provision_failed",
			message,
			nowText,
		);
	});
}

// workspaceEvents returns a workspace's timeline, newest last.
export function workspaceEvents(
	db: Database.Database,
	workspaceId: string,
	limit = 100,
): WorkspaceEvent[] {
	return db
		.prepare(
			`SELECT created_at, event_type, message FROM workspace_events
			 WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`,
		)
		.all(workspaceId, limit)
		.reverse()
		.map((row) => {
			const entry = row as {
				created_at: string;
				event_type: string;
				message: string;
			};

			return {
				createdAt: entry.created_at,
				eventType: entry.event_type,
				message: entry.message,
			};
		});
}

// noteWorkspaceIssue records a transient failure, without repeating itself.
//
// These retry every few seconds, so appending one per attempt would bury the timeline in
// identical rows. Writing only when the message changes keeps a stuck workspace legible: one line
// saying what is wrong, not seven hundred an hour.
export function noteWorkspaceIssue(
	db: Database.Database,
	lease: OperationLease,
	message: string,
	now: Date = new Date(),
): void {
	const operation = db
		.prepare("SELECT workspace_id FROM workspace_operations WHERE id = ?")
		.get(lease.id) as { workspace_id: string } | undefined;
	if (operation === undefined) {
		return;
	}

	const latest = db
		.prepare(
			`SELECT event_type, message FROM workspace_events
			 WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`,
		)
		.get(operation.workspace_id) as
		| { event_type: string; message: string }
		| undefined;
	if (
		latest?.event_type === "workspace.retrying" &&
		latest.message === message
	) {
		return;
	}

	appendWorkspaceEvent(
		db,
		operation.workspace_id,
		"workspace.retrying",
		message,
		now.toISOString(),
	);
}

// releaseWorkspaceOperation returns a still-unfinished operation to the queue after one step.
//
// The worker advances a single durable step per pass. Releasing with a delay is what stops a
// legitimately slow Proxmox task from being polled in a hot loop.
export function releaseWorkspaceOperation(
	db: Database.Database,
	lease: OperationLease,
	delayMs: number,
	now: Date = new Date(),
): void {
	const nextRunAt = new Date(now.getTime() + delayMs).toISOString();
	db.prepare(
		`UPDATE workspace_operations
		 SET status = 'queued', lease_expires_at = NULL, lease_token = NULL, next_run_at = ?
		 WHERE id = ? AND status = 'running' AND lease_token = ?`,
	).run(nextRunAt, lease.id, lease.token);
}

// workspaceProvision returns the private state for one running provision operation.
export function workspaceProvision(
	db: Database.Database,
	lease: OperationLease,
): WorkspaceProvision | undefined {
	return operationWorkspace(db, lease, "provision");
}

// workspaceTeardown returns the private state for one running destroy operation.
export function workspaceTeardown(
	db: Database.Database,
	lease: OperationLease,
): WorkspaceTeardown | undefined {
	return operationWorkspace(db, lease, "destroy");
}

function operationWorkspace(
	db: Database.Database,
	lease: OperationLease,
	kind: WorkspaceOperation["kind"],
): WorkspaceTeardown | undefined {
	const row = db
		.prepare(
			`SELECT w.id, w.hostname, w.ownership_token, w.node, w.vmid, w.current_task_upid,
				w.current_task_expires_at, w.destroy_phase
			 FROM workspace_operations o
			 JOIN workspaces w ON w.id = o.workspace_id
			 WHERE o.id = ? AND o.status = 'running' AND o.kind = ? AND o.lease_token = ?`,
		)
		.get(lease.id, kind, lease.token) as
		| {
				current_task_expires_at: string | null;
				current_task_upid: string | null;
				hostname: string;
				id: string;
				destroy_phase: DestroyPhase | null;
				node: string | null;
				ownership_token: string;
				vmid: number | null;
		  }
		| undefined;
	if (row === undefined) {
		return undefined;
	}

	const workspace: WorkspaceTeardown = {
		hostname: row.hostname,
		id: row.id,
		ownershipToken: row.ownership_token,
	};
	if (row.destroy_phase !== null) {
		workspace.phase = row.destroy_phase;
	}
	if (row.current_task_expires_at !== null) {
		workspace.taskExpiresAt = row.current_task_expires_at;
	}
	if (row.current_task_upid !== null) {
		workspace.taskUPID = row.current_task_upid;
	}
	if (row.node !== null) {
		workspace.node = row.node;
	}
	if (row.vmid !== null) {
		workspace.vmid = row.vmid;
	}

	return workspace;
}

// requestWorkspaceOperation records lifecycle work for the disabled-by-default executor.
export function requestWorkspaceOperation(
	db: Database.Database,
	workspaceId: string,
	kind: "destroy" | "provision",
): WorkspaceOperationResult {
	const request = db.transaction((): WorkspaceOperationResult => {
		const workspace = workspaceById(db, workspaceId);
		if (workspace === undefined) {
			return { kind: "not_found" };
		}

		// One live operation of a kind per workspace. The state machine permits from === to, so a
		// second retry while already provisioning would otherwise queue a rival operation: one
		// persists a VMID and clones while the other sees a VMID with no UPID yet, reconciles, and
		// nulls it -- orphaning the container it just created.
		const live = db
			.prepare(
				`SELECT id FROM workspace_operations
				 WHERE workspace_id = ? AND kind = ? AND status IN ('queued', 'running')`,
			)
			.get(workspaceId, kind) as { id: string } | undefined;
		if (live !== undefined) {
			return {
				kind: "already_queued",
				message: `${kind} is already queued for this workspace`,
			};
		}

		const nextStatus = kind === "destroy" ? "destroying" : "provisioning";
		const transition = nextWorkspaceStatus(workspace.status, nextStatus);
		if (!transition.ok) {
			return { kind: "invalid_transition", message: transition.error.message };
		}

		const now = new Date().toISOString();
		const desiredState: WorkspaceTarget =
			kind === "destroy" ? "destroyed" : "present";
		db.prepare(
			`UPDATE workspaces
			 SET desired_state = ?, status = ?, current_step = ?, updated_at = ?
			 WHERE id = ?`,
		).run(desiredState, transition.status, `${kind} queued`, now, workspaceId);

		if (kind === "destroy") {
			// Cancel outstanding provisioning. Left queued, it would keep driving the workspace
			// forward -- potentially cloning a fresh container -- while teardown removes one.
			const cancelled = db
				.prepare(
					`UPDATE workspace_operations
					 SET status = 'cancelled', completed_at = ?, lease_expires_at = NULL,
						next_run_at = NULL, error_message = ?
					 WHERE workspace_id = ? AND kind = 'provision'
						AND status IN ('queued', 'running')`,
				)
				.run(now, "superseded by a destroy request", workspaceId);
			if (cancelled.changes > 0) {
				appendWorkspaceEvent(
					db,
					workspaceId,
					"workspace.provision_cancelled",
					"provisioning cancelled by a destroy request",
					now,
				);
			}

			// current_task_upid is shared by both operation kinds and carries no kind of its own.
			// A clone UPID left here would be polled by the destroy executor as though it were a
			// teardown task, and a failed clone would then halt teardown with the container still
			// running. The clone's own outcome no longer matters: teardown re-inspects Proxmox.
			db.prepare(
				`UPDATE workspaces
				 SET current_task_upid = NULL, current_task_expires_at = NULL
				 WHERE id = ?`,
			).run(workspaceId);
		}

		const operation = insertOperation(db, workspaceId, kind, now);
		appendWorkspaceEvent(
			db,
			workspaceId,
			`workspace.${kind}_queued`,
			`${kind} queued`,
			now,
		);

		return {
			kind: "created",
			operation,
			workspace: {
				...workspace,
				currentStep: `${kind} queued`,
				desiredState,
				status: transition.status,
				updatedAt: now,
			},
		};
	});

	return request();
}

// listWorkspaces returns workspaces ordered with the newest request first.
export function listWorkspaces(db: Database.Database): Workspace[] {
	const rows = db
		.prepare(
			`SELECT id, desired_state, status, activity, repository, ref, purpose, hostname,
				herdr_session, created_at, updated_at, current_step
			 FROM workspaces ORDER BY created_at DESC`,
		)
		.all() as WorkspaceRow[];
	const workspaces: Workspace[] = [];

	for (const row of rows) {
		workspaces.push(workspaceFromRow(row));
	}

	return workspaces;
}

// workspaceById returns one workspace when it exists.
export function workspaceById(
	db: Database.Database,
	id: string,
): Workspace | undefined {
	const row = db
		.prepare(
			`SELECT id, desired_state, status, activity, repository, ref, purpose, hostname,
				herdr_session, created_at, updated_at, current_step
			 FROM workspaces WHERE id = ?`,
		)
		.get(id) as WorkspaceRow | undefined;

	if (row === undefined) {
		return undefined;
	}

	return workspaceFromRow(row);
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
	const workspace: Workspace = {
		activity: row.activity,
		createdAt: row.created_at,
		currentStep: row.current_step,
		desiredState: row.desired_state,
		herdrSession: row.herdr_session,
		hostname: row.hostname,
		id: row.id,
		repository: row.repository,
		ref: row.ref,
		status: row.status,
		updatedAt: row.updated_at,
	};

	if (row.purpose !== null) {
		workspace.purpose = row.purpose;
	}

	return workspace;
}

function insertOperation(
	db: Database.Database,
	workspaceId: string,
	kind: WorkspaceOperation["kind"],
	createdAt: string,
): WorkspaceOperation {
	const operation: WorkspaceOperation = {
		attemptCount: 0,
		createdAt,
		id: randomUUID(),
		kind,
		status: "queued",
		workspaceId,
	};

	db.prepare(
		"INSERT INTO workspace_operations (id, workspace_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?)",
	).run(
		operation.id,
		operation.workspaceId,
		operation.kind,
		operation.status,
		operation.createdAt,
	);

	return operation;
}

function workspaceRequestHash(input: CreateWorkspaceInput): string {
	const request = JSON.stringify({
		purpose: input.purpose,
		repository: input.repository,
		ref: input.ref,
	});

	return createHash("sha256").update(request).digest("hex");
}

function workspaceOperationFromRow(
	row: WorkspaceOperationRow,
): WorkspaceOperation {
	const operation: WorkspaceOperation = {
		attemptCount: row.attempt_count,
		createdAt: row.created_at,
		id: row.id,
		kind: row.kind,
		status: row.status,
		workspaceId: row.workspace_id,
	};

	if (row.claimed_at !== null) {
		operation.claimedAt = row.claimed_at;
	}
	if (row.completed_at !== null) {
		operation.completedAt = row.completed_at;
	}
	if (row.error_message !== null) {
		operation.errorMessage = row.error_message;
	}
	if (row.lease_expires_at !== null) {
		operation.leaseExpiresAt = row.lease_expires_at;
	}
	if (row.next_run_at !== null) {
		operation.nextRunAt = row.next_run_at;
	}

	return operation;
}

// appendWorkspaceEvent adds one entry to the redacted, append-only workspace timeline.
//
// Messages are human-readable operational history and must never carry token secrets, SSH
// credentials, repository credentials, or ownership tokens.
function appendWorkspaceEvent(
	db: Database.Database,
	workspaceId: string,
	eventType: string,
	message: string,
	createdAt: string,
): void {
	db.prepare(
		"INSERT INTO workspace_events (workspace_id, event_type, message, created_at) VALUES (?, ?, ?, ?)",
	).run(workspaceId, eventType, message, createdAt);
}

// withRunningOperation performs one write, in a transaction, only while this worker holds the
// operation.
//
// Every mutator goes through this so the guard cannot be forgotten on the next one added.
function withRunningOperation(
	db: Database.Database,
	lease: OperationLease,
	kind: WorkspaceOperation["kind"],
	mutate: (workspaceId: string) => void,
): WorkspaceMutation {
	const run = db.transaction((): WorkspaceMutation => {
		const operation = runningOperation(db, lease, kind);
		if (operation === undefined) {
			return { kind: "stale_operation" };
		}

		mutate(operation.workspace_id);

		return { kind: "prepared" };
	});

	return run.immediate();
}

// finishOperation closes an operation, successfully or otherwise.
function finishOperation(
	db: Database.Database,
	lease: OperationLease,
	status: "completed" | "failed",
	errorMessage: string | undefined,
	nowText: string,
): void {
	db.prepare(
		`UPDATE workspace_operations
		 SET status = ?, completed_at = ?, lease_expires_at = NULL, lease_token = NULL,
			next_run_at = NULL, error_message = ?
		 WHERE id = ? AND status = 'running' AND lease_token = ?`,
	).run(status, nowText, errorMessage ?? null, lease.id, lease.token);
}

// runningOperation resolves the workspace behind an operation this worker still holds a lease on.
//
// Every mutator goes through this so a worker whose lease was taken over cannot write, and so a
// provision executor cannot accidentally act on a destroy operation or the reverse.
function runningOperation(
	db: Database.Database,
	lease: OperationLease,
	kind: WorkspaceOperation["kind"],
) {
	return db
		.prepare(
			`SELECT workspace_id FROM workspace_operations
			 WHERE id = ? AND status = 'running' AND kind = ? AND lease_token = ?`,
		)
		.get(lease.id, kind, lease.token) as { workspace_id: string } | undefined;
}
