import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { Bell, ChevronRight, LogOut, Plus, Settings } from "lucide-react";
import { useState } from "react";

import { IconButton, IconLink } from "../components/icon-button";
import { SectionHead } from "../components/section-head";
import { SidebarEntry } from "../components/sidebar-entry";
import { ThemeToggle } from "../components/theme-toggle";
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
	const gone = workspaces.filter(
		(workspace) => workspace.status === "destroyed",
	);
	// The list is capped; the count is not. It said 15 on a controller that had destroyed forty-
	// five, because it was counting the slice rather than the fleet.
	const destroyed = gone.slice(0, DESTROYED_SHOWN);

	return (
		<div className="dashboard">
			<aside className="dashboard-sidebar">
				{/* The application's own name, on its own line, against the hairline that starts
				    the column. It was an eyebrow floating above the first group, which read as a
				    label belonging to that group rather than to the window. */}
				<div className="sidebar-head">
					{/* The product's own mark, from public/. It was a line glyph copied out of the
					    mockup, which was a stand-in for exactly this. Decorative beside the
					    wordmark that names the same thing, so it is hidden from the accessibility
					    tree rather than given alt text that would be read twice. */}
					<img alt="" className="sidebar-mark" src="/icon1.png" />
					<span className="sidebar-wordmark">PVE&middot;AGENTS</span>
				</div>

				{blocked.length === 0 ? null : (
					<p className="sidebar-waiting">
						{blocked.length === 1
							? "1 agent is waiting"
							: `${blocked.length} agents are waiting`}
					</p>
				)}

				<nav className="sidebar-nav">
					<div className="sidebar-section">
						<SectionHead count={live.length} label="Running" />
						{live.length === 0 ? (
							<p className="sidebar-empty">None running.</p>
						) : (
							<ul className="sidebar-list">
								{live.map((workspace) => (
									<SidebarEntry key={workspace.id} workspace={workspace} />
								))}
							</ul>
						)}
					</div>

					{gone.length === 0 ? null : (
						<div className="sidebar-section">
							{/* The head stays put and the list folds under it, rather than the head
							    itself being the control. A count that only appears once you have
							    opened the thing it counts is not much of a count. */}
							<SectionHead count={gone.length} label="Destroyed" />
							<details className="sidebar-archive">
								<summary className="sidebar-archive-toggle">
									<ChevronRight
										aria-hidden="true"
										className="sidebar-archive-caret"
										size={9}
										strokeWidth={1.3}
									/>
									<span>show archive</span>
								</summary>
								<ul className="sidebar-list">
									{destroyed.map((workspace) => (
										<SidebarEntry
											key={workspace.id}
											showState={false}
											workspace={workspace}
										/>
									))}
								</ul>
							</details>
						</div>
					)}
				</nav>

				<div className="sidebar-foot">
					{/* "New", not "New workspace". The footer has gained an icon button each time
					    one was needed -- settings, notifications, sign out, now the theme -- and
					    the label was the only thing left that could give up room. The plus says
					    what the word no longer has space to. */}
					<Link className="sidebar-new" to="/">
						<Plus aria-hidden="true" size={12} strokeWidth={1.5} />
						<span>New</span>
					</Link>
					<div className="sidebar-tools">
						<ThemeToggle />
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
