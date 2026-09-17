import { describe, expect, it } from "vitest";

import { allocateProxmoxVMID } from "./proxmox-clone";

const API = {
	apiURL: "https://nas.puff.lan:8006/api2/json",
	node: "nas",
	tokenID: "workspace-controller@pve!controller",
	tokenSecret: "not-a-real-secret",
};

// taken fakes Proxmox: /cluster/nextid?vmid=N answers 400 for an id already in use.
function taken(used: number[]) {
	return async (url: string) => {
		const vmid = Number(new URL(url).searchParams.get("vmid"));

		return used.includes(vmid)
			? Response.json(
					{ errors: { vmid: `VM ${vmid} already exists` } },
					{ status: 400 },
				)
			: Response.json({ data: String(vmid) });
	};
}

describe("allocateProxmoxVMID", () => {
	it("takes the floor when it is free", async () => {
		const allocated = await allocateProxmoxVMID(API, taken([]), 400);

		expect(allocated).toEqual({ kind: "allocated", vmid: 400 });
	});

	it("walks past ids Proxmox reports as taken", async () => {
		const allocated = await allocateProxmoxVMID(
			API,
			taken([400, 401, 402]),
			400,
		);

		expect(allocated).toEqual({ kind: "allocated", vmid: 403 });
	});

	it("never lands below the floor", async () => {
		// The whole point of a floor is that disposable workspaces stay out of the range where
		// hand-built guests live, so a free low id must not tempt it.
		let lowest = Number.POSITIVE_INFINITY;
		await allocateProxmoxVMID(
			API,
			async (url) => {
				const vmid = Number(new URL(url).searchParams.get("vmid"));
				lowest = Math.min(lowest, vmid);

				return Response.json({ data: String(vmid) });
			},
			400,
		);

		expect(lowest).toBe(400);
	});

	it("skips ids this controller has already promised", async () => {
		// Proxmox does not know about a candidate until the clone starts, so it would happily
		// report 400 free to two provisions a second apart.
		const allocated = await allocateProxmoxVMID(
			API,
			taken([]),
			400,
			new Set([400, 401]),
		);

		expect(allocated).toEqual({ kind: "allocated", vmid: 402 });
	});

	it("gives up rather than scanning forever", async () => {
		const exhausted = await allocateProxmoxVMID(
			API,
			async (url) =>
				Response.json(
					{ errors: { vmid: "taken" } },
					{ status: 400, statusText: String(url) },
				),
			400,
		);

		expect(exhausted.kind).toBe("failed");
		expect(JSON.stringify(exhausted)).toContain("400");
	});

	it("treats a server error as a fault rather than a taken id", async () => {
		// 400 is Proxmox's way of saying "that one is in use". Anything else means the question
		// was not answered, and walking on would silently pick a colliding id.
		const failed = await allocateProxmoxVMID(
			API,
			async () => new Response("{}", { status: 500 }),
			400,
		);

		expect(failed).toEqual({
			kind: "failed",
			message: "proxmox next VMID request returned HTTP 500",
		});
	});
});
