import type Database from "better-sqlite3";
import { z } from "zod";

import {
	createWorkspace,
	listWorkspaces,
	requestWorkspaceOperation,
	workspaceById,
	workspaceEvents,
} from "../db/workspace-repository";

export const workspaceRequestSchema = z.object({
	purpose: z.string().trim().min(1).max(500).optional(),
	repository: z.string().trim().min(1).max(2_000),
	ref: z.string().trim().min(1).max(255).default("main"),
});

// WorkspaceRequest is the public creation request accepted by the controller.
export type WorkspaceRequest = z.output<typeof workspaceRequestSchema>;

// EVENT_LIMIT caps the timeline per workspace so the fleet view cannot grow without bound.
const EVENT_LIMIT = 50;

// listRequestedWorkspaces returns all persisted workspace records with their timelines.
//
// The timeline is the only place a transient failure is visible: a workspace retrying a Proxmox
// call that keeps failing otherwise sits at its old status with nothing to show for it.
export function listRequestedWorkspaces(db: Database.Database) {
	return listWorkspaces(db).map((workspace) => ({
		...workspace,
		events: workspaceEvents(db, workspace.id, EVENT_LIMIT),
	}));
}

// FleetWorkspace is one workspace as the fleet view receives it.
export type FleetWorkspace = ReturnType<typeof listRequestedWorkspaces>[number];

// requestedWorkspace returns one persisted workspace when it exists.
export function requestedWorkspace(db: Database.Database, id: string) {
	return workspaceById(db, id);
}

// requestWorkspace persists validated workspace creation intent.
export function requestWorkspace(
	db: Database.Database,
	herdrSession: string,
	idempotencyKey: string,
	request: WorkspaceRequest,
) {
	return createWorkspace(db, {
		herdrSession,
		idempotencyKey,
		purpose: request.purpose,
		repository: request.repository,
		ref: request.ref,
	});
}

// destroyWorkspace records a request to destroy a workspace.
export function destroyWorkspace(db: Database.Database, id: string) {
	return requestWorkspaceOperation(db, id, "destroy");
}

// retryWorkspace records a request to retry a failed workspace provisioning operation.
export function retryWorkspace(db: Database.Database, id: string) {
	return requestWorkspaceOperation(db, id, "provision");
}
