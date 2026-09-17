import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceDetail } from "../db/workspace-repository";
import { herdrAgentName, readHerdrAgent } from "../services/herdr";
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
		const config = controllerRuntimeConfig();
		const workspace = workspaceDetail(controllerDatabase(), data.id);
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
			return { kind: "unavailable", reason: "no agent to read" };
		}

		const pane = await readHerdrAgent(
			{
				session: config.WORKSPACE_HERDR_SESSION,
				ssh: {
					address: workspace.ip,
					keyPath,
					user: config.WORKSPACE_SSH_USER,
				},
			},
			name,
			runSsh,
			"visible",
		);

		return pane.kind === "read"
			? { kind: "screen", text: pane.text }
			: { kind: "unavailable", reason: pane.message };
	});
