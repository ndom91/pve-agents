import { type ReactNode, useState } from "react";

import type { ChangedFile } from "../services/workspace-changes";
import { Button } from "./button";

// ChangesActions is what can be done with everything the agent changed.
//
// Outside the tabs rather than inside one, because it acts on the workspace and not on whichever
// file happens to be open. Pushing from a tab showing one file, and having it push all of them,
// would be a reasonable thing to misread.
export function ChangesActions({
	discarding,
	files,
	note,
	onDiscard,
	onPush,
	pushing,
	suggestedMessage,
}: {
	discarding: boolean;
	files: ChangedFile[];
	note: string;
	onDiscard: () => void;
	onPush: (message: string) => void;
	pushing: boolean;
	suggestedMessage: string;
}): ReactNode {
	const [message, setMessage] = useState(suggestedMessage);

	const count = files.length;
	const listed = files.map((file) => file.path).join("\n");

	// The confirmation for discarding, which is the one action here that destroys work. It records
	// which files it was armed against rather than a flag, so it stops being armed the moment the
	// tree underneath it changes at all.
	//
	// Against the exact set, not its size: the list is re-read every fifteen seconds, and an agent
	// that deleted one file and created another would leave a count that never moved and a
	// confirmation still live against work nobody had looked at.
	const [armedFor, setArmedFor] = useState<string | undefined>(undefined);
	const armed = armedFor !== undefined && armedFor === listed;

	if (count === 0) {
		return null;
	}

	return (
		<div className="changes-actions">
			<input
				disabled={pushing}
				onChange={(event) => setMessage(event.target.value)}
				placeholder="Commit message"
				value={message}
			/>
			<Button
				disabled={pushing || message.trim() === ""}
				onClick={() => onPush(message.trim())}
				// Named rather than "Push", because where it goes is the reassurance: nothing here
				// can land on the branch the workspace was cloned from.
				title="Commit everything and push it to this workspace's own branch"
			>
				{pushing ? "Pushing" : "Commit and push"}
			</Button>

			{armed ? (
				<Button disabled={discarding} onClick={onDiscard}>
					{discarding
						? "Discarding"
						: `Discard ${count} ${count === 1 ? "file" : "files"}, permanently`}
				</Button>
			) : (
				<Button onClick={() => setArmedFor(listed)}>Discard changes</Button>
			)}

			{note === "" ? null : <p className="detail-note">{note}</p>}
		</div>
	);
}
