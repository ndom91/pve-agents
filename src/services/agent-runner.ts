import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
	RunnerEvent,
	RunnerRequest,
	RunnerSnapshot,
	RunnerStatus,
} from "../domain/runner-protocol";
import { readEvent } from "../domain/runner-protocol";
import { AGENT_CWD } from "../domain/workspace-layout";
import { knownHostsPath, type SshRunner, type SshTarget } from "./ssh";

// The controller's side of the agent runner.
//
// The runner is a detached node process inside each workspace holding one Claude Code session open
// and listening on a unix socket. This module installs it, starts it, and attaches to it.
//
// It replaced driving the agent through a terminal. Reading a rendered viewport told us what the
// screen looked like rather than what the agent was doing, and answering a permission dialog meant
// typing "1" at a box of text. The SDK has typed messages and a real approval callback, and the
// runner is what puts them within reach of a controller on another host.

// RUNNER_DIR is where the runner and its package marker live in a workspace.
//
// A directory of its own with a package.json in it, because a bare .mjs outside any package cannot
// resolve a globally installed dependency: node walks up looking for node_modules and finds none.
const RUNNER_DIR = "/home/agent/.agent-runner";

// RUNNER_SOCKET is where the runner listens.
//
// Under $HOME rather than /run/user/1000, because the agent user has Linger=no: the XDG runtime
// directory only exists while a login session does, and this process outlives every session.
const RUNNER_SOCKET = "/home/agent/.agent-runner.sock";

// NODE_MODULES is where the template's global npm install puts the SDK.
//
// Reached by a symlink rather than by NODE_PATH, which was the first attempt and does not work:
// NODE_PATH is a CommonJS mechanism and node's ESM resolver ignores it entirely. The runner is an
// ES module, so it got ERR_MODULE_NOT_FOUND with NODE_PATH set correctly and pointing at a
// directory that genuinely contained the package. The ESM resolver walks up looking for
// node_modules directories, and it follows a symlink, so that is what the install creates.
const NODE_MODULES = "/usr/lib/node_modules";

// RunnerInstall reports whether a workspace has a runner ready to be started.
export type RunnerInstall =
	| { kind: "failed"; message: string }
	| { kind: "installed" };

// RunnerLaunch is whether the start command was accepted.
//
// Deliberately not the same type as RunnerState, because it cannot answer the same question. The
// script backgrounds the runner and exits, so it reports that a launch was issued and nothing
// about whether the process survived its first second. A runner that dies immediately — a missing
// dependency, a syntax error — launches perfectly.
//
// This type used to be RunnerState, and `startRunner` cheerfully returned "running" for a runner
// whose log held ERR_MODULE_NOT_FOUND. Callers poll runnerState.
export type RunnerLaunch = "failed" | "launched";

// RunnerState is whether a runner is answering on its socket.
export type RunnerState = "failed" | "running" | "stopped";

// INSTALL_SCRIPT writes the runner and its package marker.
//
// The runner's source arrives on stdin rather than as an argument. Arguments are visible in ps on
// the workspace for as long as the command runs, and while this particular content is not secret,
// the rule is worth keeping unconditional: the moment a caller can put something in an argument,
// somebody eventually puts a token there.
//
// "type": "module" because the runner uses import. Without it node reads a .mjs correctly but the
// package it now belongs to disagrees, and the error names neither.
const INSTALL_SCRIPT = [
	'mkdir -p "$1"',
	'printf %s \'{"type":"module"}\' > "$1/package.json"',
	// How the runner finds the SDK. See NODE_MODULES above for why this is a symlink and not an
	// environment variable.
	'ln -sfn "$2" "$1/node_modules"',
	'cat > "$1/$3"',
].join("\n");

// PROBE asks whether anything is listening on a socket, rather than whether the file exists.
//
// One string because two callers depend on it answering the same way: `runnerState` reports the
// truth to the provisioning phase, and START_SCRIPT uses it as its own "already running?" guard.
// If those two ever disagreed, a pass would start a second runner over a live one — two processes
// on one socket and two Claude sessions billing the same subscription.
const PROBE = `require("net").connect(process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))`;

// START_SCRIPT launches the runner so it outlives the connection that started it.
//
// setsid is what makes that true. Without it the runner dies with the ssh session, which would
// mean every agent in the fleet dying whenever the controller happened to disconnect.
//
// Detached deliberately: a controller deploy restarts the controller, and an agent whose session
// lived in the controller's memory would lose its turn every time somebody shipped a change.
//
// The credentials are sourced explicitly, and that line is the whole reason this comment is long.
// `agentEnvironment()` writes the OAuth token into ~/.config/agent-env and hooks it into .bashrc,
// which bash reads for *interactive* shells. A Herdr pane was one. This is a detached process
// started by a non-interactive ssh command, so it is not, and without the source the runner starts
// perfectly, listens perfectly, accepts a prompt, and answers every one of them with
// "Not logged in · Please run /login".
const START_SCRIPT = [
	`if [ -S "$2" ] && node -e '${PROBE}' "$2"; then`,
	"  echo already-running",
	"  exit 0",
	"fi",
	'. "$HOME/.config/agent-env"',
	'RUNNER_SOCKET="$2" RUNNER_CWD="$3" RUNNER_PERMISSION_MODE="$4" \\',
	'  setsid nohup node "$1/$5" > "$1/runner.log" 2>&1 < /dev/null &',
	"echo started",
].join("\n");

// installRunner copies the runner into a workspace.
//
// The source is passed in rather than read here, so the caller decides where it comes from: the
// controller reads it from its own deployment, and a test supplies a string.
export async function installRunner(
	target: SshTarget,
	runner: { file: string; source: string },
	ssh: SshRunner,
): Promise<RunnerInstall> {
	const result = await ssh(
		target,
		["sh", "-c", INSTALL_SCRIPT, "sh", RUNNER_DIR, NODE_MODULES, runner.file],
		runner.source,
	);
	if (result.kind === "refused") {
		return { kind: "failed", message: "workspace refused the connection" };
	}
	if (result.kind === "rejected") {
		return { kind: "failed", message: result.message };
	}
	if (result.code !== 0) {
		return {
			kind: "failed",
			message: result.stderr.trim() || "could not install the runner",
		};
	}

	return { kind: "installed" };
}

// runnerSource reads the runner this controller ships.
//
// From disk rather than bundled into the build, so the file sent to a container is the one beside
// the running controller. A copy frozen at build time looks current and is the kind of thing that
// costs an afternoon.
//
// Here rather than beside the provisioning phase that first needed it, because the probe CLI ships
// the same file and had its own spelling of this path. Two spellings of one deployment fact is
// exactly the stale-runner failure this comment warns about, arriving by a different door.
//
// Named by the harness, because the runner is the one part of a harness that is mostly itself: it
// is the only thing that talks to the agent's own API, and a second harness is mostly a second one
// of these.
//
// Cached per file: this runs on every provisioning pass for every workspace.
const cachedRunners = new Map<string, string>();
export function runnerSource(file: string): string {
	const cached = cachedRunners.get(file);
	if (cached !== undefined) {
		return cached;
	}

	const source = readFileSync(join(process.cwd(), "runner", file), "utf8");
	cachedRunners.set(file, source);

	return source;
}

// startRunner launches the runner if it is not already answering.
//
// Idempotent, because a provisioning pass that started a runner and then lost its lease has to be
// able to run again. Starting a second one would leave two processes fighting over one socket and
// two Claude sessions billing the same subscription.
//
// "launched" is not "running". Poll runnerState for that; see RunnerLaunch.
export async function startRunner(
	target: SshTarget,
	input: { file: string; permissionMode: string },
	ssh: SshRunner,
): Promise<RunnerLaunch> {
	const result = await ssh(target, [
		"sh",
		"-c",
		START_SCRIPT,
		"sh",
		RUNNER_DIR,
		RUNNER_SOCKET,
		AGENT_CWD,
		input.permissionMode,
		input.file,
	]);
	if (result.kind !== "ran") {
		return "failed";
	}

	return result.code === 0 ? "launched" : "failed";
}

// runnerState reports whether the socket answers.
//
// Connecting rather than testing for the file, because a socket left behind by a runner that died
// is still a socket. The distinction is the whole question being asked.
export async function runnerState(
	target: SshTarget,
	ssh: SshRunner,
): Promise<RunnerState> {
	const result = await ssh(target, ["node", "-e", PROBE, RUNNER_SOCKET]);
	if (result.kind !== "ran") {
		return "failed";
	}

	return result.code === 0 ? "running" : "stopped";
}

// framer turns a stream of arbitrary chunks into one call per complete JSON line.
//
// Separate and exported because this is where a socket protocol goes wrong quietly. One write does
// not arrive as one read: a long tool input reliably splits across chunks, and several small events
// reliably arrive glued together. Reading each chunk as a message works perfectly until an agent
// does something big, and then drops events with nothing in any log to say so.
//
// A malformed line is dropped rather than thrown. The alternative is tearing down a working
// attachment, and with it the operator's view of a running agent, over one bad event.
export function framer(
	onEvent: (event: RunnerEvent) => void,
): (chunk: string) => void {
	let buffer = "";

	return (chunk: string) => {
		buffer += chunk;
		let cut = buffer.indexOf("\n");
		while (cut !== -1) {
			const line = buffer.slice(0, cut);
			buffer = buffer.slice(cut + 1);
			if (line.trim() !== "") {
				try {
					const event = readEvent(JSON.parse(line));
					if (event !== undefined) {
						onEvent(event);
					}
				} catch {
					// Dropped on purpose. See above.
				}
			}
			cut = buffer.indexOf("\n");
		}
	};
}

// EXCHANGE_SCRIPT sends what arrives on stdin and reads until the runner hangs up.
//
// The message goes in on stdin rather than as an argument, which is this codebase's standing rule
// and matters more than usual here: a prompt is operator text that may contain anything at all.
//
// It used to be `nc -U "$1" | head -1`, and that was wrong in a way that took an hour of an agent
// being re-briefed every five seconds to notice. A connection receives broadcasts from the moment
// it opens, so a prompt's own "status: working" broadcast reliably arrives *before* the snapshot
// asked for behind it. The first line back was the broadcast, the caller read it as a failed
// delivery, and provisioning retried a prompt that had in fact landed — forty-one times.
//
// The runner now closes the connection after a one-shot snapshot, so reading to end of stream
// terminates on its own and the reply is picked out of whatever arrived rather than assumed to be
// first. `timeout` bounds a runner that answers nothing at all.
const EXCHANGE_SCRIPT = `timeout 15 nc -U "$1"`;

// exchange sends messages to a runner and reads its reply.
//
// The reply is always a snapshot, and the trick is that it is asked for *after* the message it is
// confirming. The runner handles lines in the order they arrive, so a snapshot that comes back
// after a prompt already reflects that prompt. One round trip, and a real confirmation rather than
// a hopeful write.
async function exchange(
	target: SshTarget,
	messages: RunnerRequest[],
	ssh: SshRunner,
): Promise<RunnerSnapshot | undefined> {
	const payload = `${[...messages, { type: "snapshot" } as RunnerRequest]
		.map((message) => JSON.stringify(message))
		.join("\n")}\n`;

	const result = await ssh(
		target,
		["sh", "-c", EXCHANGE_SCRIPT, "sh", RUNNER_SOCKET],
		payload,
	);
	if (result.kind !== "ran" || result.code !== 0) {
		return undefined;
	}

	// The reply, found rather than assumed. Broadcasts for this caller's own message can be
	// interleaved ahead of it, which is the whole reason the runner closes the connection.
	for (const line of result.stdout.split("\n")) {
		if (line.trim() === "") {
			continue;
		}

		try {
			const event = readEvent(JSON.parse(line));
			if (event?.type === "snapshot") {
				return event;
			}
		} catch {
			// A truncated or malformed line. Keep looking: the reply may still be behind it.
		}
	}

	return undefined;
}

// runnerTranscriptLength reports how much the agent has been told and has said.
//
// Zero means a runner nobody has spoken to yet, which is the only state in which briefing it is
// the right thing to do. Anything else means the briefing already landed, whatever the pass that
// sent it was told afterwards.
export async function runnerTranscriptLength(
	target: SshTarget,
	ssh: SshRunner,
): Promise<number> {
	return (await exchange(target, [], ssh))?.messages.length ?? 0;
}

// promptRunner delivers one prompt and confirms the runner took it.
//
// Used for the briefing and for every prompt typed into the page. Confirmed rather than assumed:
// writing and closing would report success for a prompt that never reached a generator, and the
// workspace would be marked ready having been told nothing.
export async function promptRunner(
	target: SshTarget,
	text: string,
	ssh: SshRunner,
): Promise<"failed" | "sent"> {
	const snapshot = await exchange(target, [{ text, type: "prompt" }], ssh);

	// "working" is the proof. A runner that took a prompt is working on it by the time it answers
	// the attach behind it.
	return snapshot?.status === "working" ? "sent" : "failed";
}

// decideRunner allows or denies one tool call the agent is suspended on.
//
// Confirmed by the request no longer being pending in the snapshot that follows it. An operator who
// clicked Allow and saw nothing happen otherwise has no way to tell a lost write from a slow agent.
export async function decideRunner(
	target: SshTarget,
	id: string,
	behavior: "allow" | "deny",
	ssh: SshRunner,
): Promise<"failed" | "sent"> {
	const snapshot = await exchange(
		target,
		[{ behavior, id, type: "decide" }],
		ssh,
	);
	if (snapshot === undefined) {
		return "failed";
	}

	return snapshot.approvals.some((approval) => approval.id === id)
		? "failed"
		: "sent";
}

// RunnerReading is what one look at a workspace's runner tells us.
//
// Two facts from one round trip, because the snapshot already carries both. Asking separately
// would be a second ssh per workspace per pass for a value that was already on the wire.
export type RunnerReading = {
	status: RunnerStatus | "unknown";
	title?: string;
};

// runnerReading asks one runner what its agent is doing, and what it calls itself.
//
// An exchange with nothing to send: `exchange` asks for a snapshot behind whatever it is given, so
// given nothing it is a bare status probe. This used to be its own script, ssh call, parse and
// error handling — four copies of what the other two calls already do, differing only in putting
// the attach in a printf instead of on stdin.
//
// "unknown" for anything that does not answer, and the word is load-bearing: the reaper refuses to
// destroy a workspace it cannot inspect, so a failed reading must never be read as an idle one.
export async function runnerReading(
	target: SshTarget,
	ssh: SshRunner,
): Promise<RunnerReading> {
	const snapshot = await exchange(target, [], ssh);

	return { status: snapshot?.status ?? "unknown", title: snapshot?.title };
}

// RunnerAttachment is a live connection to one workspace's runner.
export type RunnerAttachment = {
	close: () => void;
	send: (message: RunnerRequest) => void;
};

// attachRunner opens a long-lived connection to a workspace's runner.
//
// `nc -U` rather than a port forward, because it needs nothing on the controller and nothing
// configured on the workspace: OpenBSD netcat is already in the template, and ssh is already the
// only way in. The whole transport is one process per attached page.
//
// Newline-delimited JSON, framed here rather than by the caller: one write does not arrive as one
// read on a socket, and a long tool input reliably splits.
export function attachRunner(
	target: SshTarget,
	handlers: {
		onClose: () => void;
		onEvent: (event: RunnerEvent) => void;
	},
): RunnerAttachment {
	const ssh = spawn(
		"ssh",
		[
			"-i",
			target.keyPath,
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			`UserKnownHostsFile=${knownHostsPath(target.keyPath)}`,
			"-o",
			"LogLevel=ERROR",
			`${target.user}@${target.address}`,
			"--",
			`nc -U ${RUNNER_SOCKET}`,
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);

	const frames = framer(handlers.onEvent);
	ssh.stdout.setEncoding("utf8");
	ssh.stdout.on("data", (chunk: string) => frames(chunk));

	ssh.on("close", handlers.onClose);
	ssh.on("error", handlers.onClose);
	// Without this a controller writing to a closed connection takes the process down.
	ssh.stdin.on("error", () => undefined);

	return {
		close: () => {
			if (!ssh.killed) {
				ssh.kill("SIGHUP");
			}
		},
		send: (message) => {
			if (ssh.stdin.writable) {
				ssh.stdin.write(`${JSON.stringify(message)}\n`);
			}
		},
	};
}
