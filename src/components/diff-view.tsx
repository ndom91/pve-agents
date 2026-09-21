import { MultiFileDiff } from "@pierre/diffs/react";

// DIFF_OPTIONS is module scope on purpose.
//
// The renderer re-renders on reference equality, so an options object rebuilt on each pass would
// reset it continuously. Unified rather than split because this sits between a sidebar and a rail,
// and two columns of source in what is left over is unreadable.
const DIFF_OPTIONS = {
	diffStyle: "unified",
	// The renderer draws a filename bar of its own, which here lands directly under the accordion
	// row it was opened from -- already the file's name, status letter and line counts.
	disableFileHeader: true,
	theme: { dark: "pierre-dark", light: "pierre-light" },
} as const;

// FileContents is one side of a diff: a file's name and everything in it.
type FileContents = { contents: string; name: string };

// DiffView renders one file's two sides.
//
// Loaded on demand by its wrapper. The renderer carries a syntax highlighter and its grammars, and
// most visits to a workspace never open a file.
export default function DiffView({
	newFile,
	oldFile,
}: {
	newFile: FileContents | null;
	oldFile: FileContents | null;
}) {
	// Three calls rather than one with two nullable sides, because the renderer types them as a
	// union: exactly one side may be null, and a file on neither side is not a change at all.
	if (oldFile === null && newFile !== null) {
		return (
			<MultiFileDiff newFile={newFile} oldFile={null} options={DIFF_OPTIONS} />
		);
	}
	if (oldFile !== null && newFile === null) {
		return (
			<MultiFileDiff newFile={null} oldFile={oldFile} options={DIFF_OPTIONS} />
		);
	}
	if (oldFile === null || newFile === null) {
		return <p className="detail-note">That file no longer exists.</p>;
	}

	return (
		<MultiFileDiff newFile={newFile} oldFile={oldFile} options={DIFF_OPTIONS} />
	);
}
