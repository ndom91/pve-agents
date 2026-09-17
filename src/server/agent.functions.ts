import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
	recordWorkspaceInteraction,
	recordWorkspaceNote,
	workspaceDetail,
} from "../db/workspace-repository";
import type { HerdrTarget } from "../services/herdr";
import {
	herdrAgentName,
	promptHerdrAgent,
	readHerdrAgent,
	sendHerdrKeys,
} from "../services/herdr";
import { runSsh } from "../services/ssh";
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
		);

		return pane.kind === "read"
			? { kind: "screen", text: pane.text }
			: { kind: "unavailable", reason: pane.message };
	});

// AgentTarget is a workspace that can be spoken to, or the reason it cannot.
type AgentTarget =
	| { kind: "ready"; name: string; target: HerdrTarget }
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
