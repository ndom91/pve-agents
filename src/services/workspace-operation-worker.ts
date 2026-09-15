import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import { claimWorkspaceOperation } from "../db/workspace-repository";
import type { Fetcher } from "./proxmox-http";
import { executeWorkspaceDestroy } from "./workspace-destroy-executor";
import { executeWorkspaceProvision } from "./workspace-provision-executor";
import type { WorkspaceOperationRun } from "./workspace-task";

export type { WorkspaceOperationRun } from "./workspace-task";

// runWorkspaceOperations advances one queued operation by exactly one durable step.
//
// Destroy is claimed ahead of provision so teardown is never starved behind a queue of pending
// provisions, and so an operator asking for resources back gets them back promptly.
export async function runWorkspaceOperations(
	db: Database.Database,
	config: ControllerConfig,
	fetcher: Fetcher = fetch,
	now: Date = new Date(),
): Promise<WorkspaceOperationRun> {
	if (!config.provisioningEnabled) {
		return { processed: 0, status: "disabled" };
	}

	const destroy = claimWorkspaceOperation(db, "destroy", now);
	if (destroy.kind === "claimed") {
		return executeWorkspaceDestroy(
			db,
			config,
			destroy.operation.id,
			fetcher,
			now,
		);
	}

	const provision = claimWorkspaceOperation(db, "provision", now);
	if (provision.kind === "claimed") {
		return executeWorkspaceProvision(
			db,
			config,
			provision.operation.id,
			fetcher,
			now,
		);
	}

	return { processed: 0, status: "empty" };
}
