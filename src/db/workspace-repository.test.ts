import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database";
import {
	claimWorkspaceOperation,
	completeWorkspaceOperation,
	createWorkspace,
	listWorkspaces,
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
		const claimed = claimWorkspaceOperation(db, now);

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

		expect(claimWorkspaceOperation(db, now)).toEqual({ kind: "empty" });
		completeWorkspaceOperation(db, claimed.operation.id);
		expect(claimWorkspaceOperation(db, now)).toEqual({ kind: "empty" });
	});
});

describe("openDatabase", () => {
	it("records schema migrations once", () => {
		const db = database();

		expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([
			{ version: 1 },
			{ version: 2 },
			{ version: 3 },
		]);
	});
});

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
