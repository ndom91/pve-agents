import type { SshRunner, SshTarget } from "./ssh";

// HerdrTarget addresses one workspace's named Herdr server.
//
// The session name is part of the address, not a preference: IDs and agent names are scoped to a
// single server, so a command that forgets it silently operates on a different session.
export type HerdrTarget = {
	session: string;
	ssh: SshTarget;
};

// HerdrServerState is whether a named session has a server to talk to.
//
// "stopped" is not a failure. A freshly booted workspace has no server until one is started, which
// is the ordinary case rather than something to give up on.
export type HerdrServerState =
	| { kind: "failed"; message: string }
	| { kind: "running" }
	| { kind: "stopped" };

// HerdrWorkspace is the result of creating a workspace on a Herdr server.
export type HerdrWorkspace =
	| {
			cwd: string;
			kind: "created";
			paneId: string;
			tabId: string;
			workspaceId: string;
	  }
	| { kind: "failed"; message: string }
	| { kind: "rejected"; message: string };

// HerdrAgent is the result of starting a coding agent in an existing pane.
//
// "not-ready" is Herdr's agent_not_ready: the agent was blocked during startup but the name still
// resolves, so it can be read and answered. Restarting it would be wrong.
export type HerdrAgent =
	| { kind: "failed"; message: string }
	| { kind: "not-ready" }
	| { kind: "rejected"; message: string }
	| { kind: "started" };

// HerdrPane is a snapshot of what a pane is currently showing.
export type HerdrPane =
	| { kind: "failed"; message: string }
	| { kind: "read"; text: string };

// AGENT_NAME is Herdr's own constraint on live agent names.
//
// Enforced here because Herdr rejects a bad name at `agent start`, which is after the container,
// the session, and the workspace all exist. Failing earlier costs nothing; failing there wastes a
// full provision.
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

// AGENT_START_TIMEOUT_MS bounds Herdr's own wait for the agent to become interactive. Herdr caps
// this at 300000 and defaults to 30000; Claude Code's first run does more work than that allows.
const AGENT_START_TIMEOUT_MS = 90_000;

// herdrAgentName accepts a hostname as an agent name only if Herdr will.
export function herdrAgentName(hostname: string): string | undefined {
	return AGENT_NAME.test(hostname) ? hostname : undefined;
}

// herdrServerState reports whether the named session's server is up.
export async function herdrServerState(
	target: HerdrTarget,
	ssh: SshRunner,
): Promise<HerdrServerState> {
	const result = await run(target, ["status"], ssh);
	if (result.kind !== "ok") {
		return { kind: "failed", message: result.message };
	}

	// `herdr status` prints a client block and a server block, and reports a missing server as
	// "status: not running" with exit 0 rather than as an error.
	return /^\s*status:\s*running\s*$/m.test(result.stdout)
		? { kind: "running" }
		: { kind: "stopped" };
}

// HerdrServerStart is whether the launch command itself was accepted.
//
// "started" does not mean the socket is listening. The caller confirms that with herdrServerState,
// because the server needs a moment to bind and there is nothing useful to assume in between.
export type HerdrServerStart =
	| { kind: "failed"; message: string }
	| { kind: "started" };

// DETACH launches the server so that it outlives the SSH connection that spawned it.
//
// Two things are load-bearing and neither is obvious. setsid detaches the process group, without
// which the server dies with the session. The redirections detach its streams: SSH waits for the
// channel to close, so a backgrounded child still holding stdout would hang this command until the
// server exited, which is to say forever.
//
// The script is a fixed string and the session name arrives as a positional argument, so nothing
// the caller supplies is ever parsed as shell.
const DETACH =
	'setsid herdr --session "$1" server </dev/null >"$HOME/herdr-server.log" 2>&1 & exit 0';

// startHerdrServer launches the headless server for the named session.
export async function startHerdrServer(
	target: HerdrTarget,
	ssh: SshRunner,
): Promise<HerdrServerStart> {
	const result = await ssh(target.ssh, [
		"sh",
		"-c",
		DETACH,
		"sh",
		target.session,
	]);
	if (result.kind === "refused") {
		return { kind: "failed", message: "workspace refused the connection" };
	}
	if (result.kind === "rejected") {
		return { kind: "failed", message: result.message };
	}

	return result.code === 0
		? { kind: "started" }
		: { kind: "failed", message: message(result.stderr, result.stdout) };
}

// createHerdrWorkspace creates a workspace rooted at cwd, with env available to its panes.
//
// The requested cwd is compared against the one Herdr echoes back because a cwd that does not
// exist is ignored *silently*: the command still exits 0 and reports success, having quietly used
// the home directory instead. The exit status proves nothing on its own.
export async function createHerdrWorkspace(
	target: HerdrTarget,
	input: { cwd: string; label: string },
	ssh: SshRunner,
): Promise<HerdrWorkspace> {
	// No --env. Herdr supports it and this used it at first, but an --env argument is visible in
	// the workspace's process list for as long as the command runs. Credentials are written to a
	// file the pane's shell sources instead, during bootstrap.
	const result = await run(
		target,
		[
			"workspace",
			"create",
			"--cwd",
			input.cwd,
			"--label",
			input.label,
			"--no-focus",
		],
		ssh,
	);
	if (result.kind !== "ok") {
		return { kind: result.kind, message: result.message };
	}

	const body = payload(result.stdout);
	if (body === undefined) {
		return {
			kind: "failed",
			message: "herdr returned unreadable workspace JSON",
		};
	}

	const pane = record(body.root_pane);
	const workspace = record(body.workspace);
	const tab = record(body.tab);
	const cwd = text(pane?.cwd);
	const paneId = text(pane?.pane_id);
	const tabId = text(tab?.tab_id);
	const workspaceId = text(workspace?.workspace_id);
	if (
		cwd === undefined ||
		paneId === undefined ||
		tabId === undefined ||
		workspaceId === undefined
	) {
		return {
			kind: "failed",
			message: "herdr omitted the created workspace IDs",
		};
	}
	if (cwd !== input.cwd) {
		return {
			kind: "rejected",
			message: `herdr placed the workspace in ${cwd} rather than ${input.cwd}`,
		};
	}

	return { cwd, kind: "created", paneId, tabId, workspaceId };
}

// startHerdrAgent starts a supported agent in an existing pane.
export async function startHerdrAgent(
	target: HerdrTarget,
	input: { agentKind: string; name: string; paneId: string },
	ssh: SshRunner,
): Promise<HerdrAgent> {
	const result = await run(
		target,
		[
			"agent",
			"start",
			input.name,
			"--kind",
			input.agentKind,
			"--pane",
			input.paneId,
			"--timeout",
			String(AGENT_START_TIMEOUT_MS),
		],
		ssh,
	);
	if (result.kind === "ok") {
		return { kind: "started" };
	}
	if (result.kind === "rejected") {
		return { kind: "rejected", message: result.message };
	}
	// Already ours. The name is derived from this workspace and the server hosts nothing else, so
	// a taken name means an earlier pass started the agent and lost its release. Starting again
	// would be wrong; the caller inspects what is there instead.
	if (result.message.includes("agent_name_taken")) {
		return { kind: "started" };
	}

	return result.message.includes("agent_not_ready")
		? { kind: "not-ready" }
		: { kind: "failed", message: result.message };
}

// HerdrAgentState is a live agent's lifecycle state, as Herdr classifies it.
export type HerdrAgentState =
	| { kind: "failed"; message: string }
	| { kind: "found"; status: string };

// herdrAgentStatus reads whether an agent is idle, working, blocked, or unrecognised.
//
// Worth asking separately from the pane text: "blocked" names an approval or question dialog that
// no amount of retrying clears, whichever dialog it happens to be, and catches gates this
// controller has never seen.
export async function herdrAgentStatus(
	target: HerdrTarget,
	name: string,
	ssh: SshRunner,
): Promise<HerdrAgentState> {
	const result = await run(target, ["agent", "get", name], ssh);
	if (result.kind !== "ok") {
		return { kind: "failed", message: result.message };
	}

	const status = text(record(payload(result.stdout)?.agent)?.agent_status);

	return status === undefined
		? { kind: "failed", message: "herdr omitted the agent status" }
		: { kind: "found", status };
}

// HerdrPrompt is what happened to a prompt handed to an agent.
//
// "blocked" is its own outcome rather than a failure. Herdr refuses a prompt to an agent sitting
// at a dialog, before sending anything, and that is not a fault: it is the agent waiting for an
// answer. A caller needs to tell an operator to answer the question, not that something broke.
export type HerdrPrompt =
	| { kind: "blocked" }
	| { kind: "failed"; message: string }
	| { kind: "submitted" };

// KEYS are the key presses this controller is willing to send.
//
// An allow-list because send-keys writes raw input to a terminal running an agent that holds
// repository write access and a live GitHub token. These exist for one job, answering a dialog.
// A general "type this into the terminal" capability is a different feature with a different risk.
const KEYS = new Set([
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"ctrl+c",
	"down",
	"enter",
	"esc",
	"up",
]);

// herdrKey accepts a key press only if it is one this controller sends.
export function herdrKey(key: string): string | undefined {
	return KEYS.has(key) ? key : undefined;
}

// promptHerdrAgent submits a prompt and returns as soon as it has been written.
//
// Without --wait on purpose. Herdr reports submission rather than completion, and waiting for an
// agent's turn to finish would hold the caller for however long the work takes. What the agent
// does next is already reported by the activity pass.
export async function promptHerdrAgent(
	target: HerdrTarget,
	name: string,
	text: string,
	ssh: SshRunner,
): Promise<HerdrPrompt> {
	const result = await run(target, ["agent", "prompt", name, text], ssh);
	if (result.kind === "ok") {
		return { kind: "submitted" };
	}
	if (result.message.includes("agent_blocked")) {
		return { kind: "blocked" };
	}

	return { kind: "failed", message: result.message };
}

// sendHerdrKeys answers a dialog an agent is waiting at.
export async function sendHerdrKeys(
	target: HerdrTarget,
	name: string,
	key: string,
	ssh: SshRunner,
): Promise<HerdrPrompt> {
	const allowed = herdrKey(key);
	if (allowed === undefined) {
		return {
			kind: "failed",
			message: `${key} is not a key this controller sends`,
		};
	}

	const result = await run(target, ["agent", "send-keys", name, allowed], ssh);

	return result.kind === "ok"
		? { kind: "submitted" }
		: { kind: "failed", message: result.message };
}

// readHerdrAgent snapshots what an agent's pane is showing.
//
// "detection" is the plain-text buffer Herdr classifies agents from, which is the right source for
// deciding whether an agent is usable. "visible" is the rendered viewport, which is the right
// source for showing a human what is on screen.
export async function readHerdrAgent(
	target: HerdrTarget,
	name: string,
	ssh: SshRunner,
	source: "detection" | "visible" = "detection",
): Promise<HerdrPane> {
	const result = await run(
		target,
		["agent", "read", name, "--source", source, "--format", "text"],
		ssh,
	);

	return result.kind === "ok"
		? { kind: "read", text: result.stdout }
		: { kind: "failed", message: result.message };
}

// HerdrCommand separates a Herdr call worth retrying from one that never will be.
//
// "rejected" is exit 2, a CLI syntax error. That means the controller built a command Herdr does
// not accept, which is a bug in this repository and will fail identically on every retry.
type HerdrCommand =
	| { kind: "failed"; message: string }
	| { kind: "ok"; stdout: string }
	| { kind: "rejected"; message: string };

async function run(
	target: HerdrTarget,
	args: string[],
	ssh: SshRunner,
): Promise<HerdrCommand> {
	const result = await ssh(target.ssh, [
		"herdr",
		"--session",
		target.session,
		...args,
	]);
	if (result.kind === "refused") {
		return { kind: "failed", message: "workspace refused the connection" };
	}
	if (result.kind === "rejected") {
		return { kind: "failed", message: result.message };
	}
	if (result.code === 0) {
		return { kind: "ok", stdout: result.stdout };
	}

	const failure = message(result.stderr, result.stdout);

	return result.code === 2
		? { kind: "rejected", message: failure }
		: { kind: "failed", message: failure };
}

function message(stderr: string, stdout: string): string {
	return stderr.trim() || stdout.trim() || "herdr failed without output";
}

// payload reads the `result` object Herdr wraps every successful CLI response in.
function payload(stdout: string): Record<string, unknown> | undefined {
	try {
		return record((JSON.parse(stdout) as { result?: unknown }).result);
	} catch {
		return undefined;
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
