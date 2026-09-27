import {
	recordUnsavedWork,
	recordWorkspaceInteraction,
	recordWorkspaceNote,
	workspaceDetail,
} from "../db/workspace-repository";
import type { ListeningPort } from "../domain/port";
import { AGENT_CWD } from "../domain/workspace-layout";
import { decideRunner, promptRunner } from "../services/agent-runner";
import {
	forwardsFor,
	startForward,
	stopForward,
} from "../services/port-forward";
import { runSsh, type SshTarget } from "../services/ssh";
import type {
	ChangeAction,
	ChangedFiles,
	FileSides,
} from "../services/workspace-changes";
import {
	changedFiles,
	commitAndPush,
	discardChanges,
	discardFile,
	fileSides,
	workspaceBranch,
} from "../services/workspace-changes";
import { workspaceUnsavedWork } from "../services/workspace-git";
import { listeningPorts } from "../services/workspace-ports";
import { controllerDatabase, controllerRuntimeConfig } from "./controller";

// answerApproval allows or denies one tool call an agent is suspended on.
//
// The decision the whole refactor exists for. Under Herdr this was a keystroke aimed at a rendered
// dialog, with no way to know which call it answered or whether it landed; here it names a request
// the runner is genuinely holding a promise for.
export async function answerApproval(
	id: string,
	approvalId: string,
	behavior: "allow" | "deny",
): Promise<AgentInput> {
	const target = agentTarget(id);
	if (target.kind === "unavailable") {
		return target;
	}

	if (
		(await decideRunner(target.ssh, approvalId, behavior, runSsh)) === "failed"
	) {
		return { kind: "unavailable", reason: "the agent runner did not answer" };
	}

	recordWorkspaceNote(
		controllerDatabase(),
		id,
		"workspace.answered",
		behavior === "allow" ? "allowed a tool call" : "declined a tool call",
	);
	recordWorkspaceInteraction(controllerDatabase(), id);

	return { kind: "sent" };
}

// AgentTarget is a workspace that can be spoken to, or the reason it cannot.
export type AgentTarget =
	| { hostname: string; kind: "ready"; ssh: SshTarget }
	| { kind: "unavailable"; reason: string };

// agentTarget resolves a workspace to something reachable, refusing anything half-built.
//
// Every operator-driven call goes through this, so the guard cannot be forgotten on the next one
// added. Refusing before any connection is attempted keeps these endpoints from being usable to
// probe half-built containers.
export function agentTarget(id: string): AgentTarget {
	const config = controllerRuntimeConfig();
	const workspace = workspaceDetail(controllerDatabase(), id);
	if (workspace === undefined) {
		return { kind: "unavailable", reason: "workspace not found" };
	}
	if (workspace.status !== "ready") {
		return {
			kind: "unavailable",
			reason: `workspace is ${workspace.status}, not ready`,
		};
	}
	// Separate from the status check, which it used to share. A ready workspace with no address
	// reported "workspace is ready, not ready", which is the kind of message somebody loses an
	// afternoon to.
	if (workspace.ip === undefined) {
		return { kind: "unavailable", reason: "workspace has no address" };
	}

	const keyPath = config.WORKSPACE_SSH_KEY_PATH;
	if (keyPath === undefined) {
		return { kind: "unavailable", reason: "no agent to reach" };
	}

	return {
		hostname: workspace.hostname,
		kind: "ready",
		ssh: {
			address: workspace.ip,
			keyPath,
			user: config.WORKSPACE_SSH_USER,
		},
	};
}

// AgentInput is what happened to something an operator sent the agent.
export type AgentInput =
	| { kind: "sent" }
	| { kind: "unavailable"; reason: string };

// sendAgentPrompt gives the agent its next turn.
//
// A connection per prompt rather than a held one. The page already holds an attachment for reading;
// a second, shared, writable one would have to be kept alive across reloads and reconnections for
// something that happens when a person types a paragraph.
export async function sendAgentPrompt(
	id: string,
	text: string,
): Promise<AgentInput> {
	const target = agentTarget(id);
	if (target.kind === "unavailable") {
		return target;
	}

	if ((await promptRunner(target.ssh, text, runSsh)) === "failed") {
		return { kind: "unavailable", reason: "the agent runner did not answer" };
	}

	// Truncated: a prompt may run to thousands of characters and the timeline shows one line.
	recordWorkspaceNote(
		controllerDatabase(),
		id,
		"workspace.prompted",
		text.length > 160 ? `${text.slice(0, 160)}...` : text,
	);
	recordWorkspaceInteraction(controllerDatabase(), id);

	return { kind: "sent" };
}

// readWorkspacePorts reads what is listening inside one workspace.
//
// The container's own address travels back with the list, because a row for a server on 0.0.0.0
// has to become a link and 0.0.0.0 is not somewhere a browser can go. The page has the address
// already, but pairing it with the reading it belongs to keeps a link from being built out of a
// list taken now and an address taken whenever the detail query last ran.
// ForwardedPort is a listener plus where it has been published, when it has been.
//
// `forwarded` is the controller port, and its absence is what the row reads as "not forwarded
// yet". A loopback listener with one becomes an ordinary link.
export type ForwardedPort = ListeningPort & { forwarded?: number };

// WorkspacePortsView is the listing with the address its links have to be built from.
export type WorkspacePortsView =
	| { host: string; ip: string; kind: "listed"; ports: ForwardedPort[] }
	| { kind: "unavailable"; message: string };

// controllerHost is the name a forwarded port is reached by.
//
// The hostname out of CONTROLLER_URL and never its port: the forward is a second listener on the
// same machine, not a path under the application. Falls back to the configured value whole if it
// will not parse, which is worse than a hostname and better than nothing to show.
function controllerHost(): string {
	const configured = controllerRuntimeConfig().CONTROLLER_URL;
	try {
		return new URL(configured).hostname;
	} catch {
		return configured;
	}
}

// forwardWorkspacePort publishes one of a workspace's loopback ports on the controller.
//
// Refuses anything already reachable. Forwarding a 0.0.0.0 listener would publish, with nothing
// in front of it, something the operator can already open directly -- all cost and no gain.
export async function forwardWorkspacePort(
	id: string,
	port: number,
): Promise<
	| { allocated: number; kind: "forwarded" }
	| { kind: "unavailable"; reason: string }
> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return { kind: "unavailable", reason: agent.reason };
	}

	const listed = await listeningPorts(agent.ssh, runSsh);
	if (listed.kind !== "listed") {
		return { kind: "unavailable", reason: listed.message };
	}

	const listener = listed.ports.find((entry) => entry.port === port);
	if (listener === undefined) {
		return { kind: "unavailable", reason: `nothing is listening on ${port}` };
	}
	if (listener.reach === "direct") {
		return {
			kind: "unavailable",
			reason: `${port} is already reachable without a forward`,
		};
	}

	const started = startForward(id, agent.ssh, port);

	return "message" in started
		? { kind: "unavailable", reason: started.message }
		: { allocated: started.allocated, kind: "forwarded" };
}

// unforwardWorkspacePort takes one down.
//
// No check that it exists: stopping a forward that already died is what the operator meant, and
// "there was nothing to stop" helps nobody.
export function unforwardWorkspacePort(id: string, port: number): void {
	stopForward(id, port);
}

export async function readWorkspacePorts(
	id: string,
): Promise<WorkspacePortsView> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return { kind: "unavailable", message: agent.reason };
	}

	const listed = await listeningPorts(agent.ssh, runSsh);
	if (listed.kind !== "listed") {
		return listed;
	}

	// Merged here rather than in the browser, so one answer describes both halves at one moment.
	// A page holding a list from one request and a set of forwards from another can show a Stop
	// button for a tunnel that has already died.
	const published = new Map(
		forwardsFor(id).map((forward) => [forward.port, forward.allocated]),
	);

	return {
		// Where a forwarded port is reached, which is this controller rather than the container.
		// Taken from the request the operator is already talking to, so it is right whether they
		// came by hostname or by address.
		host: controllerHost(),
		ip: agent.ssh.address,
		kind: "listed",
		ports: listed.ports.map((port) => ({
			...port,
			forwarded: published.get(port.port),
		})),
	};
}

export async function readWorkspaceChanges(id: string): Promise<ChangedFiles> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return { kind: "failed", message: agent.reason };
	}

	const changes = await changedFiles(agent.ssh, AGENT_CWD, runSsh);
	// The flag behind the "holding unsaved work" banner, refreshed from a reading that was taken
	// anyway. It encodes exactly what was just fetched — a dirty tree or a commit that is nowhere
	// else — so recording it here costs nothing and stops the banner outliving the work it
	// describes. Only ever updated on a push, a discard, or a reaping pass before this, so a
	// workspace whose flag was set while something was briefly wrong kept claiming to hold work.
	//
	// A stale flag was never dangerous: the reaper re-reads the tree itself before destroying
	// anything, so it errs towards keeping a workspace rather than losing one. It was only a lie
	// on the page.
	if (changes.kind === "changes") {
		recordUnsavedWork(
			controllerDatabase(),
			id,
			changes.files.length > 0 || changes.unpushed > 0,
		);
	}

	return changes;
}

export async function readWorkspaceFile(
	id: string,
	path: string,
): Promise<FileSides> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return { kind: "failed", message: agent.reason };
	}

	return fileSides(agent.ssh, AGENT_CWD, path, runSsh);
}

export async function pushWorkspaceWork(
	id: string,
	message: string,
): Promise<ChangeAction> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return { kind: "failed", message: agent.reason };
	}

	const branch = workspaceBranch(agent.hostname);
	const pushed = await commitAndPush(
		agent.ssh,
		{ branch, cwd: AGENT_CWD, message },
		runSsh,
	);
	if (pushed.kind === "done") {
		recordWorkspaceNote(
			controllerDatabase(),
			id,
			"workspace.pushed",
			`pushed to ${branch}`,
		);
	}
	// Re-checked on "nothing" as well as on "done", because "nothing to push" is itself a reading
	// of the tree and a fresher one than whatever is stored. Without this, a workspace whose flag
	// was set while something was briefly wrong keeps claiming to hold work with no way to correct
	// it short of waiting for a reaping pass to look.
	if (pushed.kind !== "failed") {
		await settleUnsavedWork(agent.ssh, id);
	}

	return pushed;
}

export async function discardWorkspaceWork(id: string): Promise<ChangeAction> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return { kind: "failed", message: agent.reason };
	}

	const discarded = await discardChanges(agent.ssh, AGENT_CWD, runSsh);
	if (discarded.kind === "done") {
		// Recorded because a workspace that later looks empty should say in its own history why it
		// is, rather than leaving someone to wonder what the agent did with its afternoon.
		recordWorkspaceNote(
			controllerDatabase(),
			id,
			"workspace.discarded",
			"discarded all uncommitted changes in the working tree",
		);
		await settleUnsavedWork(agent.ssh, id);
	}

	return discarded;
}

// discardWorkspaceFile throws one file away, leaving the rest of the tree alone.
//
// The whole-tree discard is all an operator had, so an agent that did the work asked of it and
// also left a scratch file behind forced a choice between shipping the scratch file and losing the
// work. This is the same action at the size of the thing it acts on.
export async function discardWorkspaceFileWork(
	id: string,
	path: string,
): Promise<ChangeAction> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return { kind: "failed", message: agent.reason };
	}

	const discarded = await discardFile(agent.ssh, AGENT_CWD, path, runSsh);
	if (discarded.kind === "done") {
		recordWorkspaceNote(
			controllerDatabase(),
			id,
			"workspace.discarded",
			`discarded uncommitted changes to ${path}`,
		);
		// The tree may still hold other files, so this re-reads rather than assuming. Without it the
		// workspace goes on claiming to hold work until a reaping pass happens to look.
		await settleUnsavedWork(agent.ssh, id);
	}

	return discarded;
}

// settleUnsavedWork re-reads the tree after something changed it.
//
// Without this the reaping protection would stay on until the next reaping pass happened to look,
// so a workspace whose work was just pushed would keep claiming to hold it. Also counts as
// interaction: a person acting on a workspace is a reason not to reap it a moment later.
async function settleUnsavedWork(
	ssh: Parameters<typeof workspaceUnsavedWork>[0],
	id: string,
): Promise<void> {
	const db = controllerDatabase();
	recordWorkspaceInteraction(db, id);

	const unsaved = await workspaceUnsavedWork(ssh, AGENT_CWD, runSsh);
	// "unknown" deliberately leaves the flag alone. Clearing it on a reading that failed would
	// convert "could not tell" into "safe to destroy", which is the one conversion the reaper
	// exists to refuse.
	if (unsaved.kind !== "unknown") {
		recordUnsavedWork(db, id, unsaved.kind === "unsaved");
	}
}
