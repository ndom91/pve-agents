import type Database from "better-sqlite3";
import { z } from "zod";

import { createWorkspace, listWorkspaces } from "../db/workspace-repository";

export const workspaceRequestSchema = z.object({
	purpose: z.string().trim().min(1).max(500).optional(),
	repository: z.string().trim().min(1).max(2_000),
	ref: z.string().trim().min(1).max(255).default("main"),
});

// WorkspaceRequest is the public creation request accepted by the controller.
export type WorkspaceRequest = z.output<typeof workspaceRequestSchema>;

// listRequestedWorkspaces returns all persisted workspace records.
export function listRequestedWorkspaces(db: Database.Database) {
	return listWorkspaces(db);
}

// requestWorkspace persists validated workspace creation intent.
export function requestWorkspace(
	db: Database.Database,
	herdrSession: string,
	idempotencyKey: string,
	request: WorkspaceRequest,
) {
	return {
		result: createWorkspace(db, {
			herdrSession,
			idempotencyKey,
			purpose: request.purpose,
			repository: request.repository,
			ref: request.ref,
		}),
	};
}
