import {
	type Fetcher,
	type ProxmoxCredentials,
	type ProxmoxTaskRequest,
	proxmoxHeaders,
	proxmoxTimeout,
	proxmoxURL,
	submitProxmoxTask,
} from "./proxmox-http";
import { ownershipMarker, type WorkspaceOwnership } from "./proxmox-ownership";

// CloneWorkspaceInput is the controller-owned data required for one linked clone request.
export type CloneWorkspaceInput = WorkspaceOwnership & {
	hostname: string;
	node: string;
	pool: string;
	templateVMID: number;
	vmid: number;
};

// CloneWorkspaceResult is the result of submitting a clone request to Proxmox.
export type CloneWorkspaceResult = ProxmoxTaskRequest;

// ProxmoxVMID is a candidate VMID for a new workspace.
export type ProxmoxVMID =
	| { kind: "allocated"; vmid: number }
	| { kind: "failed"; message: string };

// VMID_SCAN_LIMIT bounds how far past the floor a search will look.
//
// Wide enough for any plausible fleet, narrow enough that an exhausted range fails in a few
// seconds rather than walking to 999999 one request at a time.
const VMID_SCAN_LIMIT = 128;

// allocateProxmoxVMID finds a free VMID at or above a floor.
//
// Proxmox has no "next free id from N", so this asks about candidates one at a time:
// /cluster/nextid?vmid=N answers 200 when N is free and 400 when it is taken. That check is
// cluster-wide even under a pool-scoped token, which matters because the controller cannot see
// guests outside its pool and so cannot rule out a collision by listing what exists.
//
// reserved are VMIDs this controller has already promised to other workspaces. Proxmox does not
// know about those until a clone actually starts, so two provisions running seconds apart would
// otherwise choose the same id.
export async function allocateProxmoxVMID(
	api: ProxmoxCredentials,
	fetcher: Fetcher,
	floor: number,
	reserved: ReadonlySet<number> = new Set(),
): Promise<ProxmoxVMID> {
	for (let vmid = floor; vmid < floor + VMID_SCAN_LIMIT; vmid += 1) {
		if (reserved.has(vmid)) {
			continue;
		}

		let response: Response;
		try {
			response = await fetcher(
				proxmoxURL(api.apiURL, `/cluster/nextid?vmid=${vmid}`),
				{
					headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
					method: "GET",
					signal: proxmoxTimeout(),
				},
			);
		} catch {
			return { kind: "failed", message: "proxmox next VMID request failed" };
		}
		if (response.ok) {
			return { kind: "allocated", vmid };
		}
		// 400 is the answer "that one is taken", not a fault. Anything else is.
		if (response.status !== 400) {
			return {
				kind: "failed",
				message: `proxmox next VMID request returned HTTP ${response.status}`,
			};
		}
	}

	return {
		kind: "failed",
		message: `no free VMID between ${floor} and ${floor + VMID_SCAN_LIMIT - 1}`,
	};
}

// nextProxmoxVMID returns an unreserved candidate VMID from Proxmox.
export async function nextProxmoxVMID(
	api: ProxmoxCredentials,
	fetcher: Fetcher,
): Promise<ProxmoxVMID> {
	let response: Response;
	try {
		response = await fetcher(proxmoxURL(api.apiURL, "/cluster/nextid"), {
			headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
			method: "GET",
			signal: proxmoxTimeout(),
		});
	} catch {
		return { kind: "failed", message: "proxmox next VMID request failed" };
	}
	if (!response.ok) {
		return {
			kind: "failed",
			message: `proxmox next VMID request returned HTTP ${response.status}`,
		};
	}

	const result = await response.json().catch(() => undefined);
	if (typeof result !== "object" || result === null || !("data" in result)) {
		return {
			kind: "failed",
			message: "proxmox next VMID request returned invalid JSON",
		};
	}
	const vmid = Number(result.data);
	if (!Number.isSafeInteger(vmid) || vmid < 100) {
		return {
			kind: "failed",
			message: "proxmox next VMID request returned invalid VMID",
		};
	}

	return { kind: "allocated", vmid };
}

// cloneWorkspace submits one linked LXC clone request and returns its Proxmox task identifier.
export async function cloneWorkspace(
	api: ProxmoxCredentials,
	input: CloneWorkspaceInput,
	fetcher: Fetcher,
): Promise<CloneWorkspaceResult> {
	const body = new URLSearchParams({
		description: ownershipMarker(input),
		full: "0",
		hostname: input.hostname,
		newid: input.vmid.toString(),
		pool: input.pool,
	});
	return submitProxmoxTask(
		proxmoxURL(
			api.apiURL,
			`/nodes/${encodeURIComponent(input.node)}/lxc/${input.templateVMID}/clone`,
		),
		{
			body,
			headers: {
				...proxmoxHeaders(api.tokenID, api.tokenSecret),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			method: "POST",
		},
		"clone",
		fetcher,
	);
}
