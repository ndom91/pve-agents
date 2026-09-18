import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { LogOut, Settings } from "lucide-react";
import { useState } from "react";

import { IconButton } from "../components/icon-button";
import { SidebarEntry } from "../components/sidebar-entry";
import { authClient } from "../lib/auth-client";
import { fleetQuery } from "../lib/queries";
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
	loader: ({ context }) => context.queryClient.ensureQueryData(fleetQuery()),
});

// DESTROYED_SHOWN caps the history group. The list is navigation, and destroyed workspaces already
// outnumber live ones many times over.
const DESTROYED_SHOWN = 15;

function Dashboard() {
	const { data: workspaces = [] } = useQuery(fleetQuery());
	const [signingOut, setSigningOut] = useState(false);

	async function signOut() {
		setSigningOut(true);
		try {
			await authClient.signOut();
			// Hard navigation rather than a client transition, so nothing cached from the old
			// session survives into the next one.
			window.location.href = "/login";
		} catch {
			setSigningOut(false);
		}
	}

	const live = workspaces.filter(
		(workspace) => workspace.status !== "destroyed",
	);
	const destroyed = workspaces
		.filter((workspace) => workspace.status === "destroyed")
		.slice(0, DESTROYED_SHOWN);

	return (
		<div className="dashboard">
			<aside className="dashboard-sidebar">
				<p className="eyebrow">PVE / HERDR</p>

				<nav>
					<p className="sidebar-label">Workspaces</p>
					{live.length === 0 ? (
						<p className="sidebar-empty">None running.</p>
					) : (
						<ul className="sidebar-list">
							{live.map((workspace) => (
								<SidebarEntry key={workspace.id} workspace={workspace} />
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
									<SidebarEntry
										key={workspace.id}
										showBadges={false}
										workspace={workspace}
									/>
								))}
							</ul>
						</details>
					)}
				</nav>

				<div className="sidebar-foot">
					<Link className="sidebar-new" to="/">
						+ New workspace
					</Link>
					<div className="sidebar-tools">
						{/* An anchor rather than an IconButton because it navigates. It borrows
						    the same class so the pair still reads as one control group. */}
						<Link
							aria-label="Settings"
							className="icon-button"
							title="Settings"
							to="/settings"
						>
							<Settings aria-hidden size={16} strokeWidth={1.75} />
						</Link>
						<IconButton
							disabled={signingOut}
							icon={LogOut}
							label="Sign out"
							onClick={signOut}
						/>
					</div>
				</div>
			</aside>

			<Outlet />
		</div>
	);
}
