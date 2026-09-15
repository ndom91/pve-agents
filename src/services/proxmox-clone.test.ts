import { describe, expect, it } from "vitest";

import { cloneWorkspace, ownershipMarker } from "./proxmox-clone";

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
		expect(request?.body?.toString()).toContain("full=0");
		expect(request?.body?.toString()).toContain("newid=109");
		expect(request?.body?.toString()).toContain("pool=disposable-workspaces");
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
