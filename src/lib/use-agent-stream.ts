import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { ApprovalRequest, RunnerEvent } from "../domain/runner-protocol";
import { readEvent } from "../domain/runner-protocol";
import { mapActivity } from "../domain/workspace";
import { type AgentTail, isPartial, readTail } from "./agent-tail";

export type { AgentTail } from "./agent-tail";

import { workspaceKeys } from "./queries";

// Approval is one tool call the agent is suspended on.
//
// The runner's own shape rather than a copy of it. It was a hand-written twin, which meant a field
// added on one side arrived as undefined on the other with nothing to say so.
export type Approval = ApprovalRequest;

// AgentState is everything a page knows about one workspace's agent.
export type AgentState = {
	approvals: Approval[];
	link: "attached" | "gone" | "opening";
	messages: unknown[];
	permissionMode?: string;
	status?: string;
	tail?: AgentTail;
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

			if (value.type === "snapshot" || value.type === "status") {
				// The observed status replaces whatever the last optimistic guess was, which is how
				// a prediction gets corrected rather than left standing.
				queryClient.setQueryData(
					workspaceKeys.detail(workspaceId),
					(previous: { activity: string } | undefined) =>
						previous === undefined
							? previous
							: { ...previous, activity: mapActivity(value.status) },
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
function reduce(state: AgentState, event: RunnerEvent): AgentState {
	// Worked out for every event, because the rule about when a half-written block is replaced is
	// one rule rather than one per branch.
	const tail = readTail(state.tail, event);

	if (event.type === "snapshot") {
		// A replacement, not a merge. The snapshot is the runner's whole truth, and it arrives
		// again on every reconnection: merging would double the transcript each time the
		// connection blipped.
		return {
			approvals: event.approvals,
			link: "attached",
			messages: event.messages,
			permissionMode: event.permissionMode,
			status: event.status,
			tail,
		};
	}

	if (event.type === "message") {
		// A token delta feeds the tail and is then thrown away.
		//
		// Never appended to `messages`: one reasoning turn produces several hundred of them
		// against a dozen entries worth showing, and `readTranscript` ignores them, so keeping
		// them grew the list without bound for data nothing rendered.
		return isPartial(event.message)
			? { ...state, tail }
			: { ...state, messages: [...state.messages, event.message], tail };
	}

	if (event.type === "approval") {
		return { ...state, approvals: [...state.approvals, event.approval], tail };
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
		return { ...state, status: event.status, tail };
	}

	if (event.type === "detached") {
		// Said out loud. A runner that has gone away otherwise leaves a page that looks merely
		// quiet, and an operator waiting on an agent that no longer exists.
		return { ...state, link: "gone" };
	}

	return { ...state, tail };
}

function parse(data: string): RunnerEvent | undefined {
	try {
		return readEvent(JSON.parse(data));
	} catch {
		return undefined;
	}
}
