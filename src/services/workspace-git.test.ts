import { describe, expect, it } from "vitest";

import type { SshResult, SshRunner } from "./ssh";
import { workspaceUnsavedWork } from "./workspace-git";

const TARGET = { address: "10.0.3.100", keyPath: "/keys/id", user: "agent" };

function exits(code: number, stderr = ""): SshRunner {
	return async (): Promise<SshResult> => ({
		code,
		kind: "ran",
		stderr,
		stdout: "",
	});
}

describe("workspaceUnsavedWork", () => {
	it("reports a tree holding work", async () => {
		const found = await workspaceUnsavedWork(
			TARGET,
			"/workspace/repo",
			exits(10),
		);

		expect(found).toEqual({
			kind: "unsaved",
			reason: "uncommitted or unpushed changes",
		});
	});

	it("reports a tree with nothing left to keep", async () => {
		const found = await workspaceUnsavedWork(
			TARGET,
			"/workspace/repo",
			exits(0),
		);

		expect(found).toEqual({ kind: "clean" });
	});

	it("does not call an unreachable workspace clean", async () => {
		// The distinction the whole check turns on. "Could not tell" treated as "nothing to lose"
		// is how a container gets destroyed with work on it.
		const refused = await workspaceUnsavedWork(
			TARGET,
			"/workspace/repo",
			async () => ({ kind: "refused" }),
		);

		expect(refused.kind).toBe("unknown");
	});

	it("does not call a missing checkout clean", async () => {
		// The clone may have failed, or something else may be on that disk. Either way the
		// workspace has not been shown to be safe to destroy.
		for (const code of [3, 4]) {
			const found = await workspaceUnsavedWork(
				TARGET,
				"/workspace/repo",
				exits(code),
			);

			expect(found.kind).toBe("unknown");
		}
	});

	it("does not call an unexpected failure clean", async () => {
		const found = await workspaceUnsavedWork(
			TARGET,
			"/workspace/repo",
			exits(127, "git: not found"),
		);

		expect(found.kind).toBe("unknown");
	});

	it("looks in the directory it was given", async () => {
		let command: string[] = [];
		await workspaceUnsavedWork(
			TARGET,
			"/workspace/repo",
			async (_target, args) => {
				command = args;

				return { code: 0, kind: "ran", stderr: "", stdout: "" };
			},
		);

		// Positional, so the path is never parsed as shell.
		expect(command.at(-1)).toBe("/workspace/repo");
		expect(command.join(" ")).toContain("git status --porcelain");
	});
});
