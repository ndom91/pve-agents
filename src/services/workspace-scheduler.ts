import { setTimeout as delay } from "node:timers/promises";

import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import { observeWorkspaceActivity } from "./workspace-activity";
import { refreshWorkspaceCredentials } from "./workspace-credentials";
import { runWorkspaceOperations } from "./workspace-operation-worker";
import { reapWorkspaces } from "./workspace-reaper";

// ERROR_BACKOFF_MS is the pause after a tick throws, so a persistent fault cannot become a hot
// loop against Proxmox or the database.
const ERROR_BACKOFF_MS = 30_000;

// WorkspaceSchedulerOptions lets tests substitute the tick and observe failures.
export type WorkspaceSchedulerOptions = {
	errorBackoffMs?: number;
	onError?: (error: unknown) => void;
	tick?: () => Promise<unknown>;
};

// startWorkspaceScheduler runs the operation worker on an interval until the signal aborts.
//
// Each tick is awaited before the next is scheduled, so passes can never overlap however long
// Proxmox takes. That matters more than hitting the interval exactly: two concurrent passes would
// both try to claim work, and the durable lease would then be doing work the scheduler should not
// have created in the first place.
//
// The returned promise resolves once the loop has stopped, which lets a caller shut down cleanly
// rather than leaving a tick half-finished.
export async function startWorkspaceScheduler(
	db: Database.Database,
	config: ControllerConfig,
	signal: AbortSignal,
	options: WorkspaceSchedulerOptions = {},
): Promise<void> {
	const tick = options.tick ?? (() => sweep(db, config));
	const intervalMs = config.WORKER_INTERVAL_SECONDS * 1_000;

	while (!signal.aborted) {
		let waitMs = intervalMs;
		try {
			await tick();
		} catch (error) {
			waitMs = options.errorBackoffMs ?? ERROR_BACKOFF_MS;
			options.onError?.(error);
		}

		if (signal.aborted) {
			return;
		}

		// Rejects on abort, which is the wanted outcome: stop waiting and let the loop condition
		// end it.
		await delay(waitMs, undefined, { signal }).catch(() => undefined);
	}
}

// sweep advances queued lifecycle work, then refreshes what settled workspaces are doing.
//
// Sequential, for the same reason passes never overlap: both write to SQLite, and one writer at a
// time is what keeps a busy controller off the busy_timeout. Activity runs second because it is
// the one that can be late without anything breaking.
async function sweep(
	db: Database.Database,
	config: ControllerConfig,
): Promise<void> {
	await drainOperations(db, config);
	// Activity first, deliberately: the reaper decides on the activity this records, and reaping
	// on a stale reading is how a working agent gets destroyed.
	await observeWorkspaceActivity(db, config);
	await refreshWorkspaceCredentials(db, config);
	// Awaited: it opens a connection to any workspace it is about to destroy, to check first.
	await reapWorkspaces(db, config);
}

// OPERATIONS_PER_TICK bounds how much lifecycle work one pass will do.
//
// One step per tick meant global throughput of one step every five seconds, so a workspace needing
// nine steps took the better part of a minute even with nothing else running, and six of them took
// nine minutes. Each step is one Proxmox call or one SSH round trip, so a handful fits comfortably
// inside a tick.
const OPERATIONS_PER_TICK = 6;

// OPERATIONS_BUDGET_MS stops a slow step turning the batch into a long one.
//
// A connection to a container that is not answering waits out its timeout, and several of those in
// a row would hold up the activity and credential passes that run after this. Overrunning does not
// overlap ticks, because the scheduler awaits the whole sweep, but it does delay them.
const OPERATIONS_BUDGET_MS = 4_000;

// drainOperations advances several queued operations, rather than exactly one.
async function drainOperations(
	db: Database.Database,
	config: ControllerConfig,
): Promise<void> {
	const deadline = Date.now() + OPERATIONS_BUDGET_MS;

	for (let step = 0; step < OPERATIONS_PER_TICK; step += 1) {
		const run = await runWorkspaceOperations(db, config);
		// Nothing due. Stopping here is what keeps an idle controller idle rather than spinning
		// through its budget every five seconds.
		if (run.processed === 0) {
			return;
		}
		if (Date.now() >= deadline) {
			return;
		}
	}
}
