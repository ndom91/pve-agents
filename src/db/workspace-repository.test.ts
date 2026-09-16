import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database";
import {
	advanceWorkspaceDestroy,
	claimWorkspaceOperation,
	completeWorkspaceDestroy,
	completeWorkspaceOperation,
	confirmWorkspaceClone,
	createWorkspace,
	failWorkspaceProvision,
	haltWorkspaceDestroy,
	listWorkspaces,
	prepareWorkspaceProvision,
	recordWorkspaceTask,
	releaseWorkspaceCandidateVMID,
	releaseWorkspaceOperation,
	requestWorkspaceOperation,
} from "./workspace-repository";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("createWorkspace", () => {
	it("persists workspace intent and its event", () => {
		const db = database();
		const result = createWorkspace(db, input("request-a"));

		expect(result.kind).toBe("created");
		if (result.kind !== "created") {
			return;
		}

		expect(listWorkspaces(db)).toEqual([result.workspace]);
		expect(
			db
				.prepare(
					"SELECT event_type, message FROM workspace_events WHERE workspace_id = ?",
				)
				.get(result.workspace.id),
		).toEqual({
			event_type: "workspace.requested",
			message: "workspace request accepted",
		});
	});

	it("returns the original workspace for an idempotent replay", () => {
		const db = database();
		const first = createWorkspace(db, input("request-a"));
		const second = createWorkspace(db, input("request-a"));

		expect(first.kind).toBe("created");
		expect(second.kind).toBe("existing");
		expect(listWorkspaces(db)).toHaveLength(1);
	});

	it("rejects an idempotency key used with a different request", () => {
		const db = database();

		createWorkspace(db, input("request-a"));
		const result = createWorkspace(db, {
			...input("request-a"),
			ref: "release",
		});

		expect(result).toEqual({ kind: "idempotency_conflict" });
	});

	it("records a queued destroy operation without infrastructure work", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}

		const result = requestWorkspaceOperation(
			db,
			created.workspace.id,
			"destroy",
		);

		expect(result).toMatchObject({
			kind: "created",
			operation: { kind: "destroy", status: "queued" },
			workspace: {
				desiredState: "destroyed",
				status: "destroying",
			},
		});
	});

	it("leases an operation once and completes it", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}

		const now = new Date("2026-01-01T00:00:00Z");
		const claimed = claimWorkspaceOperation(db, "provision", now);

		expect(claimed).toMatchObject({
			kind: "claimed",
			operation: {
				attemptCount: 1,
				kind: "provision",
				status: "running",
			},
		});
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}

		expect(claimWorkspaceOperation(db, "provision", now)).toEqual({
			kind: "empty",
		});
		completeWorkspaceOperation(db, claimed.lease);
		expect(claimWorkspaceOperation(db, "provision", now)).toEqual({
			kind: "empty",
		});
	});

	it("persists the VMID and clone UPID before continuing provision work", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		const claimed = claimWorkspaceOperation(db, "provision");
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}

		expect(prepareWorkspaceProvision(db, claimed.lease, "nas", 109)).toEqual({
			kind: "prepared",
		});
		expect(
			recordWorkspaceTask(db, claimed.lease, {
				expiresAt: "2026-01-01T00:15:00.000Z",
				kind: "provision",
				step: "clone task accepted",
				upid: "UPID:nas:00000001",
			}),
		).toEqual({ kind: "prepared" });
		expect(
			db
				.prepare(
					`SELECT node, vmid, current_task_upid, current_task_expires_at, current_step
					 FROM workspaces WHERE id = ?`,
				)
				.get(created.workspace.id),
		).toEqual({
			current_step: "clone task accepted",
			current_task_expires_at: "2026-01-01T00:15:00.000Z",
			current_task_upid: "UPID:nas:00000001",
			node: "nas",
			vmid: 109,
		});
	});

	it("does not offer a destroy operation to the provision executor", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		const claimed = claimWorkspaceOperation(db, "provision");
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}
		completeWorkspaceOperation(db, claimed.lease);

		expect(
			requestWorkspaceOperation(db, created.workspace.id, "destroy").kind,
		).toBe("created");
		expect(claimWorkspaceOperation(db, "provision")).toEqual({ kind: "empty" });
		expect(claimWorkspaceOperation(db, "destroy")).toMatchObject({
			kind: "claimed",
			operation: { kind: "destroy" },
		});
	});
});

describe("releaseWorkspaceOperation", () => {
	it("withholds a released operation until its next run time", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		const now = new Date("2026-01-01T00:00:00Z");
		const claimed = claimWorkspaceOperation(db, "provision", now);
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}

		releaseWorkspaceOperation(db, claimed.lease, 5_000, now);

		expect(
			claimWorkspaceOperation(
				db,
				"provision",
				new Date("2026-01-01T00:00:04Z"),
			),
		).toEqual({ kind: "empty" });
		expect(
			claimWorkspaceOperation(
				db,
				"provision",
				new Date("2026-01-01T00:00:06Z"),
			),
		).toMatchObject({ kind: "claimed", operation: { attemptCount: 2 } });
	});
});

describe("operation leases", () => {
	it("refuses writes from a worker whose lease was taken over", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}

		const first = claimWorkspaceOperation(
			db,
			"provision",
			new Date("2026-01-01T00:00:00Z"),
		);
		if (first.kind !== "claimed") {
			throw new Error("expected first claim");
		}

		// The first worker is still running; its lease simply expired. A second worker picks the
		// operation up, and from here only that second worker may write.
		const second = claimWorkspaceOperation(
			db,
			"provision",
			new Date("2026-01-01T00:05:00Z"),
		);
		if (second.kind !== "claimed") {
			throw new Error("expected takeover claim");
		}
		expect(second.lease.id).toBe(first.lease.id);
		expect(second.lease.token).not.toBe(first.lease.token);

		for (const write of [
			() => prepareWorkspaceProvision(db, first.lease, "nas", 109),
			() => confirmWorkspaceClone(db, first.lease),
			() => failWorkspaceProvision(db, first.lease, "code", "message"),
			() => releaseWorkspaceCandidateVMID(db, first.lease, "reason"),
		]) {
			expect(write()).toEqual({ kind: "stale_operation" });
		}

		expect(prepareWorkspaceProvision(db, second.lease, "nas", 109)).toEqual({
			kind: "prepared",
		});
	});

	it("stops a superseded worker from releasing or completing the operation", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		const first = claimWorkspaceOperation(
			db,
			"provision",
			new Date("2026-01-01T00:00:00Z"),
		);
		const second = claimWorkspaceOperation(
			db,
			"provision",
			new Date("2026-01-01T00:05:00Z"),
		);
		if (first.kind !== "claimed" || second.kind !== "claimed") {
			throw new Error("expected both claims");
		}

		// The stale worker must not be able to hand the operation back or close it out from under
		// the worker that now holds it.
		releaseWorkspaceOperation(db, first.lease, 0);
		completeWorkspaceOperation(db, first.lease);

		expect(
			db
				.prepare("SELECT status FROM workspace_operations WHERE id = ?")
				.get(second.lease.id),
		).toEqual({ status: "running" });
	});
});

describe("destroy mutators", () => {
	it("marks the workspace destroyed and completes the operation", () => {
		const db = database();
		const { workspaceID, lease } = destroying(db);

		expect(
			completeWorkspaceDestroy(db, lease, "container was already absent"),
		).toEqual({ kind: "prepared" });
		expect(
			db
				.prepare(
					"SELECT status, desired_state, current_step FROM workspaces WHERE id = ?",
				)
				.get(workspaceID),
		).toEqual({
			current_step: "destroyed",
			desired_state: "destroyed",
			status: "destroyed",
		});
		expect(
			db
				.prepare("SELECT status FROM workspace_operations WHERE id = ?")
				.get(lease.id),
		).toEqual({ status: "completed" });
	});

	it("halts without leaving the workspace in a state that lies about intent", () => {
		const db = database();
		const { workspaceID, lease } = destroying(db);

		expect(
			haltWorkspaceDestroy(
				db,
				lease,
				"destroy_ownership_mismatch",
				"container 109 does not carry this workspace's ownership marker",
			),
		).toEqual({ kind: "prepared" });
		expect(
			db
				.prepare(
					"SELECT status, desired_state, error_code, error_retryable FROM workspaces WHERE id = ?",
				)
				.get(workspaceID),
		).toEqual({
			desired_state: "destroyed",
			error_code: "destroy_ownership_mismatch",
			error_retryable: 0,
			status: "destroying",
		});
		expect(claimWorkspaceOperation(db, "destroy")).toEqual({ kind: "empty" });
	});

	it("rejects destroy writes from a worker that lost its lease", () => {
		const db = database();
		const { lease } = destroying(db);
		completeWorkspaceOperation(db, lease);

		for (const write of [
			() => completeWorkspaceDestroy(db, lease, "message"),
			() => haltWorkspaceDestroy(db, lease, "code", "message"),
			() => advanceWorkspaceDestroy(db, lease, "step"),
		]) {
			expect(write()).toEqual({ kind: "stale_operation" });
		}
	});

	it("refuses to mutate a destroy operation through the provision guard", () => {
		const db = database();
		const { lease } = destroying(db);

		expect(confirmWorkspaceClone(db, lease)).toEqual({
			kind: "stale_operation",
		});
		expect(failWorkspaceProvision(db, lease, "code", "message")).toEqual({
			kind: "stale_operation",
		});
	});
});

describe("failWorkspaceProvision", () => {
	it("records the failure reason and closes the operation", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		const claimed = claimWorkspaceOperation(db, "provision");
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}

		expect(
			failWorkspaceProvision(
				db,
				claimed.lease,
				"clone_task_failed",
				"proxmox task exited with storage error",
			),
		).toEqual({ kind: "prepared" });
		expect(
			db
				.prepare(
					"SELECT status, error_code, error_message, error_retryable FROM workspaces WHERE id = ?",
				)
				.get(created.workspace.id),
		).toEqual({
			error_code: "clone_task_failed",
			error_message: "proxmox task exited with storage error",
			error_retryable: 1,
			status: "failed",
		});
		expect(claimWorkspaceOperation(db, "provision")).toEqual({ kind: "empty" });
	});

	it("rejects a write from a worker whose lease was already taken over", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		const claimed = claimWorkspaceOperation(db, "provision");
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}
		completeWorkspaceOperation(db, claimed.lease);

		for (const write of [
			() => failWorkspaceProvision(db, claimed.lease, "code", "message"),
			() => confirmWorkspaceClone(db, claimed.lease),
			() => releaseWorkspaceCandidateVMID(db, claimed.lease, "reason"),
			() =>
				recordWorkspaceTask(db, claimed.lease, {
					expiresAt: "later",
					kind: "provision",
					step: "clone task accepted",
					upid: "UPID:nas:1",
				}),
		]) {
			expect(write()).toEqual({ kind: "stale_operation" });
		}
	});
});

describe("openDatabase", () => {
	it("records schema migrations once", () => {
		const db = database();

		expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([
			{ version: 1 },
			{ version: 2 },
			{ version: 3 },
			{ version: 4 },
			{ version: 5 },
		]);
	});
});

// destroying leaves one workspace with a claimed destroy operation.
function destroying(db: ReturnType<typeof openDatabase>) {
	const created = createWorkspace(db, input("request-a"));
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}
	if (
		requestWorkspaceOperation(db, created.workspace.id, "destroy").kind !==
		"created"
	) {
		throw new Error("expected destroy request");
	}

	const claimed = claimWorkspaceOperation(db, "destroy");
	if (claimed.kind !== "claimed") {
		throw new Error("expected destroy claim");
	}

	return {
		lease: claimed.lease,
		workspaceID: created.workspace.id,
	};
}

function database() {
	const db = openDatabase(":memory:");

	databases.push(db);

	return db;
}

function input(idempotencyKey: string) {
	return {
		herdrSession: "agents",
		idempotencyKey,
		purpose: "Investigate round-robin race condition",
		repository: "https://github.com/plainhq/plain.git",
		ref: "main",
	};
}
