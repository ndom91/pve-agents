import { describe, expect, it } from "vitest";

import {
	framer,
	installRunner,
	runnerReading,
	runnerState,
	startRunner,
} from "./agent-runner";
import type { SshResult, SshRunner, SshTarget } from "./ssh";

const TARGET: SshTarget = {
	address: "10.0.3.113",
	keyPath: "/var/lib/controller/ssh/id",
	user: "agent",
};

// calls records what reached ssh, which is the only place the shape of a remote command can be
// checked: everything else about it happens on a machine a test cannot see.
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

// The runner shipped by whichever harness is configured. Named here rather than inlined, because
// these tests are about install and start, not about which file a harness happens to use.
const RUNNER_FILE = "agent-runner.mjs";

describe("framer", () => {
	it("delivers one event per line", () => {
		const seen: unknown[] = [];
		const feed = framer((event) => seen.push(event));

		feed('{"type":"status","status":"idle"}\n{"type":"detached"}\n');

		expect(seen).toEqual([
			{ status: "idle", type: "status" },
			{ type: "detached" },
		]);
	});

	it("joins an event split across chunks", () => {
		// The failure this exists for. A tool input large enough to split used to arrive as two
		// unparseable halves and be dropped, so the biggest events were the ones that vanished.
		const seen: unknown[] = [];
		const feed = framer((event) => seen.push(event));

		feed('{"type":"appro');
		feed('val","id":"x"}\n');

		expect(seen).toEqual([{ id: "x", type: "approval" }]);
	});

	it("holds an incomplete line rather than delivering half of it", () => {
		const seen: unknown[] = [];
		const feed = framer((event) => seen.push(event));

		feed('{"type":"detached"}\n{"type":"stat');

		expect(seen).toEqual([{ type: "detached" }]);
	});

	it("drops an event kind it has no opinion about", () => {
		// The runner is a separate deployable shipped by the controller, but a container can be
		// running an older or newer one than the page attached to it. Something it says that this
		// side has never heard of is dropped rather than passed along as a half-typed object.
		const seen: unknown[] = [];
		const feed = framer((event) => seen.push(event));

		feed('{"type":"invented_next_release"}\n{"type":"detached"}\n');

		expect(seen).toEqual([{ type: "detached" }]);
	});

	it("drops a malformed line and keeps the attachment", () => {
		// Tearing down the connection would cost the operator sight of a running agent. One bad
		// event is the cheaper loss.
		const seen: unknown[] = [];
		const feed = framer((event) => seen.push(event));

		feed('not json\n{"type":"detached"}\n');

		expect(seen).toEqual([{ type: "detached" }]);
	});
});

describe("installRunner", () => {
	it("sends the runner on stdin, never as an argument", async () => {
		// Arguments are visible in ps on the workspace for as long as the command runs. This
		// particular content is not secret, but the rule is kept unconditional: the moment a
		// caller can put something in an argument, somebody eventually puts a token there.
		const { calls, ssh } = recorder();

		await installRunner(
			TARGET,
			{ files: [{ name: RUNNER_FILE, source: "console.log(1)" }] },
			ssh,
		);

		expect(calls[0]?.input).toBe("console.log(1)");
		expect(calls[0]?.command.join(" ")).not.toContain("console.log");
	});

	it("writes every file, one connection each", async () => {
		const { calls, ssh } = recorder();

		await installRunner(
			TARGET,
			{
				files: [
					{ name: "agent-socket.mjs", source: "export const a = 1;" },
					{ name: RUNNER_FILE, source: "import './agent-socket.mjs';" },
				],
			},
			ssh,
		);

		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.command.at(-1))).toEqual([
			"agent-socket.mjs",
			RUNNER_FILE,
		]);
		expect(calls[0]?.input).toBe("export const a = 1;");
	});

	it("stops at the first failure rather than writing the entry anyway", async () => {
		// The entry is written last so that a half-installed directory is one node refuses to
		// start, rather than one it starts and then fails to resolve an import in -- which reads
		// as the agent being broken rather than as the install being incomplete.
		const { calls, ssh } = recorder({
			code: 1,
			kind: "ran",
			stderr: "no space left on device",
			stdout: "",
		});

		const result = await installRunner(
			TARGET,
			{
				files: [
					{ name: "agent-socket.mjs", source: "x" },
					{ name: RUNNER_FILE, source: "y" },
				],
			},
			ssh,
		);

		expect(calls).toHaveLength(1);
		expect(result).toEqual({
			kind: "failed",
			message: "no space left on device",
		});
	});

	it("reports a refused connection as a failure rather than success", async () => {
		const { ssh } = recorder({ kind: "refused" });

		const result = await installRunner(
			TARGET,
			{ files: [{ name: RUNNER_FILE, source: "x" }] },
			ssh,
		);

		expect(result).toEqual({
			kind: "failed",
			message: "workspace refused the connection",
		});
	});

	it("carries the remote error rather than inventing one", async () => {
		const { ssh } = recorder({
			code: 1,
			kind: "ran",
			stderr: "mkdir: permission denied",
			stdout: "",
		});

		expect(
			await installRunner(
				TARGET,
				{ files: [{ name: RUNNER_FILE, source: "x" }] },
				ssh,
			),
		).toEqual({
			kind: "failed",
			message: "mkdir: permission denied",
		});
	});
});

describe("startRunner", () => {
	it("detaches the runner from the connection that started it", async () => {
		// Without setsid the runner dies with the ssh session, so every agent in the fleet would
		// stop whenever the controller happened to disconnect.
		const { calls, ssh } = recorder();

		await startRunner(
			TARGET,
			{ file: RUNNER_FILE, permissionMode: "auto" },
			ssh,
		);

		expect(calls[0]?.command.join(" ")).toContain("setsid");
	});

	it("passes the permission mode rather than baking one in", async () => {
		// It is policy, tuned against a running fleet, not a property of the container.
		const { calls, ssh } = recorder();

		await startRunner(
			TARGET,
			{ file: RUNNER_FILE, permissionMode: "default" },
			ssh,
		);

		expect(calls[0]?.command).toContain("default");
	});

	it("reports a failed start rather than assuming it worked", async () => {
		const { ssh } = recorder({
			code: 1,
			kind: "ran",
			stderr: "node: not found",
			stdout: "",
		});

		expect(
			await startRunner(
				TARGET,
				{ file: RUNNER_FILE, permissionMode: "auto" },
				ssh,
			),
		).toBe("failed");
	});

	it("claims only that a launch was issued, never that one is running", async () => {
		// The script backgrounds the runner and exits, so a runner that dies in its first second
		// launches perfectly. This returned "running" for one whose log held ERR_MODULE_NOT_FOUND,
		// and provisioning would have marked the workspace ready on the strength of it.
		const { ssh } = recorder();

		expect(
			await startRunner(
				TARGET,
				{ file: RUNNER_FILE, permissionMode: "auto" },
				ssh,
			),
		).toBe("launched");
	});
});

describe("installRunner's module resolution", () => {
	it("links the global install rather than setting NODE_PATH", async () => {
		// NODE_PATH is a CommonJS mechanism and node's ESM resolver ignores it. The runner is an
		// ES module, so the first attempt failed with ERR_MODULE_NOT_FOUND while NODE_PATH was set
		// correctly and pointed at a directory that genuinely held the package.
		const { calls, ssh } = recorder();

		await installRunner(
			TARGET,
			{ files: [{ name: RUNNER_FILE, source: "x" }] },
			ssh,
		);

		const script = calls[0]?.command.join(" ") ?? "";
		expect(script).toContain("ln -sfn");
		expect(script).not.toContain("NODE_PATH");
	});
});

describe("runnerState", () => {
	it("connects to the socket rather than testing for the file", async () => {
		// A socket left behind by a runner that died is still a socket. Whether anything is
		// listening is the entire question.
		const { calls, ssh } = recorder();

		await runnerState(TARGET, ssh);

		expect(calls[0]?.command.join(" ")).toContain("connect");
	});

	it("calls a socket nobody is listening on stopped, not failed", async () => {
		// The two want different handling: stopped is started again, failed is reported.
		const { ssh } = recorder({ code: 1, kind: "ran", stderr: "", stdout: "" });

		expect(await runnerState(TARGET, ssh)).toBe("stopped");
	});

	it("calls an unreachable workspace failed, not stopped", async () => {
		const { ssh } = recorder({ kind: "refused" });

		expect(await runnerState(TARGET, ssh)).toBe("failed");
	});
});

describe("runnerReading", () => {
	function answering(stdout: string) {
		return recorder({ code: 0, kind: "ran", stderr: "", stdout });
	}

	it("reads the status out of the snapshot", async () => {
		for (const status of ["working", "idle", "blocked"] as const) {
			const { ssh } = answering(
				JSON.stringify({
					approvals: [],
					messages: [],
					status,
					type: "snapshot",
				}),
			);

			expect((await runnerReading(TARGET, ssh)).status).toBe(status);
		}
	});

	it("asks for a one-shot snapshot, not a subscription", async () => {
		// A subscription is what delivers the broadcasts that used to be mistaken for the reply.
		// The one-shot makes the runner hang up, which is what lets this read to end of stream.
		const { calls, ssh } = answering('{"type":"snapshot","status":"idle"}');

		await runnerReading(TARGET, ssh);

		expect(calls[0]?.input).toContain('{"type":"snapshot"}');
		expect(calls[0]?.input).not.toContain('{"type":"attach"}');
	});

	it("refuses to guess at an answer it could not read", async () => {
		// "unknown" is load-bearing. The reaper destroys idle workspaces and keeps ones it cannot
		// inspect, so reading silence as idle is how somebody's work gets thrown away.
		for (const stdout of [
			"",
			"   ",
			"not json",
			'{"type":"status","status":"working"}',
		]) {
			const { ssh } = answering(stdout);

			expect((await runnerReading(TARGET, ssh)).status).toBe("unknown");
		}
	});

	it("refuses to guess when the workspace could not be reached at all", async () => {
		const { ssh } = recorder({ kind: "refused" });

		expect((await runnerReading(TARGET, ssh)).status).toBe("unknown");
	});

	it("carries the title back on the same round trip as the status", async () => {
		// The whole reason the title rides on the snapshot: asking for it separately would double
		// the SSH connections the observation pass makes, for a value already on the wire.
		const { calls, ssh } = answering(
			JSON.stringify({
				approvals: [],
				messages: [],
				status: "idle",
				title: "Fix the flaky login test",
				type: "snapshot",
			}),
		);

		expect(await runnerReading(TARGET, ssh)).toEqual({
			status: "idle",
			title: "Fix the flaky login test",
		});
		expect(calls).toHaveLength(1);
	});

	it("has no title for a runner that predates naming", async () => {
		// Those runners are still running and will not be replaced until their workspace is. Their
		// snapshots have no title field at all, which must read as "no name" and not as an error.
		const { ssh } = answering('{"type":"snapshot","status":"idle"}');

		expect((await runnerReading(TARGET, ssh)).title).toBeUndefined();
	});
});
