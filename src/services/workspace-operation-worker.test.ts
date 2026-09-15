import { describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";
import { createWorkspace } from "../db/workspace-repository";
import { runWorkspaceOperations } from "./workspace-operation-worker";

describe("runWorkspaceOperations", () => {
	it("does not execute queued operations by default", async () => {
		const db = openDatabase(":memory:");

		expect(await runWorkspaceOperations(db, controllerConfig({}))).toEqual({
			processed: 0,
			status: "disabled",
		});
		db.close();
	});

	it("persists clone recovery points around one provision request", async () => {
		const db = openDatabase(":memory:");
		const created = createWorkspace(db, {
			herdrSession: "agents",
			idempotencyKey: "request-a",
			repository: "https://github.com/plainhq/plain.git",
			ref: "main",
		});
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}

		const result = await runWorkspaceOperations(db, config(), async (url) => {
			if (url.endsWith("/cluster/nextid")) {
				return Response.json({ data: "109" });
			}

			return Response.json({ data: "UPID:nas:00000001" });
		});

		expect(result).toEqual({ processed: 1, status: "clone_submitted" });
		expect(
			db
				.prepare("SELECT vmid, current_task_upid FROM workspaces WHERE id = ?")
				.get(created.workspace.id),
		).toEqual({ current_task_upid: "UPID:nas:00000001", vmid: 109 });
		db.close();
	});
});

function config() {
	return controllerConfig({
		CONTROLLER_ID: "b66d3c5d-22c6-4199-889e-764f12d37fe5",
		PROVISIONING_ENABLED: "true",
		PROXMOX_BRIDGE: "vmbr0",
		PROXMOX_NODE: "nas",
		PROXMOX_POOL: "disposable-workspaces",
		PROXMOX_TEMPLATE_VMID: "107",
		PROXMOX_TOKEN_ID: "workspace-controller@pve!controller",
		PROXMOX_TOKEN_SECRET: "not-a-real-secret",
		PROXMOX_URL: "https://nas.puff.lan:8006/api2/json",
	});
}
