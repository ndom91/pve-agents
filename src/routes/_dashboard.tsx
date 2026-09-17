import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
} from "@tanstack/react-router";

import { WorkspaceBadges } from "../components/workspace-badges";
import { fleetQuery, statusQuery } from "../lib/queries";
import { sessionState } from "../server/session.functions";

export const Route = createFileRoute("/_dashboard")({
	// Runs on every navigation, including client-side transitions, so a session that expires
	// mid-visit redirects rather than leaving a dead page behind.
	beforeLoad: async () => {
		const state = await sessionState();
		if (state.required && !state.signedIn) {
			throw redirect({ to: "/login" });
		}
	},
	component: Dashboard,
	// Primed rather than fetched: the component reads the same key, so the first paint has data
	// and hydration does not refetch it.
	loader: async ({ context }) => {
		await Promise.all([
			context.queryClient.ensureQueryData(fleetQuery()),
			context.queryClient.ensureQueryData(statusQuery()),
		]);
	},
});

// DESTROYED_SHOWN caps the history group. The list is navigation, and destroyed workspaces already
// outnumber live ones many times over.
const DESTROYED_SHOWN = 15;

function Dashboard() {
	const { data: status } = useQuery(statusQuery());
	const { data: workspaces = [] } = useQuery(fleetQuery());

	const live = workspaces.filter(
		(workspace) => workspace.status !== "destroyed",
	);
	const destroyed = workspaces
		.filter((workspace) => workspace.status === "destroyed")
		.slice(0, DESTROYED_SHOWN);

	return (
		<div className="dashboard">
			<aside className="dashboard-sidebar">
				<div className="sidebar-head">
					<p className="eyebrow">PVE / HERDR</p>
					<Link to="/settings">Settings</Link>
				</div>

				<nav>
					<p className="sidebar-label">Workspaces</p>
					{live.length === 0 ? (
						<p className="sidebar-empty">None running.</p>
					) : (
						<ul className="sidebar-list">
							{live.map((workspace) => (
								<li key={workspace.id}>
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
										<span className="sidebar-badges">
											<WorkspaceBadges
												activity={workspace.activity}
												status={workspace.status}
											/>
										</span>
									</Link>
								</li>
							))}
						</ul>
					)}

					{destroyed.length === 0 ? null : (
						<details className="sidebar-destroyed">
							<summary>
								Destroyed<span>{destroyed.length}</span>
							</summary>
							<ul className="sidebar-list">
								{destroyed.map((workspace) => (
									<li key={workspace.id}>
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
										</Link>
									</li>
								))}
							</ul>
						</details>
					)}
				</nav>

				<Link className="sidebar-new" to="/">
					+ New workspace
				</Link>

				<p className="sidebar-mode">
					{status?.provisioningEnabled
						? status.workerEnabled
							? "Provisioning enabled"
							: "Worker stopped"
						: "Provisioning disabled"}
				</p>
			</aside>

			<Outlet />
		</div>
	);
}

// shortRepository drops the host, which is the same for every workspace and so carries nothing.
function shortRepository(repository: string): string {
	return repository.replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
}
