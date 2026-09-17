import type Database from "better-sqlite3";

import { controllerSettings } from "../db/settings-repository";
import {
	reapableFailedWorkspaces,
	reapableWorkspaces,
	recordWorkspaceNote,
	requestWorkspaceOperation,
} from "../db/workspace-repository";

// ReapReason is which rule decided a workspace had outlived its usefulness.
type ReapReason = { message: string; rule: "idle" | "max-age" };

// reapWorkspaces destroys workspaces that have outlived their usefulness.
//
// It does not delete anything itself. It queues a destroy through the same path the API and the UI
// use, which already verifies ownership before purging and is idempotent. A reaper that removed
// containers directly would be a second destroy implementation with none of those properties.
//
// Off unless switched on, because this removes real containers without being asked.
export function reapWorkspaces(
	db: Database.Database,
	now: Date = new Date(),
): { reaped: number } {
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
