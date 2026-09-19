import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

import {
	agentEnvironment,
	claudeSeed,
	prepareClaudeWorkspace,
} from "./claude-agent";

const TARGET = { address: "10.0.3.102", keyPath: "/keys/id", user: "agent" };

// Captured from Claude Code v2.1.274 starting in a freshly cloned workspace.
describe("claudeSeed", () => {
	it("trusts the directory the agent will actually run in", () => {
		// Trust is recorded per directory, so seeding it for the wrong path leaves the dialog in
		// place and the agent blocked.
		expect(JSON.parse(claudeSeed("/workspace/repo"))).toEqual({
			hasCompletedOnboarding: true,
			projects: { "/workspace/repo": { hasTrustDialogAccepted: true } },
		});
	});
});

describe("prepareClaudeWorkspace", () => {
	const TOKEN = "sk-ant-oat01-not-a-real-token";

	it("keeps the credential out of every argument", async () => {
		// Herdr's --env would have been simpler and was how this worked first, but an argument is
		// visible in the workspace's process list for as long as the command runs. stdin is not.
		let command: string[] = [];
		let stdin = "";
		await prepareClaudeWorkspace(
			TARGET,
			{ cwd: "/workspace/repo", token: TOKEN },
			async (_target, args, input) => {
				command = args;
				stdin = input ?? "";

				return { code: 0, kind: "ran", stderr: "", stdout: "" };
			},
		);

		for (const argument of command) {
			expect(argument).not.toContain(TOKEN);
		}
		expect(stdin).toContain(TOKEN);
	});

	it("seeds onboarding and creates the working directory", async () => {
		let command: string[] = [];
		const prepared = await prepareClaudeWorkspace(
			TARGET,
			{ cwd: "/workspace/repo", token: TOKEN },
			async (_target, args) => {
				command = args;

				return { code: 0, kind: "ran", stderr: "", stdout: "" };
			},
		);

		expect(prepared).toEqual({ kind: "prepared" });
		expect(command.at(-2)).toBe("/workspace/repo");
		expect(JSON.parse(command.at(-1) as string)).toEqual(
			JSON.parse(claudeSeed("/workspace/repo")),
		);
	});

	it("sources the credential from a file an interactive pane reads", async () => {
		// A Herdr pane is an interactive non-login shell, which reads .bashrc and not .profile.
		// Writing to the wrong one leaves the agent unauthenticated with nothing to show for it.
		let command: string[] = [];
		await prepareClaudeWorkspace(
			TARGET,
			{ cwd: "/workspace/repo", token: TOKEN },
			async (_target, args) => {
				command = args;

				return { code: 0, kind: "ran", stderr: "", stdout: "" };
			},
		);

		expect(command.join(" ")).toContain(".bashrc");
		expect(command.join(" ")).not.toContain(".profile");
	});

	it("scrubs the credential out of a failure message", async () => {
		const failed = await prepareClaudeWorkspace(
			TARGET,
			{ cwd: "/workspace/repo", token: TOKEN },
			async () => ({
				code: 1,
				kind: "ran",
				stderr: `sh: could not write ${TOKEN}`,
				stdout: "",
			}),
		);

		expect(JSON.stringify(failed)).not.toContain(TOKEN);
		expect(JSON.stringify(failed)).toContain("[redacted]");
	});

	it("reports a workspace that refused the connection as retryable", async () => {
		const prepared = await prepareClaudeWorkspace(
			TARGET,
			{ cwd: "/workspace/repo", token: TOKEN },
			async () => ({ kind: "refused" }),
		);

		expect(prepared.kind).toBe("failed");
	});
});

describe("agentEnvironment", () => {
	it("survives a shell intact, whatever is in it", async () => {
		// This line is sourced by a shell, so a quote in the value would end the string and leave
		// the remainder running as commands. Checked by sourcing it in a real shell and reading
		// the value back, because what is being tested is how a shell reads it.
		const token = `tok'en; touch /tmp/pve-herdr-agents-should-not-exist`;
		const { stdout } = await run("sh", [
			"-c",
			`${agentEnvironment(token)}printf %s "$CLAUDE_CODE_OAUTH_TOKEN"`,
		]);

		expect(stdout).toBe(token);
		expect(existsSync("/tmp/pve-herdr-agents-should-not-exist")).toBe(false);
	});
});
