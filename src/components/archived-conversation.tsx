import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";

import { transcriptQuery } from "../lib/queries";
import { AgentChat } from "./agent-chat";
import { PanelNote, PanelSpinner } from "./panel-state";

// NO_APPROVALS is shared so `AgentChat`'s memo sees the same array every render. A fresh `[]` per
// render would re-read the whole transcript each time anything above this re-rendered.
const NO_APPROVALS: never[] = [];

// ArchivedConversation is a destroyed workspace's conversation, read back from the database.
//
// The live page's renderer over a different source. The conversation was saved as the runner's
// raw messages, so it goes through the same harness reader the live feed uses and looks exactly
// as it did while the agent was running, minus anything that needed the agent to answer.
export function ArchivedConversation({
	workspaceId,
}: {
	workspaceId: string;
}): ReactNode {
	const { data, isError, isPending } = useQuery(
		transcriptQuery(workspaceId, true),
	);

	const messages = useMemo(
		() => (data ? (JSON.parse(data.messagesJson) as unknown[]) : []),
		[data],
	);

	if (isPending) {
		return <PanelSpinner label="Loading the saved conversation." />;
	}
	if (isError) {
		return (
			<PanelNote tone="warn">
				The saved conversation could not be loaded.
			</PanelNote>
		);
	}
	// Not an error. Every workspace destroyed before conversations were kept has none, and so does
	// one whose agent did not answer on the way out. The second kind has a timeline entry saying
	// so; the first has nothing to say, which is why this sentence does not point at the timeline.
	if (data === null) {
		return <PanelNote>No conversation was kept for this workspace.</PanelNote>;
	}

	return (
		<AgentChat
			approvals={NO_APPROVALS}
			busy={false}
			harness={data.harness}
			link="archived"
			messages={messages}
			// Nothing to decide: approvals are not kept, because nothing is waiting on them.
			onDecide={() => {}}
		/>
	);
}
