import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { WorkspaceBadges } from "./workspace-badges";

type SidebarWorkspace = {
	activity: string;
	hostname: string;
	id: string;
	repository: string;
	status: string;
};

// SidebarEntry is one workspace in the navigation list.
//
// Badges are optional because the destroyed group does not show them: every entry there says
// "destroyed", so the badge would be a column of identical words rather than information.
export function SidebarEntry({
	showBadges = true,
	workspace,
}: {
	showBadges?: boolean;
	workspace: SidebarWorkspace;
}): ReactNode {
	return (
		<li>
			<Link
				activeProps={{ className: "sidebar-entry is-active" }}
				className="sidebar-entry"
				params={{ workspaceId: workspace.id }}
				to="/workspaces/$workspaceId"
			>
				<span className="sidebar-name">{workspace.hostname}</span>
				<span className="sidebar-repo">
					{shortRepository(workspace.repository)}
				</span>
				{showBadges ? (
					<span className="sidebar-badges">
						<WorkspaceBadges
							activity={workspace.activity}
							status={workspace.status}
						/>
					</span>
				) : null}
			</Link>
		</li>
	);
}

// shortRepository drops the host, which is the same for every workspace and so carries nothing.
function shortRepository(repository: string): string {
	return repository.replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
}
