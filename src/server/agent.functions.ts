import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
	recordUnsavedWork,
	recordWorkspaceInteraction,
	recordWorkspaceNote,
	workspaceDetail,
} from "../db/workspace-repository";
import { AGENT_CWD } from "../domain/workspace-layout";
import type { HerdrTarget } from "../services/herdr";
import {
	herdrAgentName,
	promptHerdrAgent,
	readHerdrAgent,
	sendHerdrKeys,
} from "../services/herdr";
import { runSsh } from "../services/ssh";
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
import { operatorMiddleware } from "./middleware";

// WorkspacePane is the agent's screen, or the reason it could not be read.
export type WorkspacePane =
	| { kind: "screen"; text: string }
	| { kind: "unavailable"; reason: string };

// workspacePane reads what a workspace's agent is showing right now.
//
// Unlike every other server function here this one opens an SSH connection per call, so it is
// deliberately narrow: it answers only for a workspace that finished provisioning and recorded a
// pane. Anything else is refused before a connection is attempted, which keeps a page refresh from
// becoming a probe against half-built containers.
//
// The screen is the current viewport and nothing more. Claude Code draws on the terminal's
// alternate screen, whose rows never enter Herdr's scrollback, so there is no history to offer and
// asking for more lines would not produce any.
export const workspacePane = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(async ({ data }): Promise<WorkspacePane> => {
		const agent = agentTarget(data.id);
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
	});

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
	if (workspace.status !== "ready" || workspace.ip === undefined) {
		return {
			kind: "unavailable",
			reason: `workspace is ${workspace.status}, not ready`,
		};
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

// promptWorkspaceAgent submits an operator's prompt to a workspace's agent.
export const promptWorkspaceAgent = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(
		z.object({
			id: z.string().trim().min(1),
			text: z.string().trim().min(1).max(10_000),
		}),
	)
	.handler(async ({ data }): Promise<AgentInput> => {
		const agent = agentTarget(data.id);
		if (agent.kind === "unavailable") {
			return agent;
		}

		const prompted = await promptHerdrAgent(
			agent.target,
			agent.name,
			data.text,
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
			data.id,
			"workspace.prompted",
			data.text.length > 160 ? `${data.text.slice(0, 160)}...` : data.text,
		);
		// The reaper's idle clock. Without this it runs on sampled activity alone, which misses
		// any turn shorter than the observation interval.
		recordWorkspaceInteraction(controllerDatabase(), data.id);

		return { kind: "sent" };
	});

// sendWorkspaceKeys answers a dialog the agent is waiting at.
export const sendWorkspaceKeys = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(
		z.object({ id: z.string().trim().min(1), key: z.string().trim().min(1) }),
	)
	.handler(async ({ data }): Promise<AgentInput> => {
		const agent = agentTarget(data.id);
		if (agent.kind === "unavailable") {
			return agent;
		}

		// The allow-list lives in the adapter, so a key is checked before it reaches Herdr whether
		// it arrived from here or from anywhere else.
		const sent = await sendHerdrKeys(
			agent.target,
			agent.name,
			data.key,
			runSsh,
		);
		if (sent.kind !== "submitted") {
			return {
				kind: "unavailable",
				reason: sent.kind === "blocked" ? "agent is blocked" : sent.message,
			};
		}

		recordWorkspaceNote(
			controllerDatabase(),
			data.id,
			"workspace.answered",
			`sent ${data.key}`,
		);
		recordWorkspaceInteraction(controllerDatabase(), data.id);

		return { kind: "sent" };
	});

// workspaceChanges lists what the agent has done to the checkout.
//
// Available whenever a workspace is ready rather than only once the reaper has flagged it. The work
// is the point of the workspace, and waiting for a protection to trip before showing it would mean
// the only way to see finished work is for something to have gone slightly wrong.
export const workspaceChanges = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(async ({ data }): Promise<ChangedFiles> => {
		const agent = agentTarget(data.id);
		if (agent.kind === "unavailable") {
			return { kind: "failed", message: agent.reason };
		}

		return changedFiles(agent.target.ssh, AGENT_CWD, runSsh);
	});

// workspaceFileDiff reads one file as it was and as it is.
export const workspaceFileDiff = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.validator(
		z.object({
			id: z.string().trim().min(1),
			path: z.string().trim().min(1).max(1_024),
		}),
	)
	.handler(async ({ data }): Promise<FileSides> => {
		const agent = agentTarget(data.id);
		if (agent.kind === "unavailable") {
			return { kind: "failed", message: agent.reason };
		}

		return fileSides(agent.target.ssh, AGENT_CWD, data.path, runSsh);
	});

// pushWorkspaceChanges saves everything in the workspace onto a branch of its own.
export const pushWorkspaceChanges = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(
		z.object({
			id: z.string().trim().min(1),
			message: z.string().trim().min(1).max(500),
		}),
	)
	.handler(async ({ data }): Promise<ChangeAction> => {
		const agent = agentTarget(data.id);
		if (agent.kind === "unavailable") {
			return { kind: "failed", message: agent.reason };
		}

		const branch = workspaceBranch(agent.hostname);
		const pushed = await commitAndPush(
			agent.target.ssh,
			{ branch, cwd: AGENT_CWD, message: data.message },
			runSsh,
		);
		if (pushed.kind === "done") {
			recordWorkspaceNote(
				controllerDatabase(),
				data.id,
				"workspace.pushed",
				`pushed to ${branch}`,
			);
			await settleUnsavedWork(agent.target.ssh, data.id);
		}

		return pushed;
	});

// discardWorkspaceChanges throws the working tree away.
//
// The only operator action here that destroys something, and it destroys exactly what the reaper
// refuses to. It stays because the alternative is worse: without it a workspace held by one stray
// scratch file can only be released by opening a terminal, which is the gap this whole view exists
// to close. The confirmation naming the file count lives in the UI; a generic "are you sure" is one
// people learn to dismiss.
export const discardWorkspaceChanges = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(async ({ data }): Promise<ChangeAction> => {
		const agent = agentTarget(data.id);
		if (agent.kind === "unavailable") {
			return { kind: "failed", message: agent.reason };
		}

		const discarded = await discardChanges(agent.target.ssh, AGENT_CWD, runSsh);
		if (discarded.kind === "done") {
			// Recorded because a workspace that later looks empty should say in its own history why
			// it is, rather than leaving someone to wonder what the agent did with its afternoon.
			recordWorkspaceNote(
				controllerDatabase(),
				data.id,
				"workspace.discarded",
				"discarded all uncommitted changes in the working tree",
			);
			await settleUnsavedWork(agent.target.ssh, data.id);
		}

		return discarded;
	});

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
