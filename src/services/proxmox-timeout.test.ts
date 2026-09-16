import { describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { cloneWorkspace, nextProxmoxVMID } from "./proxmox-clone";
import {
	containerConfig,
	containerState,
	deleteContainer,
	shutdownContainer,
	stopContainer,
} from "./proxmox-container";
import type { Fetcher } from "./proxmox-http";
import { probeProxmox } from "./proxmox-probe";
import { proxmoxTaskStatus } from "./proxmox-task";

const API = {
	apiURL: "https://nas.puff.lan:8006/api2/json",
	node: "nas",
	tokenID: "t",
	tokenSecret: "s",
};
const UPID = "UPID:nas:0000A1B2:00C3D4E5:65F00000:vzclone:109:root@pam:";

// Every Proxmox call must be bounded. An unbounded fetch parks the scheduler on an await it can
// never leave, which stops all provisioning and makes SIGTERM useless.
describe("proxmox request timeouts", () => {
	const calls: Array<[string, () => Promise<unknown>]> = [];

	function record(name: string, run: (fetcher: Fetcher) => Promise<unknown>) {
		calls.push([
			name,
			() => {
				let seen: RequestInit | undefined;
				const fetcher: Fetcher = async (_url, init) => {
					seen = init;

					return Response.json({ data: "UPID:nas:1" });
				};

				return run(fetcher).then(() => seen);
			},
		]);
	}

	record("nextProxmoxVMID", (f) => nextProxmoxVMID(API, f));
	record("cloneWorkspace", (f) => cloneWorkspace(API, clone(), f));
	record("containerConfig", (f) => containerConfig(API, 109, f));
	record("containerState", (f) => containerState(API, 109, f));
	record("shutdownContainer", (f) => shutdownContainer(API, 109, f));
	record("stopContainer", (f) => stopContainer(API, 109, f));
	record("deleteContainer", (f) => deleteContainer(API, 109, f));
	record("proxmoxTaskStatus", (f) => proxmoxTaskStatus(API, UPID, f));

	for (const [name, run] of calls) {
		it(`${name} passes an abort signal`, async () => {
			const init = (await run()) as RequestInit | undefined;

			expect(
				init?.signal,
				`${name} issued a request with no timeout`,
			).toBeTruthy();
			expect(init?.signal?.aborted).toBe(false);
		});
	}

	it("probeProxmox passes an abort signal", async () => {
		let seen: RequestInit | undefined;
		await probeProxmox(
			controllerConfig({
				PROXMOX_NODE: "nas",
				PROXMOX_TEMPLATE_VMID: "107",
				PROXMOX_TOKEN_ID: "t",
				PROXMOX_TOKEN_SECRET: "s",
				PROXMOX_URL: API.apiURL,
			}),
			async (_url, init) => {
				seen = init;

				return Response.json({ data: "109" });
			},
		);

		expect(seen?.signal).toBeTruthy();
	});
});

function clone() {
	return {
		controllerID: "b66d3c5d-22c6-4199-889e-764f12d37fe5",
		createdAt: "2026-01-01T00:00:00.000Z",
		hostname: "agent-test",
		node: "nas",
		ownershipToken: "4a5d1c0e-4bd6-4a8f-9b1f-2c0d4e6f8a1b",
		pool: "disposable-workspaces",
		templateVMID: 107,
		vmid: 109,
		workspaceID: "0f2c9b8a-1d3e-4f50-9a6b-7c8d9e0f1a2b",
	};
}
