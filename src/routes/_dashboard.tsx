import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { Bell, LogOut, Settings } from "lucide-react";
import { useState } from "react";

import { IconButton, IconLink } from "../components/icon-button";
import { SidebarEntry } from "../components/sidebar-entry";
import { authClient } from "../lib/auth-client";
import { fleetQuery } from "../lib/queries";
import { useBlockedAlerts } from "../lib/use-blocked-alerts";
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
	// A blocked workspace is exempt from reaping, so it waits until a person ends it. This is what
	// makes that person aware there is something to end.
	const { blocked, permission, requestPermission } =
		useBlockedAlerts(workspaces);
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

				{blocked.length === 0 ? null : (
					<p className="sidebar-waiting">
						{blocked.length === 1
							? "1 agent is waiting"
							: `${blocked.length} agents are waiting`}
					</p>
				)}

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
						{/* A link rather than a button because it navigates, and IconLink so the
						    appearance comes from the same place as the buttons beside it. */}
						<IconLink icon={Settings} label="Settings" to="/settings" />
						{/* Offered only while it would do something. Browsers require a gesture to
						    ask, so this is a button rather than a prompt on load, and it disappears
						    once answered either way. */}
						{permission !== "prompt" ? null : (
							<IconButton
								icon={Bell}
								label="Notify me when an agent is waiting"
								onClick={requestPermission}
							/>
						)}
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
