import { lazy, type ReactNode, Suspense } from "react";

import { useMounted } from "../lib/use-mounted";
import type { ChangedFile } from "../services/workspace-changes";

// Fetched when someone opens the diff tab, not when they open a workspace.
//
// The tree renderer is large, and most visits to a workspace are to watch a terminal rather than
// to read a diff. Imported directly it went into the detail route's own chunk, so every visit paid
// for it whether or not the tab was ever opened.
const ChangesTree = lazy(() => import("./changes-tree"));

// WorkspaceChanges is the tree of what the agent has done to the checkout.
export function WorkspaceChanges({
	files,
	onSelect,
	selected,
}: {
	files: ChangedFile[];
	onSelect: (path: string) => void;
	selected?: string;
}): ReactNode {
	// The renderer draws into shadow DOM, so it waits for the browser rather than being preloaded
	// on the server: the two must agree exactly on the options affecting first markup, and a
	// mismatch is a hydration failure rather than a partial merge. Nothing here is on screen at
	// first paint, so waiting costs nothing.
	if (!useMounted()) {
		return <p className="detail-note">Loading the tree.</p>;
	}

	return (
		<Suspense fallback={<p className="detail-note">Loading the tree.</p>}>
			<ChangesTree files={files} onSelect={onSelect} selected={selected} />
		</Suspense>
	);
}
