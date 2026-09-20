import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
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
	files,
	workspaceId,
}: {
	files: ChangedFile[];
	workspaceId: string;
}): ReactNode {
	// Held here rather than by the page, and it survives switching to another tab and back, because
	// the rail keeps an opened panel mounted rather than unmounting it.
	const { isOpen, toggle } = useOpenRows();

	return (
		<ol className="changes-accordion">
			{files.map((file) => {
				const expanded = isOpen(file.path);

				return (
					<li className="change-entry" key={file.path}>
						<button
							aria-expanded={expanded}
							className={`change-row is-${file.status}`}
							onClick={() => toggle(file.path)}
							type="button"
						>
							<ChevronRight
								aria-hidden
								className="change-caret"
								size={12}
								strokeWidth={2}
							/>
							{/* The whole path, not the file name. Two files called config.ts are told
							    apart by reading rather than by hovering, which is what a tab needed. */}
							<span className="change-path">{file.path}</span>
							<span className="change-status">{file.status}</span>
						</button>
						{expanded ? (
							<ChangeDiff path={file.path} workspaceId={workspaceId} />
						) : null}
					</li>
				);
			})}
		</ol>
	);
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
