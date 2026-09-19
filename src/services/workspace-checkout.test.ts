import { describe, expect, it } from "vitest";

import type { SshResult, SshRunner, SshTarget } from "./ssh";
import { checkoutRepository, storeGitCredential } from "./workspace-checkout";

const TARGET = { address: "10.0.3.105", keyPath: "/keys/id", user: "agent" };
const TOKEN = "ghs_not_a_real_installation_token";
const REPOSITORY = { name: "open-plan-annotator", owner: "ndom91" };

describe("checkoutRepository", () => {
	it("never puts the token in an argument", () => {
		// The property this whole two-step dance exists for. An argument is visible in ps on the
		// workspace for as long as the command runs, and git repeats the remote it was using in
		// its error output, which the controller appends to the timeline the UI renders.
		//
		// Asserted against every argument of every command, so adding the token to a URL later for
		// convenience fails here rather than in production.
		return recorded(async (ssh) => {
			await checkoutRepository(
				TARGET,
				{
					cwd: "/workspace/repo",
					ref: "main",
					repository: REPOSITORY,
					token: TOKEN,
				},
				ssh,
			);
		}).then(({ commands, inputs }) => {
			for (const command of commands) {
				for (const argument of command) {
					expect(argument).not.toContain(TOKEN);
				}
			}

			// It does reach the workspace, just on stdin, which no process list shows.
			expect(inputs.join("")).toContain(TOKEN);
		});
	});

	it("widens the fetch refspec so a pushed branch is observable", async () => {
		// The clone is single-branch, which narrows the refspec to that branch alone. A branch
		// pushed later then gets no remote-tracking ref, `git rev-parse @{u}` fails, and the commit
		// counts as unpushed forever: the workspace reports work it has already pushed, and the
		// reaper asks the same question and never lets it go.
		const { commands } = await recorded(async (ssh) => {
			await checkoutRepository(
				TARGET,
				{
					cwd: "/workspace/repo",
					ref: "main",
					repository: REPOSITORY,
					token: TOKEN,
				},
				ssh,
			);
		});

		expect(commands.map((command) => command.join(" ")).join("\n")).toContain(
			'config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"',
		);
	});

	it("clones from a URL carrying no credentials", async () => {
		const { commands } = await recorded(async (ssh) => {
			await checkoutRepository(
				TARGET,
				{
					cwd: "/workspace/repo",
					ref: "main",
					repository: REPOSITORY,
					token: TOKEN,
				},
				ssh,
			);
		});

		const clone = commands.find((command) =>
			command.some((argument) => argument.includes("git clone")),
		);
		expect(clone).toBeDefined();
		expect(clone?.join(" ")).toContain(
			"https://github.com/ndom91/open-plan-annotator.git",
		);
		expect(clone?.join(" ")).not.toContain("@github.com");
	});

	it("checks out the requested ref", async () => {
		const { commands } = await recorded(async (ssh) => {
			await checkoutRepository(
				TARGET,
				{
					cwd: "/workspace/repo",
					ref: "release/2026",
					repository: REPOSITORY,
					token: TOKEN,
				},
				ssh,
			);
		});

		expect(commands.at(-1)).toContain("release/2026");
	});

	it("scrubs the token out of a failure message", async () => {
		// git prints the remote it was using when a fetch fails, and the stored credential is part
		// of that remote.
		const result = await checkoutRepository(
			TARGET,
			{
				cwd: "/workspace/repo",
				ref: "main",
				repository: REPOSITORY,
				token: TOKEN,
			},
			async (_target, command) =>
				command.join(" ").includes("git clone")
					? {
							code: 128,
							kind: "ran",
							stderr: `fatal: could not read from https://x-access-token:${TOKEN}@github.com`,
							stdout: "",
						}
					: { code: 0, kind: "ran", stderr: "", stdout: "" },
		);

		expect(result.kind).toBe("failed");
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(JSON.stringify(result)).toContain("[redacted]");
	});

	it("stops at the first failed step", async () => {
		// Cloning with no credential stored would fail on a private repository in a way that looks
		// like a missing repository, which is a far worse message than the real one.
		let attempts = 0;
		const result = await checkoutRepository(
			TARGET,
			{
				cwd: "/workspace/repo",
				ref: "main",
				repository: REPOSITORY,
				token: TOKEN,
			},
			async () => {
				attempts += 1;

				return { kind: "refused" };
			},
		);

		expect(result.kind).toBe("failed");
		expect(attempts).toBe(1);
	});
});

describe("storeGitCredential", () => {
	it("replaces the credential without touching the repository", async () => {
		const { commands, inputs } = await recorded(async (ssh) => {
			await storeGitCredential(TARGET, TOKEN, ssh);
		});

		expect(commands).toHaveLength(1);
		expect(commands[0]?.join(" ")).not.toContain("git clone");
		expect(commands[0]?.join(" ")).toContain("credential.helper store");
		expect(inputs[0]).toContain(TOKEN);
	});
});

// recorded runs a checkout against a fake workspace, keeping every command and every stdin.
async function recorded(
	use: (ssh: SshRunner) => Promise<void>,
): Promise<{ commands: string[][]; inputs: string[] }> {
	const commands: string[][] = [];
	const inputs: string[] = [];
	const ssh: SshRunner = async (
		_target: SshTarget,
		command: string[],
		input?: string,
	): Promise<SshResult> => {
		commands.push(command);
		inputs.push(input ?? "");

		return { code: 0, kind: "ran", stderr: "", stdout: "" };
	};

	await use(ssh);

	return { commands, inputs };
}
