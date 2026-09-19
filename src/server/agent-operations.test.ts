import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every SSH call in these handlers goes through runSsh, imported directly rather than injected.
// Replacing it with something that records and throws is what lets these assert the property that
// matters: a refusal happens *before* anything reaches the network.
const reached = vi.fn();
vi.mock("../services/ssh", async (importOriginal) => ({
	...(await importOriginal<typeof import("../services/ssh")>()),
	runSsh: (...args: unknown[]) => {
		reached(...args);

		throw new Error("a refused workspace must never be contacted");
	},
}));

import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";
import { createWorkspace } from "../db/workspace-repository";
import {
	discardWorkspaceWork,
	pushWorkspaceWork,
	readWorkspaceChanges,
	readWorkspaceFile,
	readWorkspacePane,
	sendAgentKeys,
	sendAgentPrompt,
} from "./agent-operations";

// The symbol the controller caches its database and configuration under.
//
// These handlers reach for process-wide state rather than taking it as an argument, and this is
// the one scope a test and a handler share. Seeding it is what makes them runnable here at all.
const STATE = Symbol.for("pve-herdr-agents.controller");

let db: Database.Database;

beforeEach(() => {
	db = openDatabase(":memory:");
	(globalThis as Record<symbol, unknown>)[STATE] = {
		database: db,
		runtimeConfig: controllerConfig({
			WORKSPACE_SSH_KEY_PATH: "/tmp/test-controller-key",
		}),
	};
	reached.mockClear();
});

afterEach(() => {
	db.close();
	delete (globalThis as Record<symbol, unknown>)[STATE];
});

// Every operator-driven operation, so the guard cannot be forgotten on the next one added. The
// list is the point: a new one missing from it is exactly what this file exists to catch.
const operations = [
	{ name: "readWorkspacePane", run: (id: string) => readWorkspacePane(id) },
	{
		name: "sendAgentPrompt",
		run: (id: string) => sendAgentPrompt(id, "do a thing"),
	},
	{ name: "sendAgentKeys", run: (id: string) => sendAgentKeys(id, "enter") },
	{
		name: "readWorkspaceChanges",
		run: (id: string) => readWorkspaceChanges(id),
	},
	{
		name: "readWorkspaceFile",
		run: (id: string) => readWorkspaceFile(id, "src/index.ts"),
	},
	{
		name: "pushWorkspaceWork",
		run: (id: string) => pushWorkspaceWork(id, "Agent work"),
	},
	{
		name: "discardWorkspaceWork",
		run: (id: string) => discardWorkspaceWork(id),
	},
];

describe("agent operations", () => {
	for (const { name, run } of operations) {
		it(`${name} refuses a workspace that is not ready`, async () => {
			// Queued and never provisioned: no address, no agent, nothing to talk to. It must say
			// so rather than opening a connection to find out.
			const id = queued(db);

			expect(refusal(await run(id))).toMatch(/not ready|no agent/);
			expect(reached).not.toHaveBeenCalled();
		});

		it(`${name} refuses a workspace that does not exist`, async () => {
			expect(
				refusal(await run("00000000-0000-0000-0000-000000000000")),
			).toContain("not found");
			expect(reached).not.toHaveBeenCalled();
		});

		it(`${name} refuses a ready workspace with no address`, async () => {
			// "ready" is the one status that otherwise passes, and a record can carry it without an
			// address after a restore or a write that landed in pieces. Trusting the status alone
			// would send a connection to undefined.
			const id = queued(db);
			db.prepare("UPDATE workspaces SET status = 'ready' WHERE id = ?").run(id);

			// Says which of the two it is. Sharing the status message here produced "workspace is
			// ready, not ready", so the wording is worth pinning rather than matching loosely.
			expect(refusal(await run(id))).toBe("workspace has no address");
			expect(reached).not.toHaveBeenCalled();
		});
	}
});

// refusal pulls the message out of whichever shape the operation refuses in.
//
// They do not share one: the read operations answer with their own failure type so the UI can
// render it in place, and the input operations answer with "unavailable". Reaching into both keeps
// one list of operations here rather than two.
function refusal(result: unknown): string {
	const shape = result as { message?: string; reason?: string };

	return shape.reason ?? shape.message ?? JSON.stringify(result);
}

// queued leaves one workspace in the state a request starts in.
function queued(database: Database.Database): string {
	const created = createWorkspace(database, {
		herdrSession: "agents",
		idempotencyKey: `queued-${Math.random()}`,
		repository: "github.com/ndom91/sveltekasten",
		ref: "main",
	});
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}

	return created.workspace.id;
}
