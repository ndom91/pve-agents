import type { ReactNode } from "react";

import { useAgentStream } from "../lib/use-agent-stream";
import { AgentChat } from "./agent-chat";

// AgentConversation is the conversation plus the socket that feeds it.
//
// It exists to own `useAgentStream`, and that is the whole job. The hook used to be called by the
// workspace route, which put the stream's tail in the route's own state -- so every token the agent
// streamed re-rendered the top bar, the meta band, the composer, the right panel, and every rail
// tab that had ever been opened. The rail keeps opened tabs mounted so the terminal's socket
// survives a glance elsewhere, which meant a timeline nobody was looking at was being regrouped and
// re-formatted once per word.
//
// Memoising the expensive parts helped and did not fix it: the renders were still happening, they
// were just cheaper. Moving the hook down one level stops them reaching anything but the feed.
//
// Deliberately separate from `AgentChat` rather than folded into it. AgentChat takes messages and
// renders them, which is what makes it testable without a server; a component that opens a socket
// is not.
export function AgentConversation({
	busy,
	onDecide,
	workspaceId,
}: {
	busy: boolean;
	onDecide: (approvalId: string, behavior: "allow" | "deny") => void;
	workspaceId: string;
}): ReactNode {
	// `true`, not a prop. The caller only renders this once the workspace is ready, so a `ready`
	// prop here looked like a gate and gated nothing -- the second argument could never be false,
	// and unmounting is what actually stops the stream. A prop that cannot change is worse than
	// no prop: the next person passes `false` and is surprised.
	const agent = useAgentStream(workspaceId, true);

	return (
		<AgentChat
			approvals={agent.approvals}
			busy={busy}
			link={agent.link}
			messages={agent.messages}
			onDecide={onDecide}
			permissionMode={agent.permissionMode}
			tail={agent.tail}
		/>
	);
}
