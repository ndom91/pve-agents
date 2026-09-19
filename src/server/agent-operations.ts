import {
	recordUnsavedWork,
	recordWorkspaceInteraction,
	recordWorkspaceNote,
	workspaceDetail,
} from "../db/workspace-repository";
import { AGENT_CWD } from "../domain/workspace-layout";
import { decideRunner, promptRunner } from "../services/agent-runner";
import type { HerdrTarget } from "../services/herdr";
import {
	herdrAgentName,
	promptHerdrAgent,
	readHerdrAgent,
	sendHerdrKeys,
} from "../services/herdr";
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
	fileSides,
	workspaceBranch,
} from "../services/workspace-changes";
import { workspaceUnsavedWork } from "../services/workspace-git";
import { controllerDatabase, controllerRuntimeConfig } from "./controller";

// sendRunnerPrompt gives a runner-backed agent its next turn.
//
// A connection per prompt rather than a held one. The page already holds an attachment for reading;
// a second, shared, writable one would have to be kept alive across reloads and reconnections for
// something that happens when a person types a paragraph.
async function sendRunnerPrompt(id: string, text: string): Promise<AgentInput> {
	const target = runnerTarget(id);
	if (target.kind === "unavailable") {
		return target;
	}

	if ((await promptRunner(target.ssh, text)) === "failed") {
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
	const target = runnerTarget(id);
	if (target.kind === "unavailable") {
		return target;
	}

	if ((await decideRunner(target.ssh, approvalId, behavior)) === "failed") {
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

// RunnerTarget is a workspace whose runner can be reached, or why it cannot.
type RunnerTarget =
	| { kind: "ready"; ssh: SshTarget }
	| { kind: "unavailable"; reason: string };

// runnerTarget resolves a workspace to its runner, refusing anything half-built.
//
// The same three checks agentTarget makes and deliberately separate from it: that one resolves a
// Herdr agent name, which a runner-backed workspace does not have and must not be refused for
// lacking.
function runnerTarget(id: string): RunnerTarget {
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
	// Separate from the status check for the reason recorded on agentTarget: a ready workspace with
	// no address once reported "workspace is ready, not ready".
	if (workspace.ip === undefined) {
		return { kind: "unavailable", reason: "workspace has no address" };
	}

	const keyPath = config.WORKSPACE_SSH_KEY_PATH;
	if (keyPath === undefined) {
		return { kind: "unavailable", reason: "no agent to reach" };
	}

	return {
		kind: "ready",
		ssh: {
			address: workspace.ip,
			keyPath,
			user: config.WORKSPACE_SSH_USER,
		},
	};
}

// WorkspacePane is the agent's screen, or the reason it could not be read.
export type WorkspacePane =
	| { kind: "screen"; text: string }
	| { kind: "unavailable"; reason: string };

// readWorkspacePane is the handler above, as an ordinary function.
export async function readWorkspacePane(id: string): Promise<WorkspacePane> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return agent;
	}

	const pane = await readHerdrAgent(
		agent.target,
		agent.name,
		runSsh,
		"visible",
		"ansi",
	);

	return pane.kind === "read"
		? { kind: "screen", text: pane.text }
		: { kind: "unavailable", reason: pane.message };
}

// AgentTarget is a workspace that can be spoken to, or the reason it cannot.
type AgentTarget =
	| { hostname: string; kind: "ready"; name: string; target: HerdrTarget }
	| { kind: "unavailable"; reason: string };

// agentTarget resolves a workspace to its live agent, refusing anything not fully provisioned.
//
// Every operator-driven call goes through this, so the guard cannot be forgotten on the next one
// added. Refusing before any connection is attempted keeps these endpoints from being usable to
// probe half-built containers.
function agentTarget(id: string): AgentTarget {
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
	// afternoon to. It is reachable: a record can carry the status without the address after a
	// restore, or after a write that landed in pieces.
	if (workspace.ip === undefined) {
		return { kind: "unavailable", reason: "workspace has no address" };
	}

	const name = herdrAgentName(workspace.hostname);
	const keyPath = config.WORKSPACE_SSH_KEY_PATH;
	if (name === undefined || keyPath === undefined) {
		return { kind: "unavailable", reason: "no agent to reach" };
	}

	return {
		hostname: workspace.hostname,
		kind: "ready",
		name,
		target: {
			session: config.WORKSPACE_HERDR_SESSION,
			ssh: {
				address: workspace.ip,
				keyPath,
				user: config.WORKSPACE_SSH_USER,
			},
		},
	};
}

// AgentInput is what happened to something an operator sent the agent.
export type AgentInput =
	| { kind: "blocked" }
	| { kind: "sent" }
	| { kind: "unavailable"; reason: string };

export async function sendAgentPrompt(
	id: string,
	text: string,
): Promise<AgentInput> {
	if (controllerRuntimeConfig().WORKSPACE_AGENT_RUNNER === "sdk") {
		return await sendRunnerPrompt(id, text);
	}

	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return agent;
	}

	const prompted = await promptHerdrAgent(
		agent.target,
		agent.name,
		text,
		runSsh,
	);
	if (prompted.kind === "blocked") {
		return { kind: "blocked" };
	}
	if (prompted.kind === "failed") {
		return { kind: "unavailable", reason: prompted.message };
	}

	// Truncated: a prompt may run to thousands of characters and the timeline shows one line.
	recordWorkspaceNote(
		controllerDatabase(),
		id,
		"workspace.prompted",
		text.length > 160 ? `${text.slice(0, 160)}...` : text,
	);
	// The reaper's idle clock. Without this it runs on sampled activity alone, which misses any
	// turn shorter than the observation interval.
	recordWorkspaceInteraction(controllerDatabase(), id);

	return { kind: "sent" };
}

export async function sendAgentKeys(
	id: string,
	key: string,
): Promise<AgentInput> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return agent;
	}

	// The allow-list lives in the adapter, so a key is checked before it reaches Herdr whether it
	// arrived from here or from anywhere else.
	const sent = await sendHerdrKeys(agent.target, agent.name, key, runSsh);
	if (sent.kind !== "submitted") {
		return {
			kind: "unavailable",
			reason: sent.kind === "blocked" ? "agent is blocked" : sent.message,
		};
	}

	recordWorkspaceNote(
		controllerDatabase(),
		id,
		"workspace.answered",
		`sent ${key}`,
	);
	recordWorkspaceInteraction(controllerDatabase(), id);

	return { kind: "sent" };
}

export async function readWorkspaceChanges(id: string): Promise<ChangedFiles> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return { kind: "failed", message: agent.reason };
	}

	const changes = await changedFiles(agent.target.ssh, AGENT_CWD, runSsh);
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

	return fileSides(agent.target.ssh, AGENT_CWD, path, runSsh);
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
		agent.target.ssh,
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
		await settleUnsavedWork(agent.target.ssh, id);
	}

	return pushed;
}

export async function discardWorkspaceWork(id: string): Promise<ChangeAction> {
	const agent = agentTarget(id);
	if (agent.kind === "unavailable") {
		return { kind: "failed", message: agent.reason };
	}

	const discarded = await discardChanges(agent.target.ssh, AGENT_CWD, runSsh);
	if (discarded.kind === "done") {
		// Recorded because a workspace that later looks empty should say in its own history why it
		// is, rather than leaving someone to wonder what the agent did with its afternoon.
		recordWorkspaceNote(
			controllerDatabase(),
			id,
			"workspace.discarded",
			"discarded all uncommitted changes in the working tree",
		);
		await settleUnsavedWork(agent.target.ssh, id);
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
