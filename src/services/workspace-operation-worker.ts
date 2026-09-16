import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import {
	claimWorkspaceOperation,
	failWorkspaceProvision,
	haltWorkspaceDestroy,
	type OperationLease,
	type WorkspaceOperation,
} from "../db/workspace-repository";
import type { Fetcher } from "./proxmox-http";
import { executeWorkspaceDestroy } from "./workspace-destroy-executor";
import { executeWorkspaceProvision } from "./workspace-provision-executor";
import type { WorkspaceOperationRun } from "./workspace-task";

export type { WorkspaceOperationRun } from "./workspace-task";

// OPERATION_MAX_AGE_MS bounds how long one operation may keep retrying.
//
// Deliberately a wall clock rather than an attempt count: a healthy clone is polled every few
// seconds and would blow through any sensible count, while a durable fault such as a revoked
// Proxmox token never records a task at all and so escapes the per-task deadline. Without this an
// operation retries forever, leaving the workspace stuck with nothing an operator would notice.
const OPERATION_MAX_AGE_MS = 3_600_000;

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
		return (
			exhausted(db, destroy.lease, destroy.operation, now) ??
			(await executeWorkspaceDestroy(db, config, destroy.lease, fetcher, now))
		);
	}

	const provision = claimWorkspaceOperation(db, "provision", now);
	if (provision.kind === "claimed") {
		return (
			exhausted(db, provision.lease, provision.operation, now) ??
			(await executeWorkspaceProvision(
				db,
				config,
				provision.lease,
				fetcher,
				now,
			))
		);
	}

	return { processed: 0, status: "empty" };
}

// exhausted ends an operation that has been retrying past its deadline.
//
// Returns undefined when the operation may continue, so the caller reads as "give up, or run".
function exhausted(
	db: Database.Database,
	lease: OperationLease,
	operation: WorkspaceOperation,
	now: Date,
): WorkspaceOperationRun | undefined {
	const startedAt = Date.parse(operation.createdAt);
	if (
		Number.isNaN(startedAt) ||
		now.getTime() - startedAt < OPERATION_MAX_AGE_MS
	) {
		return undefined;
	}

	const minutes = OPERATION_MAX_AGE_MS / 60_000;
	const message = `${operation.kind} made no progress within ${minutes} minutes and was given up on after ${operation.attemptCount} attempts`;
	if (operation.kind === "destroy") {
		// Teardown halts rather than failing: the desired state is still "destroyed", and the
		// container may well still exist and need a human to look at it.
		haltWorkspaceDestroy(db, lease, "destroy_attempts_exhausted", message, now);
	} else {
		failWorkspaceProvision(
			db,
			lease,
			"provision_attempts_exhausted",
			message,
			now,
		);
	}

	return { processed: 1, status: "attempts_exhausted" };
}
