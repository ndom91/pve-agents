import type Database from "better-sqlite3";
import { z } from "zod";

import type { ControllerConfig } from "../config/controller-config";
import {
	createWorkspace,
	listWorkspaces,
	requestWorkspaceOperation,
	workspaceById,
	workspaceDetail,
	workspaceEventTimelines,
} from "../db/workspace-repository";
import { parseRepository } from "../domain/repository";
import { repositoryAccess } from "./github-app";
import type { Fetcher } from "./proxmox-http";

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
	const timelines = workspaceEventTimelines(db, EVENT_LIMIT);

	return listWorkspaces(db).map((workspace) => ({
		...workspace,
		events: timelines.get(workspace.id) ?? [],
	}));
}

// workspaceWithTimeline returns one workspace, its placement, and its whole timeline.
export function workspaceWithTimeline(db: Database.Database, id: string) {
	const workspace = workspaceDetail(db, id);
	if (workspace === undefined) {
		return undefined;
	}

	return {
		...workspace,
		events: workspaceEventTimelines(db, EVENT_LIMIT).get(id) ?? [],
	};
}

// FleetWorkspace is one workspace as the fleet view receives it.
export type FleetWorkspace = ReturnType<typeof listRequestedWorkspaces>[number];

// requestedWorkspace returns one persisted workspace when it exists.
export function requestedWorkspace(db: Database.Database, id: string) {
	return workspaceById(db, id);
}

// WorkspaceRefusal is a request the controller will not build a workspace for.
export type WorkspaceRefusal = { kind: "refused"; message: string };

// checkWorkspaceRequest decides whether a request is worth building a container for.
//
// Both checks happen before anything is provisioned, because the alternative is a minute of
// cloning and booting followed by a failure whose cause is three steps behind where it surfaced.
//
// A GitHub outage is deliberately not a refusal: the controller then knows nothing about the
// repository, and turning that into a rejected request would make an outage at GitHub an outage
// here. The checkout step retries, which is the right place for a transient fault.
export async function checkWorkspaceRequest(
	config: ControllerConfig,
	request: WorkspaceRequest,
	fetcher: Fetcher = fetch,
): Promise<WorkspaceRefusal | undefined> {
	const repository = parseRepository(request.repository);
	if (repository.kind === "invalid") {
		return {
			kind: "refused",
			message: `${request.repository}: ${repository.message}`,
		};
	}

	const appId = config.GITHUB_APP_ID;
	const installationId = config.GITHUB_APP_INSTALLATION_ID;
	const privateKeyPath = config.GITHUB_APP_PRIVATE_KEY_PATH;
	if (
		appId === undefined ||
		installationId === undefined ||
		privateKeyPath === undefined
	) {
		return undefined;
	}

	const access = await repositoryAccess(
		{ appId, installationId, privateKeyPath },
		repository,
		fetcher,
	);

	return access.kind === "inaccessible"
		? { kind: "refused", message: access.message }
		: undefined;
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
