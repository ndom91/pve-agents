import { describe, expect, it } from "vitest";

import { proxmoxTaskStatus, taskNode } from "./proxmox-task";

const UPID = "UPID:nas:0000A1B2:00C3D4E5:65F00000:vzclone:109:root@pam:";

describe("taskNode", () => {
	it("reads the node that owns the task", () => {
		expect(taskNode(UPID)).toBe("nas");
	});

	it("rejects a malformed UPID", () => {
		expect(taskNode("UPID:nas:0000A1B2")).toBeUndefined();
		expect(taskNode("nas:0000A1B2:1:2:3:4:5:6:")).toBeUndefined();
		expect(taskNode("UPID::1:2:3:4:5:6:")).toBeUndefined();
	});
});

describe("proxmoxTaskStatus", () => {
	it("polls the node named in the UPID, not the configured node", async () => {
		const urls: string[] = [];
		await proxmoxTaskStatus(api(), UPID, async (url) => {
			urls.push(url);

			return Response.json({ data: { exitstatus: "OK", status: "stopped" } });
		});

		expect(urls).toEqual([
			`${api().apiURL}/nodes/nas/tasks/${encodeURIComponent(UPID)}/status`,
		]);
	});

	it("succeeds only when the task stopped with exit status OK", async () => {
		expect(await status({ exitstatus: "OK", status: "stopped" })).toEqual({
			kind: "succeeded",
		});
	});

	it("treats a running task as unfinished", async () => {
		expect(await status({ status: "running" })).toEqual({ kind: "running" });
	});

	it("fails a stopped task with any other exit status", async () => {
		expect(
			await status({
				exitstatus: "unable to create CT 109",
				status: "stopped",
			}),
		).toEqual({
			kind: "failed",
			message: "proxmox task exited with unable to create CT 109",
		});
	});

	it("fails a stopped task that reports no exit status", async () => {
		expect(await status({ status: "stopped" })).toEqual({
			kind: "failed",
			message: "proxmox task exited with no exit status",
		});
	});

	it("reports a transient error as unknown rather than failed", async () => {
		const unreachable = await proxmoxTaskStatus(api(), UPID, async () => {
			throw new Error("ECONNREFUSED");
		});
		expect(unreachable.kind).toBe("unknown");

		const serverError = await proxmoxTaskStatus(
			api(),
			UPID,
			async () => new Response("", { status: 500 }),
		);
		expect(serverError.kind).toBe("unknown");

		const badJSON = await proxmoxTaskStatus(
			api(),
			UPID,
			async () => new Response("not json", { status: 200 }),
		);
		expect(badJSON.kind).toBe("unknown");
	});

	it("fails a malformed UPID without issuing a request", async () => {
		let called = false;
		const result = await proxmoxTaskStatus(api(), "not-a-upid", async () => {
			called = true;

			return Response.json({ data: {} });
		});

		expect(result.kind).toBe("failed");
		expect(called).toBe(false);
	});
});

function api() {
	return {
		apiURL: "https://nas.puff.lan:8006/api2/json",
		node: "nas",
		tokenID: "workspace-controller@pve!controller",
		tokenSecret: "not-a-real-secret",
	};
}

function status(data: Record<string, string>) {
	return proxmoxTaskStatus(api(), UPID, async () => Response.json({ data }));
}
