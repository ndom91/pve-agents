import { workspaceOutcome } from "../domain/workspace-outcome";
import type { NoticeProps } from "./notice";

// outcomeNotice says what became of a workspace's work, once its container is gone.
//
// Its own module rather than a helper in the route, because a route cannot be imported by a test
// without building a router, and the mapping from outcome to severity is the part worth asserting.
export function outcomeNotice(
	workspace: Parameters<typeof workspaceOutcome>[0],
): NoticeProps[] {
	const outcome = workspaceOutcome(workspace);

	if (outcome.kind === "pushed") {
		return [
			{
				// The branch was a link inside the sentence; a strip clips its text, so the link
				// becomes the action instead, where it cannot be clipped away.
				action:
					outcome.url === undefined
						? undefined
						: {
								label: "Open branch",
								onClick: () => window.open(outcome.url, "_blank", "noreferrer"),
							},
				lead: "Work pushed",
				rest: `on ${outcome.branch}, not the branch this was cloned from. The container is gone; the work is not.`,
				severity: "green",
			},
		];
	}
	if (outcome.kind === "discarded") {
		return [
			{
				lead: "Changes discarded",
				rest: "everything in the working tree was deliberately thrown away before this workspace ended.",
				severity: "neutral",
			},
		];
	}
	if (outcome.kind === "lost") {
		// The only outcome where something is gone and nobody can get it back.
		return [
			{
				lead: "Ended holding unsaved work",
				rest: "its container has been deleted, so that work is gone.",
				severity: "red",
			},
		];
	}

	return [];
}
