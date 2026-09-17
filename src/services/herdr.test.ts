import { describe, expect, it } from "vitest";

import {
	createHerdrWorkspace,
	herdrAgentName,
	herdrServerState,
	promptHerdrAgent,
	sendHerdrKeys,
	startHerdrAgent,
	startHerdrServer,
} from "./herdr";
import type { SshResult, SshRunner, SshTarget } from "./ssh";

const TARGET = {
	session: "agents",
	ssh: { address: "10.0.3.102", keyPath: "/keys/id", user: "agent" },
};

// Captured from herdr 0.9.0 on a real workspace container.
const CREATED = JSON.stringify({
	id: "cli:workspace:create",
	result: {
		root_pane: {
			agent_status: "unknown",
			cwd: "/workspace/repo",
			pane_id: "w1:p1",
			tab_id: "w1:t1",
			workspace_id: "w1",
		},
		tab: { tab_id: "w1:t1", workspace_id: "w1" },
		type: "workspace_created",
		workspace: { label: "agent-2881", workspace_id: "w1" },
	},
});

describe("herdrAgentName", () => {
	it("accepts a workspace hostname", () => {
		expect(herdrAgentName("agent-2881")).toBe("agent-2881");
	});

	it("rejects a name herdr would reject at agent start", () => {
		// Herdr enforces [a-z][a-z0-9_-]{0,31}. Catching it here costs nothing; catching it there
		// wastes a container, a session, and a workspace.
		expect(herdrAgentName("596a79dc-be81-425d-a1b9-0aa328e465f1")).toBe(
			undefined,
		);
		expect(herdrAgentName("Agent-1")).toBe(undefined);
		expect(herdrAgentName("1agent")).toBe(undefined);
	});
});

describe("herdrServerState", () => {
	it("reads a running server from the status block", async () => {
		const state = await herdrServerState(
			TARGET,
			ran(0, "client:\n  version: 0.9.0\n\nserver:\n  status: running\n"),
		);
		expect(state).toEqual({ kind: "running" });
	});

	it("treats a missing server as stopped rather than failed", async () => {
		// herdr reports this with exit 0. A freshly booted workspace always looks like this, so
		// calling it a failure would fail every provision at the first check.
		const state = await herdrServerState(
			TARGET,
			ran(0, "server:\n  status: not running\n"),
		);
		expect(state).toEqual({ kind: "stopped" });
	});
});

describe("startHerdrServer", () => {
	it("detaches the server from the ssh session", async () => {
		let command: string[] = [];
		const started = await startHerdrServer(TARGET, async (_target, args) => {
			command = args;

			return { code: 0, kind: "ran", stderr: "", stdout: "" };
		});

		expect(started).toEqual({ kind: "started" });
		// Without setsid the server dies with the connection; without the redirections this call
		// never returns, because ssh waits on a stream the backgrounded server still holds.
		expect(command.join(" ")).toContain("setsid");
		expect(command.join(" ")).toContain("</dev/null");
		expect(command.join(" ")).toContain("2>&1");
		// The session name is a positional argument, never interpolated into the script.
		expect(command.at(-1)).toBe("agents");
	});
});

describe("createHerdrWorkspace", () => {
	it("returns the ids herdr reported", async () => {
		const created = await createHerdrWorkspace(
			TARGET,
			{ cwd: "/workspace/repo", label: "agent-2881" },
			ran(0, CREATED),
		);

		expect(created).toEqual({
			cwd: "/workspace/repo",
			kind: "created",
			paneId: "w1:p1",
			tabId: "w1:t1",
			workspaceId: "w1",
		});
	});

	it("rejects a workspace herdr silently placed somewhere else", async () => {
		// The trap this whole check exists for: a --cwd that does not exist is ignored, and the
		// command still exits 0 reporting workspace_created from the home directory.
		const elsewhere = CREATED.replaceAll("/workspace/repo", "/home/agent");
		const created = await createHerdrWorkspace(
			TARGET,
			{ cwd: "/workspace/repo", label: "agent-2881" },
			ran(0, elsewhere),
		);

		expect(created.kind).toBe("rejected");
	});

	it("passes no credentials as arguments", async () => {
		// Herdr supports --env and this used it at first, but an --env argument is in the process
		// list of the workspace for as long as the command runs. Credentials go to a file the
		// pane's shell sources instead.
		let command: string[] = [];
		await createHerdrWorkspace(
			TARGET,
			{ cwd: "/workspace/repo", label: "l" },
			async (_target, args) => {
				command = args;

				return { code: 0, kind: "ran", stderr: "", stdout: CREATED };
			},
		);

		expect(command).not.toContain("--env");
	});

	it("does not retry a command herdr could not parse", async () => {
		// Exit 2 is a CLI syntax error, which means this repository built the command wrong. It
		// will fail identically forever, so it must not look like a transient fault.
		const created = await createHerdrWorkspace(
			TARGET,
			{ cwd: "/workspace/repo", label: "l" },
			ran(2, "", "unknown option: --nope"),
		);

		expect(created.kind).toBe("rejected");
	});
});

describe("startHerdrAgent", () => {
	const input = { agentKind: "claude", name: "agent-2881", paneId: "w1:p1" };

	it("reports a started agent", async () => {
		const started = await startHerdrAgent(
			TARGET,
			input,
			ran(0, JSON.stringify({ result: { type: "agent_started" } })),
		);

		expect(started).toEqual({ kind: "started" });
	});

	it("separates a blocked startup from a failed one", async () => {
		// agent_not_ready keeps the name resolvable, so the agent can be read and answered.
		// Restarting it would be wrong.
		const started = await startHerdrAgent(
			TARGET,
			input,
			ran(1, "", '{"error":{"code":"agent_not_ready"}}'),
		);

		expect(started).toEqual({ kind: "not-ready" });
	});
});

function ran(code: number, stdout: string, stderr = ""): SshRunner {
	return async (_target: SshTarget): Promise<SshResult> => ({
		code,
		kind: "ran",
		stderr,
		stdout,
	});
}

describe("promptHerdrAgent", () => {
	it("reports a blocked agent as blocked, not as a failure", async () => {
		// The UI branches on this. Herdr refuses a prompt to an agent at a dialog before sending
		// anything, which is not a fault: it is the agent waiting for an answer, and an operator
		// needs to be told to answer it rather than told something broke.
		const prompted = await promptHerdrAgent(
			TARGET,
			"agent-2881",
			"do the thing",
			ran(1, "", '{"error":{"code":"agent_blocked"}}'),
		);

		expect(prompted).toEqual({ kind: "blocked" });
	});

	it("sends the text it was given, unchanged", async () => {
		let command: string[] = [];
		await promptHerdrAgent(
			TARGET,
			"agent-2881",
			"Fix the login bug; don't touch the tests",
			async (_target, args) => {
				command = args;

				return { code: 0, kind: "ran", stderr: "", stdout: "{}" };
			},
		);

		expect(command).toContain("Fix the login bug; don't touch the tests");
	});

	it("returns as soon as the prompt is submitted", async () => {
		// No --wait: Herdr reports submission rather than completion, and waiting for a turn to
		// finish would hold the caller for however long the work takes.
		let command: string[] = [];
		await promptHerdrAgent(
			TARGET,
			"agent-2881",
			"go",
			async (_target, args) => {
				command = args;

				return { code: 0, kind: "ran", stderr: "", stdout: "{}" };
			},
		);

		expect(command).not.toContain("--wait");
	});
});

describe("sendHerdrKeys", () => {
	it("sends a key from the allow-list", async () => {
		let command: string[] = [];
		const sent = await sendHerdrKeys(
			TARGET,
			"agent-2881",
			"enter",
			async (_target, args) => {
				command = args;

				return { code: 0, kind: "ran", stderr: "", stdout: "{}" };
			},
		);

		expect(sent).toEqual({ kind: "submitted" });
		expect(command).toContain("enter");
	});

	it("refuses anything else before it reaches herdr", async () => {
		// send-keys writes raw input to a terminal running an agent that holds repository write
		// access and a live GitHub token. These exist to answer a dialog, not to type commands.
		for (const key of ["ctrl+d", "rm -rf /", "a", "tab", "f1"]) {
			const sent = await sendHerdrKeys(TARGET, "agent-2881", key, async () => {
				throw new Error("herdr must not be contacted for a rejected key");
			});

			expect(sent.kind).toBe("failed");
		}
	});
});
