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

// WorkspaceRail lists where a workspace lives and what it is made of.
//
// Reference material rather than navigation: these are the values you read when something has gone
// wrong, so they sit quietly beside the terminal instead of competing with it.
export function WorkspaceRail({
	workspace,
}: {
	workspace: RailWorkspace;
}): ReactNode {
	return (
		<aside className="dashboard-rail">
			<p className="sidebar-label">Placement</p>
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
