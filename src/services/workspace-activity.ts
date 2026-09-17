import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import {
	recordWorkspaceActivity,
	staleWorkspaceActivity,
} from "../db/workspace-repository";
import type { WorkspaceActivity } from "../domain/workspace";
import { herdrAgentName, herdrAgentStatus } from "./herdr";
import { runSsh, type SshRunner } from "./ssh";

// ACTIVITY_BATCH bounds how many workspaces one pass will contact.
//
// Each costs an SSH connection, and the scheduler awaits the whole pass before its next tick. A
// ceiling here is what keeps a large fleet from turning a five-second loop into a minute of
// reconnecting. Workspaces beyond the batch are simply the oldest next time.
const ACTIVITY_BATCH = 8;

// observeWorkspaceActivity records what the agent in each ready workspace is doing.
//
// Deliberately not an operation: there is no lease, no retry budget, and nothing to resume. A
// reading that fails is just an old reading, and the next pass takes another one.
export async function observeWorkspaceActivity(
	db: Database.Database,
	config: ControllerConfig,
	now: Date = new Date(),
	ssh: SshRunner = runSsh,
): Promise<{ observed: number }> {
	const keyPath = config.WORKSPACE_SSH_KEY_PATH;
	if (keyPath === undefined) {
		return { observed: 0 };
	}

	const staleBefore = new Date(
		now.getTime() - config.WORKSPACE_ACTIVITY_INTERVAL_SECONDS * 1_000,
	).toISOString();
	const workspaces = staleWorkspaceActivity(
		db,
		staleBefore,
		ACTIVITY_BATCH,
	).filter((workspace) => herdrAgentName(workspace.hostname) !== undefined);

	// Concurrently, because these are independent network round trips and the slowest one would
	// otherwise set the pace for all of them. The batch size is the bound.
	const readings = await Promise.all(
		workspaces.map(async (workspace) => ({
			activity: await readActivity(config, keyPath, workspace, ssh),
			id: workspace.id,
		})),
	);

	for (const reading of readings) {
		recordWorkspaceActivity(db, reading, now);
	}

	return { observed: readings.length };
}

// readActivity asks one workspace's agent what state it is in.
async function readActivity(
	config: ControllerConfig,
	keyPath: string,
	workspace: { hostname: string; ip: string },
	ssh: SshRunner,
): Promise<WorkspaceActivity> {
	const state = await herdrAgentStatus(
		{
			session: config.WORKSPACE_HERDR_SESSION,
			ssh: { address: workspace.ip, keyPath, user: config.WORKSPACE_SSH_USER },
		},
		workspace.hostname,
		ssh,
	);

	// A workspace whose Herdr server has died reads as unknown and nothing else happens. No
	// timeline entry: this runs every half minute forever, and a broken workspace would bury its
	// own history under identical rows.
	return state.kind === "failed" ? "unknown" : mapActivity(state.status);
}

// mapActivity translates Herdr's lifecycle states into the four the controller reports.
//
// "idle" and "done" merge because both mean the agent is ready for input; they differ only in
// whether the server has seen the completion, which is a display concern of Herdr's own clients.
// "unknown" is passed through rather than flattened into idle: Herdr defines it as an agent it
// cannot classify, which is not evidence that anything has finished.
function mapActivity(status: string): WorkspaceActivity {
	switch (status) {
		case "working":
			return "active";
		case "blocked":
			return "blocked";
		case "done":
		case "idle":
			return "idle";
		default:
			return "unknown";
	}
}
