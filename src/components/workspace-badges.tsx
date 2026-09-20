import type { ReactNode } from "react";

import type { ChipTone } from "./status-chip";
import { StatusChip } from "./status-chip";
import { SwapText } from "./swap-text";

// WorkspaceBadges shows a workspace's lifecycle status and, once it has an agent, what that agent
// is doing.
//
// Activity is deliberately absent before "ready": a workspace still being built has no agent, and
// showing "unknown" there reads as a problem rather than as nothing having happened yet.
//
// Two shapes. On a card the two facts are loose chips, which is what a chip is for. In the screen
// bar they are one bordered group with a divider between them, because that is what the design
// draws there and because two separate outlines floating beside a third control was three objects
// in a row that is meant to read as two.
//
// Neither shape is interactive. The mockup's group is a segmented control -- a *wanted* state you
// can set -- and this application has none to set: activity is observed, and desired state only
// ever changes by destroying the workspace. This borrows the grouping and not the semantics, so
// they stay spans rather than becoming buttons that would do nothing when pressed.
export function WorkspaceBadges({
	activity,
	status,
	variant = "chips",
}: {
	activity: string;
	status: string;
	variant?: "chips" | "group";
}): ReactNode {
	const showActivity = status === "ready";

	if (variant === "chips") {
		return (
			<>
				<StatusChip label={status} tone={statusTone(status)} />
				{showActivity ? (
					<StatusChip label={activity} tone={activityTone(activity)} />
				) : null}
			</>
		);
	}

	// No role and no label on the box. `role="group"` would claim these are controls somebody can
	// operate; they are two words in a box, the words are the whole accessible content, and they
	// read fine in order without being announced as a group first.
	return (
		<div className="state-group">
			{/* The lifecycle leads and carries the fill. The mockup fills its active segment with
			    --sage-quiet, but that is a control and this is a report: rule 9 says sage is for
			    things you can do. The green chip tint says the same thing and says it truthfully --
			    green is what is so right now. */}
			<span className={`state-seg is-lead is-${statusTone(status)}`}>
				<span aria-hidden="true" className="state-dot" />
				<SwapText value={status} />
			</span>
			{showActivity ? (
				<>
					<span aria-hidden="true" className="state-div" />
					{/* No fill and no dot. It qualifies the segment beside it rather than standing
					    on its own, and two filled halves would be a group with nothing to look at
					    first. Blocked is the exception: it is the one value here that needs a
					    person, and it takes amber so it is not read as "running along fine". */}
					<span className={`state-seg is-${activityTone(activity)}`}>
						<SwapText value={activity} />
					</span>
				</>
			) : null}
		</div>
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
