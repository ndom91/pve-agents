import type { ControllerConfig } from "../config/controller-config";

import type { Fetcher } from "./proxmox-http";
import { proxmoxTaskStatus } from "./proxmox-task";

// TASK_TIMEOUT_MS bounds how long a Proxmox task may stay un-terminal before it is given up on.
//
// Provisional: promote to configuration once real clone and delete timings on local-zfs are
// measured.
export const TASK_TIMEOUT_MS = 900_000;

// POLL_INTERVAL_MS is the delay before an operation waiting on Proxmox is retried.
export const POLL_INTERVAL_MS = 5_000;

// WorkspaceOperationRun is the durable outcome of one worker pass.
export type WorkspaceOperationRun = {
	processed: 0 | 1;
	status:
		| "awaiting_reconciliation"
		| "awaiting_task"
		| "clone_confirmed"
		| "clone_submitted"
		| "container_deleted"
		| "container_missing"
		| "delete_submitted"
		| "destroy_halted"
		| "disabled"
		| "empty"
		| "request_failed"
		| "shutdown_submitted"
		| "stale_operation"
		| "stop_submitted"
		| "task_failed"
		| "vmid_adopted"
		| "vmid_released";
};

// TaskOutcome is the controller's decision about a task it is waiting on.
//
// "pending" folds together a running task and an unreadable answer on purpose: neither is a
// verdict, and only the persisted deadline may end the wait.
export type TaskOutcome =
	| { kind: "failed"; message: string }
	| { kind: "pending" }
	| { kind: "succeeded" }
	| { kind: "timed_out" };

// ProxmoxCredentials narrows the optional Proxmox configuration once provisioning is enabled.
export type ProxmoxCredentials = {
	apiURL: string;
	node: string;
	tokenID: string;
	tokenSecret: string;
};

// proxmoxCredentials reads the Proxmox settings that configuration validation already guarantees.
//
// controller-config.ts requires every one of these when PROVISIONING_ENABLED=true, and no executor
// runs otherwise, so the assertions here cannot fire at runtime.
export function proxmoxCredentials(
	config: ControllerConfig,
): ProxmoxCredentials {
	return {
		apiURL: config.PROXMOX_URL as string,
		node: config.PROXMOX_NODE as string,
		tokenID: config.PROXMOX_TOKEN_ID as string,
		tokenSecret: config.PROXMOX_TOKEN_SECRET as string,
	};
}

// awaitTask polls one Proxmox task and decides whether the controller may continue.
export async function awaitTask(
	config: ControllerConfig,
	upid: string,
	expiresAt: string | undefined,
	fetcher: Fetcher,
	now: Date,
): Promise<TaskOutcome> {
	const api = proxmoxCredentials(config);
	const task = await proxmoxTaskStatus(
		api.apiURL,
		api.tokenID,
		api.tokenSecret,
		upid,
		fetcher,
	);
	if (task.kind === "succeeded") {
		return { kind: "succeeded" };
	}
	if (task.kind === "failed") {
		return { kind: "failed", message: task.message };
	}
	if (taskDeadlinePassed(expiresAt, now)) {
		return { kind: "timed_out" };
	}

	return { kind: "pending" };
}

// taskExpiry returns the deadline to persist alongside a newly submitted task.
export function taskExpiry(now: Date): string {
	return new Date(now.getTime() + TASK_TIMEOUT_MS).toISOString();
}

function taskDeadlinePassed(expiresAt: string | undefined, now: Date): boolean {
	if (expiresAt === undefined) {
		return false;
	}

	const deadline = Date.parse(expiresAt);
	if (Number.isNaN(deadline)) {
		return false;
	}

	return now.getTime() >= deadline;
}
