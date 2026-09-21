import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { shortRepository } from "../domain/repository";
import type { ProvisionPhase } from "../domain/workspace";
import { isProvisioning } from "../domain/workspace-lifecycle";
import { Elapsed } from "./elapsed";
import { LifecycleStrip } from "./lifecycle-strip";
import { StatusDot } from "./status-dot";
import { WorkspaceBadges } from "./workspace-badges";

// FleetWorkspace is what a row needs. Structural rather than the full record, so this does not
// have to change every time the workspace type grows a field it does not show.
type FleetWorkspace = {
	activity: string;
	createdAt?: string;
	currentStep?: string;
	provisionPhase?: ProvisionPhase;
	hostname: string;
	id: string;
	ip?: string;
	lastActivityAt?: string;
	node?: string;
	purpose?: string;
	readyAt?: string;
	repository: string;
	status: string;
	title?: string;
	unsavedWork?: boolean;
	vmid?: number;
};

// FleetRow is one running workspace, as a row of a table.
//
// It was a tile in a grid. One workspace is the common case here and a grid of one is a card
// floating in an empty half-screen; a table still reads with a single row in it, and the columns
// line up once there are four. What each column holds is the same information the tile carried.
//
// The title leads rather than the hostname. `agent-8d1f` distinguishes two workspaces but says
// nothing about either; what somebody scanning the fleet wants is which of these is the one they
// asked to fix the login bug.
export function FleetRow({
	workspace,
}: {
	workspace: FleetWorkspace;
}): ReactNode {
	// Whether the agent has named its own work yet. Until it has, the title line falls back to the
	// container's name -- and then the repo column must not repeat it underneath.
	const named = workspace.title !== undefined && workspace.title !== "";
	const building = isProvisioning(workspace.status);

	return (
		<div className="fleet-row">
			<Link
				className="fleet-cells"
				params={{ workspaceId: workspace.id }}
				to="/workspaces/$workspaceId"
			>
				<span className="fleet-what">
					<span className="fleet-title-line">
						{/* Silent: the state chip further along this row already prints the
						    word, so a second hidden copy would be read out twice. */}
						<StatusDot
							activity={workspace.activity}
							silent
							status={workspace.status}
						/>
						<span className="fleet-title">
							{named ? workspace.title : workspace.hostname}
						</span>
					</span>
					<span className="fleet-purpose">
						{workspace.purpose?.trim() || "No purpose supplied"}
					</span>
				</span>

				<span className="fleet-col is-repo">
					<span className="fleet-strong">
						{shortRepository(workspace.repository)}
					</span>
					<span className="fleet-weak">{named ? workspace.hostname : ""}</span>
				</span>

				<span className="fleet-col is-where">
					<span className="fleet-strong">{placement(workspace)}</span>
					<span className="fleet-weak">{workspace.ip ?? ""}</span>
				</span>

				<span className="fleet-col is-state">
					<WorkspaceBadges
						activity={workspace.activity}
						status={workspace.status}
					/>
					{/* Only when true. The flag is also false and undefined, and undefined means
					    nobody has looked yet, which is not something to claim on a row. */}
					{workspace.unsavedWork === true ? (
						<span className="fleet-flag">unsaved</span>
					) : null}
				</span>

				<span className="fleet-col is-up">
					<Elapsed since={workspace.readyAt ?? workspace.createdAt} />
				</span>

				<span aria-hidden="true" className="fleet-go">
					&rsaquo;
				</span>
			</Link>

			{/* The strip, and how long it took. Only while there is something to watch: a workspace
			    that is up says so in its state chip, and a full bar under every row would be six
			    green segments repeating what the word already said. */}
			{!building ? null : (
				<div className="fleet-progress">
					<LifecycleStrip
						phase={workspace.provisionPhase}
						status={workspace.status}
					/>
					<span className="fleet-step">{workspace.currentStep ?? ""}</span>
				</div>
			)}
		</div>
	);
}

// placement is the node and the container id, which are read together or not at all.
function placement(workspace: { node?: string; vmid?: number }): string {
	if (workspace.node === undefined) {
		return workspace.vmid === undefined ? "" : String(workspace.vmid);
	}

	return workspace.vmid === undefined
		? workspace.node
		: `${workspace.node}·${workspace.vmid}`;
}
