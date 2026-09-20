import {
	type Fetcher,
	type ProxmoxCredentials,
	proxmoxHeaders,
	proxmoxRead,
	proxmoxUnreadable,
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
	const label = `pool request for ${pool}`;
	const read = await proxmoxRead(
		proxmoxURL(api.apiURL, `/pools/${encodeURIComponent(pool)}`),
		{
			headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
			method: "GET",
		},
		label,
		fetcher,
	);
	if (read.kind === "failed") {
		return read;
	}

	const members = (read.data as { members?: unknown } | undefined)?.members;
	if (!Array.isArray(members)) {
		return proxmoxUnreadable(label);
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

// PoolMembership is whether one VMID belongs to the controller's pool.
export type PoolMembership =
	| { kind: "failed"; message: string }
	| { kind: "inside" }
	| { kind: "outside" };

// poolContainsVMID answers the question a 403 cannot.
//
// Reading a guest outside the pool is forbidden whether it was deleted, never existed, or belongs
// to someone else. Callers need to know which side of the pool it is on; what they do about it
// differs, so that stays with them.
export async function poolContainsVMID(
	api: ProxmoxCredentials,
	pool: string,
	vmid: number,
	fetcher: Fetcher,
): Promise<PoolMembership> {
	const members = await poolMembers(api, pool, fetcher);
	if (members.kind === "failed") {
		return members;
	}

	return members.vmids.has(vmid) ? { kind: "inside" } : { kind: "outside" };
}
