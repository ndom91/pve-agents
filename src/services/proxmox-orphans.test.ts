import { describe, expect, it } from "vitest";
import { confirmOrphan, findOrphanContainers } from "./proxmox-orphans";
import { ownershipMarker } from "./proxmox-ownership";

const API = {
	apiURL: "https://nas.puff.lan:8006/api2/json",
	node: "nas",
	tokenID: "workspace-controller@pve!controller",
	tokenSecret: "not-a-real-secret",
};

const OURS = "b66d3c5d-22c6-4199-889e-764f12d37fe5";
const THEIRS = "00000000-0000-4000-8000-000000000000";

// proxmox fakes a pool and the config of each container in it.
function proxmox(containers: Record<number, string | undefined>) {
	return async (url: string) => {
		if (url.includes("/pools/")) {
			return Response.json({
				data: {
					members: Object.keys(containers).map((vmid) => ({
						vmid: Number(vmid),
					})),
				},
			});
		}

		const vmid = Number(url.match(/lxc\/(\d+)\/config/)?.[1]);
		const description = containers[vmid];
		if (description === undefined) {
			return new Response("{}", { status: 500 });
		}

		return Response.json({
			data: { description, hostname: `agent-${vmid}` },
		});
	};
}

function marker(controllerID: string, workspaceID: string): string {
	return ownershipMarker({
		controllerID,
		createdAt: "2026-01-01T00:00:00Z",
		ownershipToken: "token",
		workspaceID,
	});
}

describe("findOrphanContainers", () => {
	it("finds a container whose workspace no longer exists", async () => {
		const scan = await findOrphanContainers(
			API,
			"disposable-workspaces",
			OURS,
			new Set(),
			proxmox({ 400: marker(OURS, "gone") }),
		);

		expect(scan).toEqual({
			kind: "scanned",
			orphans: [
				{
					createdAt: "2026-01-01T00:00:00Z",
					hostname: "agent-400",
					vmid: 400,
					workspaceID: "gone",
				},
			],
			unreadable: [],
		});
	});

	it("never claims a container belonging to another controller", async () => {
		// Two controllers can share a pool. Ownership is per controller, and getting this wrong
		// means being told to delete someone else's running work.
		const scan = await findOrphanContainers(
			API,
			"disposable-workspaces",
			OURS,
			new Set(),
			proxmox({ 400: marker(THEIRS, "gone") }),
		);

		expect(scan).toMatchObject({ orphans: [] });
	});

	it("never claims a container this software did not create", async () => {
		const scan = await findOrphanContainers(
			API,
			"disposable-workspaces",
			OURS,
			new Set(),
			proxmox({ 400: "a container someone made by hand" }),
		);

		expect(scan).toMatchObject({ orphans: [] });
	});

	it("leaves alone a container whose workspace still exists", async () => {
		const scan = await findOrphanContainers(
			API,
			"disposable-workspaces",
			OURS,
			new Set(["alive"]),
			proxmox({ 400: marker(OURS, "alive") }),
		);

		expect(scan).toMatchObject({ orphans: [] });
	});

	it("reports a container it could not read rather than assuming it is unowned", async () => {
		// The one that cannot be read is exactly the one where a wrong guess is expensive.
		const scan = await findOrphanContainers(
			API,
			"disposable-workspaces",
			OURS,
			new Set(),
			proxmox({ 400: marker(OURS, "gone"), 401: undefined }),
		);

		expect(scan).toMatchObject({
			orphans: [expect.objectContaining({ vmid: 400 })],
			unreadable: [401],
		});
	});

	it("fails the whole scan when the pool cannot be listed", async () => {
		const scan = await findOrphanContainers(
			API,
			"disposable-workspaces",
			OURS,
			new Set(),
			async () => new Response("{}", { status: 500 }),
		);

		expect(scan.kind).toBe("failed");
	});
});

describe("confirmOrphan", () => {
	it("confirms a container it still owns and has no workspace for", async () => {
		const confirmed = await confirmOrphan(
			API,
			400,
			OURS,
			new Set(),
			proxmox({ 400: marker(OURS, "gone") }),
		);

		expect(confirmed).toEqual({ kind: "confirmed", workspaceID: "gone" });
	});

	it("refuses a VMID that is not ours, however it was asked for", async () => {
		// The scan result goes to a browser and comes back as a number in a form. That number is a
		// request, not authorization.
		const refused = await confirmOrphan(
			API,
			400,
			OURS,
			new Set(),
			proxmox({ 400: marker(THEIRS, "gone") }),
		);

		expect(refused.kind).toBe("refused");
	});

	it("refuses a container whose workspace came back", async () => {
		// Between the scan and the click, a workspace could have been retried onto that VMID.
		const refused = await confirmOrphan(
			API,
			400,
			OURS,
			new Set(["alive"]),
			proxmox({ 400: marker(OURS, "alive") }),
		);

		expect(refused.kind).toBe("refused");
	});

	it("refuses a container it cannot read", async () => {
		const refused = await confirmOrphan(
			API,
			400,
			OURS,
			new Set(),
			proxmox({ 400: undefined }),
		);

		expect(refused.kind).toBe("refused");
	});
});
