import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database";
import { createWorkspace, listWorkspaces } from "./workspace-repository";

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
});

describe("openDatabase", () => {
	it("records schema migrations once", () => {
		const db = database();

		expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([
			{ version: 1 },
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
