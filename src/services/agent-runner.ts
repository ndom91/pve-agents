import { spawn } from "node:child_process";

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
	'cat > "$1/agent-runner.mjs"',
].join("\n");

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
	'if [ -S "$2" ] && node -e \'require("net").connect(process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))\' "$2"; then',
	"  echo already-running",
	"  exit 0",
	"fi",
	'. "$HOME/.config/agent-env"',
	'RUNNER_SOCKET="$2" RUNNER_CWD="$3" RUNNER_PERMISSION_MODE="$4" \\',
	'  setsid nohup node "$1/agent-runner.mjs" > "$1/runner.log" 2>&1 < /dev/null &',
	"echo started",
].join("\n");

// installRunner copies the runner into a workspace.
//
// The source is passed in rather than read here, so the caller decides where it comes from: the
// controller reads it from its own deployment, and a test supplies a string.
export async function installRunner(
	target: SshTarget,
	source: string,
	ssh: SshRunner,
): Promise<RunnerInstall> {
	const result = await ssh(
		target,
		["sh", "-c", INSTALL_SCRIPT, "sh", RUNNER_DIR, NODE_MODULES],
		source,
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

// startRunner launches the runner if it is not already answering.
//
// Idempotent, because a provisioning pass that started a runner and then lost its lease has to be
// able to run again. Starting a second one would leave two processes fighting over one socket and
// two Claude sessions billing the same subscription.
//
// "launched" is not "running". Poll runnerState for that; see RunnerLaunch.
export async function startRunner(
	target: SshTarget,
	permissionMode: string,
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
		permissionMode,
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
	const result = await ssh(target, [
		"node",
		"-e",
		'require("net").connect(process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))',
		RUNNER_SOCKET,
	]);
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
	onEvent: (event: unknown) => void,
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
					onEvent(JSON.parse(line));
				} catch {
					// Dropped on purpose. See above.
				}
			}
			cut = buffer.indexOf("\n");
		}
	};
}

// RunnerAttachment is a live connection to one workspace's runner.
export type RunnerAttachment = {
	close: () => void;
	send: (message: unknown) => void;
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
		onEvent: (event: unknown) => void;
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
