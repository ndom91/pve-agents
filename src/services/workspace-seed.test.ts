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

// A stand-in rather than the real harness. What is under test is that a merged destination takes
// the merge branch and everything else does not, which has nothing to do with which file
// claude-code happens to merge.
const HARNESS = { merges: (path: string) => path === ".claude.json" };

describe("seedWorkspace", () => {
	it("sends the content on stdin, never as an argument", async () => {
		// Arguments are visible in `ps` on the workspace for as long as the command runs, and a
		// seeded file is the one thing here an operator might reasonably put a credential in.
		const { calls, ssh } = recorder();

		await seedWorkspace(
			TARGET,
			HARNESS,
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
			HARNESS,
			[{ content: "x", path: "a b.md", root: "home" }],
			ssh,
		);

		expect(calls[0]?.command.slice(-4)).toEqual([
			"home",
			"a b.md",
			"/workspace/repo",
			"write",
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
			HARNESS,
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
			HARNESS,
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

		expect(await seedWorkspace(TARGET, HARNESS, [], ssh)).toEqual({
			kind: "seeded",
		});
		expect(calls).toHaveLength(0);
	});
});

describe("seeding ~/.claude.json", () => {
	// The script itself is asserted rather than its effect, because its effect happens inside a
	// container. The behaviour it encodes -- merge, refuse a corrupt file, force the mode -- was
	// checked against a real workspace by hand; what these hold is that the branch stays wired up
	// and keeps using stdin.
	function script(calls: { command: string[] }[]): string {
		return calls[0]?.command[2] ?? "";
	}

	it("merges rather than overwriting, because the workspace wrote that file first", async () => {
		// bootstrapAgentHome puts the onboarding and trust-dialog flags in ~/.claude.json a step
		// before seeding runs. Writing over it takes them away and the agent stalls on a first-run
		// prompt with nobody there to answer it.
		const { calls, ssh } = recorder();

		await seedWorkspace(
			TARGET,
			HARNESS,
			[
				{
					content: JSON.stringify({ mcpServers: {} }),
					path: ".claude.json",
					root: "home",
				},
			],
			ssh,
		);

		// The branch is chosen by the caller and arrives as an argument, so the script no longer
		// names a file. Which file is merged is the harness's answer, asserted where it lives.
		expect(calls[0]?.command.at(-1)).toBe("merge");

		const body = script(calls);
		expect(body).toContain('if [ "$4" = "merge" ]');
		expect(body).toContain("function merge(base, over)");
		// Refuses rather than repairs: overwriting a file it cannot parse is how the flags are lost.
		expect(body).toContain("is not readable JSON");
		expect(body).toContain("chmodSync(file, 0o600)");
	});

	it("still sends the content on stdin on the merge branch", async () => {
		// The merge reads fd 0 rather than an argument, for the same reason every other write
		// does: arguments are visible in `ps`, and this is the file an MCP token goes in.
		const { calls, ssh } = recorder();
		const content = JSON.stringify({ mcpServers: { m: { url: "SECRET" } } });

		await seedWorkspace(
			TARGET,
			HARNESS,
			[{ content, path: ".claude.json", root: "home" }],
			ssh,
		);

		expect(calls[0]?.input).toBe(content);
		expect(calls[0]?.command.join(" ")).not.toContain("SECRET");
		expect(script(calls)).toContain("readFileSync(0,");
	});

	it("leaves every other destination on the plain write", async () => {
		const { calls, ssh } = recorder();

		await seedWorkspace(
			TARGET,
			HARNESS,
			[{ content: "{}", path: ".claude/settings.json", root: "home" }],
			ssh,
		);

		// Same script either way -- the branch is chosen in the container, from the resolved
		// target -- so what matters is that the path it was given is not the merged one.
		expect(calls[0]?.command).toContain(".claude/settings.json");
		expect(script(calls)).toContain('cat > "$target"');
	});
});
