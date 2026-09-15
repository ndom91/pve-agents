import {
	type Fetcher,
	type ProxmoxTaskRequest,
	proxmoxHeaders,
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

// nextProxmoxVMID returns an unreserved candidate VMID from Proxmox.
export async function nextProxmoxVMID(
	apiURL: string,
	tokenID: string,
	tokenSecret: string,
	fetcher: Fetcher = fetch,
): Promise<
	{ kind: "allocated"; vmid: number } | { kind: "failed"; message: string }
> {
	let response: Response;
	try {
		response = await fetcher(proxmoxURL(apiURL, "/cluster/nextid"), {
			headers: proxmoxHeaders(tokenID, tokenSecret),
			method: "GET",
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
	apiURL: string,
	tokenID: string,
	tokenSecret: string,
	input: CloneWorkspaceInput,
	fetcher: Fetcher = fetch,
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
			apiURL,
			`/nodes/${encodeURIComponent(input.node)}/lxc/${input.templateVMID}/clone`,
		),
		{
			body,
			headers: {
				...proxmoxHeaders(tokenID, tokenSecret),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			method: "POST",
		},
		"clone",
		fetcher,
	);
}

export { ownershipMarker };
