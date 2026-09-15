import { describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";
import { startWorkspaceScheduler } from "./workspace-scheduler";

describe("startWorkspaceScheduler", () => {
	it("ticks repeatedly until aborted", async () => {
		const abort = new AbortController();
		let ticks = 0;

		const loop = startWorkspaceScheduler(db(), config(1), abort.signal, {
			tick: async () => {
				ticks += 1;
				if (ticks === 2) {
					abort.abort();
				}
			},
		});

		await loop;
		expect(ticks).toBe(2);
	});

	it("never overlaps a tick that outlasts the interval", async () => {
		const abort = new AbortController();
		let running = 0;
		let overlapped = false;
		let ticks = 0;

		await startWorkspaceScheduler(db(), config(1), abort.signal, {
			tick: async () => {
				running += 1;
				if (running > 1) {
					overlapped = true;
				}

				// Deliberately longer than the interval. The scheduler must wait for this rather
				// than firing a second pass that would race for the same operation lease.
				await new Promise((resolve) => setTimeout(resolve, 15));
				running -= 1;
				ticks += 1;
				if (ticks === 2) {
					abort.abort();
				}
			},
		});

		expect(overlapped).toBe(false);
	});

	it("stops promptly when aborted mid-wait", async () => {
		const abort = new AbortController();
		const started = Date.now();

		const loop = startWorkspaceScheduler(db(), config(3600), abort.signal, {
			tick: async () => undefined,
		});
		setTimeout(() => abort.abort(), 10);
		await loop;

		// Without abort-aware waiting this would sit on the full hour-long interval.
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("keeps running after a tick throws", async () => {
		const abort = new AbortController();
		const errors: unknown[] = [];
		let ticks = 0;

		await startWorkspaceScheduler(db(), config(1), abort.signal, {
			errorBackoffMs: 1,
			onError: (error) => errors.push(error),
			tick: async () => {
				ticks += 1;
				if (ticks === 1) {
					throw new Error("proxmox unreachable");
				}

				abort.abort();
			},
		});

		expect(ticks).toBe(2);
		expect(errors).toHaveLength(1);
	});
});

function config(intervalSeconds: number) {
	return controllerConfig({
		WORKER_INTERVAL_SECONDS: String(intervalSeconds),
	});
}

function db() {
	return openDatabase(":memory:");
}
