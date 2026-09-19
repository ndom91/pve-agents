import type { ReactNode } from "react";

import type { ChangedFiles } from "../services/workspace-changes";
import { WorkspaceChanges } from "./workspace-changes";

// ChangesPanel is the list of what the agent changed.
//
// Only the list. The diff for a file opens as its own tab, and the commit and discard controls sit
// below the tabs, because they act on the workspace rather than on anything shown here.
export function ChangesPanel({
	changes,
	onSelect,
	selected,
}: {
	changes?: ChangedFiles;
	onSelect: (path: string) => void;
	selected?: string;
}): ReactNode {
	if (changes === undefined) {
		return <p className="detail-note">Reading the workspace.</p>;
	}
	if (changes.kind === "failed") {
		// Not an empty list. "The agent changed nothing" is a different claim from "nobody could
		// look", and it is the claim the reaper refuses to make for the same reason.
		return <p className="detail-note">{changes.message}</p>;
	}
	if (changes.files.length === 0) {
		// A clean tree is not the same as no work. A push that failed leaves the change committed
		// and only on that disk, and saying "nothing changed" about it is how somebody concludes
		// there is nothing to rescue and destroys the workspace.
		return (
			<p className="detail-note">
				{changes.unpushed > 0
					? `Nothing uncommitted. ${changes.unpushed} ${
							changes.unpushed === 1 ? "commit is" : "commits are"
						} committed here and not pushed anywhere else.`
					: "The agent has not changed anything in the checkout."}
			</p>
		);
	}

	return (
		<WorkspaceChanges
			files={changes.files}
			onSelect={onSelect}
			selected={selected}
		/>
	);
}
