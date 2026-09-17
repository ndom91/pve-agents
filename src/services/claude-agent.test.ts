import { describe, expect, it } from "vitest";

import {
	claudeAwaitingInput,
	claudeSeed,
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

describe("claudeAwaitingInput", () => {
	it("recognises the first-run wizard", () => {
		// Herdr reports this screen as idle with interactive_ready true, and `agent start` exits 0.
		// The screen is the only evidence that the agent is unusable.
		expect(claudeAwaitingInput(WIZARD)).toBe(true);
	});

	it("recognises the folder-trust dialog", () => {
		// A second gate, per working directory, found only after the first one was closed. Herdr
		// does report this one as blocked, but the two checks cover each other.
		expect(
			claudeAwaitingInput(
				"Quick safety check: Is this a project you created or one you trust?",
			),
		).toBe(true);
	});

	it("passes an agent sitting at its prompt", () => {
		expect(claudeAwaitingInput(PROMPT)).toBe(false);
	});
});

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
		// Both the path and the settings are positional arguments, so neither is parsed as shell.
		expect(command.at(-2)).toBe("/workspace/repo");
		expect(JSON.parse(command.at(-1) as string)).toEqual(
			JSON.parse(claudeSeed("/workspace/repo")),
		);
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
