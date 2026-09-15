// CloneWorkspaceInput is the controller-owned data required for one linked clone request.
export type CloneWorkspaceInput = {
	controllerID: string;
	createdAt: string;
	hostname: string;
	node: string;
	ownershipToken: string;
	pool: string;
	templateVMID: number;
	vmid: number;
	workspaceID: string;
};

// CloneWorkspaceResult is the result of submitting a clone request to Proxmox.
export type CloneWorkspaceResult =
	| { kind: "accepted"; upid: string }
	| { kind: "failed"; message: string };

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

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
	let response: Response;
	try {
		response = await fetcher(
			`${urlWithoutTrailingSlash(apiURL)}/nodes/${encodeURIComponent(input.node)}/lxc/${input.templateVMID}/clone`,
			{
				body,
				headers: {
					Accept: "application/json",
					Authorization: `PVEAPIToken=${tokenID}=${tokenSecret}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				method: "POST",
			},
		);
	} catch {
		return { kind: "failed", message: "proxmox clone request failed" };
	}

	if (!response.ok) {
		return {
			kind: "failed",
			message: `proxmox clone request returned HTTP ${response.status}`,
		};
	}

	let result: { data: unknown };
	try {
		result = (await response.json()) as { data: unknown };
	} catch {
		return {
			kind: "failed",
			message: "proxmox clone request returned invalid JSON",
		};
	}
	if (typeof result.data !== "string") {
		return {
			kind: "failed",
			message: "proxmox clone request returned no UPID",
		};
	}

	return { kind: "accepted", upid: result.data };
}

// ownershipMarker returns the metadata required to authorize future destructive actions.
export function ownershipMarker(input: CloneWorkspaceInput): string {
	return [
		"managed-by=pve-herdr-agents",
		`controller-id=${input.controllerID}`,
		`workspace-id=${input.workspaceID}`,
		`ownership-token=${input.ownershipToken}`,
		`created-at=${input.createdAt}`,
	].join("\n");
}

function urlWithoutTrailingSlash(url: string): string {
	if (url.endsWith("/")) {
		return url.slice(0, -1);
	}

	return url;
}
