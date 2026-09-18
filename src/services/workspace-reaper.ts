import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import { controllerSettings } from "../db/settings-repository";
import {
	reapableFailedWorkspaces,
	reapableWorkspaces,
	recordUnsavedWork,
	recordWorkspaceNote,
	requestWorkspaceOperation,
} from "../db/workspace-repository";
import { AGENT_CWD } from "../domain/workspace-layout";
import { runSsh, type SshRunner } from "./ssh";
import { workspaceUnsavedWork } from "./workspace-git";

// ReapReason is which rule decided a workspace had outlived its usefulness.
type ReapReason = { message: string; rule: "idle" | "max-age" };

// Candidate is what the safety check needs, shared by both kinds of reapable workspace.
type Candidate = { hostname: string; id: string; ip?: string };

// reapWorkspaces destroys workspaces that have outlived their usefulness.
//
// It does not delete anything itself. It queues a destroy through the same path the API and the UI
// use, which already verifies ownership before purging and is idempotent. A reaper that removed
// containers directly would be a second destroy implementation with none of those properties.
//
// Off unless switched on, because this removes real containers without being asked.
export async function reapWorkspaces(
	db: Database.Database,
	config: ControllerConfig,
	now: Date = new Date(),
	ssh: SshRunner = runSsh,
): Promise<{ reaped: number }> {
	const settings = controllerSettings(db);
	if (!settings.reapingEnabled) {
		return { reaped: 0 };
	}

	let reaped = 0;
	for (const workspace of reapableWorkspaces(db)) {
		// An agent at a dialog is waiting for a person, and destroying it throws away real work.
		// Exempt from both rules, which does mean a question nobody answers keeps its container
		// alive indefinitely. The fleet view's blocked badge is what stands between that and an
		// LXC running until someone notices.
		if (workspace.activity === "blocked") {
			continue;
		}

		const reason = expiredReason(workspace, settings, now);
		if (reason === undefined) {
			continue;
		}
		if (await heldBack(db, config, workspace, now, ssh)) {
			continue;
		}

		// Written before the operation is queued, so a workspace that vanishes does not end its
		// history at "destroy queued" with nothing to say why.
		recordWorkspaceNote(
			db,
			workspace.id,
			"workspace.reaped",
			reason.message,
			now,
		);
		requestWorkspaceOperation(db, workspace.id, "destroy");
		reaped += 1;
	}

	// A failed workspace keeps its container, and nothing else would ever remove it. Held for a
	// grace period first, because that container is the only copy of whatever went wrong.
	for (const workspace of reapableFailedWorkspaces(db)) {
		const failedAt = workspace.errorOccurredAt ?? workspace.createdAt;
		const heldHours = minutesSince(failedAt, now) / 60;
		if (heldHours < settings.reapFailedAfterHours) {
			continue;
		}
		if (await heldBack(db, config, workspace, now, ssh)) {
			continue;
		}

		recordWorkspaceNote(
			db,
			workspace.id,
			"workspace.reaped",
			`destroyed after failing ${Math.round(heldHours)}h ago, past the ${settings.reapFailedAfterHours}h grace period`,
			now,
		);
		requestWorkspaceOperation(db, workspace.id, "destroy");
		reaped += 1;
	}

	return { reaped };
}

// heldBack decides whether an expired workspace must be kept anyway.
//
// This is the only path in the system that loses something irreversibly. A container is
// reconstructible and a clone re-cloneable; a diff that existed only on that disk is not. So the
// tree is inspected before anything is queued, and anything short of a confident "nothing here" is
// a reason to keep it.
//
// Checked only for a workspace already due to be destroyed, so it costs one connection at the
// moment of reaping rather than a poll across the fleet.
async function heldBack(
	db: Database.Database,
	config: ControllerConfig,
	workspace: Candidate,
	now: Date,
	ssh: SshRunner,
): Promise<boolean> {
	const keyPath = config.WORKSPACE_SSH_KEY_PATH;
	// Nothing to look at. A workspace that never got an address never got a checkout either, so
	// there is nothing on it to protect.
	if (keyPath === undefined || workspace.ip === undefined) {
		return false;
	}

	const unsaved = await workspaceUnsavedWork(
		{ address: workspace.ip, keyPath, user: config.WORKSPACE_SSH_USER },
		AGENT_CWD,
		ssh,
	);
	if (unsaved.kind === "clean") {
		recordUnsavedWork(db, workspace.id, false, now);

		return false;
	}
	if (unsaved.kind === "unsaved") {
		recordUnsavedWork(db, workspace.id, true, now);
	}

	noteOnce(
		db,
		workspace.id,
		unsaved.kind === "unsaved"
			? "kept rather than destroyed: uncommitted or unpushed changes in the workspace"
			: `kept rather than destroyed: could not check for unsaved work (${unsaved.message})`,
		now,
	);

	return true;
}

// noteOnce appends a timeline entry only when it differs from the last one.
//
// A held workspace is reconsidered on every pass, so without this the reason would repeat every
// few seconds and bury the history it exists to explain. Same reasoning as noteWorkspaceIssue,
// which cannot be used here because it wants an operation lease and this is not operation work.
function noteOnce(
	db: Database.Database,
	id: string,
	message: string,
	now: Date,
): void {
	const latest = db
		.prepare(
			`SELECT event_type, message FROM workspace_events
			 WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`,
		)
		.get(id) as { event_type: string; message: string } | undefined;
	if (latest?.event_type === "workspace.kept" && latest.message === message) {
		return;
	}

	recordWorkspaceNote(db, id, "workspace.kept", message, now);
}

// expiredReason decides whether a workspace has run past one of the two limits.
function expiredReason(
	workspace: {
		activity: string;
		createdAt: string;
		lastActivityAt?: string;
	},
	settings: { reapIdleMinutes: number; reapMaxAgeHours: number },
	now: Date,
): ReapReason | undefined {
	const ageMinutes = minutesSince(workspace.createdAt, now);
	if (ageMinutes >= settings.reapMaxAgeHours * 60) {
		return {
			message: `destroyed after ${Math.round(ageMinutes / 60)}h, past the ${settings.reapMaxAgeHours}h maximum age`,
			rule: "max-age",
		};
	}

	// A working agent is not idle however long it has been at it.
	if (workspace.activity === "active") {
		return undefined;
	}

	// Falling back to creation is load-bearing rather than tidy: last_activity_at only moves while
	// an agent is actually working, so a workspace that never did anything has none at all. Without
	// this, the workspaces most worth reaping would be the ones that could never be reaped.
	const idleSince = workspace.lastActivityAt ?? workspace.createdAt;
	const idleMinutes = minutesSince(idleSince, now);
	if (idleMinutes >= settings.reapIdleMinutes) {
		return {
			message:
				workspace.lastActivityAt === undefined
					? `destroyed after ${Math.round(idleMinutes)}m without ever doing any work, past the ${settings.reapIdleMinutes}m idle limit`
					: `destroyed after ${Math.round(idleMinutes)}m idle, past the ${settings.reapIdleMinutes}m idle limit`,
			rule: "idle",
		};
	}

	return undefined;
}

function minutesSince(at: string, now: Date): number {
	return (now.getTime() - Date.parse(at)) / 60_000;
}
