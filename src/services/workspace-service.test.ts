import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/database";
import { createWorkspace } from "../db/workspace-repository";
import {
	listRequestedWorkspaces,
	workspaceRequestSchema,
} from "./workspace-service";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("listRequestedWorkspaces", () => {
	it("carries a timeline only for a workspace that can still change", () => {
		// Where the fleet payload's weight was: fifty events each for every container ever
		// destroyed, re-fetched on every poll, to render a list that reads none of them. A
		// destroyed workspace's timeline cannot change, and the page about one workspace fetches
		// its own.
		const db = openDatabase(":memory:");
		databases.push(db);

		const live = create(db, "live");
		const gone = create(db, "gone");
		db.prepare("UPDATE workspaces SET status = 'destroyed' WHERE id = ?").run(
			gone,
		);

		const listed = listRequestedWorkspaces(db);

		// Both rows are still there -- the count the sidebar prints depends on it.
		expect(listed).toHaveLength(2);
		expect(
			listed.find((entry) => entry.id === live)?.events.length,
		).toBeGreaterThan(0);
		expect(listed.find((entry) => entry.id === gone)?.events).toEqual([]);
	});
});

function create(db: ReturnType<typeof openDatabase>, key: string): string {
	const created = createWorkspace(db, {
		idempotencyKey: key,
		ref: "main",
		repository: "https://github.com/plainhq/plain.git",
	});
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}

	return created.workspace.id;
}

describe("workspaceRequestSchema", () => {
	it("accepts a request without purpose", () => {
		const result = workspaceRequestSchema.parse({
			repository: "git@github.com:plainhq/plain.git",
			ref: "main",
		});

		expect(result).toEqual({
			repository: "git@github.com:plainhq/plain.git",
			ref: "main",
		});
	});
});
