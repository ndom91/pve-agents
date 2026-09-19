import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { WorkspaceBadges } from "./workspace-badges";

// FleetWorkspace is what a card needs. Structural rather than the full record, so this does not
// have to change every time the workspace type grows a field it does not show.
type FleetWorkspace = {
	activity: string;
	createdAt?: string;
	hostname: string;
	id: string;
	lastActivityAt?: string;
	purpose?: string;
	repository: string;
	status: string;
	unsavedWork?: boolean;
};

// FleetCard is one running workspace, as much of it as fits on a tile.
//
// The purpose leads rather than the hostname. `agent-8d1f` distinguishes two workspaces but says
// nothing about either; what somebody scanning the fleet wants to know is which of these is the one
// they asked to fix the login bug.
export function FleetCard({
	workspace,
}: {
	workspace: FleetWorkspace;
}): ReactNode {
	return (
		<Link
			className="fleet-card"
			params={{ workspaceId: workspace.id }}
			to="/workspaces/$workspaceId"
		>
			<p className="fleet-purpose">
				{workspace.purpose?.trim() || "No purpose supplied"}
			</p>

			<div className="fleet-meta">
				<span className="fleet-host">{workspace.hostname}</span>
				<span className="fleet-repo">
					{shortRepository(workspace.repository)}
				</span>
			</div>

			<div className="fleet-badges">
				<WorkspaceBadges
					activity={workspace.activity}
					status={workspace.status}
				/>
				{/* Only when true. The flag is also false and undefined, and undefined means nobody
				    has looked yet, which is not something to claim on a tile. */}
				{workspace.unsavedWork === true ? (
					<span className="fleet-flag">unsaved</span>
				) : null}
				<span className="fleet-age">{age(workspace)}</span>
			</div>
		</Link>
	);
}

// age is how long this workspace has been quiet, or how long it has existed.
//
// Two different facts under one label deliberately: before an agent does anything there is no
// activity to measure, and "12m old" and "12m idle" are the same number for a workspace that has
// never worked. Which one it is matters less on a tile than the order of magnitude.
function age(workspace: {
	createdAt?: string;
	lastActivityAt?: string;
}): string {
	const since = workspace.lastActivityAt ?? workspace.createdAt;
	if (since === undefined) {
		return "";
	}

	const minutes = Math.max(
		0,
		Math.round((Date.now() - Date.parse(since)) / 60_000),
	);
	if (minutes < 60) {
		return `${minutes}m`;
	}

	const hours = Math.round(minutes / 60);

	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

// shortRepository drops the host, which is github.com for every workspace here and therefore tells
// nobody anything.
function shortRepository(repository: string): string {
	return repository.replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
}
