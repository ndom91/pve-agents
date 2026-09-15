import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
	DEFAULT_WORKSPACE_ACTIVITY,
	DEFAULT_WORKSPACE_STATUS,
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
		db.prepare(
			"INSERT INTO workspace_events (workspace_id, event_type, message, created_at) VALUES (?, ?, ?, ?)",
		).run(
			workspace.id,
			"workspace.requested",
			"workspace request accepted",
			now,
		);

		return { kind: "created", workspace };
	});

	return persist();
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

function workspaceRequestHash(input: CreateWorkspaceInput): string {
	const request = JSON.stringify({
		purpose: input.purpose,
		repository: input.repository,
		ref: input.ref,
	});

	return createHash("sha256").update(request).digest("hex");
}
