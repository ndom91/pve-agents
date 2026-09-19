import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { workspaceDetail } from "../db/workspace-repository";
import {
	controllerDatabase,
	controllerRuntimeConfig,
} from "../server/controller";
import {
	attachRunner,
	installRunner,
	runnerState,
	startRunner,
} from "../services/agent-runner";
import { runSsh, type SshTarget } from "../services/ssh";

// An operator tool for driving one workspace's agent runner by hand.
//
// It exists because the runner is the one piece of this system that cannot be tested the usual
// way: it runs in a container, holds a real Claude session, and the behaviour worth checking is
// whether a permission request actually suspends a tool call and whether answering it actually
// releases one. A unit test can prove the framing; only this can prove the mechanism.
//
// Kept after the UI ships. When an agent is behaving strangely the question is almost always "what
// is the runner actually saying", and this answers it without a browser.
//
//   pnpm build:cli
//   ./bin/controller-node.sh dist/cli/runner-probe.js <workspace-id> [install]
//
// Then type a prompt and press enter. `/approve <id>`, `/deny <id>`, `/interrupt`, `/quit`.

function main(): void {
	const [id, action] = process.argv.slice(2);
	if (id === undefined) {
		process.stderr.write("usage: runner-probe <workspace-id> [install]\n");
		process.exit(2);
	}

	const target = resolve(id);

	void (async () => {
		if (action === "install") {
			// Read from the deployment rather than bundled into this file, so the runner shipped to
			// a container is the one on disk beside the controller and not a copy frozen at build
			// time. A stale runner that looks current is a long afternoon.
			const source = readFileSync("runner/agent-runner.mjs", "utf8");
			const installed = await installRunner(target, source, runSsh);
			if (installed.kind === "failed") {
				process.stderr.write(`install failed: ${installed.message}\n`);
				process.exit(1);
			}
			process.stdout.write("installed\n");

			const started = await startRunner(
				target,
				process.env.RUNNER_PERMISSION_MODE ?? "auto",
				runSsh,
			);
			process.stdout.write(`start: ${started}\n`);
		}

		const state = await runnerState(target, runSsh);
		if (state !== "running") {
			process.stderr.write(`runner is ${state}; pass "install" to set it up\n`);
			process.exit(1);
		}

		attach(target);
	})();
}

function attach(target: SshTarget): void {
	const runner = attachRunner(target, {
		onClose: () => {
			process.stdout.write("\n[attachment closed]\n");
			process.exit(0);
		},
		onEvent: (event) => report(event),
	});

	runner.send({ type: "attach" });

	const input = createInterface({ input: process.stdin });
	input.on("line", (line) => {
		const text = line.trim();
		if (text === "") {
			return;
		}
		if (text === "/quit") {
			runner.close();
			process.exit(0);
		}
		if (text === "/interrupt") {
			runner.send({ type: "interrupt" });

			return;
		}
		if (text.startsWith("/approve ")) {
			runner.send({ behavior: "allow", id: text.slice(9), type: "decide" });

			return;
		}
		if (text.startsWith("/deny ")) {
			runner.send({ behavior: "deny", id: text.slice(6), type: "decide" });

			return;
		}

		runner.send({ text, type: "prompt" });
	});
}

// report prints an event in the shape a person can read.
//
// Deliberately lossy. The point is to watch the mechanism work, and a raw dump of every partial
// message scrolls the thing you were waiting for off the screen.
function report(event: unknown): void {
	const value = event as Record<string, unknown>;

	if (value.type === "snapshot") {
		const messages = value.messages as unknown[];
		const approvals = value.approvals as unknown[];
		process.stdout.write(
			`[snapshot] session=${String(value.sessionId)} status=${String(
				value.status,
			)} mode=${String(value.permissionMode)} messages=${messages.length} pending=${
				approvals.length
			}\n`,
		);
		for (const approval of approvals) {
			report({ approval, type: "approval" });
		}

		return;
	}

	if (value.type === "approval") {
		const approval = value.approval as Record<string, unknown>;
		process.stdout.write(
			`[approval ${String(approval.id)}] ${String(
				approval.title ?? approval.toolName,
			)}\n  /approve ${String(approval.id)}   /deny ${String(approval.id)}\n`,
		);

		return;
	}

	if (value.type === "status" || value.type === "resolved") {
		process.stdout.write(`[${value.type}] ${JSON.stringify(value)}\n`);

		return;
	}

	if (value.type === "fatal") {
		process.stdout.write(`[fatal] ${String(value.message)}\n`);

		return;
	}

	if (value.type === "message") {
		describe(value.message as Record<string, unknown>);
	}
}

function describe(message: Record<string, unknown>): void {
	// The deltas are what makes streaming visible, so they are printed without a newline and
	// without a label: the text simply appears, the way it does in a terminal.
	if (message.type === "stream_event") {
		const event = message.event as
			| { delta?: { text?: string; type?: string } }
			| undefined;
		if (event?.delta?.type === "text_delta") {
			process.stdout.write(event.delta.text ?? "");
		}

		return;
	}

	if (message.type === "assistant") {
		const body = message.message as { content?: unknown[] } | undefined;
		for (const block of body?.content ?? []) {
			const part = block as Record<string, unknown>;
			if (part.type === "tool_use") {
				process.stdout.write(`\n[tool] ${String(part.name)}\n`);
			}
		}

		return;
	}

	if (message.type === "result") {
		process.stdout.write(`\n[result] ${String(message.subtype)}\n`);
	}
}

// resolve turns a workspace id into something reachable, refusing anything half-built.
//
// The same three checks the server operations make, and separate for the same reason: a ready
// workspace with no address once reported "workspace is ready, not ready".
function resolve(id: string): SshTarget {
	const config = controllerRuntimeConfig();
	const workspace = workspaceDetail(controllerDatabase(), id);
	if (workspace === undefined) {
		process.stderr.write("workspace not found\n");
		process.exit(1);
	}
	if (workspace.ip === undefined) {
		process.stderr.write("workspace has no address\n");
		process.exit(1);
	}
	if (config.WORKSPACE_SSH_KEY_PATH === undefined) {
		process.stderr.write("WORKSPACE_SSH_KEY_PATH is not configured\n");
		process.exit(1);
	}

	return {
		address: workspace.ip,
		keyPath: config.WORKSPACE_SSH_KEY_PATH,
		user: config.WORKSPACE_SSH_USER,
	};
}

main();
