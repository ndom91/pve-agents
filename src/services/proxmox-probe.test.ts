import { describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { probeProxmox } from "./proxmox-probe";

describe("probeProxmox", () => {
	it("checks the configured template without mutating Proxmox", async () => {
		const requests: RequestInit[] = [];
		const result = await probeProxmox(config(), async (url, init) => {
			requests.push(init);
			if (url.endsWith("/cluster/nextid")) {
				return Response.json({ data: "200" });
			}
			if (url.endsWith("/storage")) {
				return Response.json({ data: [{ storage: "local-zfs" }] });
			}
			if (url.endsWith("/pools")) {
				return Response.json({ data: [{ poolid: "disposable-workspaces" }] });
			}
			if (url.endsWith("/network")) {
				return Response.json({ data: [{ iface: "vmbr0" }] });
			}

			return Response.json({
				data: {
					net0: "name=eth0,bridge=vmbr0,ip=dhcp,type=veth",
					rootfs: "local-zfs:subvol-107-disk-0,size=8G",
					template: 1,
					unprivileged: 1,
				},
			});
		});

		expect(result).toEqual({
			checks: [
				{
					detail: "token can read the next available VMID",
					name: "api",
					status: "ok",
				},
				{
					detail: "template 107 is unprivileged",
					name: "template",
					status: "ok",
				},
				{
					detail: "template rootfs storage local-zfs exists",
					name: "storage",
					status: "ok",
				},
				{
					detail: "pool disposable-workspaces exists",
					name: "pool",
					status: "ok",
				},
				{ detail: "bridge vmbr0 exists on nas", name: "bridge", status: "ok" },
			],
			ok: true,
		});
		for (const request of requests) {
			expect(request.method).toBe("GET");
		}
	});

	it("reports missing API configuration without a request", async () => {
		const result = await probeProxmox(controllerConfig({}), async () => {
			throw new Error("fetch must not be called");
		});

		expect(result).toEqual({
			checks: [
				{
					detail:
						"missing PROXMOX_NODE, PROXMOX_TEMPLATE_VMID, PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET, PROXMOX_URL",
					name: "api",
					status: "skipped",
				},
			],
			ok: false,
		});
	});
});

function config() {
	return controllerConfig({
		PROXMOX_BRIDGE: "vmbr0",
		PROXMOX_NODE: "nas",
		PROXMOX_POOL: "disposable-workspaces",
		PROXMOX_TEMPLATE_VMID: "107",
		PROXMOX_TOKEN_ID: "workspace-controller@pve!controller",
		PROXMOX_TOKEN_SECRET: "not-a-real-secret",
		PROXMOX_URL: "https://nas.puff.lan:8006/api2/json",
	});
}
