import type Database from "better-sqlite3";
import { z } from "zod";

import {
	createWorkspace,
	listWorkspaces,
	workspaceById,
} from "../db/workspace-repository";

const workspaceRequestSchema = z.object({
	purpose: z.string().trim().min(1).max(500).optional(),
	repository: z.string().trim().min(1).max(2_000),
	ref: z.string().trim().min(1).max(255).default("main"),
});

// WorkspaceRequest is the public creation request accepted by the controller.
export type WorkspaceRequest = z.output<typeof workspaceRequestSchema>;

// WorkspaceRequestResult is the outcome of validating a workspace creation request.
export type WorkspaceRequestResult =
	| { ok: true; request: WorkspaceRequest }
	| { issues: string[]; ok: false };

// listRequestedWorkspaces returns all persisted workspace records.
export function listRequestedWorkspaces(db: Database.Database) {
	return listWorkspaces(db);
}

// requestedWorkspace returns a workspace when it exists.
export function requestedWorkspace(db: Database.Database, id: string) {
	return workspaceById(db, id);
}

// requestWorkspace validates and persists workspace creation intent.
export function requestWorkspace(
	db: Database.Database,
	herdrSession: string,
	idempotencyKey: string,
	input: unknown,
) {
	const request = workspaceRequest(input);
	if (!request.ok) {
		return request;
	}

	return {
		ok: true as const,
		result: createWorkspace(db, {
			herdrSession,
			idempotencyKey,
			purpose: request.request.purpose,
			repository: request.request.repository,
			ref: request.request.ref,
		}),
	};
}

// workspaceRequest validates untrusted API input without exposing Zod internals to callers.
export function workspaceRequest(input: unknown): WorkspaceRequestResult {
	const result = workspaceRequestSchema.safeParse(input);
	if (!result.success) {
		const issues: string[] = [];
		for (const issue of result.error.issues) {
			issues.push(issue.message);
		}

		return { issues, ok: false };
	}

	return { ok: true, request: result.data };
}
