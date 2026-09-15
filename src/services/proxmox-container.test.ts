import { describe, expect, it } from "vitest";

import {
	containerConfig,
	containerDescription,
	containerState,
	deleteContainer,
	shutdownContainer,
	stopContainer,
} from "./proxmox-container";
import type { Fetcher, ProxmoxTaskRequest } from "./proxmox-http";

describe("containerConfig", () => {
	it("returns the configuration of an existing container", async () => {
		const result = await containerConfig(
			api(),
			"token",
			"secret",
			"nas",
			109,
			async () => Response.json({ data: { description: "managed-by=x" } }),
		);

		expect(result).toEqual({
			config: { description: "managed-by=x" },
			kind: "found",
		});
	});

	it("treats HTTP 404 as a missing container", async () => {
		expect(await respond(new Response("", { status: 404 }))).toEqual({
			kind: "missing",
		});
	});

	it("treats a Proxmox does-not-exist 500 as a missing container", async () => {
		expect(
			await respond(
				new Response(
					"Configuration file 'nodes/nas/lxc/109.conf' does not exist",
					{
						status: 500,
					},
				),
			),
		).toEqual({ kind: "missing" });
	});

	it("treats any other error as transient rather than missing", async () => {
		expect(
			(await respond(new Response("permission denied", { status: 500 }))).kind,
		).toBe("failed");
		expect((await respond(new Response("", { status: 401 }))).kind).toBe(
			"failed",
		);
		expect(
			(await respond(new Response("not json", { status: 200 }))).kind,
		).toBe("failed");
	});

	it("reports an unreachable Proxmox as transient", async () => {
		const result = await containerConfig(
			api(),
			"token",
			"secret",
			"nas",
			109,
			async () => {
				throw new Error("ECONNREFUSED");
			},
		);

		expect(result.kind).toBe("failed");
	});
});

describe("containerState", () => {
	it("reports a running container", async () => {
		expect(await state({ status: "running" })).toEqual({ kind: "running" });
	});

	it("reports a stopped container", async () => {
		expect(await state({ status: "stopped" })).toEqual({ kind: "stopped" });
	});

	it("treats an unfamiliar transitional state as running", async () => {
		// Anything that is not explicitly stopped must route through shutdown and force stop
		// rather than straight to delete.
		expect(await state({ status: "mounted" })).toEqual({ kind: "running" });
	});

	it("fails when Proxmox reports no state at all", async () => {
		expect((await state({})).kind).toBe("failed");
	});

	it("treats a missing container as missing, not failed", async () => {
		const result = await containerState(
			api(),
			"token",
			"secret",
			"nas",
			109,
			async () => new Response("", { status: 404 }),
		);

		expect(result).toEqual({ kind: "missing" });
	});
});

describe("teardown actions", () => {
	it("asks for a clean shutdown with a bounded timeout and no forced stop", async () => {
		const request = await captured((fetcher) =>
			shutdownContainer(api(), "token", "secret", "nas", 109, fetcher),
		);

		expect(request.result).toEqual({ kind: "accepted", upid: "UPID:nas:1" });
		expect(request.url).toBe(`${api()}/nodes/nas/lxc/109/status/shutdown`);
		expect(request.method).toBe("POST");
		expect(request.body).toContain("forceStop=0");
		expect(request.body).toMatch(/timeout=\d+/);
	});

	it("forces a stop without a timeout", async () => {
		const request = await captured((fetcher) =>
			stopContainer(api(), "token", "secret", "nas", 109, fetcher),
		);

		expect(request.result).toEqual({ kind: "accepted", upid: "UPID:nas:1" });
		expect(request.url).toBe(`${api()}/nodes/nas/lxc/109/status/stop`);
		expect(request.method).toBe("POST");
	});

	it("deletes with purge and never with destroy-unreferenced-disks", async () => {
		const request = await captured((fetcher) =>
			deleteContainer(api(), "token", "secret", "nas", 109, fetcher),
		);

		expect(request.result).toEqual({ kind: "accepted", upid: "UPID:nas:1" });
		expect(request.method).toBe("DELETE");
		expect(request.url).toContain("purge=1");
		expect(request.url).not.toContain("destroy-unreferenced-disks");
	});

	it("fails rather than reporting success when no UPID comes back", async () => {
		const result = await deleteContainer(
			api(),
			"token",
			"secret",
			"nas",
			109,
			async () => Response.json({ data: null }),
		);

		expect(result).toEqual({
			kind: "failed",
			message: "proxmox delete request returned no UPID",
		});
	});

	it("reports an unreachable Proxmox as failed", async () => {
		const result = await stopContainer(
			api(),
			"token",
			"secret",
			"nas",
			109,
			async () => {
				throw new Error("ECONNREFUSED");
			},
		);

		expect(result.kind).toBe("failed");
	});
});

describe("containerDescription", () => {
	it("returns the description when present", () => {
		expect(containerDescription({ description: "managed-by=x" })).toBe(
			"managed-by=x",
		);
	});

	it("returns nothing when the container carries no description", () => {
		expect(containerDescription({})).toBeUndefined();
		expect(containerDescription({ description: 7 })).toBeUndefined();
	});
});

function api() {
	return "https://nas.puff.lan:8006/api2/json";
}

// captured runs one action against a stub, returning both its result and the request it made.
async function captured(
	action: (fetcher: Fetcher) => Promise<ProxmoxTaskRequest>,
) {
	let url = "";
	let method = "";
	let body = "";

	const result = await action(async (requestURL, init) => {
		url = requestURL;
		method = init.method as string;
		body = init.body === undefined ? "" : String(init.body);

		return Response.json({ data: "UPID:nas:1" });
	});

	return { body, method, result, url };
}

function state(data: Record<string, string>) {
	return containerState(api(), "token", "secret", "nas", 109, async () =>
		Response.json({ data }),
	);
}

function respond(response: Response) {
	return containerConfig(
		api(),
		"token",
		"secret",
		"nas",
		109,
		async () => response,
	);
}
