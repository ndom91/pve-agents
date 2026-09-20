import type { ReactNode } from "react";

import type { ChipTone } from "./status-chip";
import { StatusChip } from "./status-chip";

// WorkspaceBadges shows a workspace's lifecycle status and, once it has an agent, what that agent
// is doing.
//
// Activity is deliberately absent before "ready": a workspace still being built has no agent, and
// showing "unknown" there reads as a problem rather than as nothing having happened yet.
//
// Two chips rather than the mockup's one segmented control. That control is a *wanted* state you
// can set, and this application has nothing to set -- activity is observed and desired state is
// only ever changed by destroying the workspace. Inventing a pause flow to fill the slot would be a
// redesign; these are the same two facts the page has always shown, in the refresh's shape.
export function WorkspaceBadges({
	activity,
	status,
}: {
	activity: string;
	status: string;
}): ReactNode {
	return (
		<>
			<StatusChip label={status} tone={statusTone(status)} />
			{status === "ready" ? (
				<StatusChip label={activity} tone={activityTone(activity)} />
			) : null}
		</>
	);
}

// statusTone colours the lifecycle. Green is the one state where nothing is pending and nothing is
// wrong; amber is every step on the way there, because they are all "come back shortly".
function statusTone(status: string): ChipTone {
	if (status === "ready") {
		return "green";
	}
	if (status === "failed") {
		return "red";
	}
	if (status === "destroyed") {
		return "neutral";
	}

	return "amber";
}

// activityTone colours what the agent is doing. Blocked is amber and alone in it: it is the only
// value here that needs a person, and it is coloured for that rather than for decoration.
function activityTone(activity: string): ChipTone {
	if (activity === "active") {
		return "green";
	}

	return activity === "blocked" ? "amber" : "neutral";
}
