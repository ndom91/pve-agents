import { type Fetcher, proxmoxHeaders, proxmoxURL } from "./proxmox-http";

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
	apiURL: string,
	tokenID: string,
	tokenSecret: string,
	upid: string,
	fetcher: Fetcher = fetch,
): Promise<ProxmoxTaskStatus> {
	const node = taskNode(upid);
	if (node === undefined) {
		return { kind: "failed", message: `malformed Proxmox UPID ${upid}` };
	}

	const path = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`;
	let response: Response;
	try {
		response = await fetcher(proxmoxURL(apiURL, path), {
			headers: proxmoxHeaders(tokenID, tokenSecret),
			method: "GET",
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
