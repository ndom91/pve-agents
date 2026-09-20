import { queryOptions } from "@tanstack/react-query";

import { workspaceChanges, workspaceFileDiff } from "../server/agent.functions";
import { listSeedFiles, readSeedFile } from "../server/seed-files.functions";
import { workspaceSettings } from "../server/settings.functions";
import { controllerStatus } from "../server/status.functions";
import { listWorkspaces, workspaceDetail } from "../server/workspace.functions";

// Cadences live together rather than beside whichever component happened to need one, because the
// interesting property is the ratio between them: a database read is cheap and a screen read opens
// an SSH connection to a workspace.
//
// FLEET_REFRESH_MS is half the worker interval, so a step lands on screen within about one tick.
const FLEET_REFRESH_MS = 2_500;

// CHANGES_REFRESH_MS is how often the list of changed files is re-read while it is on screen.
//
// Far slower than the fleet poll because each one is an SSH connection and a `git status`, and a
// diff moves when the agent finishes a turn rather than continuously. Only runs while the tab is
// actually open.
const CHANGES_REFRESH_MS = 15_000;

// workspaceKeys keeps every key in one place, so an invalidation cannot miss by a typo.
export const workspaceKeys = {
	changes: (id: string) => ["workspace", id, "changes"] as const,
	detail: (id: string) => ["workspace", id] as const,
	file: (id: string, path: string) => ["workspace", id, "file", path] as const,
	list: () => ["workspaces"] as const,
	seedFile: (id: string) => ["seed-files", id] as const,
	seedFiles: () => ["seed-files"] as const,
	settings: () => ["settings"] as const,
	status: () => ["controller-status"] as const,
};

// fleetQuery is the workspace list the sidebar navigates by.
//
// The interval is a function of the query's own data rather than a flag passed in, because the
// answer depends on what was last fetched. Passing a boolean would mean a second read of the same
// key somewhere else to compute it, which is the duplication Query is here to remove.
export function fleetQuery() {
	return queryOptions({
		queryFn: () => listWorkspaces(),
		queryKey: workspaceKeys.list(),
		refetchInterval: (query) =>
			watchable(query.state.data) ? FLEET_REFRESH_MS : false,
		refetchIntervalInBackground: false,
	});
}

// watchable reports whether anything in the fleet can still change.
//
// "ready" counts: a ready workspace holds no operation, but its agent's activity keeps moving, and
// that is exactly when the fleet is most worth watching. Destroyed and failed are the only states
// nothing further happens from on its own.
function watchable(workspaces?: { status: string }[]): boolean {
	return (workspaces ?? []).some(
		(workspace) =>
			workspace.status !== "destroyed" && workspace.status !== "failed",
	);
}

// workspaceQuery is one workspace's record and timeline.
export function workspaceQuery(id: string) {
	return queryOptions({
		queryFn: () => workspaceDetail({ data: { id } }),
		queryKey: workspaceKeys.detail(id),
		refetchInterval: (query) =>
			settled(query.state.data?.status) ? false : FLEET_REFRESH_MS,
		refetchIntervalInBackground: false,
	});
}

// settled marks a workspace nothing further happens to, so its page stops asking.
function settled(status?: string): boolean {
	return status === "destroyed" || status === "failed";
}

// changesQuery holds what the agent has done to the checkout.
//
// Gated on the tab being open rather than merely on the workspace being ready: every fetch is an
// SSH connection, and polling one for a panel nobody is looking at would put a connection per
// workspace per fifteen seconds on the controller for no one's benefit.
export function changesQuery(id: string, open: boolean) {
	return queryOptions({
		enabled: open,
		queryFn: () => workspaceChanges({ data: { id } }),
		queryKey: workspaceKeys.changes(id),
		refetchInterval: open ? CHANGES_REFRESH_MS : false,
	});
}

// fileDiffQuery holds one file as it was and as it is.
//
// Fetched only once a file is selected, and never refetched on an interval: a file is read to be
// read, and having it change under the reader mid-scroll would be worse than it being a minute old.
export function fileDiffQuery(id: string, path?: string) {
	return queryOptions({
		enabled: path !== undefined,
		queryFn: () => workspaceFileDiff({ data: { id, path: path ?? "" } }),
		queryKey: workspaceKeys.file(id, path ?? ""),
		refetchInterval: false,
	});
}

// statusQuery holds whether the controller will act on anything at all.
//
// Refreshed on the same cadence as the fleet while work is in flight, because the two answer one
// question between them: the fleet says what exists, this says whether it is being advanced. A
// controller with its worker off looks identical to a busy one from the fleet list alone.
export function statusQuery() {
	return queryOptions({
		queryFn: () => controllerStatus(),
		queryKey: workspaceKeys.status(),
		refetchInterval: (query) =>
			(query.state.data?.activeOperations ?? 0) > 0 ? FLEET_REFRESH_MS : false,
		refetchIntervalInBackground: false,
	});
}

export function settingsQuery() {
	return queryOptions({
		queryFn: () => workspaceSettings(),
		queryKey: workspaceKeys.settings(),
	});
}

// seedFilesQuery is what every new workspace will be seeded with.
//
// No interval. Nothing changes this but the operator sitting in front of it, and the mutations
// invalidate the key themselves.
export function seedFilesQuery() {
	return queryOptions({
		queryFn: () => listSeedFiles(),
		queryKey: workspaceKeys.seedFiles(),
	});
}

// seedFileQuery is one file's body, fetched when its row is opened.
//
// Per row rather than with the list, so a page of twenty files costs twenty sizes and nothing else
// until somebody opens one. The cache makes reopening free.
export function seedFileQuery(id: string) {
	return queryOptions({
		queryFn: () => readSeedFile({ data: { id } }),
		queryKey: workspaceKeys.seedFile(id),
	});
}
