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
	unpushed,
}: {
	discarding: boolean;
	files: ChangedFile[];
	note: string;
	onDiscard: () => void;
	onPush: (message: string) => void;
	pushing: boolean;
	suggestedMessage: string;
	unpushed: number;
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

	// Offered whenever there is anything to push, not only when the tree is dirty. A failed push
	// leaves a clean tree and a commit that exists nowhere else, and hiding the button there left
	// the workspace held with no way to act on it — the exact dead end this panel exists to avoid.
	if (count === 0 && unpushed === 0) {
		return null;
	}

	return (
		<div className="changes-actions">
			{/* Labelled rather than relying on the placeholder, because the field arrives pre-filled
			    with the workspace's purpose and a placeholder is only ever read when a field is
			    empty. It explained itself to nobody who had not already emptied it. */}
			<label className="changes-message">
				<span>Commit message</span>
				<input
					disabled={pushing}
					onChange={(event) => setMessage(event.target.value)}
					placeholder="Commit message"
					value={message}
				/>
			</label>
			<Button
				disabled={pushing || message.trim() === ""}
				onClick={() => onPush(message.trim())}
				// Named rather than "Push", because where it goes is the reassurance: nothing here
				// can land on the branch the workspace was cloned from.
				tooltip="Commit everything and push it to this workspace's own branch"
			>
				{pushing ? "Pushing" : "Commit and push"}
			</Button>

			{/* Red, not sage: the accent is never the destructive action. */}
			{count === 0 ? null : armed ? (
				<Button disabled={discarding} onClick={onDiscard} variant="danger">
					{discarding
						? "Discarding"
						: `Discard ${count} ${count === 1 ? "file" : "files"}, permanently`}
				</Button>
			) : (
				<Button onClick={() => setArmedFor(listed)} variant="danger">
					Discard changes
				</Button>
			)}

			{note === "" ? null : <p className="detail-note">{note}</p>}
		</div>
	);
}
