import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import {
	recordWorkspaceActivity,
	recordWorkspaceTitle,
	staleWorkspaceActivity,
} from "../db/workspace-repository";
import { mapActivity, type WorkspaceActivity } from "../domain/workspace";
import { readTitle } from "../domain/workspace-title";
import { runnerReading } from "./agent-runner";
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
			id: workspace.id,
			...(await read(config, keyPath, workspace, ssh)),
		})),
	);

	for (const reading of readings) {
		recordWorkspaceActivity(db, reading, now);
		// The title comes along on every reading, but it is written at most once per workspace:
		// `recordWorkspaceTitle` refuses a row that already has one, which is what stops a
		// generated name overwriting one an operator typed, and what keeps `updated_at` still on a
		// fleet that is not changing.
		const title = readTitle(reading.title);
		if (title !== undefined) {
			recordWorkspaceTitle(db, reading.id, title, now);
		}
	}

	return { observed: readings.length };
}

// read asks one workspace's agent what state it is in, and what it calls itself.
//
// The activity half is asserted rather than inferred. This used to map Herdr's classification of a
// rendered dialog; "blocked" now means a callback inside the SDK is genuinely suspended waiting for
// a person. The reaper's refusal to destroy a blocked agent rests on it, so the difference is worth
// more than it looks.
//
// The title rides along because the snapshot already carries it. Asking for it separately would
// double the SSH connections this pass makes for a value that was already on the wire.
async function read(
	config: ControllerConfig,
	keyPath: string,
	workspace: { hostname: string; ip: string },
	ssh: SshRunner,
): Promise<{ activity: WorkspaceActivity; title?: string }> {
	const reading = await runnerReading(
		{ address: workspace.ip, keyPath, user: config.WORKSPACE_SSH_USER },
		ssh,
	);

	return { activity: mapActivity(reading.status), title: reading.title };
}
