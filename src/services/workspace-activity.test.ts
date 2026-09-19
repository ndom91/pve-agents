import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";
import { createWorkspace } from "../db/workspace-repository";
import type { SshResult, SshRunner } from "./ssh";
import { mapActivity, observeWorkspaceActivity } from "./workspace-activity";

const OBSERVED_AT = new Date("2026-01-01T00:00:00Z");

const databases: Database.Database[] = [];

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("mapActivity", () => {
	// Exported and tested directly because the stream uses it too, several times more often than
	// the observation pass does. A second copy of this mapping would be a way for the two to
	// disagree about what "done" means.
	it("maps every status a runner reports", () => {
		expect(mapActivity("working")).toBe("active");
		expect(mapActivity("blocked")).toBe("blocked");
		expect(mapActivity("idle")).toBe("idle");
		expect(mapActivity("done")).toBe("idle");
		expect(mapActivity("unknown")).toBe("unknown");
		expect(mapActivity("something-new")).toBe("unknown");
	});

	it("keeps blocked distinct from everything else", () => {
		// The controls for answering a dialog are gated on this value. Folding blocked into idle
		// would leave an agent waiting with no way to answer it.
		expect(mapActivity("blocked")).not.toBe(mapActivity("idle"));
		expect(mapActivity("blocked")).not.toBe(mapActivity("working"));
	});
});

describe("observeWorkspaceActivity", () => {
	it("maps every runner status to the activity the fleet reports", async () => {
		for (const [status, activity] of [
			["working", "active"],
			["blocked", "blocked"],
			["idle", "idle"],
		] as const) {
			const db = database();
			const id = ready(db);

			await observeWorkspaceActivity(db, config(), OBSERVED_AT, agent(status));

			expect(activityOf(db, id)).toBe(activity);
		}
	});

	it("does not flatten an unclassified agent into idle", async () => {
		// A status nobody could read is not evidence that anything finished. Reporting it as idle
		// would invent a fact, and the reaper acts on idle.
		const db = database();
		const id = ready(db);

		await observeWorkspaceActivity(db, config(), OBSERVED_AT, agent("unknown"));

		expect(activityOf(db, id)).toBe("unknown");
	});

	it("records a workspace it cannot reach as unknown rather than throwing", async () => {
		const db = database();
		const id = ready(db);

		const pass = await observeWorkspaceActivity(
			db,
			config(),
			OBSERVED_AT,
			async () => ({ kind: "refused" }),
		);

		expect(pass).toEqual({ observed: 1 });
		expect(activityOf(db, id)).toBe("unknown");
	});

	it("leaves a workspace alone until its reading goes stale", async () => {
		const db = database();
		ready(db);

		await observeWorkspaceActivity(db, config(), OBSERVED_AT, agent("idle"));

		// Well inside the 30s interval, so contacting the workspace again would be waste.
		const soon = await observeWorkspaceActivity(
			db,
			config(),
			new Date(OBSERVED_AT.getTime() + 10_000),
			async () => {
				throw new Error("workspace must not be contacted again this soon");
			},
		);
		expect(soon).toEqual({ observed: 0 });

		const later = await observeWorkspaceActivity(
			db,
			config(),
			new Date(OBSERVED_AT.getTime() + 31_000),
			agent("idle"),
		);
		expect(later).toEqual({ observed: 1 });
	});

	it("moves last_activity_at only while the agent is working", async () => {
		// Its job is to answer "how long has this done nothing", which a reading taken every
		// thirty seconds would otherwise reset forever.
		const db = database();
		const id = ready(db);

		await observeWorkspaceActivity(db, config(), OBSERVED_AT, agent("idle"));
		expect(lastActivityOf(db, id)).toBe(null);

		await observeWorkspaceActivity(
			db,
			config(),
			new Date(OBSERVED_AT.getTime() + 60_000),
			agent("working"),
		);
		expect(lastActivityOf(db, id)).toBe("2026-01-01T00:01:00.000Z");
	});

	it("reads a runner-backed workspace from its socket, not from a screen", async () => {
		// The states line up one for one with Herdr's, which is why mapActivity is shared: the
		// controller's vocabulary should not change just because the transport did.
		for (const [status, activity] of [
			["working", "active"],
			["blocked", "blocked"],
			["idle", "idle"],
		] as const) {
			const db = database();
			const id = ready(db);

			await observeWorkspaceActivity(
				db,
				runnerConfig(),
				OBSERVED_AT,
				snapshot(status),
			);

			expect(activityOf(db, id)).toBe(activity);
		}
	});

	it("will not call a runner it could not read idle", async () => {
		// The reaper destroys idle workspaces and refuses to destroy ones it cannot inspect, so
		// reading a truncated or empty answer as idle is how work gets thrown away.
		for (const stdout of ["", "not json", '{"type":"snapshot"}']) {
			const db = database();
			const id = ready(db);

			await observeWorkspaceActivity(
				db,
				runnerConfig(),
				OBSERVED_AT,
				async () => ({
					code: 0,
					kind: "ran",
					stderr: "",
					stdout,
				}),
			);

			expect(activityOf(db, id)).toBe("unknown");
		}
	});

	it("ignores workspaces that are not ready", async () => {
		const db = database();
		createWorkspace(db, {
			idempotencyKey: "queued",
			repository: "github.com/ndom91/sveltekasten",
			ref: "main",
		});

		const pass = await observeWorkspaceActivity(
			db,
			config(),
			OBSERVED_AT,
			async () => {
				throw new Error("a workspace without an agent must not be contacted");
			},
		);

		expect(pass).toEqual({ observed: 0 });
	});
});

// agent fakes a workspace whose runner reports one status.
function agent(status: string): SshRunner {
	return async (): Promise<SshResult> => ({
		code: 0,
		kind: "ran",
		stderr: "",
		stdout: `${JSON.stringify({ approvals: [], messages: [], status, type: "snapshot" })}\n`,
	});
}

// ready leaves one workspace looking like a finished provision.
function ready(db: Database.Database): string {
	const created = createWorkspace(db, {
		idempotencyKey: `ready-${Math.random()}`,
		repository: "github.com/ndom91/sveltekasten",
		ref: "main",
	});
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}

	db.prepare(
		"UPDATE workspaces SET status = 'ready', ip = '10.0.3.105' WHERE id = ?",
	).run(created.workspace.id);

	return created.workspace.id;
}

function activityOf(db: Database.Database, id: string): string {
	return (
		db.prepare("SELECT activity FROM workspaces WHERE id = ?").get(id) as {
			activity: string;
		}
	).activity;
}

function lastActivityOf(db: Database.Database, id: string): string | null {
	return (
		db
			.prepare("SELECT last_activity_at FROM workspaces WHERE id = ?")
			.get(id) as { last_activity_at: string | null }
	).last_activity_at;
}

function config() {
	return controllerConfig({
		WORKSPACE_SSH_KEY_PATH: "/tmp/test-controller-key",
	});
}

function runnerConfig() {
	return controllerConfig({
		WORKSPACE_AGENT_RUNNER: "sdk",
		WORKSPACE_SSH_KEY_PATH: "/tmp/test-controller-key",
	});
}

// snapshot answers as a runner would: one line of JSON carrying its current status.
function snapshot(status: string): SshRunner {
	return () =>
		Promise.resolve<SshResult>({
			code: 0,
			kind: "ran",
			stderr: "",
			stdout: `${JSON.stringify({ approvals: [], messages: [], status, type: "snapshot" })}\n`,
		});
}

function database(): Database.Database {
	const db = openDatabase(":memory:");
	databases.push(db);

	return db;
}
