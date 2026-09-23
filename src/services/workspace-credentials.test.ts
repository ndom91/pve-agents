import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";
import { createWorkspace } from "../db/workspace-repository";
import { refreshWorkspaceCredentials } from "./workspace-credentials";

const NOW = new Date("2026-01-01T12:00:00Z");

const KEY_PATH = join(tmpdir(), "pve-agents-test-app.pem");

const databases: Database.Database[] = [];

// A real key, because the assertion is signed before any request is made: a fake fetcher never
// gets a chance to stand in for a key that cannot be read.
beforeAll(() => {
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { format: "pem", type: "pkcs1" },
		publicKeyEncoding: { format: "pem", type: "spki" },
	});
	writeFileSync(KEY_PATH, privateKey, { mode: 0o600 });
});

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("refreshWorkspaceCredentials", () => {
	it("replaces a credential that is approaching its expiry", async () => {
		const db = database();
		// Minted 45 minutes ago. The token lasts an hour, so this is the last comfortable moment
		// to replace it.
		const id = ready(db, "2026-01-01T11:15:00Z");
		let stdin = "";

		const pass = await refreshWorkspaceCredentials(
			db,
			config(),
			NOW,
			minted(),
			async (_target, _command, input) => {
				stdin = input ?? "";

				return { code: 0, kind: "ran", stderr: "", stdout: "" };
			},
		);

		expect(pass).toEqual({ refreshed: 1 });
		expect(stdin).toContain("ghs_fresh_token");
		expect(credentialAt(db, id)).toBe(NOW.toISOString());
	});

	it("leaves a recently minted credential alone", async () => {
		const db = database();
		ready(db, "2026-01-01T11:55:00Z");

		const pass = await refreshWorkspaceCredentials(
			db,
			config(),
			NOW,
			async () => {
				throw new Error("github must not be called for a fresh credential");
			},
			async () => {
				throw new Error("the workspace must not be contacted");
			},
		);

		expect(pass).toEqual({ refreshed: 0 });
	});

	it("ignores a workspace that never checked out a repository", async () => {
		// No git_credential_at means the checkout step has not run. Pushing a credential there
		// would put one where the provisioning sequence has not decided there should be one.
		const db = database();
		ready(db, null);

		const pass = await refreshWorkspaceCredentials(
			db,
			config(),
			NOW,
			async () => {
				throw new Error("github must not be called");
			},
			async () => {
				throw new Error("the workspace must not be contacted");
			},
		);

		expect(pass).toEqual({ refreshed: 0 });
	});

	it("does not claim a credential it could not deliver", async () => {
		// Recording the attempt would leave the workspace holding an expired credential while the
		// controller believed it had a fresh one, and the next pass would skip it.
		const db = database();
		const id = ready(db, "2026-01-01T11:15:00Z");

		const pass = await refreshWorkspaceCredentials(
			db,
			config(),
			NOW,
			minted(),
			async () => ({ kind: "refused" }),
		);

		expect(pass).toEqual({ refreshed: 0 });
		expect(credentialAt(db, id)).toBe("2026-01-01T11:15:00Z");
	});

	it("does nothing when no github app is configured", async () => {
		const db = database();
		ready(db, "2026-01-01T11:15:00Z");

		const pass = await refreshWorkspaceCredentials(
			db,
			controllerConfig({ WORKSPACE_SSH_KEY_PATH: "/tmp/key" }),
			NOW,
			async () => {
				throw new Error("github must not be called");
			},
			async () => {
				throw new Error("the workspace must not be contacted");
			},
		);

		expect(pass).toEqual({ refreshed: 0 });
	});
});

// minted fakes GitHub handing out an installation token.
function minted() {
	return async () =>
		Response.json({
			expires_at: "2026-01-01T13:00:00Z",
			token: "ghs_fresh_token",
		});
}

function ready(db: Database.Database, credentialAt: string | null): string {
	const created = createWorkspace(db, {
		harnessId: "harness-1",
		idempotencyKey: `ready-${Math.random()}`,
		repository: "github.com/ndom91/open-plan-annotator",
		ref: "main",
	});
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}

	db.prepare(
		`UPDATE workspaces SET status = 'ready', ip = '10.0.3.105', git_credential_at = ?
		 WHERE id = ?`,
	).run(credentialAt, created.workspace.id);

	return created.workspace.id;
}

function credentialAt(db: Database.Database, id: string): string | null {
	return (
		db
			.prepare("SELECT git_credential_at FROM workspaces WHERE id = ?")
			.get(id) as { git_credential_at: string | null }
	).git_credential_at;
}

function config() {
	return controllerConfig({
		GITHUB_APP_ID: "123456",
		GITHUB_APP_INSTALLATION_ID: "7890",
		GITHUB_APP_PRIVATE_KEY_PATH: KEY_PATH,
		WORKSPACE_SSH_KEY_PATH: "/tmp/test-controller-key",
	});
}

function database(): Database.Database {
	const db = openDatabase(":memory:");
	databases.push(db);

	return db;
}
