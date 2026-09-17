import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { liveWorkspaceIDs } from "../db/workspace-repository";
import {
	containerState,
	deleteContainer,
	stopContainer,
} from "../services/proxmox-container";
import type { ProxmoxTaskRequest } from "../services/proxmox-http";
import {
	confirmOrphan,
	findOrphanContainers,
	type OrphanScan,
} from "../services/proxmox-orphans";
import { awaitTask, proxmoxCredentials } from "../services/workspace-task";
import { controllerDatabase, controllerRuntimeConfig } from "./controller";
import { operatorMiddleware } from "./middleware";

// OrphanRemoval is what happened to a container an operator asked to remove.
export type OrphanRemoval =
	| { kind: "refused"; message: string }
	| { kind: "removed" };

// scanOrphans compares what Proxmox holds against what the controller has a record of.
//
// Operator-initiated rather than scheduled, deliberately. A lost or restored database makes every
// live workspace look orphaned, so anything on a timer would eventually purge the whole fleet. It
// also keeps the cost off the fleet view, which polls every few seconds.
export const scanOrphans = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.handler(async (): Promise<OrphanScan> => {
		const config = controllerRuntimeConfig();
		if (!config.provisioningEnabled) {
			return { kind: "failed", message: "provisioning is disabled" };
		}

		return findOrphanContainers(
			proxmoxCredentials(config),
			config.PROXMOX_POOL as string,
			config.CONTROLLER_ID as string,
			liveWorkspaceIDs(controllerDatabase()),
			fetch,
		);
	});

// destroyOrphan removes one container the controller created and no longer tracks.
//
// Outside the operation queue on purpose: an orphan has no workspace row to attach an operation
// to, and inventing one so the queue could be used would be worse than not using it. It is one
// container, asked for by a person, and the outcome is reported straight back.
export const destroyOrphan = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(z.object({ vmid: z.coerce.number().int().min(100) }))
	.handler(async ({ data }): Promise<OrphanRemoval> => {
		const config = controllerRuntimeConfig();
		if (!config.provisioningEnabled) {
			return { kind: "refused", message: "provisioning is disabled" };
		}

		const api = proxmoxCredentials(config);
		// Re-read and re-check rather than trusting the scan the browser posted back. A VMID
		// arriving in a form is a request, not authorization, and between the scan and the click
		// the container could have been replaced or its workspace retried.
		const owned = await confirmOrphan(
			api,
			data.vmid,
			config.CONTROLLER_ID as string,
			liveWorkspaceIDs(controllerDatabase()),
			fetch,
		);
		if (owned.kind === "refused") {
			return owned;
		}

		// Proxmox refuses to delete a running container, and both stop and delete are asynchronous
		// tasks: a submitted UPID is not a finished job. Each one is waited for, because reporting
		// "removed" off the back of an accepted request would be reporting something that had not
		// happened.
		const state = await containerState(api, data.vmid, fetch);
		if (state.kind === "running") {
			const stopped = await settle(
				config,
				await stopContainer(api, data.vmid, fetch),
			);
			if (stopped !== undefined) {
				return { kind: "refused", message: stopped };
			}
		}

		const removed = await settle(
			config,
			await deleteContainer(api, data.vmid, fetch),
		);

		return removed === undefined
			? { kind: "removed" }
			: { kind: "refused", message: removed };
	});

// TASK_TIMEOUT_MS bounds how long one Proxmox task is waited on.
//
// This runs inside a request, so it cannot wait the way the operation queue can. Deleting a
// container is quick; a task still running after this is reported rather than waited out, and a
// re-scan will show whether it finished.
const TASK_TIMEOUT_MS = 30_000;

// settle waits for one submitted Proxmox task, returning a message only when something went wrong.
async function settle(
	config: ReturnType<typeof controllerRuntimeConfig>,
	submitted: ProxmoxTaskRequest,
): Promise<string | undefined> {
	if (submitted.kind === "failed") {
		return submitted.message;
	}

	const deadline = Date.now() + TASK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const outcome = await awaitTask(
			config,
			submitted.upid,
			new Date(deadline).toISOString(),
			fetch,
			new Date(),
		);
		if (outcome.kind === "succeeded") {
			return undefined;
		}
		if (outcome.kind === "failed") {
			return outcome.message;
		}
		if (outcome.kind === "timed_out") {
			return "proxmox task did not finish in time";
		}

		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}

	return "proxmox task did not finish in time";
}
