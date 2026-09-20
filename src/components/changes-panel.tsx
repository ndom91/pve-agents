import type { ReactNode } from "react";

import type { ChangedFiles } from "../services/workspace-changes";
import { ChangesAccordion } from "./changes-accordion";

// ChangesPanel is what the agent changed, or why nobody could tell.
//
// The three answers that are not a list of files are handled here, so the accordion below only
// ever deals with files. The commit and discard controls sit under the tabs rather than in here,
// because they act on the workspace rather than on any one row.
export function ChangesPanel({
	changes,
	workspaceId,
}: {
	changes?: ChangedFiles;
	workspaceId: string;
}): ReactNode {
	if (changes === undefined) {
		return <ChangesEmpty>Reading the workspace.</ChangesEmpty>;
	}
	if (changes.kind === "failed") {
		// Not an empty list. "The agent changed nothing" is a different claim from "nobody could
		// look", and it is the claim the reaper refuses to make for the same reason. Warned rather
		// than muted for that reason: a grey card here reads as "nothing to see".
		return <ChangesEmpty tone="warn">{changes.message}</ChangesEmpty>;
	}
	if (changes.files.length === 0) {
		// A clean tree is not the same as no work. A push that failed leaves the change committed
		// and only on that disk, and saying "nothing changed" about it is how somebody concludes
		// there is nothing to rescue and destroys the workspace.
		if (changes.unpushed > 0) {
			return (
				<ChangesEmpty tone="warn">
					{`Nothing uncommitted. ${changes.unpushed} ${
						changes.unpushed === 1 ? "commit is" : "commits are"
					} committed here and not pushed anywhere else.`}
				</ChangesEmpty>
			);
		}
		return (
			<ChangesEmpty>
				The agent has not changed anything in the checkout.
			</ChangesEmpty>
		);
	}

	return <ChangesAccordion files={changes.files} workspaceId={workspaceId} />;
}

// ChangesEmpty is every answer this tab has that is not a list of files.
//
// Centred in the panel rather than set against its top-left corner, where one sentence under the
// tab strip reads as a caption for content that failed to arrive rather than as the answer.
function ChangesEmpty({
	children,
	tone = "muted",
}: {
	children: ReactNode;
	tone?: "muted" | "warn";
}): ReactNode {
	return (
		<div className="changes-empty">
			<p className={`changes-empty-card changes-empty-card-${tone}`}>
				{children}
			</p>
		</div>
	);
}
