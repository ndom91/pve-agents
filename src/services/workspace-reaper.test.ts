import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";
import { updateControllerSettings } from "../db/settings-repository";
import {
	createWorkspace,
	recordWorkspaceInteraction,
} from "../db/workspace-repository";
import type { SshResult, SshRunner } from "./ssh";
import { reapWorkspaces } from "./workspace-reaper";

// config gives the reaper somewhere to connect from. Without a key path it cannot check a tree at
// all, which is a different code path from checking and finding nothing.
function config() {
	return controllerConfig({
		WORKSPACE_SSH_KEY_PATH: "/tmp/test-controller-key",
	});
}

// Exit 0 from the check script: nothing uncommitted, nothing unpushed.
const clean: SshRunner = async (): Promise<SshResult> => ({
	code: 0,
	kind: "ran",
	stderr: "",
	stdout: "",
});

// Exit 10: the tree holds work that would die with the container.
const unsaved: SshRunner = async (): Promise<SshResult> => ({
	code: 10,
	kind: "ran",
	stderr: "",
	stdout: "",
});

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

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 0,
		});
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

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 1,
		});
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
		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 0,
		});
	});

	it("does not reap a workspace that was prompted recently", async () => {
		// The failure this was written for. An agent answering a short prompt finishes inside the
		// thirty-second observation interval, so it can be prompted repeatedly and never once be
		// *seen* working. A workspace prompted fourteen minutes earlier was destroyed as one that
		// had "never done any work", because sampled activity was the only evidence being kept.
		const db = database();
		const id = ready(db, {
			activity: "idle",
			createdAt: "2026-01-01T10:00:00Z",
			lastActivityAt: null,
		});
		enable(db, { reapIdleMinutes: 60 });

		// An operator prompts it. Nothing observes the agent working, because the turn is short.
		recordWorkspaceInteraction(db, id, new Date("2026-01-01T11:46:00Z"));

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 0,
		});
	});

	it("never idle-reaps an agent that is working", async () => {
		const db = database();
		ready(db, {
			activity: "active",
			createdAt: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T00:05:00Z",
		});
		enable(db, { reapIdleMinutes: 60, reapMaxAgeHours: 720 });

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 0,
		});
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

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 0,
		});
	});

	it("reaps an old workspace even when it is not idle", async () => {
		const db = database();
		const id = ready(db, {
			activity: "active",
			createdAt: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T11:59:00Z",
		});
		enable(db, { reapIdleMinutes: 60, reapMaxAgeHours: 6 });

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 1,
		});
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

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 0,
		});
	});

	it("keeps a workspace holding work nobody saved", async () => {
		// The only path in the system that loses something irreversibly. A container can be
		// rebuilt and a clone re-cloned; a diff that existed only on that disk cannot. An agent
		// briefed to write a file and not to push produces exactly this.
		const db = database();
		const id = ready(db, {
			activity: "idle",
			createdAt: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T00:00:00Z",
		});
		enable(db, { reapIdleMinutes: 60 });

		expect(await reapWorkspaces(db, config(), NOW, unsaved)).toEqual({
			reaped: 0,
		});
		expect(keptNote(db, id)).toContain("uncommitted or unpushed");
	});

	it("keeps it past the maximum age too, not only the idle limit", async () => {
		// Exempting from idle alone would just postpone the loss to the hard cap, which is worse
		// than not protecting it: it looks like protection and still destroys the work, later and
		// with less chance of anyone being around.
		const db = database();
		ready(db, {
			activity: "idle",
			createdAt: "2025-01-01T00:00:00Z",
			lastActivityAt: "2025-01-01T00:00:00Z",
		});
		enable(db, { reapIdleMinutes: 5, reapMaxAgeHours: 1 });

		expect(await reapWorkspaces(db, config(), NOW, unsaved)).toEqual({
			reaped: 0,
		});
	});

	it("still reaps a workspace with nothing left on it", async () => {
		// Otherwise the protection would quietly disable reaping altogether.
		const db = database();
		ready(db, {
			activity: "idle",
			createdAt: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T00:00:00Z",
		});
		enable(db, { reapIdleMinutes: 60 });

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 1,
		});
	});

	it("does not destroy a workspace it could not inspect", async () => {
		// Refusing to act on missing evidence, the same instinct as the orphan scan reporting a
		// container it could not read rather than assuming it was unowned.
		const db = database();
		const id = ready(db, {
			activity: "idle",
			createdAt: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T00:00:00Z",
		});
		enable(db, { reapIdleMinutes: 60 });

		expect(
			await reapWorkspaces(db, config(), NOW, async () => ({
				kind: "refused",
			})),
		).toEqual({ reaped: 0 });
		expect(keptNote(db, id)).toContain("could not check");
	});

	it("explains itself once, not on every pass", async () => {
		// A held workspace is reconsidered every few seconds, and a repeated reason would bury the
		// history it exists to explain.
		const db = database();
		const id = ready(db, {
			activity: "idle",
			createdAt: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T00:00:00Z",
		});
		enable(db, { reapIdleMinutes: 60 });

		await reapWorkspaces(db, config(), NOW, unsaved);
		await reapWorkspaces(db, config(), NOW, unsaved);
		await reapWorkspaces(db, config(), NOW, unsaved);

		expect(
			(
				db
					.prepare(
						"SELECT count(*) c FROM workspace_events WHERE workspace_id = ? AND event_type = 'workspace.kept'",
					)
					.get(id) as { c: number }
			).c,
		).toBe(1);
	});

	it("marks the workspace so the exemption is visible", async () => {
		// A workspace kept forever by a stray file is only an acceptable trade if someone can see
		// that it is being kept.
		const db = database();
		const id = ready(db, {
			activity: "idle",
			createdAt: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T00:00:00Z",
		});
		enable(db, { reapIdleMinutes: 60 });

		await reapWorkspaces(db, config(), NOW, unsaved);

		expect(
			(
				db
					.prepare("SELECT unsaved_work FROM workspaces WHERE id = ?")
					.get(id) as { unsaved_work: number | null }
			).unsaved_work,
		).toBe(1);
	});

	it("holds a failed workspace through its grace period", async () => {
		// That container is the only copy of whatever went wrong, so there has to be time to look
		// at it before it is purged.
		const db = database();
		failed(db, { errorAt: "2026-01-01T09:00:00Z", vmid: 400 });
		enable(db, {});

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 0,
		});
	});

	it("reaps a failed workspace once the grace period is past", async () => {
		const db = database();
		const id = failed(db, { errorAt: "2026-01-01T02:00:00Z", vmid: 400 });
		enable(db, {});

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 1,
		});
		expect(lastNote(db, id)).toContain("grace period");
	});

	it("leaves a failed workspace that never got a container", async () => {
		// Nothing to clean up, and queueing a destroy would be teardown of something that never
		// existed.
		const db = database();
		failed(db, { errorAt: "2025-01-01T00:00:00Z", vmid: null });
		enable(db, {});

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 0,
		});
	});

	it("does not queue a second destroy for one already being torn down", async () => {
		const db = database();
		ready(db, { activity: "idle", createdAt: "2025-01-01T00:00:00Z" });
		enable(db, { reapIdleMinutes: 5 });

		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 1,
		});
		expect(await reapWorkspaces(db, config(), NOW, clean)).toEqual({
			reaped: 0,
		});
		expect(queuedDestroys(db)).toBe(1);
	});
});

function enable(
	db: Database.Database,
	patch: {
		reapFailedAfterHours?: number;
		reapIdleMinutes?: number;
		reapMaxAgeHours?: number;
	},
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
		idempotencyKey: `ready-${Math.random()}`,
		repository: "github.com/ndom91/open-plan-annotator",
		ref: "main",
	});
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}

	// createWorkspace queues a provision, which would otherwise make every workspace look busy.
	db.prepare("UPDATE workspace_operations SET status = 'completed'").run();
	// An address, because the reaper connects to a workspace before destroying it. Without one it
	// takes the "nothing to look at" path and the check never runs.
	db.prepare(
		`UPDATE workspaces
		 SET status = 'ready', ip = '10.0.3.100', activity = ?, created_at = ?,
			last_activity_at = ?
		 WHERE id = ?`,
	).run(
		input.activity,
		input.createdAt,
		input.lastActivityAt ?? null,
		created.workspace.id,
	);

	return created.workspace.id;
}

function failed(
	db: Database.Database,
	input: { errorAt: string; vmid: number | null },
): string {
	const created = createWorkspace(db, {
		idempotencyKey: `failed-${Math.random()}`,
		repository: "github.com/ndom91/open-plan-annotator",
		ref: "main",
	});
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}

	db.prepare("UPDATE workspace_operations SET status = 'completed'").run();
	db.prepare(
		`UPDATE workspaces
		 SET status = 'failed', vmid = ?, ip = '10.0.3.100', error_occurred_at = ?,
			error_code = 'clone_task_failed'
		 WHERE id = ?`,
	).run(input.vmid, input.errorAt, created.workspace.id);

	return created.workspace.id;
}

function keptNote(db: Database.Database, id: string): string {
	return (
		db
			.prepare(
				`SELECT message FROM workspace_events
				 WHERE workspace_id = ? AND event_type = 'workspace.kept'
				 ORDER BY id DESC LIMIT 1`,
			)
			.get(id) as { message: string }
	).message;
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
