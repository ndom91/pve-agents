import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";
import {
	createWorkspace,
	requestWorkspaceOperation,
} from "../db/workspace-repository";
import type { Fetcher } from "./proxmox-http";
import { ownershipMarker } from "./proxmox-ownership";
import { runWorkspaceOperations } from "./workspace-operation-worker";

const CONTROLLER_ID = "b66d3c5d-22c6-4199-889e-764f12d37fe5";
const UPID = "UPID:nas:0000A1B2:00C3D4E5:65F00000:vzclone:109:root@pam:";
const SHUTDOWN_UPID =
	"UPID:nas:0000A1B3:00C3D4E5:65F00001:vzshutdown:109:root@pam:";
const STOP_UPID = "UPID:nas:0000A1B4:00C3D4E5:65F00002:vzstop:109:root@pam:";
const DELETE_UPID =
	"UPID:nas:0000A1B5:00C3D4E5:65F00003:vzdestroy:109:root@pam:";

// Every helper pins the controller clock so that a later poll is past the release delay but well
// inside the clone deadline. Left to the wall clock, every test would read as a timed-out task.
const SUBMITTED_AT = new Date("2026-01-01T00:00:00Z");
const POLLED_AT = new Date("2026-01-01T00:00:10Z");

const databases: Database.Database[] = [];
let ticks = 0;

beforeEach(() => {
	ticks = 0;
});

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("runWorkspaceOperations", () => {
	it("does not execute queued operations by default", async () => {
		const db = database();

		expect(await runWorkspaceOperations(db, controllerConfig({}))).toEqual({
			processed: 0,
			status: "disabled",
		});
	});

	it("persists clone recovery points around one provision request", async () => {
		const db = database();
		const workspaceID = workspace(db);

		const result = await runWorkspaceOperations(db, config(), async (url) => {
			if (url.endsWith("/cluster/nextid")) {
				return Response.json({ data: "109" });
			}

			return Response.json({ data: UPID });
		});

		expect(result).toEqual({ processed: 1, status: "clone_submitted" });
		expect(
			db
				.prepare("SELECT vmid, current_task_upid FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ current_task_upid: UPID, vmid: 109 });
	});

	it("confirms a clone once Proxmox reports success", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({ data: { exitstatus: "OK", status: "stopped" } }),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "clone_confirmed" });
		expect(
			db
				.prepare(
					"SELECT status, current_step, current_task_upid FROM workspaces WHERE id = ?",
				)
				.get(workspaceID),
		).toEqual({
			current_step: "clone confirmed",
			current_task_upid: null,
			status: "provisioning",
		});
	});

	it("keeps waiting while the clone task is still running", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => Response.json({ data: { status: "running" } }),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "awaiting_task" });
		expect(workspaceStatus(db, workspaceID)).toBe("provisioning");
		expect(
			db
				.prepare("SELECT status, next_run_at FROM workspace_operations")
				.get() as { next_run_at: string; status: string },
		).toMatchObject({ status: "queued" });
	});

	it("fails the workspace when the clone task reports a bad exit status", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({
					data: { exitstatus: "unable to create CT 109", status: "stopped" },
				}),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "task_failed" });
		expect(
			db
				.prepare(
					"SELECT status, error_code, error_message FROM workspaces WHERE id = ?",
				)
				.get(workspaceID),
		).toEqual({
			error_code: "clone_task_failed",
			error_message: "proxmox task exited with unable to create CT 109",
			status: "failed",
		});
		expect(db.prepare("SELECT status FROM workspace_operations").get()).toEqual(
			{ status: "failed" },
		);
	});

	it("does not fail the workspace when polling hits a transient error", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => new Response("", { status: 500 }),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "awaiting_task" });
		expect(workspaceStatus(db, workspaceID)).toBe("provisioning");
	});

	it("fails a task that never finishes before its deadline", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => Response.json({ data: { status: "running" } }),
			new Date("2026-01-01T01:00:00Z"),
		);

		expect(result).toEqual({ processed: 1, status: "task_failed" });
		expect(
			db
				.prepare("SELECT status, error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ error_code: "clone_task_timeout", status: "failed" });
	});

	it("adopts a candidate container whose ownership marker matches", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({
					data: {
						description: ownershipMarker({
							controllerID: CONTROLLER_ID,
							createdAt: "2026-01-01T00:00:00.000Z",
							ownershipToken: ownershipToken(db, workspaceID),
							workspaceID,
						}),
					},
				}),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "vmid_adopted" });
		expect(
			db
				.prepare("SELECT vmid, current_step FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ current_step: "clone confirmed", vmid: 109 });
	});

	it("abandons a candidate VMID whose container belongs to someone else", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({
					data: {
						description: ownershipMarker({
							controllerID: "11111111-1111-1111-1111-111111111111",
							createdAt: "2026-01-01T00:00:00.000Z",
							ownershipToken: "22222222-2222-2222-2222-222222222222",
							workspaceID: "33333333-3333-3333-3333-333333333333",
						}),
					},
				}),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "vmid_released" });
		expect(
			db.prepare("SELECT vmid FROM workspaces WHERE id = ?").get(workspaceID),
		).toEqual({ vmid: null });
		expect(workspaceStatus(db, workspaceID)).toBe("provisioning");
	});

	it("never issues a write while reconciling an unverified container", async () => {
		const db = database();
		await lostCloneResponse(db);
		const methods: string[] = [];

		await runWorkspaceOperations(
			db,
			config(),
			async (_url, init) => {
				methods.push(init.method as string);

				return Response.json({ data: { description: "hand-written note" } });
			},
			POLLED_AT,
		);

		expect(methods).toEqual(["GET"]);
	});

	it("resumes a clone that was still running when its response was lost", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async (url) => {
				if (url.includes("/tasks?")) {
					return Response.json({
						data: [{ id: "109", type: "vzclone", upid: UPID }],
					});
				}

				return new Response("", { status: 404 });
			},
			POLLED_AT,
		);

		// The container is not visible yet, but the clone is in flight. Abandoning the VMID here
		// would leave it as an orphan carrying this workspace's ownership marker.
		expect(result).toEqual({ processed: 1, status: "task_recovered" });
		expect(
			db
				.prepare("SELECT vmid, current_task_upid FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ current_task_upid: UPID, vmid: 109 });
	});

	it("ignores an unrelated running task on the same VMID", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async (url) => {
				if (url.includes("/tasks?")) {
					return Response.json({
						data: [{ id: "109", type: "vzstart", upid: UPID }],
					});
				}

				return new Response("", { status: 404 });
			},
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "vmid_released" });
		expect(
			db.prepare("SELECT vmid FROM workspaces WHERE id = ?").get(workspaceID),
		).toEqual({ vmid: null });
	});

	it("abandons a candidate VMID when no container was ever created", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async (url) => {
				if (url.includes("/tasks?")) {
					return Response.json({ data: [] });
				}

				return new Response("", { status: 404 });
			},
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "vmid_released" });
		expect(
			db.prepare("SELECT vmid FROM workspaces WHERE id = ?").get(workspaceID),
		).toEqual({ vmid: null });
	});

	it("retries reconciliation when the inspection request fails", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => new Response("permission denied", { status: 500 }),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "awaiting_reconciliation" });
		expect(
			db.prepare("SELECT vmid FROM workspaces WHERE id = ?").get(workspaceID),
		).toEqual({ vmid: 109 });
	});
});

describe("runWorkspaceOperations destroying a workspace", () => {
	it("shuts a running container down before deleting it", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		const calls: string[] = [];

		const shutdown = await tick(db, proxmox(db, workspaceID, { calls }));
		expect(shutdown).toEqual({ processed: 1, status: "shutdown_submitted" });
		expect(calls).toEqual([
			"GET /config",
			"GET /status/current",
			"POST /status/shutdown",
		]);

		await tick(db, proxmox(db, workspaceID, { task: "OK" }));
		expect(currentStep(db, workspaceID)).toBe("shutdown confirmed");

		const remove = await tick(
			db,
			proxmox(db, workspaceID, { state: "stopped" }),
		);
		expect(remove).toEqual({ processed: 1, status: "delete_submitted" });

		const done = await tick(db, proxmox(db, workspaceID, { task: "OK" }));
		expect(done).toEqual({ processed: 1, status: "container_deleted" });
		expect(
			db
				.prepare("SELECT status, destroyed_at FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toMatchObject({ status: "destroyed" });
	});

	it("deletes an already stopped container without shutting it down", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		const calls: string[] = [];

		const result = await tick(
			db,
			proxmox(db, workspaceID, { calls, state: "stopped" }),
		);

		expect(result).toEqual({ processed: 1, status: "delete_submitted" });
		expect(calls).toEqual([
			"GET /config",
			"GET /status/current",
			"DELETE /lxc",
		]);
	});

	it("escalates to a forced stop when clean shutdown fails", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		await tick(db, proxmox(db, workspaceID, {}));

		await tick(db, proxmox(db, workspaceID, { task: "timeout waiting" }));
		expect(currentStep(db, workspaceID)).toBe(
			"clean shutdown failed; force stop required",
		);

		const calls: string[] = [];
		const stop = await tick(db, proxmox(db, workspaceID, { calls }));

		expect(stop).toEqual({ processed: 1, status: "stop_submitted" });
		expect(calls).toEqual(["GET /config", "POST /status/stop"]);
	});

	it("force stops a guest still running after its shutdown reported success", async () => {
		const db = database();
		const workspaceID = await destroyable(db);

		await tick(db, proxmox(db, workspaceID, {}));
		await tick(db, proxmox(db, workspaceID, { task: "OK" }));
		expect(currentStep(db, workspaceID)).toBe("shutdown confirmed");

		// The task succeeded but the guest is still up. Asking it to shut down again would cycle
		// shutdown -> confirm -> shutdown until the operation deadline.
		const calls: string[] = [];
		const result = await tick(
			db,
			proxmox(db, workspaceID, { calls, state: "running" }),
		);

		expect(result).toEqual({ processed: 1, status: "stop_submitted" });
		expect(calls).toEqual([
			"GET /config",
			"GET /status/current",
			"POST /status/stop",
		]);
	});

	it("treats an absent container as a successful destruction", async () => {
		const db = database();
		const workspaceID = await destroyable(db);

		const result = await tick(
			db,
			async () => new Response("", { status: 404 }),
		);

		expect(result).toEqual({ processed: 1, status: "container_missing" });
		expect(workspaceStatus(db, workspaceID)).toBe("destroyed");
	});

	it("halts without issuing any write when ownership does not match", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		const calls: string[] = [];

		const result = await tick(
			db,
			proxmox(db, workspaceID, { calls, description: "hand-written note" }),
		);

		expect(result).toEqual({ processed: 1, status: "destroy_halted" });
		expect(calls).toEqual(["GET /config"]);
		expect(
			db
				.prepare(
					"SELECT status, error_code, error_retryable FROM workspaces WHERE id = ?",
				)
				.get(workspaceID),
		).toMatchObject({
			error_code: "destroy_ownership_mismatch",
			error_retryable: 0,
			status: "destroying",
		});
		expect(
			db
				.prepare(
					"SELECT status FROM workspace_operations WHERE kind = 'destroy'",
				)
				.get(),
		).toEqual({ status: "failed" });
	});

	it("cancels outstanding provisioning when a destroy is requested", async () => {
		const db = database();
		const workspaceID = await destroyable(db);

		expect(
			db
				.prepare(
					"SELECT status, error_message FROM workspace_operations WHERE kind = 'provision'",
				)
				.get(),
		).toEqual({
			error_message: "superseded by a destroy request",
			status: "cancelled",
		});

		// A cancelled provision must never run again; otherwise it could clone a replacement
		// container while teardown removes the original.
		await tick(db, async () => new Response("", { status: 404 }));
		expect(workspaceStatus(db, workspaceID)).toBe("destroyed");
		expect(
			await tick(db, async () => {
				throw new Error("no operation should remain claimable");
			}),
		).toEqual({ processed: 0, status: "empty" });
	});

	it("does not poll a cancelled clone task as though it were a teardown task", async () => {
		const db = database();
		// Destroy requested while the clone is still in flight: the workspace row still carries the
		// clone UPID, and both kinds share that one column.
		const workspaceID = await submitted(db);
		expect(requestWorkspaceOperation(db, workspaceID, "destroy").kind).toBe(
			"created",
		);
		expect(
			db
				.prepare("SELECT current_task_upid FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ current_task_upid: null });

		// A failed clone task must not halt teardown. Teardown re-inspects Proxmox instead.
		const result = await tick(
			db,
			proxmox(db, workspaceID, { state: "stopped", task: "clone failed" }),
		);

		expect(result).toEqual({ processed: 1, status: "delete_submitted" });
		expect(workspaceStatus(db, workspaceID)).toBe("destroying");
	});

	it("halts on a container this controller owns but for a different workspace", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		const calls: string[] = [];

		// managed-by and controller-id both match; only workspace-id and the token differ. This is
		// what VMID reuse produces on real hardware, and it is the case an unmarked-container test
		// cannot catch.
		const result = await tick(
			db,
			proxmox(db, workspaceID, {
				calls,
				description: ownershipMarker({
					controllerID: CONTROLLER_ID,
					createdAt: "2026-01-01T00:00:00.000Z",
					ownershipToken: "99999999-9999-9999-9999-999999999999",
					workspaceID: "88888888-8888-8888-8888-888888888888",
				}),
			}),
		);

		expect(result).toEqual({ processed: 1, status: "destroy_halted" });
		expect(calls).toEqual(["GET /config"]);
		expect(
			db
				.prepare("SELECT error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ error_code: "destroy_ownership_mismatch" });
	});

	it("does not fail a teardown on a transient Proxmox error", async () => {
		const db = database();
		const workspaceID = await destroyable(db);

		const result = await tick(
			db,
			async () => new Response("permission denied", { status: 500 }),
		);

		expect(result).toEqual({ processed: 1, status: "awaiting_reconciliation" });
		expect(
			db
				.prepare("SELECT status, error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ error_code: null, status: "destroying" });
	});

	it("claims a destroy ahead of another workspace's queued provision", async () => {
		const db = database();
		const destroying = await destroyable(db);
		createWorkspace(db, {
			herdrSession: "agents",
			idempotencyKey: "request-b",
			repository: "https://github.com/plainhq/other.git",
			ref: "main",
		});

		const result = await tick(
			db,
			async () => new Response("", { status: 404 }),
		);

		expect(result).toEqual({ processed: 1, status: "container_missing" });
		expect(workspaceStatus(db, destroying)).toBe("destroyed");
	});

	it("rejects a second destroy request once the workspace is destroyed", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		await tick(db, async () => new Response("", { status: 404 }));

		expect(requestWorkspaceOperation(db, workspaceID, "destroy").kind).toBe(
			"invalid_transition",
		);
	});

	it("destroys a workspace that never got as far as a container", async () => {
		const db = database();
		const workspaceID = workspace(db);
		expect(requestWorkspaceOperation(db, workspaceID, "destroy").kind).toBe(
			"created",
		);

		const result = await tick(db, async () => {
			throw new Error("proxmox must not be contacted");
		});

		expect(result).toEqual({ processed: 1, status: "container_missing" });
		expect(workspaceStatus(db, workspaceID)).toBe("destroyed");
	});
});

// proxmox builds a fetcher routing each teardown call to a canned response, optionally recording
// the request line so a test can assert exactly which actions were attempted.
function proxmox(
	db: Database.Database,
	workspaceID: string,
	options: {
		calls?: string[];
		description?: string;
		state?: "running" | "stopped";
		task?: string;
	},
): Fetcher {
	const description =
		options.description ??
		ownershipMarker({
			controllerID: CONTROLLER_ID,
			createdAt: "2026-01-01T00:00:00.000Z",
			ownershipToken: ownershipToken(db, workspaceID),
			workspaceID,
		});

	return async (url, init) => {
		const method = init.method as string;
		const record = (path: string) => options.calls?.push(`${method} ${path}`);

		if (url.includes("/tasks/")) {
			return Response.json({
				data: { exitstatus: options.task ?? "OK", status: "stopped" },
			});
		}
		if (url.endsWith("/config")) {
			record("/config");

			return Response.json({ data: { description } });
		}
		if (url.endsWith("/status/current")) {
			record("/status/current");

			return Response.json({ data: { status: options.state ?? "running" } });
		}
		if (url.endsWith("/status/shutdown")) {
			record("/status/shutdown");

			return Response.json({ data: SHUTDOWN_UPID });
		}
		if (url.endsWith("/status/stop")) {
			record("/status/stop");

			return Response.json({ data: STOP_UPID });
		}
		if (method === "DELETE") {
			record("/lxc");
			expect(url).toContain("purge=1");
			expect(url).not.toContain("destroy-unreferenced-disks");

			return Response.json({ data: DELETE_UPID });
		}

		throw new Error(`unexpected request ${method} ${url}`);
	};
}

// tick advances the clock a minute per pass, since an operation released to wait on Proxmox is
// deliberately not due again immediately.
function tick(db: Database.Database, fetcher: Fetcher) {
	ticks += 1;

	return runWorkspaceOperations(
		db,
		config(),
		fetcher,
		new Date(POLLED_AT.getTime() + ticks * 60_000),
	);
}

function currentStep(db: Database.Database, workspaceID: string): string {
	return (
		db
			.prepare("SELECT current_step FROM workspaces WHERE id = ?")
			.get(workspaceID) as { current_step: string }
	).current_step;
}

// destroyable leaves a workspace with a confirmed clone and a queued destroy request.
async function destroyable(db: Database.Database): Promise<string> {
	const workspaceID = await submitted(db);
	await runWorkspaceOperations(
		db,
		config(),
		async () =>
			Response.json({ data: { exitstatus: "OK", status: "stopped" } }),
		POLLED_AT,
	);
	if (
		requestWorkspaceOperation(db, workspaceID, "destroy").kind !== "created"
	) {
		throw new Error("expected destroy request");
	}

	return workspaceID;
}

function config() {
	return controllerConfig({
		CONTROLLER_AUTH_SECRET: "c".repeat(48),
		CONTROLLER_ID,
		CONTROLLER_OPERATOR_GITHUB_ID: "1",
		GITHUB_CLIENT_ID: "github-client",
		GITHUB_CLIENT_SECRET: "github-secret",
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

function database(): Database.Database {
	const db = openDatabase(":memory:");
	databases.push(db);

	return db;
}

// lostCloneResponse leaves a workspace holding a candidate VMID with no clone UPID, which is the
// state a controller crash between the two checkpoints produces.
async function lostCloneResponse(db: Database.Database): Promise<string> {
	const workspaceID = workspace(db);
	await runWorkspaceOperations(
		db,
		config(),
		async (url) => {
			if (url.endsWith("/cluster/nextid")) {
				return Response.json({ data: "109" });
			}

			throw new Error("clone response lost");
		},
		SUBMITTED_AT,
	);

	return workspaceID;
}

function ownershipToken(db: Database.Database, workspaceID: string): string {
	return (
		db
			.prepare("SELECT ownership_token FROM workspaces WHERE id = ?")
			.get(workspaceID) as { ownership_token: string }
	).ownership_token;
}

// submitted leaves a workspace waiting on an accepted clone task recorded at a known time.
async function submitted(db: Database.Database): Promise<string> {
	const workspaceID = workspace(db);
	await runWorkspaceOperations(
		db,
		config(),
		async (url) => {
			if (url.endsWith("/cluster/nextid")) {
				return Response.json({ data: "109" });
			}

			return Response.json({ data: UPID });
		},
		SUBMITTED_AT,
	);

	return workspaceID;
}

function workspace(db: Database.Database): string {
	const created = createWorkspace(db, {
		herdrSession: "agents",
		idempotencyKey: "request-a",
		repository: "https://github.com/plainhq/plain.git",
		ref: "main",
	});
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}

	return created.workspace.id;
}

function workspaceStatus(db: Database.Database, workspaceID: string): string {
	return (
		db
			.prepare("SELECT status FROM workspaces WHERE id = ?")
			.get(workspaceID) as {
			status: string;
		}
	).status;
}

describe("runWorkspaceOperations giving up", () => {
	it("fails a provision that has been retrying past its deadline", async () => {
		const db = database();
		const workspaceID = workspace(db);

		// Stands in for a durable fault such as a revoked Proxmox token: the request never
		// succeeds, so no task is ever recorded and the per-task deadline never applies.
		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => new Response("", { status: 401 }),
			new Date(Date.now() + 2 * 60 * 60 * 1000),
		);

		expect(result).toEqual({ processed: 1, status: "attempts_exhausted" });
		expect(
			db
				.prepare("SELECT status, error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({
			error_code: "provision_attempts_exhausted",
			status: "failed",
		});
	});

	it("halts rather than fails an exhausted destroy", async () => {
		const db = database();
		const workspaceID = workspace(db);
		requestWorkspaceOperation(db, workspaceID, "destroy");

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => new Response("", { status: 401 }),
			new Date(Date.now() + 2 * 60 * 60 * 1000),
		);

		// The desired state is still "destroyed" and the container may still exist, so teardown
		// stops for a human rather than claiming a terminal failure.
		expect(result).toEqual({ processed: 1, status: "attempts_exhausted" });
		expect(
			db
				.prepare("SELECT status, error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({
			error_code: "destroy_attempts_exhausted",
			status: "destroying",
		});
	});

	it("leaves a young operation alone", async () => {
		const db = database();
		workspace(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => new Response("", { status: 401 }),
			new Date(),
		);

		expect(result.status).not.toBe("attempts_exhausted");
	});
});
