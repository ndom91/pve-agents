import type { ReactNode } from "react";

import { Tooltip } from "./tooltip";

// DotTone is how a dot reads at a glance, rather than what the workspace's status column says.
//
// Five, because five is what the colours can actually distinguish. Nine statuses and four
// activities collapse into these: the question a dot answers is "is this fine, is it working on
// something, does it want me, or is it over".
type DotTone = "error" | "gone" | "live" | "pending" | "waiting";

// StatusDot is one workspace's state as a single dot, with the word behind it for anyone who
// cannot see the colour.
//
// The mockups draw a bare dot here and STYLE.md section 7 says status is never colour-only -- every
// dot is paired with a word. Both are satisfiable at once: the dot is what a sighted reader sees,
// and the word is in the accessible name and the tooltip rather than in the layout. A sidebar row
// at 236px has no room for "provisioning" beside a title that is already being clipped, which is
// why the word is not simply printed.
export function StatusDot({
	activity,
	silent = false,
	status,
}: {
	activity?: string;
	// The word is already on screen beside this dot, so do not carry a second copy of it. A row
	// that prints "booting" next to a dot whose hidden text also says "booting" reads it twice to
	// a screen reader, and makes the word ambiguous to a test looking for one of them.
	silent?: boolean;
	status: string;
}): ReactNode {
	const { tone, word } = read(status, activity);

	if (silent) {
		return <span aria-hidden="true" className={`status-dot is-${tone}`} />;
	}

	// The word twice, on purpose and to two different readers: visually-hidden is what a screen
	// reader gets, and the tooltip is what a sighted person gets for a dot whose colour they have
	// not learned yet.
	return (
		<Tooltip label={word}>
			<span className={`status-dot is-${tone}`}>
				<span className="visually-hidden">{word}</span>
			</span>
		</Tooltip>
	);
}

// read turns the two columns into the one thing the dot says.
//
// Order matters: the terminal states answer first, because a destroyed workspace whose last
// observed activity was "active" is not active, it is gone. Activity is only meaningful while the
// container is ready, which is the same rule `WorkspaceBadges` applies when it decides whether to
// render the activity badge at all.
function read(
	status: string,
	activity?: string,
): { tone: DotTone; word: string } {
	if (status === "failed") {
		return { tone: "error", word: "failed" };
	}
	if (status === "destroyed") {
		return { tone: "gone", word: "destroyed" };
	}
	if (status !== "ready") {
		return { tone: "pending", word: status };
	}

	// Blocked is amber rather than green: the workspace is healthy, but it is the one state that
	// needs a person, and a dot that looks like every other running one is how that gets missed.
	if (activity === "blocked") {
		return { tone: "waiting", word: "blocked" };
	}

	return { tone: "live", word: activity === "active" ? "active" : "ready" };
}
