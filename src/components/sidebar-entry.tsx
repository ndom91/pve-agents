import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { shortRepository } from "../domain/repository";
import { Elapsed } from "./elapsed";
import { StatusDot } from "./status-dot";

type SidebarWorkspace = {
	activity: string;
	createdAt?: string;
	hostname: string;
	id: string;
	repository: string;
	status: string;
	title?: string;
};

// SidebarEntry is one workspace in the navigation list.
//
// Two lines: what the work is, then which machine is doing it and for how long. The title used to
// stand alone with the repository under it and a row of badges under that, which spent three lines
// and a pair of bordered words on a list whose job is to be scanned.
//
// The state moves into a dot at the head of the title, so it reads on the same line as the thing it
// describes. `showState` is off for the destroyed group: every entry there says destroyed, so the
// dot would be a column of identical grey rather than information.
export function SidebarEntry({
	showState = true,
	workspace,
}: {
	showState?: boolean;
	workspace: SidebarWorkspace;
}): ReactNode {
	// Whether the agent has named its own work yet. Until it has, the title line falls back to the
	// container's name -- and then the meta line below must not repeat it, or the row says
	// "agent-932a" twice and spends its second line saying nothing.
	const named = workspace.title !== undefined && workspace.title !== "";

	return (
		<li>
			<Link
				activeProps={{ className: "sidebar-entry is-active" }}
				className="sidebar-entry"
				params={{ workspaceId: workspace.id }}
				to="/workspaces/$workspaceId"
			>
				<span className="sidebar-entry-head">
					{showState ? (
						<StatusDot
							activity={workspace.activity}
							status={workspace.status}
						/>
					) : null}
					{/* The name the agent gave the work, falling back to the container's.
					    `agent-c824` identifies a machine; a column of them is a column of nothing
					    to choose between, which is the whole reason a title exists. */}
					<span className="sidebar-entry-title">
						{named ? workspace.title : workspace.hostname}
					</span>
				</span>

				{/* The machine facts, under the title and indented past the dot. Mono, because
				    every one of them is an identifier rather than something a person wrote. */}
				<span className="sidebar-entry-meta">
					{named ? (
						<>
							<span className="sidebar-entry-host">{workspace.hostname}</span>
							<span aria-hidden="true" className="sidebar-entry-tick" />
						</>
					) : null}
					<span className="sidebar-entry-repo">
						{shortRepository(workspace.repository)}
					</span>
					<span className="sidebar-entry-age">
						<Elapsed since={workspace.createdAt} />
					</span>
				</span>
			</Link>
		</li>
	);
}
