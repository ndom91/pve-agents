import type { RunnerEvent } from "../domain/runner-protocol";

// AgentTail is the block the agent is writing right now, as far as it has got.
//
// Separate from the transcript rather than appended to it, because it is not a message yet. It is
// replaced by the real one the moment the block completes, and rendering it as though it were
// already part of the transcript would show the same paragraph twice for a frame.
export type AgentTail = { kind: "say" | "thought"; text: string };

// readTail folds one event into the block being written.
//
// A pure function rather than three branches inside the hook's reducer, because the rule that
// matters here is about *when the tail is replaced* and that is the part worth being able to hold
// still in a test: too late and a paragraph appears twice, too early and text flickers out and
// back as it is being read.
export function readTail(
	tail: AgentTail | undefined,
	event: RunnerEvent,
): AgentTail | undefined {
	// The whole truth, and it has no half-written block in it.
	if (event.type === "snapshot") {
		return undefined;
	}
	if (event.type !== "message") {
		return tail;
	}

	const delta = deltaOf(event.message);
	if (delta !== undefined) {
		// The change of kind is the boundary between one block and the next. An agent that stops
		// thinking and starts writing has ended one and begun another, and running the two
		// together would put its reasoning and its answer in the same paragraph.
		return tail?.kind === delta.kind
			? { kind: tail.kind, text: tail.text + delta.text }
			: delta;
	}

	// A partial carrying something else — a tool call's arguments assembling character by
	// character, a signature. Neither reads as anything at this size, and neither ends the block
	// being written.
	if (isPartial(event.message)) {
		return tail;
	}

	// A completed message. Whatever the tail was showing has either just arrived in the transcript
	// or been superseded by it.
	return undefined;
}

// isPartial reports a token delta, as opposed to a message that completed.
export function isPartial(message: unknown): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { type?: unknown }).type === "stream_event"
	);
}

// deltaOf pulls the text of a streamed token out of a partial message, if it carries one.
function deltaOf(message: unknown): AgentTail | undefined {
	if (!isPartial(message)) {
		return undefined;
	}

	const delta = (message as { event?: { delta?: Record<string, unknown> } })
		.event?.delta;
	if (delta?.type === "text_delta" && typeof delta.text === "string") {
		return { kind: "say", text: delta.text };
	}
	if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
		return { kind: "thought", text: delta.thinking };
	}

	return undefined;
}
