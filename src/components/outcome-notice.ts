import { workspaceOutcome } from "../domain/workspace-outcome";
import type { NoticeSeverity } from "./notice";

// OutcomeItem is what became of a workspace's work, as a fact in the meta band.
export type OutcomeItem = { label: string; severity: NoticeSeverity };

// outcomeItem says what became of a workspace's work, once its container is gone.
//
// A band item rather than a strip, which is the notices spec's own rule applied: the container is
// gone, so none of these offers anything to do about it, and a state that will be true for hours
// with no decision attached belongs among the facts rather than in a bar above the feed.
//
// The branch is not lost by shrinking to a chip. It is already a fact in the same band, and the
// Details tab carries the link that opens it on GitHub.
//
// Its own module rather than a helper in the route, because a route cannot be imported by a test
// without building a router, and the mapping from outcome to severity is the part worth asserting.
export function outcomeItem(
	workspace: Parameters<typeof workspaceOutcome>[0],
): OutcomeItem[] {
	const outcome = workspaceOutcome(workspace);

	if (outcome.kind === "pushed") {
		return [{ label: "work pushed", severity: "green" }];
	}
	if (outcome.kind === "discarded") {
		return [{ label: "changes discarded", severity: "neutral" }];
	}
	if (outcome.kind === "lost") {
		// The only outcome where something is gone and nobody can get it back.
		return [{ label: "unsaved work lost", severity: "red" }];
	}

	return [];
}
