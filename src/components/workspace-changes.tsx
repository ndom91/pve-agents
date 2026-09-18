import {
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useRef,
	useState,
} from "react";

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
	const mounted = useMounted();

	// Remounting the tree is how its selection gets cleared.
	//
	// The page owns which file is open, and closing one has to leave the tree agreeing. The model
	// exposes no way to deselect a row, so a tree left holding the old selection would report it
	// straight back and the file would reopen the instant it was closed. That is what made "back to
	// the terminal" look like it did nothing.
	//
	// Cheap here, where the tree holds the handful of files an agent touched rather than a
	// repository. It does discard expansion state, which is the reason to prefer a real deselect if
	// the library ever offers one.
	const [generation, setGeneration] = useState(0);
	const previous = useRef<string | undefined>(undefined);

	useEffect(() => {
		if (previous.current !== undefined && selected === undefined) {
			setGeneration((count) => count + 1);
		}
		previous.current = selected;
	}, [selected]);

	// The renderer draws into shadow DOM, so it waits for the browser rather than being preloaded
	// on the server: the two must agree exactly on the options affecting first markup, and a
	// mismatch is a hydration failure rather than a partial merge. Nothing here is on screen at
	// first paint, so waiting costs nothing.
	if (!mounted) {
		return <p className="detail-note">Loading the tree.</p>;
	}

	return (
		<Suspense fallback={<p className="detail-note">Loading the tree.</p>}>
			<ChangesTree
				files={files}
				key={generation}
				onSelect={onSelect}
				selected={selected}
			/>
		</Suspense>
	);
}
