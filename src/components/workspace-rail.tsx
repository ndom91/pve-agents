import type { ReactNode } from "react";

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

// RailTab is which half of the rail is on screen.
export type RailTab = "details" | "diff";

// WorkspaceRail shows where a workspace lives, and what its agent has changed.
//
// Two tabs rather than two panels stacked, because they are read at different times and for
// different reasons. Placement is reference material you reach for when something has gone wrong.
// The diff is the actual output of the workspace, and it earns the same space rather than being
// squeezed underneath a list of VMIDs.
//
// The tabs appear only once there is something to show in the second one. A workspace still
// provisioning has no changes to list, and an empty tab would invite a click that answers nothing.
export function WorkspaceRail({
	changes,
	onTab,
	tab = "details",
	workspace,
}: {
	changes?: ReactNode;
	onTab?: (tab: RailTab) => void;
	tab?: RailTab;
	workspace: RailWorkspace;
}): ReactNode {
	if (changes !== undefined && tab === "diff") {
		return (
			<aside className="dashboard-rail">
				<Tabs onTab={onTab} tab={tab} />
				{changes}
			</aside>
		);
	}

	return (
		<aside className="dashboard-rail">
			{changes === undefined ? (
				<p className="sidebar-label">Placement</p>
			) : (
				<Tabs onTab={onTab} tab={tab} />
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

// Tabs switches the rail between placement and the agent's changes.
function Tabs({
	onTab,
	tab,
}: {
	onTab?: (tab: RailTab) => void;
	tab: RailTab;
}) {
	return (
		<div className="rail-tabs">
			{(["details", "diff"] as const).map((name) => (
				<button
					aria-selected={tab === name}
					className="rail-tab"
					key={name}
					onClick={() => onTab?.(name)}
					role="tab"
					type="button"
				>
					{name === "details" ? "Details" : "Diff"}
				</button>
			))}
		</div>
	);
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
