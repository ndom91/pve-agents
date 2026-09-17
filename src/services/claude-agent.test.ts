import { describe, expect, it } from "vitest";

import {
	claudeAwaitingOnboarding,
	prepareClaudeWorkspace,
} from "./claude-agent";

const TARGET = { address: "10.0.3.102", keyPath: "/keys/id", user: "agent" };

// Captured from Claude Code v2.1.274 starting in a freshly cloned workspace.
const WIZARD = `Welcome to Claude Code v2.1.274

 Let's get started.

 Choose the text style that looks best with your terminal
 To change this later, run /theme

   1. Auto (match terminal)
 > 2. Dark mode`;

const PROMPT = `agent@agent-2881:/workspace/repo$ claude

 > Try "how do I log an error?"
`;

describe("claudeAwaitingOnboarding", () => {
	it("recognises the first-run wizard", () => {
		// Herdr reports this screen as idle with interactive_ready true, and `agent start` exits 0.
		// The screen is the only evidence that the agent is unusable.
		expect(claudeAwaitingOnboarding(WIZARD)).toBe(true);
	});

	it("passes an agent sitting at its prompt", () => {
		expect(claudeAwaitingOnboarding(PROMPT)).toBe(false);
	});
});

describe("prepareClaudeWorkspace", () => {
	it("seeds onboarding and creates the working directory", async () => {
		let command: string[] = [];
		const prepared = await prepareClaudeWorkspace(
			TARGET,
			"/workspace/repo",
			async (_target, args) => {
				command = args;

				return { code: 0, kind: "ran", stderr: "", stdout: "" };
			},
		);

		expect(prepared).toEqual({ kind: "prepared" });
		expect(command.join(" ")).toContain("hasCompletedOnboarding");
		// The path is a positional argument, so it is never parsed as shell.
		expect(command.at(-1)).toBe("/workspace/repo");
	});

	it("reports a workspace that refused the connection as retryable", async () => {
		const prepared = await prepareClaudeWorkspace(
			TARGET,
			"/workspace/repo",
			async () => ({ kind: "refused" }),
		);

		expect(prepared.kind).toBe("failed");
	});
});
