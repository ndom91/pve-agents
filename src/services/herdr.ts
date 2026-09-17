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
	input: { cwd: string; env: Record<string, string>; label: string },
	ssh: SshRunner,
): Promise<HerdrWorkspace> {
	const env = Object.entries(input.env).flatMap(([key, value]) => [
		"--env",
		`${key}=${value}`,
	]);
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
			...env,
		],
		ssh,
		Object.values(input.env),
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

// readHerdrAgent snapshots what an agent's pane is showing.
export async function readHerdrAgent(
	target: HerdrTarget,
	name: string,
	ssh: SshRunner,
): Promise<HerdrPane> {
	const result = await run(
		target,
		["agent", "read", name, "--source", "detection", "--format", "text"],
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
	secrets: string[] = [],
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
		return { kind: "failed", message: redact(result.message, secrets) };
	}
	if (result.code === 0) {
		return { kind: "ok", stdout: result.stdout };
	}

	const failure = redact(message(result.stderr, result.stdout), secrets);

	return result.code === 2
		? { kind: "rejected", message: failure }
		: { kind: "failed", message: failure };
}

// redact removes injected credentials from anything that becomes an operator-visible message.
//
// Herdr echoes the failing command in its errors, and these messages are appended to the workspace
// timeline the UI renders. Scrubbing at the boundary is the only place that covers every caller.
function redact(value: string, secrets: string[]): string {
	return secrets.reduce(
		(scrubbed, secret) =>
			secret === "" ? scrubbed : scrubbed.split(secret).join("[redacted]"),
		value,
	);
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
