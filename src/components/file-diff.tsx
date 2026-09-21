import { lazy, type ReactNode, Suspense, useMemo } from "react";

import { useMounted } from "../lib/use-mounted";
import type { FileSides } from "../services/workspace-changes";
import { PanelNote, PanelSpinner } from "./panel-state";

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

	// The waits are the panel's spinner; the words survive as its label, which is all a screen
	// reader ever had of them. A sentence here reads as the answer rather than as the wait for one.
	if (sides === undefined) {
		return <PanelSpinner label={`Reading ${path}.`} />;
	}
	// These three are answers, not waits: no diff is coming and the words are the content.
	if (sides.kind === "failed") {
		return <PanelNote tone="warn">{sides.message}</PanelNote>;
	}
	if (sides.kind === "binary") {
		return <PanelNote>{path} is binary.</PanelNote>;
	}
	if (sides.kind === "too-large") {
		return <PanelNote>{path} is too large to show.</PanelNote>;
	}
	if (!mounted) {
		return <PanelSpinner label="Loading the diff." />;
	}

	return (
		<Suspense fallback={<PanelSpinner label="Loading the diff." />}>
			<DiffView newFile={newFile} oldFile={oldFile} />
		</Suspense>
	);
}
