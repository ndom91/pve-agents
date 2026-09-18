import { X } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { ChangedFiles } from "../services/workspace-changes";
import { Button } from "./button";
import { IconButton } from "./icon-button";
import { WorkspaceChanges } from "./workspace-changes";

// ChangesPanel is the rail's diff tab: what changed, and what can be done about it.
export function ChangesPanel({
	changes,
	diff,
	discarding,
	note,
	onClose,
	onDiscard,
	onPush,
	onSelect,
	pushing,
	selected,
	suggestedMessage,
}: {
	changes?: ChangedFiles;
	diff?: ReactNode;
	discarding: boolean;
	note: string;
	onClose: () => void;
	onDiscard: () => void;
	onPush: (message: string) => void;
	onSelect: (path: string) => void;
	pushing: boolean;
	selected?: string;
	suggestedMessage: string;
}): ReactNode {
	const [message, setMessage] = useState(suggestedMessage);

	const files = changes?.kind === "changes" ? changes.files : [];
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

	if (changes === undefined) {
		return <p className="detail-note">Reading the workspace.</p>;
	}
	if (changes.kind === "failed") {
		return <p className="detail-note">{changes.message}</p>;
	}
	if (count === 0) {
		return (
			<p className="detail-note">
				The agent has not changed anything in the checkout.
			</p>
		);
	}

	return (
		<div className="changes-panel">
			<WorkspaceChanges files={files} onSelect={onSelect} selected={selected} />

			{/* The file is read here rather than in the centre, so the terminal stays where it is
			    and nothing has to be navigated away from to look at a change. The rail is narrow
			    for a diff, which is what the drag handle on its edge is for. */}
			{selected === undefined ? null : (
				<div className="changes-diff">
					<div className="changes-diff-head">
						<span className="changes-diff-path">{selected}</span>
						<IconButton
							icon={X}
							label="Close the file"
							onClick={() => onClose()}
						/>
					</div>
					{diff}
				</div>
			)}

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
					// Named rather than "Push", because where it goes is the reassurance: nothing
					// here can land on the branch the workspace was cloned from.
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
			</div>

			{note === "" ? null : <p className="detail-note">{note}</p>}
		</div>
	);
}
