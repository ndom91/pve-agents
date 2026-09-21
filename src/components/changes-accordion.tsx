import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { fileDiffQuery } from "../lib/queries";
import { useOpenRows } from "../lib/use-open-rows";
import type { ChangedFile } from "../services/workspace-changes";
import { FileDiff } from "./file-diff";

// ChangesAccordion is what the agent changed, as one page.
//
// Every changed file is a row, collapsed. Opening one unfolds its diff underneath it and leaves
// every other row where it was, so reading three files is three clicks rather than three clicks
// and three tab switches. This replaced a tab per opened file, which kept each diff intact but
// made the tab strip scroll sideways once a change touched more than a few files.
//
// Flat rather than a tree. The set here is what one agent touched, usually a handful of files, and
// the full path already says where each one lives. Nesting bought grouping at the cost of a
// virtualising tree that could not host anything underneath a row, which is the whole feature.
export function ChangesAccordion({
	against,
	files,
	workspaceId,
}: {
	// What the changes are measured against, for the header. The branch the workspace was cut
	// from, not the one it would push to. Not called `ref`: that is React's own prop name, and a
	// component taking one by accident is a bug nobody reads twice.
	against?: string;
	files: ChangedFile[];
	workspaceId: string;
}): ReactNode {
	// Held here rather than by the page, and it survives switching to another tab and back, because
	// the rail keeps an opened panel mounted rather than unmounting it.
	const { isOpen, toggle } = useOpenRows();

	return (
		<div className="changes">
			{/* How much there is, and what it is a change from. The mockup carries added and
			    removed line counts here as well; this side counts files, not lines -- the status
			    walk reports a path and a letter per file and never opens one -- so the numbers
			    would have to be invented. */}
			<div className="changes-bar">
				<span className="changes-count">
					{files.length === 1 ? "1 file" : `${files.length} files`}
				</span>
				<span className="changes-bar-spacer" />
				{against === undefined ? null : (
					<span className="changes-against">vs {against}</span>
				)}
			</div>

			<ol className="changes-accordion">
				{files.map((file) => {
					const expanded = isOpen(file.path);

					return (
						<li className="change-entry" key={file.path}>
							<button
								aria-expanded={expanded}
								// Stated, because the path is split across two spans to dim the
								// directory and the accessible name computation joins them with a
								// space -- "src/b/ config.ts" is not a path anybody can search for.
								// It carries the status too, which the letter alone does not.
								aria-label={`${file.path}, ${file.status}`}
								className={`change-row is-${file.status}`}
								onClick={() => toggle(file.path)}
								type="button"
							>
								{/* One letter, coloured. The word it replaces spent a quarter of a
							    392px row saying "modified" on every line of a list where most
							    things are modified. The status is still the accessible name of the
							    row, so nothing is lost to a reader who cannot see the colour. */}
								<span aria-hidden="true" className="change-mark">
									{MARKS[file.status]}
								</span>
								{/* The whole path, not the file name. Two files called config.ts are told
							    apart by reading rather than by hovering, which is what a tab needed.
							    The directory is dimmed so the eye lands on the name without losing
							    the rest of it. */}
								<span className="change-path">
									<span className="change-dir">{directory(file.path)}</span>
									<span className="change-name">{basename(file.path)}</span>
								</span>
							</button>
							{expanded ? (
								<ChangeDiff path={file.path} workspaceId={workspaceId} />
							) : null}
						</li>
					);
				})}
			</ol>
		</div>
	);
}

// MARKS is git's own letter for each status. Renamed is R and untracked is A: an untracked file is
// one git has not been told about yet, and to a reader it is a file that was not there before.
const MARKS: Record<string, string> = {
	added: "A",
	deleted: "D",
	modified: "M",
	renamed: "R",
	untracked: "A",
};

// directory is everything up to and including the last slash, or nothing for a file at the root.
function directory(path: string): string {
	const cut = path.lastIndexOf("/");

	return cut === -1 ? "" : path.slice(0, cut + 1);
}

// basename is the part somebody is actually looking for.
function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

// ChangeDiff reads one file and renders its two sides.
//
// A component per expanded row rather than one fetch for everything, because each read is an SSH
// round trip: asking for every file up front would open a connection per changed file to show a
// page whose rows are all shut. The query cache makes re-expanding a row free.
//
// Unmounted on collapse. The renderer carries a syntax highlighter and draws into shadow DOM, so
// several left mounted and hidden is several highlight passes' worth of DOM behind rows nobody has
// open.
function ChangeDiff({
	path,
	workspaceId,
}: {
	path: string;
	workspaceId: string;
}) {
	const { data: sides } = useQuery(fileDiffQuery(workspaceId, path));

	return (
		<div className="change-diff">
			<FileDiff path={path} sides={sides} />
		</div>
	);
}
