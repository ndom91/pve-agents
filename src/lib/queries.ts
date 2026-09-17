import { queryOptions } from "@tanstack/react-query";

import { workspacePane } from "../server/agent.functions";
import { workspaceSettings } from "../server/settings.functions";
import { controllerStatus } from "../server/status.functions";
import { listWorkspaces, workspaceDetail } from "../server/workspace.functions";

// Cadences live together rather than beside whichever component happened to need one, because the
// interesting property is the ratio between them: a database read is cheap and a screen read opens
// an SSH connection to a workspace.
//
// FLEET_REFRESH_MS is half the worker interval, so a step lands on screen within about one tick.
const FLEET_REFRESH_MS = 2_500;

// SCREEN_REFRESH_MS is slower on purpose. A terminal that changed a second ago will still have
// changed in five, and each read costs a connection to the container.
const SCREEN_REFRESH_MS = 5_000;

// workspaceKeys keeps every key in one place, so an invalidation cannot miss by a typo.
export const workspaceKeys = {
	detail: (id: string) => ["workspace", id] as const,
	list: () => ["workspaces"] as const,
	pane: (id: string) => ["workspace", id, "pane"] as const,
	settings: () => ["settings"] as const,
	status: () => ["status"] as const,
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

export function statusQuery() {
	return queryOptions({
		queryFn: () => controllerStatus(),
		queryKey: workspaceKeys.status(),
		refetchInterval: FLEET_REFRESH_MS,
		refetchIntervalInBackground: false,
	});
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

// paneQuery holds the agent's screen.
//
// Fetched once for a first paint, then fed by the event stream rather than polled: a fixed
// interval is either too slow to catch a turn or too expensive to run all day, which is the
// problem the stream exists to solve. The initial fetch stays so the page has something before
// the stream's first message.
export function paneQuery(id: string, ready: boolean) {
	return queryOptions({
		enabled: ready,
		queryFn: () => workspacePane({ data: { id } }),
		queryKey: workspaceKeys.pane(id),
		refetchInterval: false,
		staleTime: SCREEN_REFRESH_MS,
	});
}

export function settingsQuery() {
	return queryOptions({
		queryFn: () => workspaceSettings(),
		queryKey: workspaceKeys.settings(),
	});
}
