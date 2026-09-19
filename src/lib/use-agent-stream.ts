import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { workspaceKeys } from "./queries";

// Approval is one tool call the agent is suspended on.
export type Approval = {
	decisionReason?: string;
	displayName?: string;
	id: string;
	input: Record<string, unknown>;
	title?: string;
	toolName: string;
};

// AgentState is everything a page knows about one workspace's agent.
export type AgentState = {
	approvals: Approval[];
	link: "attached" | "gone" | "opening";
	messages: unknown[];
	permissionMode?: string;
	sessionId?: string;
	status?: string;
};

const EMPTY: AgentState = { approvals: [], link: "opening", messages: [] };

// useAgentStream holds one workspace's transcript, fed by the runner.
//
// Component state rather than the query cache, unlike the screen stream beside it. A screen is one
// value that replaces itself; a transcript is a list that only grows, and pushing every appended
// message through a cache entry would re-serialise the whole history on each one.
//
// Activity still goes to the cache, because the rest of the page reads it from there: the sidebar,
// the badges, and the controls gated on a blocked agent.
export function useAgentStream(
	workspaceId: string,
	enabled: boolean,
): AgentState {
	const [state, setState] = useState<AgentState>(EMPTY);
	const queryClient = useQueryClient();

	useEffect(() => {
		if (!enabled) {
			return;
		}

		// Reset on the way in. Without it, navigating between two workspaces shows the previous
		// one's transcript until the new snapshot lands, which reads as the wrong agent answering.
		setState(EMPTY);

		const source = new EventSource(`/api/workspaces/${workspaceId}/agent`);

		source.onmessage = (event) => {
			const value = parse(event.data);
			if (value === undefined) {
				return;
			}

			if (typeof value.status === "string") {
				// The observed status replaces whatever the last optimistic guess was, which is how
				// a prediction gets corrected rather than left standing.
				queryClient.setQueryData(
					workspaceKeys.detail(workspaceId),
					(previous: { activity: string } | undefined) =>
						previous === undefined
							? previous
							: { ...previous, activity: activityOf(value.status as string) },
				);
			}

			setState((previous) => reduce(previous, value));
		};

		// EventSource reconnects on its own with backoff, so an error is not handled beyond leaving
		// the last known transcript on display. Closing it would turn a blip into a dead page, and
		// the reconnect replays the snapshot anyway.
		return () => source.close();
	}, [enabled, queryClient, workspaceId]);

	return state;
}

// reduce folds one event into what the page knows.
function reduce(state: AgentState, event: Record<string, unknown>): AgentState {
	if (event.type === "snapshot") {
		// A replacement, not a merge. The snapshot is the runner's whole truth, and it arrives
		// again on every reconnection: merging would double the transcript each time the
		// connection blipped.
		return {
			approvals: (event.approvals as Approval[]) ?? [],
			link: "attached",
			messages: (event.messages as unknown[]) ?? [],
			permissionMode: event.permissionMode as string | undefined,
			sessionId: event.sessionId as string | undefined,
			status: event.status as string | undefined,
		};
	}

	if (event.type === "message") {
		return { ...state, messages: [...state.messages, event.message] };
	}

	if (event.type === "approval") {
		return {
			...state,
			approvals: [...state.approvals, event.approval as Approval],
		};
	}

	if (event.type === "resolved") {
		// Dropped for everybody, not just whoever answered. Two open pages on one workspace must
		// not both keep offering a decision that has been made.
		return {
			...state,
			approvals: state.approvals.filter((approval) => approval.id !== event.id),
		};
	}

	if (event.type === "status") {
		return { ...state, status: event.status as string };
	}

	if (event.type === "detached") {
		// Said out loud. A runner that has gone away otherwise leaves a page that looks merely
		// quiet, and an operator waiting on an agent that no longer exists.
		return { ...state, link: "gone" };
	}

	return state;
}

// activityOf maps the runner's words onto the workspace vocabulary the rest of the page reads.
//
// The same mapping the server does, because the cache it writes into is the same one the server's
// own writes land in, and two spellings of "blocked" would make the controls flicker.
function activityOf(status: string): string {
	switch (status) {
		case "working":
			return "active";
		case "blocked":
			return "blocked";
		case "idle":
			return "idle";
		default:
			return "unknown";
	}
}

function parse(data: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(data) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}
