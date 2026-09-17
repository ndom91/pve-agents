import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/database";
import { updateControllerSettings } from "../db/settings-repository";
import { createWorkspace } from "../db/workspace-repository";
import { reapWorkspaces } from "./workspace-reaper";

const NOW = new Date("2026-01-01T12:00:00Z");

const databases: Database.Database[] = [];

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("reapWorkspaces", () => {
	it("destroys nothing at all while disabled", async () => {
		// It removes real containers without being asked, so it has to be switched on deliberately.
		const db = database();
		ready(db, { activity: "idle", createdAt: "2026-01-01T00:00:00Z" });

		expect(reapWorkspaces(db, NOW)).toEqual({ reaped: 0 });
		expect(queuedDestroys(db)).toBe(0);
	});

	it("reaps a workspace that has never done any work at all", async () => {
		// The exact case this was built for: last_activity_at only moves while an agent works, so
		// a workspace that was never told anything has none. Without falling back to creation, the
		// workspaces most worth reaping would be the only ones that could never be reaped.
		const db = database();
		const id = ready(db, {
			activity: "idle",
			createdAt: "2026-01-01T10:00:00Z",
			lastActivityAt: null,
		});
		enable(db, { reapIdleMinutes: 60 });

		expect(reapWorkspaces(db, NOW)).toEqual({ reaped: 1 });
		expect(lastNote(db, id)).toContain("without ever doing any work");
		expect(queuedDestroys(db)).toBe(1);
	});

	it("measures idleness from the last time the agent worked", async () => {
		const db = database();
		ready(db, {
			activity: "idle",
			createdAt: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T11:50:00Z",
		});
		enable(db, { reapIdleMinutes: 60 });

		// Twelve hours old but working ten minutes ago, so not idle.
		expect(reapWorkspaces(db, NOW)).toEqual({ reaped: 0 });
	});

	it("never idle-reaps an agent that is working", async () => {
		const db = database();
		ready(db, {
			activity: "active",
			createdAt: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T00:05:00Z",
		});
		enable(db, { reapIdleMinutes: 60, reapMaxAgeHours: 720 });

		expect(reapWorkspaces(db, NOW)).toEqual({ reaped: 0 });
	});

	it("exempts a blocked agent from both rules", async () => {
		// An agent at a dialog is waiting for a person, and destroying it throws away real work.
		// The cost is that an unanswered question keeps its container alive indefinitely.
		const db = database();
		ready(db, {
			activity: "blocked",
			createdAt: "2025-01-01T00:00:00Z",
			lastActivityAt: "2025-01-01T00:00:00Z",
		});
		enable(db, { reapIdleMinutes: 5, reapMaxAgeHours: 1 });

		expect(reapWorkspaces(db, NOW)).toEqual({ reaped: 0 });
	});

	it("reaps an old workspace even when it is not idle", async () => {
		const db = database();
		const id = ready(db, {
			activity: "active",
			createdAt: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T11:59:00Z",
		});
		enable(db, { reapIdleMinutes: 60, reapMaxAgeHours: 6 });

		expect(reapWorkspaces(db, NOW)).toEqual({ reaped: 1 });
		expect(lastNote(db, id)).toContain("maximum age");
	});

	it("ignores a workspace that is not ready", async () => {
		// One mid-provision is not idle, it is busy being built.
		const db = database();
		const id = ready(db, {
			activity: "idle",
			createdAt: "2025-01-01T00:00:00Z",
		});
		db.prepare("UPDATE workspaces SET status = 'booting' WHERE id = ?").run(id);
		enable(db, { reapIdleMinutes: 5 });

		expect(reapWorkspaces(db, NOW)).toEqual({ reaped: 0 });
	});

	it("does not queue a second destroy for one already being torn down", async () => {
		const db = database();
		ready(db, { activity: "idle", createdAt: "2025-01-01T00:00:00Z" });
		enable(db, { reapIdleMinutes: 5 });

		expect(reapWorkspaces(db, NOW)).toEqual({ reaped: 1 });
		expect(reapWorkspaces(db, NOW)).toEqual({ reaped: 0 });
		expect(queuedDestroys(db)).toBe(1);
	});
});

function enable(
	db: Database.Database,
	patch: { reapIdleMinutes?: number; reapMaxAgeHours?: number },
): void {
	updateControllerSettings(db, { reapingEnabled: true, ...patch });
}

function ready(
	db: Database.Database,
	input: {
		activity: string;
		createdAt: string;
		lastActivityAt?: string | null;
	},
): string {
	const created = createWorkspace(db, {
		herdrSession: "agents",
		idempotencyKey: `ready-${Math.random()}`,
		repository: "github.com/ndom91/open-plan-annotator",
		ref: "main",
	});
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}

	// createWorkspace queues a provision, which would otherwise make every workspace look busy.
	db.prepare("UPDATE workspace_operations SET status = 'completed'").run();
	db.prepare(
		`UPDATE workspaces
		 SET status = 'ready', activity = ?, created_at = ?, last_activity_at = ?
		 WHERE id = ?`,
	).run(
		input.activity,
		input.createdAt,
		input.lastActivityAt ?? null,
		created.workspace.id,
	);

	return created.workspace.id;
}

function queuedDestroys(db: Database.Database): number {
	return (
		db
			.prepare(
				"SELECT count(*) c FROM workspace_operations WHERE kind = 'destroy'",
			)
			.get() as { c: number }
	).c;
}

function lastNote(db: Database.Database, id: string): string {
	return (
		db
			.prepare(
				`SELECT message FROM workspace_events
				 WHERE workspace_id = ? AND event_type = 'workspace.reaped'
				 ORDER BY id DESC LIMIT 1`,
			)
			.get(id) as { message: string }
	).message;
}

function database(): Database.Database {
	const db = openDatabase(":memory:");
	databases.push(db);

	return db;
}
