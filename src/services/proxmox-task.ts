import {
	type Fetcher,
	type ProxmoxCredentials,
	proxmoxHeaders,
	proxmoxTimeout,
	proxmoxURL,
} from "./proxmox-http";

// ProxmoxTaskStatus is the controller's verdict on one Proxmox UPID.
//
// "unknown" is deliberately transient: a lost response or a 5xx tells us nothing about the task,
// so callers must retry rather than treat the workspace as failed.
export type ProxmoxTaskStatus =
	| { kind: "failed"; message: string }
	| { kind: "running" }
	| { kind: "succeeded" }
	| { kind: "unknown"; message: string };

// taskNode extracts the node that owns a UPID.
//
// Tasks must be polled on the node named in the UPID rather than the configured node; a clone can
// be reported by a different cluster member than the one the controller submitted it to.
export function taskNode(upid: string): string | undefined {
	const fields = upid.split(":");
	if (fields.length < 8 || fields[0] !== "UPID") {
		return undefined;
	}

	const node = fields[1];
	if (node === undefined || node.length === 0) {
		return undefined;
	}

	return node;
}

// proxmoxTaskStatus polls one Proxmox task and reports whether it finished successfully.
export async function proxmoxTaskStatus(
	api: ProxmoxCredentials,
	upid: string,
	fetcher: Fetcher,
): Promise<ProxmoxTaskStatus> {
	const node = taskNode(upid);
	if (node === undefined) {
		return { kind: "failed", message: `malformed Proxmox UPID ${upid}` };
	}

	const path = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`;
	let response: Response;
	try {
		response = await fetcher(proxmoxURL(api.apiURL, path), {
			headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
			method: "GET",
			signal: proxmoxTimeout(),
		});
	} catch {
		return { kind: "unknown", message: "proxmox task status request failed" };
	}
	if (!response.ok) {
		return {
			kind: "unknown",
			message: `proxmox task status request returned HTTP ${response.status}`,
		};
	}

	const result = (await response.json().catch(() => undefined)) as
		| { data?: unknown }
		| undefined;
	const data = taskData(result?.data);
	if (data === undefined) {
		return {
			kind: "unknown",
			message: "proxmox task status request returned invalid JSON",
		};
	}

	if (data.status !== "stopped") {
		return { kind: "running" };
	}
	if (data.exitstatus === "OK") {
		return { kind: "succeeded" };
	}

	return {
		kind: "failed",
		message: `proxmox task exited with ${data.exitstatus ?? "no exit status"}`,
	};
}

function taskData(
	value: unknown,
): { exitstatus?: string; status: string } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const record = value as { exitstatus?: unknown; status?: unknown };
	if (typeof record.status !== "string") {
		return undefined;
	}
	if (typeof record.exitstatus === "string") {
		return { exitstatus: record.exitstatus, status: record.status };
	}

	return { status: record.status };
}

// RunningTaskLookup is the result of searching Proxmox for an unfinished task on one guest.
export type RunningTaskLookup =
	| { kind: "failed"; message: string }
	| { kind: "found"; upid: string }
	| { kind: "none" };

// runningCloneTask finds an unfinished clone targeting one VMID.
//
// This recovers the lost-clone-response case. Proxmox reports a guest that is still being created
// as "does not exist", which is indistinguishable from a clone that never started. Treating that
// as "never started" and allocating a new candidate would leave the in-flight clone as an orphan
// wearing this workspace's ownership marker that nothing would ever destroy.
export async function runningCloneTask(
	api: ProxmoxCredentials,
	vmid: number,
	fetcher: Fetcher,
): Promise<RunningTaskLookup> {
	const path = `/nodes/${encodeURIComponent(api.node)}/tasks?running=1&limit=500`;
	let response: Response;
	try {
		response = await fetcher(proxmoxURL(api.apiURL, path), {
			headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
			method: "GET",
			signal: proxmoxTimeout(),
		});
	} catch {
		return { kind: "failed", message: "proxmox task list request failed" };
	}
	if (!response.ok) {
		return {
			kind: "failed",
			message: `proxmox task list request returned HTTP ${response.status}`,
		};
	}

	const result = (await response.json().catch(() => undefined)) as
		| { data?: unknown }
		| undefined;
	if (!Array.isArray(result?.data)) {
		return {
			kind: "failed",
			message: "proxmox task list request returned invalid JSON",
		};
	}

	for (const entry of result.data) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}

		const task = entry as { id?: unknown; type?: unknown; upid?: unknown };
		// Matched on type as well as guest id: an unrelated task on a recycled VMID must not be
		// mistaken for this workspace's clone.
		if (
			task.type === "vzclone" &&
			String(task.id) === String(vmid) &&
			typeof task.upid === "string"
		) {
			return { kind: "found", upid: task.upid };
		}
	}

	return { kind: "none" };
}
