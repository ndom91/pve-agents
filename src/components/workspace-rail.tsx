import { X } from "lucide-react";
import type { ReactNode } from "react";

import { useRailWidth } from "../lib/use-rail-width";
import { RailResizer } from "./rail-resizer";

// RailWorkspace is the placement detail the rail reads. Structural rather than the full record, so
// this does not have to move every time the workspace type grows a field it does not show.
type RailWorkspace = {
	createdAt?: string;
	currentStep?: string;
	herdrPaneId?: string;
	herdrSession?: string;
	herdrWorkspaceId?: string;
	ip?: string;
	lastActivityAt?: string;
	node?: string;
	provisionPhase?: string;
	ref?: string;
	repository?: string;
	vmid?: number;
};

// RailTab is what the rail is showing.
//
// A shape rather than a string, because one of the three carries a path and the other two do not.
// Encoding a file as a reserved-prefixed string would work until a repository held a file called
// "diff".
export type RailTab =
	| { kind: "details" }
	| { kind: "diff" }
	| { kind: "file"; path: string }
	| { kind: "timeline" };

// sameTab compares two tabs, which is otherwise a three-way check at every call site.
export function sameTab(left: RailTab, right: RailTab): boolean {
	if (left.kind !== right.kind) {
		return false;
	}

	return left.kind !== "file" || left.path === (right as { path: string }).path;
}

// WorkspaceRail shows where a workspace lives, and what its agent has changed.
//
// Tabs rather than panels stacked, because they are read at different times and for different
// reasons. Placement is reference material you reach for when something has gone wrong. The list of
// changes is the actual output of the workspace. A file opened from that list gets a tab of its
// own, so reading one change does not cost you the sight of another, and closing it is one click
// rather than a navigation.
//
// The tabs appear only once there is something to show beyond placement. A workspace still
// provisioning has no changes to list, and an empty tab would invite a click that answers nothing.
export function WorkspaceRail({
	actions,
	changes,
	file,
	files = [],
	onClose,
	onTab,
	tab = { kind: "details" },
	timeline,
	workspace,
}: {
	actions?: ReactNode;
	changes?: ReactNode;
	file?: ReactNode;
	files?: string[];
	onClose?: (path: string) => void;
	onTab?: (tab: RailTab) => void;
	tab?: RailTab;
	timeline?: ReactNode;
	workspace: RailWorkspace;
}): ReactNode {
	const { setWidth, width } = useRailWidth();

	// The rail sets its own width rather than the grid setting it, so the handle does not have to
	// reach across routes to the layout that owns the columns. The grid's last column is `auto`.
	const sized = { width: `${width}px` };

	// Tabs appear once there is anything beyond placement to show. The timeline alone is enough:
	// a workspace that failed before it ever had a diff still has a history worth reading, and
	// that is exactly when somebody goes looking for one.
	const tabbed = changes ?? timeline;

	if (tabbed !== undefined && tab.kind !== "details") {
		return (
			<aside className="dashboard-rail" style={sized}>
				<RailResizer onResize={setWidth} width={width} />
				<Tabs
					changes={changes}
					files={files}
					onClose={onClose}
					onTab={onTab}
					tab={tab}
					timeline={timeline}
				/>
				<div className="rail-body">
					{tab.kind === "file" ? file : null}
					{tab.kind === "diff" ? changes : null}
					{tab.kind === "timeline" ? timeline : null}
				</div>
				{actions}
			</aside>
		);
	}

	return (
		<aside className="dashboard-rail" style={sized}>
			<RailResizer onResize={setWidth} width={width} />
			{tabbed === undefined ? (
				<p className="sidebar-label">Placement</p>
			) : (
				<Tabs
					changes={changes}
					files={files}
					onClose={onClose}
					onTab={onTab}
					tab={tab}
					timeline={timeline}
				/>
			)}
			<dl>
				<Fact label="Repository" value={workspace.repository} />
				<Fact label="Ref" value={workspace.ref} />
				<Fact label="Node" value={workspace.node} />
				<Fact label="VMID" value={workspace.vmid?.toString()} />
				<Fact label="Address" value={workspace.ip} />
				<Fact label="Phase" value={workspace.provisionPhase} />
				<Fact label="Step" value={workspace.currentStep} />
				<Fact label="Herdr session" value={workspace.herdrSession} />
				<Fact label="Herdr workspace" value={workspace.herdrWorkspaceId} />
				<Fact label="Herdr pane" value={workspace.herdrPaneId} />
				<Fact label="Created" value={workspace.createdAt?.slice(0, 19)} />
				<Fact
					label="Last active"
					value={workspace.lastActivityAt?.slice(0, 19)}
				/>
			</dl>
		</aside>
	);
}

// Tabs switches the rail between placement, the change list, and any file opened from it.
function Tabs({
	changes,
	files,
	onClose,
	onTab,
	tab,
	timeline,
}: {
	changes?: ReactNode;
	files: string[];
	onClose?: (path: string) => void;
	onTab?: (tab: RailTab) => void;
	tab: RailTab;
	timeline?: ReactNode;
}) {
	// Diff only for a workspace that has one. A destroyed container cannot be inspected, and a tab
	// that answers nothing is worse than an absent one.
	const fixed: { label: string; value: RailTab }[] = [
		{ label: "Details", value: { kind: "details" } },
		...(changes === undefined
			? []
			: [{ label: "Diff", value: { kind: "diff" } as RailTab }]),
		...(timeline === undefined
			? []
			: [{ label: "Timeline", value: { kind: "timeline" } as RailTab }]),
	];

	return (
		// Scrolls sideways rather than wrapping. Wrapping would change the rail's height as files
		// are opened, moving everything below it.
		<div className="rail-tabs" role="tablist">
			{fixed.map(({ label, value }) => (
				<button
					aria-selected={sameTab(tab, value)}
					className="rail-tab"
					key={label}
					onClick={() => onTab?.(value)}
					role="tab"
					type="button"
				>
					{label}
				</button>
			))}

			{files.map((path) => {
				const value: RailTab = { kind: "file", path };

				return (
					<span
						className={
							sameTab(tab, value) ? "rail-file is-active" : "rail-file"
						}
						key={path}
					>
						<button
							aria-selected={sameTab(tab, value)}
							className="rail-tab"
							onClick={() => onTab?.(value)}
							role="tab"
							// The label is the file name; the path is what disambiguates two files
							// with the same one, so it is the title.
							title={path}
							type="button"
						>
							{basename(path)}
						</button>
						{/* Shown on hover and while this tab is the one open, which is the tab
						    somebody is most likely to want rid of. Always visible would put a row
						    of crosses beside every name. */}
						<button
							aria-label={`Close ${path}`}
							className="rail-file-close"
							onClick={() => onClose?.(path)}
							title={`Close ${path}`}
							type="button"
						>
							<X aria-hidden size={12} strokeWidth={2} />
						</button>
					</span>
				);
			})}
		</div>
	);
}

// basename is the part of a path worth putting on a tab.
//
// The whole path would make every tab as wide as the rail. The full path stays as the title, and
// two files sharing a name are told apart by hovering rather than by reading a truncated middle.
function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

// Fact renders one label and value, and nothing at all when there is no value yet.
//
// A workspace acquires these as it provisions, so a missing one means "not there yet" rather than
// "empty", and an empty row would read as a problem.
function Fact({ label, value }: { label: string; value?: string }) {
	if (value === undefined || value === "") {
		return null;
	}

	return (
		<div>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}
