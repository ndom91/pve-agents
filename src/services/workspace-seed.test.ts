import { describe, expect, it } from "vitest";

import type { SshResult, SshRunner, SshTarget } from "./ssh";
import { seedWorkspace } from "./workspace-seed";

const TARGET: SshTarget = {
	address: "10.0.3.113",
	keyPath: "/var/lib/controller/ssh/id",
	user: "agent",
};

function recorder(...results: SshResult[]) {
	const calls: { command: string[]; input?: string }[] = [];
	const queued = [...results];

	const ssh: SshRunner = (_target, command, input) => {
		calls.push({ command, input });

		return Promise.resolve(
			queued.shift() ?? { code: 0, kind: "ran", stderr: "", stdout: "" },
		);
	};

	return { calls, ssh };
}

describe("seedWorkspace", () => {
	it("sends the content on stdin, never as an argument", async () => {
		// Arguments are visible in `ps` on the workspace for as long as the command runs, and a
		// seeded file is the one thing here an operator might reasonably put a credential in.
		const { calls, ssh } = recorder();

		await seedWorkspace(
			TARGET,
			[{ content: "SECRET", path: "CLAUDE.md", root: "repo" }],
			ssh,
		);

		expect(calls[0]?.input).toBe("SECRET");
		expect(calls[0]?.command.join(" ")).not.toContain("SECRET");
	});

	it("passes the destination positionally rather than building a path", async () => {
		// ssh joins its argv and the remote shell splits it again, so a path interpolated into the
		// script text is a path whose spaces and semicolons are the remote shell's to interpret.
		const { calls, ssh } = recorder();

		await seedWorkspace(
			TARGET,
			[{ content: "x", path: "a b.md", root: "home" }],
			ssh,
		);

		expect(calls[0]?.command.slice(-3)).toEqual([
			"home",
			"a b.md",
			"/workspace/repo",
		]);
	});

	it("stops at the first failure rather than seeding half a workspace", async () => {
		// Carrying on leaves a workspace holding some of its configuration with no way to tell
		// which, and the step is retried whole anyway.
		const { calls, ssh } = recorder({
			code: 1,
			kind: "ran",
			stderr: "permission denied",
			stdout: "",
		});

		const result = await seedWorkspace(
			TARGET,
			[
				{ content: "a", path: "first.md", root: "repo" },
				{ content: "b", path: "second.md", root: "repo" },
			],
			ssh,
		);

		expect(calls).toHaveLength(1);
		expect(result).toEqual({
			failed: "first.md",
			kind: "failed",
			message: "could not write first.md: permission denied",
		});
	});

	it("names the file in the failure, because that is what an operator has to fix", async () => {
		const { ssh } = recorder({ kind: "refused" });

		const result = await seedWorkspace(
			TARGET,
			[{ content: "a", path: ".claude/settings.json", root: "home" }],
			ssh,
		);

		expect(result.kind === "failed" && result.message).toContain(
			".claude/settings.json",
		);
	});

	it("opens no connection when there is nothing to write", async () => {
		// The common case. A round trip to do nothing is a round trip on every provision forever.
		const { calls, ssh } = recorder();

		expect(await seedWorkspace(TARGET, [], ssh)).toEqual({ kind: "seeded" });
		expect(calls).toHaveLength(0);
	});
});
