import { createFileRoute } from "@tanstack/react-router";
import { Suspense, useState } from "react";

import { PanelSpinner } from "../components/panel-state";
import { SettingsHarnesses } from "../components/settings-harnesses";
import { SettingsMaintenance } from "../components/settings-maintenance";
import { SettingsReaping } from "../components/settings-reaping";
import { SettingsSeedFiles } from "../components/settings-seed-files";
import { type Tab, TabStrip } from "../components/tab-strip";
import {
	harnessesQuery,
	harnessKindsQuery,
	settingsQuery,
} from "../lib/queries";

export const Route = createFileRoute("/_dashboard/settings")({
	component: Settings,
	// Auth is handled once by the _dashboard layout, so it is not repeated here.
	//
	// All three keys the tabs read with useSuspenseQuery, not just the one the first tab needs.
	// That is the contract those calls are written against -- settings-reaping says so in as many
	// words -- and the Agents tab was reading two keys nobody had ensured, so opening it suspended
	// a component with no boundary above it and blanked the whole route until the fetch landed.
	loader: async ({ context }) => {
		await Promise.all([
			context.queryClient.ensureQueryData(settingsQuery()),
			context.queryClient.ensureQueryData(harnessesQuery()),
			context.queryClient.ensureQueryData(harnessKindsQuery()),
		]);
	},
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
			{/* The boundary the loader above should mean nobody reaches, and the reason it is here
			    anyway: a useSuspenseQuery whose key has been evicted suspends, and without this the
			    nearest boundary is the router's, which unmounts the page -- content gone, sidebar
			    reset, indistinguishable from a reload. A spinner in the panel is the honest version
			    of the same wait, and it covers whatever tab is added next. */}
			<Suspense fallback={<PanelSpinner label="Loading settings." />}>
				{tab === "agents" ? <SettingsHarnesses /> : null}
				{tab === "reaping" ? <SettingsReaping /> : null}
				{tab === "files" ? <SettingsSeedFiles /> : null}
				{tab === "maintenance" ? <SettingsMaintenance /> : null}
			</Suspense>
		</main>
	);
}
