import {
	type Fetcher,
	type ProxmoxCredentials,
	proxmoxHeaders,
	proxmoxTimeout,
	proxmoxURL,
} from "./proxmox-http";

// ProxmoxPoolMembers is the set of guests in the controller's pool.
export type ProxmoxPoolMembers =
	| { kind: "failed"; message: string }
	| { kind: "members"; vmids: Set<number> };

// poolMembers lists the VMIDs in one Proxmox pool.
//
// This is the only way a pool-scoped token can tell "that container is not mine" from "I cannot
// reach Proxmox". Reading a guest outside the pool returns 403 whether it was deleted, never
// existed, or belongs to someone else, so the guest endpoint cannot answer the question.
export async function poolMembers(
	api: ProxmoxCredentials,
	pool: string,
	fetcher: Fetcher,
): Promise<ProxmoxPoolMembers> {
	let response: Response;
	try {
		response = await fetcher(
			proxmoxURL(api.apiURL, `/pools/${encodeURIComponent(pool)}`),
			{
				headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
				method: "GET",
				signal: proxmoxTimeout(),
			},
		);
	} catch {
		return {
			kind: "failed",
			message: `proxmox pool request for ${pool} failed`,
		};
	}
	if (!response.ok) {
		return {
			kind: "failed",
			message: `proxmox pool request for ${pool} returned HTTP ${response.status}`,
		};
	}

	const result = (await response.json().catch(() => undefined)) as
		| { data?: { members?: unknown } }
		| undefined;
	const members = result?.data?.members;
	if (!Array.isArray(members)) {
		return {
			kind: "failed",
			message: `proxmox pool request for ${pool} returned invalid JSON`,
		};
	}

	const vmids = new Set<number>();
	for (const member of members) {
		const vmid = (member as { vmid?: unknown })?.vmid;
		if (typeof vmid === "number") {
			vmids.add(vmid);
		}
	}

	return { kind: "members", vmids };
}
