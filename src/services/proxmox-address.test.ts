import { describe, expect, it } from "vitest";

import { containerAddress } from "./proxmox-address";
import type { Fetcher } from "./proxmox-http";

const API = {
	apiURL: "https://nas.puff.lan:8006/api2/json",
	node: "nas",
	tokenID: "t",
	tokenSecret: "s",
};

describe("containerAddress", () => {
	it("takes the eth0 address", async () => {
		expect(
			await find([
				{ inet: "127.0.0.1/8", name: "lo" },
				{ inet: "10.0.3.101/24", name: "eth0" },
			]),
		).toEqual({ address: "10.0.3.101", kind: "found" });
	});

	it("ignores loopback and link-local", async () => {
		// A link-local address means DHCP has not answered, not that the container is reachable.
		expect(
			await find([
				{ inet: "127.0.0.1/8", name: "lo" },
				{ inet: "169.254.7.3/16", name: "eth0" },
			]),
		).toEqual({ kind: "pending" });
	});

	it("prefers eth0 over a container's own bridge", async () => {
		// Picking docker0 would give an address only reachable from inside the container.
		expect(
			await find([
				{ inet: "172.17.0.1/16", name: "docker0" },
				{ inet: "10.0.3.101/24", name: "eth0" },
			]),
		).toEqual({ address: "10.0.3.101", kind: "found" });
	});

	it("rejects an address outside the configured subnet", async () => {
		expect(
			await find([{ inet: "172.17.0.1/16", name: "eth0" }], "10.0.3.0/24"),
		).toEqual({ kind: "pending" });
		expect(
			await find([{ inet: "10.0.3.101/24", name: "eth0" }], "10.0.3.0/24"),
		).toEqual({ address: "10.0.3.101", kind: "found" });
	});

	it("matches a subnet by prefix, not by string", async () => {
		// 10.0.30.5 shares a textual prefix with 10.0.3.0/24 but is not in it.
		expect(
			await find([{ inet: "10.0.30.5/24", name: "eth0" }], "10.0.3.0/24"),
		).toEqual({ kind: "pending" });
	});

	it("is pending, not failed, when no interface has an address yet", async () => {
		expect(await find([{ name: "eth0" }])).toEqual({ kind: "pending" });
		expect(await find([])).toEqual({ kind: "pending" });
	});

	it("reports a transport or shape problem as failed", async () => {
		const unreachable: Fetcher = async () => {
			throw new Error("ECONNREFUSED");
		};
		expect(
			(await containerAddress(API, 109, undefined, unreachable)).kind,
		).toBe("failed");

		const notJSON: Fetcher = async () => new Response("nope", { status: 200 });
		expect((await containerAddress(API, 109, undefined, notJSON)).kind).toBe(
			"failed",
		);

		const forbidden: Fetcher = async () => new Response("", { status: 403 });
		expect((await containerAddress(API, 109, undefined, forbidden)).kind).toBe(
			"failed",
		);
	});
});

function find(data: Array<Record<string, string>>, subnet?: string) {
	return containerAddress(API, 109, subnet, async () =>
		Response.json({ data }),
	);
}
