import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import {
	recordWorkspaceActivity,
	staleWorkspaceActivity,
} from "../db/workspace-repository";
import type { WorkspaceActivity } from "../domain/workspace";
import { runnerStatus } from "./agent-runner";
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
	const workspaces = staleWorkspaceActivity(db, staleBefore, ACTIVITY_BATCH);

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
//
// Asserted rather than inferred. This used to map Herdr's classification of a rendered dialog;
// "blocked" now means a callback inside the SDK is genuinely suspended waiting for a person. The
// reaper's refusal to destroy a blocked agent rests on it, so the difference is worth more than it
// looks.
async function readActivity(
	config: ControllerConfig,
	keyPath: string,
	workspace: { hostname: string; ip: string },
	ssh: SshRunner,
): Promise<WorkspaceActivity> {
	return mapActivity(
		await runnerStatus(
			{ address: workspace.ip, keyPath, user: config.WORKSPACE_SSH_USER },
			ssh,
		),
	);
}

// mapActivity translates a runner's status into the four states the controller reports.
//
// Exported because the agent stream observes the same states far more often than this pass does,
// and a second copy of this mapping is a way for the two to disagree.
//
// "done" is still accepted alongside "idle" because Herdr used to report both and a database
// restored from that era can hold either; they meant the same thing. "unknown" is passed through
// rather than flattened into idle, which is the rule the reaper depends on: a status nobody could
// read is not evidence that anything finished.
export function mapActivity(status: string): WorkspaceActivity {
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
