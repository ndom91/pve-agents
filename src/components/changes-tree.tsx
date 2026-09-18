import {
	FileTree,
	useFileTree,
	useFileTreeSelection,
} from "@pierre/trees/react";
import { useEffect, useMemo, useRef } from "react";

import type { ChangedFile } from "../services/workspace-changes";

// ChangesTree renders what the agent changed as a file tree.
//
// Only changed files, not the whole repository. The question this answers is "what did the agent
// do", and a full checkout would bury a three-file answer in a few thousand rows of untouched
// source.
//
// Loaded on demand by its wrapper rather than imported directly, because the renderer is large and
// most visits to a workspace never open this tab.
export default function ChangesTree({
	files,
	onSelect,
	selected,
}: {
	files: ChangedFile[];
	onSelect: (path: string) => void;
	selected?: string;
}) {
	const paths = useMemo(() => files.map((file) => file.path), [files]);
	const gitStatus = useMemo(
		() => files.map((file) => ({ path: file.path, status: file.status })),
		[files],
	);

	const { model } = useFileTree({
		// Single-child directory chains collapse into one row, so "src/main/java/com/x" is one
		// line rather than five. Most of a repository tree is that shape.
		flattenEmptyDirectories: true,
		gitStatus,
		paths,
	});

	// The model is built once and later option changes do not reconfigure it, so every update after
	// the first has to be pushed in through the model itself. Without this the tree would keep
	// showing whatever the agent had changed at the moment the tab was first opened.
	useEffect(() => {
		model.resetPaths(paths);
		model.setGitStatus(gitStatus);
	}, [gitStatus, model, paths]);

	const chosen = useFileTreeSelection(model);

	// What was last reported upward. The page and the tree each hold a version of "which file", and
	// without somewhere to record what has already been passed between them they echo: clearing the
	// page's selection left the row still selected here, the effect below saw a file the page did
	// not have, and reported it again. That is why "back to the terminal" appeared to do nothing —
	// it worked, and the tree immediately undid it.
	const reported = useRef<string | undefined>(undefined);

	// Tree to page.
	useEffect(() => {
		// Directories are selectable and have no diff to show. Reporting one would blank the pane
		// the reader was looking at, so only a path that is genuinely a changed file counts.
		const path = chosen.find((candidate) => paths.includes(candidate));
		if (path !== undefined && path !== reported.current) {
			reported.current = path;
			onSelect(path);
		}
	}, [chosen, onSelect, paths]);

	// Clearing the selection from here is not possible: the public model exposes getSelectedPaths
	// and no setter, and the write methods belong to a controller it does not hand out. The wrapper
	// remounts this component instead, which is why `selected` is not read after the first render.
	void selected;

	return <FileTree className="changes-tree" model={model} />;
}
