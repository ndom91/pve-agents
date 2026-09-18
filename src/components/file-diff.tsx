import { lazy, type ReactNode, Suspense, useMemo } from "react";

import { useMounted } from "../lib/use-mounted";
import type { FileSides } from "../services/workspace-changes";

// Fetched when someone opens a file, not when they open a workspace. The renderer carries a
// syntax highlighter and its grammars, which is a lot to hand to someone watching a terminal.
const DiffView = lazy(() => import("./diff-view"));

// FileDiff shows one file as it was and as it is.
export function FileDiff({
	path,
	sides,
}: {
	path: string;
	sides?: FileSides;
}): ReactNode {
	const mounted = useMounted();

	// Contents rather than a patch, which is what makes a file the agent created show up at all:
	// git produces no diff for an untracked file, and that is the commonest change of all.
	const oldFile = useMemo(
		() =>
			sides?.kind === "contents" && sides.before !== undefined
				? { contents: sides.before, name: path }
				: null,
		[path, sides],
	);
	const newFile = useMemo(
		() =>
			sides?.kind === "contents" && sides.after !== undefined
				? { contents: sides.after, name: path }
				: null,
		[path, sides],
	);

	if (sides === undefined) {
		return <p className="detail-note">Reading {path}.</p>;
	}
	if (sides.kind === "failed") {
		return <p className="detail-note">{sides.message}</p>;
	}
	if (sides.kind === "binary") {
		return <p className="detail-note">{path} is binary.</p>;
	}
	if (sides.kind === "too-large") {
		return <p className="detail-note">{path} is too large to show.</p>;
	}
	if (!mounted) {
		return <p className="detail-note">Loading the diff.</p>;
	}

	return (
		<Suspense fallback={<p className="detail-note">Loading the diff.</p>}>
			<DiffView newFile={newFile} oldFile={oldFile} />
		</Suspense>
	);
}
