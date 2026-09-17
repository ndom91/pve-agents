import { containerConfig, containerDescription } from "./proxmox-container";
import type { Fetcher, ProxmoxCredentials } from "./proxmox-http";
import { MANAGED_BY, parseOwnershipMarker } from "./proxmox-ownership";
import { poolMembers } from "./proxmox-pool";

// OrphanContainer is a container this controller created and no longer has a record of.
export type OrphanContainer = {
	createdAt?: string;
	hostname?: string;
	vmid: number;
	workspaceID: string;
};

// OrphanScan is the outcome of comparing Proxmox against the database.
//
// "partial" matters: a container whose config could not be read is neither confirmed owned nor
// confirmed foreign, and reporting a scan as complete when some guests went unexamined would
// invite deleting on incomplete information.
export type OrphanScan =
	| { kind: "failed"; message: string }
	| { kind: "scanned"; orphans: OrphanContainer[]; unreadable: number[] };

// findOrphanContainers lists containers this controller owns but has no live workspace for.
//
// Every condition here exists to avoid deleting something. Ownership is read from the container's
// own description rather than from pool membership or naming, because the description is the only
// metadata written atomically during the clone and so the only thing that proves provenance.
//
// The controller-id check is what stops one controller being told to delete another's work when
// they share a pool.
export async function findOrphanContainers(
	api: ProxmoxCredentials,
	pool: string,
	controllerID: string,
	live: ReadonlySet<string>,
	fetcher: Fetcher,
): Promise<OrphanScan> {
	const members = await poolMembers(api, pool, fetcher);
	if (members.kind === "failed") {
		return members;
	}

	const orphans: OrphanContainer[] = [];
	const unreadable: number[] = [];
	for (const vmid of members.vmids) {
		const config = await containerConfig(api, vmid, fetcher);
		if (config.kind !== "found") {
			// Not assumed unowned. A container that cannot be read is exactly the one where a
			// wrong guess is expensive.
			unreadable.push(vmid);
			continue;
		}

		const marker = parseOwnershipMarker(containerDescription(config.config));
		if (marker["managed-by"] !== MANAGED_BY) {
			continue;
		}
		if (marker["controller-id"] !== controllerID) {
			continue;
		}

		const workspaceID = marker["workspace-id"];
		if (workspaceID === undefined || live.has(workspaceID)) {
			continue;
		}

		const orphan: OrphanContainer = { vmid, workspaceID };
		const hostname = config.config.hostname;
		if (typeof hostname === "string") {
			orphan.hostname = hostname;
		}
		if (marker["created-at"] !== undefined) {
			orphan.createdAt = marker["created-at"];
		}
		orphans.push(orphan);
	}

	return { kind: "scanned", orphans, unreadable };
}

// OrphanOwnership is whether one VMID is still a container this controller may delete.
export type OrphanOwnership =
	| { kind: "confirmed"; workspaceID: string }
	| { kind: "refused"; message: string };

// confirmOrphan re-checks ownership immediately before a container is destroyed.
//
// The scan result travels to a browser and comes back as a number in a form. That number is a
// request, not authorization: re-reading the marker here is what makes the destroy safe, and is
// the difference between deleting a container this controller made and deleting whatever happens
// to have that id now.
export async function confirmOrphan(
	api: ProxmoxCredentials,
	vmid: number,
	controllerID: string,
	live: ReadonlySet<string>,
	fetcher: Fetcher,
): Promise<OrphanOwnership> {
	const config = await containerConfig(api, vmid, fetcher);
	if (config.kind !== "found") {
		return { kind: "refused", message: `${vmid} could not be read` };
	}

	const marker = parseOwnershipMarker(containerDescription(config.config));
	const workspaceID = marker["workspace-id"];
	if (
		marker["managed-by"] !== MANAGED_BY ||
		marker["controller-id"] !== controllerID ||
		workspaceID === undefined
	) {
		return {
			kind: "refused",
			message: `${vmid} was not created by this controller`,
		};
	}
	if (live.has(workspaceID)) {
		return {
			kind: "refused",
			message: `${vmid} belongs to a workspace that still exists`,
		};
	}

	return { kind: "confirmed", workspaceID };
}
