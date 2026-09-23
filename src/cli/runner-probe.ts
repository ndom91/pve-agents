import { createInterface } from "node:readline";

import type { RunnerEvent } from "../domain/runner-protocol";
import { configuredHarness } from "../harness";
import { agentTarget } from "../server/agent-operations";
import { controllerRuntimeConfig } from "../server/controller";
import {
	attachRunner,
	installRunner,
	runnerSource,
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
			// The same source the provisioning phase ships, read the same way. This used to spell
			// the path itself, which is two spellings of one deployment fact and exactly the
			// stale-runner failure it was trying to avoid.
			const agent = configuredHarness(controllerRuntimeConfig());
			const installed = await installRunner(
				target,
				{ file: agent.runner, source: runnerSource(agent.runner) },
				runSsh,
			);
			if (installed.kind === "failed") {
				process.stderr.write(`install failed: ${installed.message}\n`);
				process.exit(1);
			}
			process.stdout.write("installed\n");

			const started = await startRunner(
				target,
				{
					file: agent.runner,
					permissionMode: process.env.RUNNER_PERMISSION_MODE ?? "auto",
				},
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
function report(event: RunnerEvent): void {
	if (event.type === "snapshot") {
		process.stdout.write(
			`[snapshot] session=${event.sessionId ?? "none"} status=${event.status}` +
				` mode=${event.permissionMode} messages=${event.messages.length}` +
				` pending=${event.approvals.length}\n`,
		);
		for (const approval of event.approvals) {
			report({ approval, type: "approval" });
		}

		return;
	}

	if (event.type === "approval") {
		const { displayName, id, title, toolName } = event.approval;
		process.stdout.write(
			`[approval ${id}] ${title ?? displayName ?? toolName}\n` +
				`  /approve ${id}   /deny ${id}\n`,
		);

		return;
	}

	if (event.type === "status" || event.type === "resolved") {
		process.stdout.write(`[${event.type}] ${JSON.stringify(event)}\n`);

		return;
	}

	if (event.type === "fatal") {
		process.stdout.write(`[fatal] ${event.message}\n`);

		return;
	}

	if (event.type === "message") {
		describe(event.message as Record<string, unknown>);
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

// resolve turns a workspace id into something reachable, or says why it is not.
//
// The controller's own guard rather than a second copy of it. The CLI keeps its own presentation —
// a line on stderr and a non-zero exit, rather than a typed refusal a caller pattern-matches — but
// the lookup and its three checks are the server's.
function resolve(id: string): SshTarget {
	const target = agentTarget(id);
	if (target.kind === "unavailable") {
		process.stderr.write(`${target.reason}\n`);
		process.exit(1);
	}

	return target.ssh;
}

main();
