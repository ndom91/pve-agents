import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";

import { transcriptQuery } from "../lib/queries";
import { AgentChat } from "./agent-chat";
import { PanelNote, PanelSpinner } from "./panel-state";

// Module-level so `AgentChat`'s memo sees the same array each render; a fresh `[]` would re-read
// the whole transcript every time.
const NO_APPROVALS: never[] = [];

// Nothing to decide: approvals are not kept, because nothing is waiting on them.
function noDecision(): void {}

// ArchivedConversation is a destroyed workspace's conversation, read back from the database.
//
// Saved as the runner's raw messages, so it goes through the same harness reader as the live feed
// and looks as it did while the agent ran.
export function ArchivedConversation({
  workspaceId,
}: {
  workspaceId: string;
}): ReactNode {
  const { data, isError, isPending } = useQuery(transcriptQuery(workspaceId));

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
      onDecide={noDecision}
    />
  );
}
