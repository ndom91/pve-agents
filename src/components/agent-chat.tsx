import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import {
	readTranscript,
	type TranscriptEntry,
} from "../domain/agent-transcript";
import type { Approval } from "../lib/use-agent-stream";
import { Button } from "./button";

// AgentChat is the conversation, where the terminal used to be.
//
// Built by hand rather than from a chat library, and that was a decision rather than an oversight.
// The two candidates were Vercel's AI Elements, which is Tailwind-on-shadcn source copied into
// your repo — this application has no Tailwind and 1600 lines of its own CSS — and TanStack AI,
// whose UI layer ships no markup at all by design. What either would have contributed is a
// collapsible row, which `changes-accordion.tsx` beside this file already is.
//
// What was worth taking is the vocabulary: the tool states below are AI Elements', because it had
// already worked out the six facts a reader needs and a fifth spelling of them helps nobody.
export function AgentChat({
	approvals,
	busy,
	link,
	messages,
	onDecide,
	permissionMode,
}: {
	approvals: Approval[];
	busy: boolean;
	link: "attached" | "gone" | "opening";
	messages: unknown[];
	onDecide: (approvalId: string, behavior: "allow" | "deny") => void;
	permissionMode?: string;
}): ReactNode {
	const entries = readTranscript(messages, approvals);

	return (
		<div className="agent-chat">
			<Rail entries={entries} />

			{/* Below the transcript, not inside it. An approval is the newest thing that happened
			    and the only thing that needs an answer, so it sits where the eye lands last. */}
			{approvals.map((approval) => (
				<ApprovalCard
					approval={approval}
					busy={busy}
					key={approval.id}
					onDecide={onDecide}
					permissionMode={permissionMode}
				/>
			))}

			{link === "gone" ? (
				<p className="detail-note">
					The agent runner is no longer answering. Its session ended with it.
				</p>
			) : null}
			{link === "opening" && entries.length === 0 ? (
				<p className="detail-note">Attaching to the agent.</p>
			) : null}
			{link === "attached" && entries.length === 0 ? (
				<p className="detail-note">
					Nothing has happened yet. Tell the agent what to do.
				</p>
			) : null}
		</div>
	);
}

// Rail is the transcript itself, pinned to the bottom while it grows.
function Rail({ entries }: { entries: TranscriptEntry[] }) {
	const end = useRef<HTMLDivElement>(null);
	// Whether the reader is at the bottom. Scrolling on every append would yank somebody out of
	// the middle of a tool result they had scrolled back to read, which is the commonest reason to
	// scroll back at all.
	const pinned = useRef(true);

	useEffect(() => {
		if (pinned.current) {
			end.current?.scrollIntoView({ block: "end" });
		}
	}, []);

	return (
		<ol
			className="chat-entries"
			onScroll={(event) => {
				const box = event.currentTarget;
				pinned.current =
					box.scrollHeight - box.scrollTop - box.clientHeight < 40;
			}}
		>
			{entries.map((entry, index) => (
				<li
					className={`chat-entry is-${entry.kind}`}
					// Position is the only stable identity a text entry has: the same sentence can
					// legitimately appear twice, and entries are never reordered or removed.
					key={entry.kind === "tool" ? entry.id : `${entry.kind}-${index}`}
				>
					<Entry entry={entry} />
				</li>
			))}
			<div ref={end} />
		</ol>
	);
}

function Entry({ entry }: { entry: TranscriptEntry }) {
	if (entry.kind === "tool") {
		return <ToolRow entry={entry} />;
	}
	if (entry.kind === "thought") {
		return <Fold summary="Thought" text={entry.text} />;
	}
	if (entry.kind === "ended") {
		return <p className="chat-ended">The turn ended: {entry.reason}</p>;
	}

	return <p className="chat-text">{entry.text}</p>;
}

// ToolRow is one tool call and, folded under it, what it returned.
//
// Collapsed by default because a transcript is mostly these, and a page that opens every result is
// a page of file contents with the reasoning lost between them.
function ToolRow({
	entry,
}: {
	entry: Extract<TranscriptEntry, { kind: "tool" }>;
}) {
	return (
		<Fold
			// Failures open on their own. A closed row saying "Error" asks the reader to go and
			// find out what went wrong; the reason is the entire content of that row.
			open={entry.state === "error"}
			state={entry.state}
			summary={`${entry.name} ${describe(entry.input)}`.trim()}
			text={entry.result ?? ""}
		/>
	);
}

// Fold is the disclosure this page uses everywhere: a summary row, and content under it.
function Fold({
	open = false,
	state,
	summary,
	text,
}: {
	open?: boolean;
	state?: string;
	summary: string;
	text: string;
}) {
	const [shown, setShown] = useState(open);
	const empty = text.trim() === "";

	return (
		<>
			<button
				aria-expanded={shown}
				className={state === undefined ? "chat-fold" : `chat-fold is-${state}`}
				// Nothing to unfold. Still a row, because the call happened and belongs in the
				// order of events, but not a control that does nothing when clicked.
				disabled={empty}
				onClick={() => setShown((was) => !was)}
				type="button"
			>
				<ChevronRight aria-hidden className="chat-caret" size={12} />
				<span className="chat-summary">{summary}</span>
				{state === undefined ? null : (
					<span className="chat-state">{label(state)}</span>
				)}
			</button>
			{shown && !empty ? <pre className="chat-output">{text}</pre> : null}
		</>
	);
}

// ApprovalCard is the question the whole control plane exists to ask.
function ApprovalCard({
	approval,
	busy,
	onDecide,
	permissionMode,
}: {
	approval: Approval;
	busy: boolean;
	onDecide: (approvalId: string, behavior: "allow" | "deny") => void;
	permissionMode?: string;
}) {
	return (
		<div className="chat-approval">
			{/* The runner composes this sentence itself — "Claude wants to read foo.txt" — so it is
			    shown rather than rebuilt from the tool name and its input. Rebuilding means writing
			    a renderer per tool and getting it quietly wrong for the ones nobody tested. */}
			<p className="chat-approval-title">
				{approval.title ?? `${approval.displayName ?? approval.toolName}`}
			</p>
			{approval.decisionReason === undefined ? null : (
				<p className="chat-approval-why">{approval.decisionReason}</p>
			)}
			<pre className="chat-output">
				{JSON.stringify(approval.input, null, 2)}
			</pre>
			<div className="chat-approval-actions">
				<Button
					disabled={busy}
					onClick={() => onDecide(approval.id, "allow")}
					type="button"
				>
					Allow
				</Button>
				<Button
					className="chat-decline"
					disabled={busy}
					onClick={() => onDecide(approval.id, "deny")}
					type="button"
				>
					Decline
				</Button>
			</div>
			{/* Only when it is not the mode that was asked for. Auto mode falls back to asking
			    about everything when it is unavailable, and without this the page just seems to
			    have become tediously cautious for no reason anybody can see. */}
			{permissionMode === "auto" ? (
				<p className="chat-approval-why">
					Auto mode asked about this one rather than deciding it.
				</p>
			) : null}
		</div>
	);
}

// describe reduces a tool's input to the part worth putting on a closed row.
//
// A path or a command, not the whole object: the object is what unfolding shows, and a summary
// wide enough to hold it is not a summary.
function describe(input: Record<string, unknown>): string {
	for (const key of ["file_path", "command", "path", "pattern", "url"]) {
		const value = input[key];
		if (typeof value === "string" && value !== "") {
			return value.length > 80 ? `${value.slice(0, 80)}…` : value;
		}
	}

	return "";
}

function label(state: string): string {
	switch (state) {
		case "awaiting-approval":
			return "waiting on you";
		case "denied":
			return "declined";
		case "error":
			return "error";
		case "ok":
			return "done";
		default:
			return "running";
	}
}
