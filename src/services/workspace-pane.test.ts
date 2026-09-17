import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/database";
import { createWorkspace, workspaceDetail } from "../db/workspace-repository";

const databases: Database.Database[] = [];

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("workspaceDetail", () => {
	it("omits placement a workspace has not reached yet", () => {
		// The detail page asks whether a field is present. Carrying nulls through would make every
		// caller check twice for the same thing.
		const db = database();
		const id = workspace(db);

		const detail = workspaceDetail(db, id);

		expect(detail?.vmid).toBe(undefined);
		expect(detail?.ip).toBe(undefined);
		expect(detail?.herdrPaneId).toBe(undefined);
		expect(detail?.status).toBe("requested");
	});

	it("reports placement and failure detail once they exist", () => {
		const db = database();
		const id = workspace(db);

		db.prepare(
			`UPDATE workspaces
			 SET status = 'ready', node = 'nas', vmid = 109, ip = '10.0.3.105',
				herdr_workspace_id = 'w1', herdr_pane_id = 'w1:p1',
				provision_phase = 'agent-started', error_code = 'agent_awaiting_input',
				error_message = 'claude is waiting for input'
			 WHERE id = ?`,
		).run(id);

		expect(workspaceDetail(db, id)).toMatchObject({
			errorCode: "agent_awaiting_input",
			errorMessage: "claude is waiting for input",
			herdrPaneId: "w1:p1",
			herdrWorkspaceId: "w1",
			ip: "10.0.3.105",
			node: "nas",
			provisionPhase: "agent-started",
			status: "ready",
			vmid: 109,
		});
	});

	it("returns nothing for a workspace that does not exist", () => {
		expect(workspaceDetail(database(), "missing")).toBe(undefined);
	});
});

function workspace(db: Database.Database): string {
	const created = createWorkspace(db, {
		herdrSession: "agents",
		idempotencyKey: "detail",
		repository: "github.com/ndom91/sveltekasten",
		ref: "main",
	});
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}

	return created.workspace.id;
}

function database(): Database.Database {
	const db = openDatabase(":memory:");
	databases.push(db);

	return db;
}
