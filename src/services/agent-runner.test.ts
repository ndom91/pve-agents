import { describe, expect, it } from "vitest";

import {
	framer,
	installRunner,
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

describe("framer", () => {
	it("delivers one event per line", () => {
		const seen: unknown[] = [];
		const feed = framer((event) => seen.push(event));

		feed('{"type":"a"}\n{"type":"b"}\n');

		expect(seen).toEqual([{ type: "a" }, { type: "b" }]);
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

		feed('{"type":"a"}\n{"type":"b"');

		expect(seen).toEqual([{ type: "a" }]);
	});

	it("drops a malformed line and keeps the attachment", () => {
		// Tearing down the connection would cost the operator sight of a running agent. One bad
		// event is the cheaper loss.
		const seen: unknown[] = [];
		const feed = framer((event) => seen.push(event));

		feed('not json\n{"type":"a"}\n');

		expect(seen).toEqual([{ type: "a" }]);
	});
});

describe("installRunner", () => {
	it("sends the runner on stdin, never as an argument", async () => {
		// Arguments are visible in ps on the workspace for as long as the command runs. This
		// particular content is not secret, but the rule is kept unconditional: the moment a
		// caller can put something in an argument, somebody eventually puts a token there.
		const { calls, ssh } = recorder();

		await installRunner(TARGET, "console.log(1)", ssh);

		expect(calls[0]?.input).toBe("console.log(1)");
		expect(calls[0]?.command.join(" ")).not.toContain("console.log");
	});

	it("reports a refused connection as a failure rather than success", async () => {
		const { ssh } = recorder({ kind: "refused" });

		const result = await installRunner(TARGET, "x", ssh);

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

		expect(await installRunner(TARGET, "x", ssh)).toEqual({
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

		await startRunner(TARGET, "auto", ssh);

		expect(calls[0]?.command.join(" ")).toContain("setsid");
	});

	it("passes the permission mode rather than baking one in", async () => {
		// It is policy, tuned against a running fleet, not a property of the container.
		const { calls, ssh } = recorder();

		await startRunner(TARGET, "default", ssh);

		expect(calls[0]?.command).toContain("default");
	});

	it("reports a failed start rather than assuming it worked", async () => {
		const { ssh } = recorder({
			code: 1,
			kind: "ran",
			stderr: "node: not found",
			stdout: "",
		});

		expect(await startRunner(TARGET, "auto", ssh)).toBe("failed");
	});

	it("claims only that a launch was issued, never that one is running", async () => {
		// The script backgrounds the runner and exits, so a runner that dies in its first second
		// launches perfectly. This returned "running" for one whose log held ERR_MODULE_NOT_FOUND,
		// and provisioning would have marked the workspace ready on the strength of it.
		const { ssh } = recorder();

		expect(await startRunner(TARGET, "auto", ssh)).toBe("launched");
	});
});

describe("installRunner's module resolution", () => {
	it("links the global install rather than setting NODE_PATH", async () => {
		// NODE_PATH is a CommonJS mechanism and node's ESM resolver ignores it. The runner is an
		// ES module, so the first attempt failed with ERR_MODULE_NOT_FOUND while NODE_PATH was set
		// correctly and pointed at a directory that genuinely held the package.
		const { calls, ssh } = recorder();

		await installRunner(TARGET, "x", ssh);

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
