import { Check, X } from "lucide-react";
import { type ReactNode, useState } from "react";

import { MAX_TITLE } from "../domain/workspace-title";
import { IconButton } from "./icon-button";

// WorkspaceTitle is the workspace's name, and the place to change it.
//
// Reading and editing are the same element rather than a heading with a pencil beside it: the
// heading is the only thing on this page a person would want to rename, so a control pointing at
// it would be a control with one possible subject.
//
// `hostname` is the fallback and never the value. Clearing the field removes the title and the
// machine's name comes back, which is why there is no separate Clear button -- "save nothing" and
// "clear" are the same act, and two controls for one act invites the question of how they differ.
export function WorkspaceTitle({
	hostname,
	onRename,
	title,
}: {
	hostname: string;
	onRename: (title: string) => void;
	title?: string;
}): ReactNode {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");

	function open(): void {
		// The title, not the hostname. Opening the editor on a workspace with no title should offer
		// an empty field to write in, not the machine name to delete first.
		setDraft(title ?? "");
		setEditing(true);
	}

	function save(): void {
		setEditing(false);
		if (draft !== (title ?? "")) {
			onRename(draft);
		}
	}

	if (!editing) {
		return (
			// A button, because it does something when clicked and a heading does not. The heading
			// stays inside it so the page keeps exactly one h1.
			<button className="workspace-title" onClick={open} type="button">
				<h1>{title ?? hostname}</h1>
			</button>
		);
	}

	return (
		<div className="workspace-title is-editing">
			<input
				aria-label="Workspace title"
				// biome-ignore lint/a11y/noAutofocus: the field exists only because it was asked for
				autoFocus
				maxLength={MAX_TITLE}
				onChange={(event) => setDraft(event.target.value)}
				// Enter saves and Escape abandons, which is the reason this is an input rather than
				// the textarea it looks like: in a textarea Enter means newline, and a title that
				// is capped at sixty characters has no second line to put one on.
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						save();
					}
					if (event.key === "Escape") {
						setEditing(false);
					}
				}}
				placeholder={hostname}
				type="text"
				value={draft}
			/>
			<IconButton icon={Check} label="Save title" onClick={save} size={14} />
			<IconButton
				icon={X}
				label="Cancel"
				onClick={() => setEditing(false)}
				size={14}
				variant="tertiary"
			/>
		</div>
	);
}
