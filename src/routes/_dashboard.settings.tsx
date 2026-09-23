import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { SettingsHarnesses } from "../components/settings-harnesses";
import { SettingsMaintenance } from "../components/settings-maintenance";
import { SettingsReaping } from "../components/settings-reaping";
import { SettingsSeedFiles } from "../components/settings-seed-files";
import { type Tab, TabStrip } from "../components/tab-strip";
import { settingsQuery } from "../lib/queries";

export const Route = createFileRoute("/_dashboard/settings")({
	component: Settings,
	// Auth is handled once by the _dashboard layout, so it is not repeated here.
	loader: ({ context }) => context.queryClient.ensureQueryData(settingsQuery()),
});

type SettingsTab = "agents" | "files" | "maintenance" | "reaping";

const TABS: Tab<SettingsTab>[] = [
	{ label: "Reaping", value: "reaping" },
	{ label: "Agents", value: "agents" },
	{ label: "Seed files", value: "files" },
	{ label: "Maintenance", value: "maintenance" },
];

// Settings is three unrelated concerns that used to be one scroll.
//
// Tabs rather than sections because the page had reached the point where a third concern meant
// nobody would find the second. Each tab owns its own state and its own server calls; this holds
// nothing but which one is open.
//
// That is deliberately local state and not a search param. A `?tab=` would survive a reload and be
// linkable, which is the better answer in the abstract, but it means `validateSearch` on a route
// and nothing here uses it yet. AGENTS.md records that a routing change can leave the page inert
// with all four checks passing, and the workspace rail already keeps its tab this way.
function Settings() {
	const [tab, setTab] = useState<SettingsTab>("reaping");

	return (
		<main className="dashboard-main dashboard-main-wide">
			<header className="settings-head">
				<h1>Settings</h1>
				<p className="workspace-purpose">
					Saved to the controller database and read on every pass, so a change
					applies without a restart.
				</p>
			</header>

			<TabStrip current={tab} onSelect={setTab} tabs={TABS} />

			{/* Unmounted rather than hidden, unlike the workspace rail. Nothing here holds a
			    connection that closing would break, and the orphan scan should not keep a stale
			    result alive behind a tab nobody is looking at. */}
			{tab === "agents" ? <SettingsHarnesses /> : null}
			{tab === "reaping" ? <SettingsReaping /> : null}
			{tab === "files" ? <SettingsSeedFiles /> : null}
			{tab === "maintenance" ? <SettingsMaintenance /> : null}
		</main>
	);
}
