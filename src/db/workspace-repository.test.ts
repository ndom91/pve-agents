import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database";
import {
	advanceWorkspaceDestroy,
	claimWorkspaceOperation,
	completeWorkspaceDestroy,
	completeWorkspaceOperation,
	confirmWorkspaceClone,
	countActiveOperations,
	createWorkspace,
	failWorkspaceProvision,
	haltWorkspaceDestroy,
	listWorkspaces,
	noteWorkspaceIssue,
	prepareWorkspaceProvision,
	recordWorkspaceTask,
	releaseWorkspaceCandidateVMID,
	releaseWorkspaceOperation,
	requestWorkspaceOperation,
	workspaceEventTimelines,
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

describe("requestWorkspaceOperation", () => {
	it("refuses a second live operation of the same kind", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}

		// createWorkspace already queued a provision. A retry while that one is live would
		// otherwise race it: one persists a VMID and clones, the other reconciles and nulls it.
		expect(
			requestWorkspaceOperation(db, created.workspace.id, "provision"),
		).toEqual({
			kind: "already_queued",
			message: "provision is already queued for this workspace",
		});
		expect(
			db
				.prepare(
					"SELECT count(*) c FROM workspace_operations WHERE kind = 'provision'",
				)
				.get(),
		).toEqual({ c: 1 });
	});

	it("allows a retry once the previous operation has finished", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		const claimed = claimWorkspaceOperation(db, "provision");
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}
		failWorkspaceProvision(db, claimed.lease, "clone_task_failed", "boom");

		expect(
			requestWorkspaceOperation(db, created.workspace.id, "provision").kind,
		).toBe("created");
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
			() => advanceWorkspaceDestroy(db, lease, "shutdown-tried", "step"),
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
			{ version: 6 },
			{ version: 7 },
			{ version: 8 },
			{ version: 9 },
			{ version: 10 },
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

// timeline reads one workspace's events out of the grouped query the fleet view uses.
function timeline(db: ReturnType<typeof openDatabase>, workspaceId: string) {
	return workspaceEventTimelines(db, 50).get(workspaceId) ?? [];
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

describe("workspace timeline", () => {
	it("records a transient failure once, however often it retries", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		const claimed = claimWorkspaceOperation(db, "provision");
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}

		// A failing Proxmox call retries every few seconds. One line per attempt would bury the
		// timeline in identical rows and hide everything that came before.
		for (let attempt = 0; attempt < 50; attempt += 1) {
			noteWorkspaceIssue(db, claimed.lease, "proxmox clone request failed");
		}

		const retrying = timeline(db, created.workspace.id).filter(
			(event) => event.eventType === "workspace.retrying",
		);
		expect(retrying).toHaveLength(1);
		expect(retrying[0]?.message).toBe("proxmox clone request failed");
	});

	it("records a different failure as its own entry", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		const claimed = claimWorkspaceOperation(db, "provision");
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}

		noteWorkspaceIssue(db, claimed.lease, "proxmox clone request failed");
		noteWorkspaceIssue(db, claimed.lease, "proxmox clone request failed");
		noteWorkspaceIssue(db, claimed.lease, "proxmox config request failed");

		expect(
			timeline(db, created.workspace.id)
				.filter((event) => event.eventType === "workspace.retrying")
				.map((event) => event.message),
		).toEqual([
			"proxmox clone request failed",
			"proxmox config request failed",
		]);
	});

	it("returns the timeline oldest first", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		requestWorkspaceOperation(db, created.workspace.id, "destroy");

		expect(timeline(db, created.workspace.id).map((e) => e.eventType)).toEqual([
			"workspace.requested",
			"workspace.provision_cancelled",
			"workspace.destroy_queued",
		]);
	});
});

describe("countActiveOperations", () => {
	it("counts only work the worker still has to act on", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}

		// The fleet view stops refreshing when this reaches zero, so a terminal operation must not
		// keep it polling forever.
		expect(countActiveOperations(db)).toBe(1);

		const claimed = claimWorkspaceOperation(db, "provision");
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}
		expect(countActiveOperations(db)).toBe(1);

		completeWorkspaceOperation(db, claimed.lease);
		expect(countActiveOperations(db)).toBe(0);
	});

	it("ignores cancelled and failed operations", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		const claimed = claimWorkspaceOperation(db, "provision");
		if (claimed.kind !== "claimed") {
			throw new Error("expected operation claim");
		}
		failWorkspaceProvision(db, claimed.lease, "code", "message");

		expect(countActiveOperations(db)).toBe(0);
	});
});

describe("noteWorkspaceIssue", () => {
	it("refuses an issue from a worker whose lease was taken over", () => {
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

		noteWorkspaceIssue(db, first.lease, "stale worker complaining");
		noteWorkspaceIssue(db, second.lease, "current worker complaining");

		expect(
			timeline(db, created.workspace.id)
				.filter((event) => event.eventType === "workspace.retrying")
				.map((event) => event.message),
		).toEqual(["current worker complaining"]);
	});
});

describe("workspaceEventTimelines", () => {
	it("limits per workspace, not across the fleet", () => {
		const db = database();
		const ids: string[] = [];
		for (const key of ["a", "b", "c"]) {
			const created = createWorkspace(db, input(key));
			if (created.kind !== "created") {
				throw new Error("expected workspace creation");
			}
			ids.push(created.workspace.id);
			requestWorkspaceOperation(db, created.workspace.id, "destroy");
		}

		// Each workspace has three events. A limit applied across the whole result would starve
		// the later workspaces of theirs.
		const timelines = workspaceEventTimelines(db, 2);
		for (const id of ids) {
			expect(timelines.get(id)).toHaveLength(2);
		}
	});

	it("keeps the newest entries, ordered oldest first", () => {
		const db = database();
		const created = createWorkspace(db, input("request-a"));
		if (created.kind !== "created") {
			throw new Error("expected workspace creation");
		}
		requestWorkspaceOperation(db, created.workspace.id, "destroy");

		// Three events exist: requested, provision_cancelled, destroy_queued.
		expect(
			workspaceEventTimelines(db, 2)
				.get(created.workspace.id)
				?.map((event) => event.eventType),
		).toEqual(["workspace.provision_cancelled", "workspace.destroy_queued"]);
	});

	it("omits a workspace with no events rather than returning undefined rows", () => {
		const db = database();

		expect(workspaceEventTimelines(db, 50).size).toBe(0);
	});
});
