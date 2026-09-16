import { describe, expect, it } from "vitest";

import { cloneWorkspace, nextProxmoxVMID } from "./proxmox-clone";
import { ownershipMarker } from "./proxmox-ownership";

describe("ownershipMarker", () => {
	it("includes every ownership proof", () => {
		expect(ownershipMarker(input())).toBe(
			[
				"managed-by=pve-herdr-agents",
				"controller-id=controller-1",
				"workspace-id=workspace-1",
				"ownership-token=ownership-1",
				"created-at=2026-01-01T00:00:00.000Z",
			].join("\n"),
		);
	});
});

describe("cloneWorkspace", () => {
	it("submits a linked clone with its ownership marker", async () => {
		let request: RequestInit | undefined;
		const result = await cloneWorkspace(
			"https://nas.puff.lan:8006/api2/json",
			"workspace-controller@pve!controller",
			"not-a-real-secret",
			input(),
			async (_url, init) => {
				request = init;

				return Response.json({ data: "UPID:nas:00000001" });
			},
		);

		expect(result).toEqual({ kind: "accepted", upid: "UPID:nas:00000001" });
		expect(request?.method).toBe("POST");

		const body = new URLSearchParams(request?.body?.toString());
		expect(body.get("full")).toBe("0");
		expect(body.get("newid")).toBe("109");
		expect(body.get("pool")).toBe("disposable-workspaces");
		expect(body.get("hostname")).toBe("agent-workspace");
		// The marker is the only authorization proof for every later destructive action and for
		// adopting a candidate VMID. A clone that shipped without it would orphan its container.
		expect(body.get("description")).toBe(ownershipMarker(input()));
	});

	it("never submits a clone without an ownership marker", async () => {
		let body = new URLSearchParams();
		await cloneWorkspace(
			"https://nas.puff.lan:8006/api2/json",
			"workspace-controller@pve!controller",
			"not-a-real-secret",
			input(),
			async (_url, init) => {
				body = new URLSearchParams(init.body?.toString());

				return Response.json({ data: "UPID:nas:00000001" });
			},
		);

		const marker = body.get("description") ?? "";
		for (const field of [
			"managed-by=pve-herdr-agents",
			`controller-id=${input().controllerID}`,
			`workspace-id=${input().workspaceID}`,
			`ownership-token=${input().ownershipToken}`,
		]) {
			expect(marker).toContain(field);
		}
	});
});

describe("nextProxmoxVMID", () => {
	it("returns a candidate VMID from Proxmox", async () => {
		const result = await nextProxmoxVMID(
			"https://nas.puff.lan:8006/api2/json",
			"workspace-controller@pve!controller",
			"not-a-real-secret",
			async () => Response.json({ data: "109" }),
		);

		expect(result).toEqual({ kind: "allocated", vmid: 109 });
	});
});

function input() {
	return {
		controllerID: "controller-1",
		createdAt: "2026-01-01T00:00:00.000Z",
		hostname: "agent-workspace",
		node: "nas",
		ownershipToken: "ownership-1",
		pool: "disposable-workspaces",
		templateVMID: 107,
		vmid: 109,
		workspaceID: "workspace-1",
	};
}
