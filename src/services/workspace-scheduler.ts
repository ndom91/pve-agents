import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import { runWorkspaceOperations } from "./workspace-operation-worker";

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
	const tick = options.tick ?? (() => runWorkspaceOperations(db, config));
	const intervalMs = config.WORKER_INTERVAL_SECONDS * 1_000;

	while (!signal.aborted) {
		let delay = intervalMs;
		try {
			await tick();
		} catch (error) {
			delay = options.errorBackoffMs ?? ERROR_BACKOFF_MS;
			options.onError?.(error);
		}

		if (signal.aborted) {
			return;
		}

		await sleep(delay, signal);
	}
}

// sleep waits for a delay, returning early when the signal aborts.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);

		function abort() {
			clearTimeout(timer);
			resolve();
		}

		signal.addEventListener("abort", abort, { once: true });
	});
}
