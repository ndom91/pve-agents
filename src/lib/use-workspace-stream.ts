import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { WorkspacePane } from "../server/agent.functions";
import { workspaceKeys } from "./queries";

type Snapshot = { activity: string; screen: string };

// useWorkspaceStream feeds a workspace's live screen and activity into the query cache.
//
// Components keep using useQuery and never learn the data arrived by push rather than by poll,
// which is what makes this swappable: a WebSocket later changes this file and nothing else.
export function useWorkspaceStream(
	workspaceId: string,
	enabled: boolean,
): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		if (!enabled) {
			return;
		}

		const source = new EventSource(`/api/workspaces/${workspaceId}/stream`);

		source.onmessage = (event) => {
			const snapshot = parse(event.data);
			if (snapshot === undefined) {
				return;
			}

			const pane: WorkspacePane = { kind: "screen", text: snapshot.screen };
			queryClient.setQueryData<WorkspacePane>(
				workspaceKeys.pane(workspaceId),
				pane,
			);

			// The observed activity replaces whatever the last optimistic guess was, which is how
			// a prediction gets corrected rather than left standing.
			queryClient.setQueryData(
				workspaceKeys.detail(workspaceId),
				(previous: { activity: string } | undefined) =>
					previous === undefined
						? previous
						: { ...previous, activity: snapshot.activity },
			);
		};

		// EventSource reconnects on its own with backoff, so an error is not handled here beyond
		// leaving the last known screen on display. Closing it would turn a blip into a dead page.
		return () => source.close();
	}, [enabled, queryClient, workspaceId]);
}

function parse(data: string): Snapshot | undefined {
	try {
		const value = JSON.parse(data) as Partial<Snapshot>;

		return typeof value.activity === "string" &&
			typeof value.screen === "string"
			? { activity: value.activity, screen: value.screen }
			: undefined;
	} catch {
		return undefined;
	}
}
