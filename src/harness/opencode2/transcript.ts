import type { ToolState, TranscriptEntry } from "../../domain/transcript";

// Reading opencode's messages into the rows a person sees.
//
// The shapes below were read off a real server rather than from the OpenAPI document, which
// describes its message payloads as an opaque JSON string. Where a field is optional here it is
// because a real message was seen without it.

// OpencodeMessage is one entry from `GET /api/session/{id}/message`.
//
// A user message carries its text directly; an assistant message carries parts. Both kinds are in
// the same list, which arrives newest first.
type OpencodeMessage = {
	content?: OpencodePart[];
	error?: { message?: string };
	finish?: string;
	id?: string;
	text?: string;
	time?: { completed?: number; created?: number };
	type?: string;
};

type OpencodePart = {
	id?: string;
	name?: string;
	state?: {
		content?: { text?: string; type?: string }[];
		input?: Record<string, unknown>;
		status?: string;
	};
	text?: string;
	time?: { completed?: number; created?: number };
	type?: string;
};

// TOOL_STATES maps opencode's four to the reader's vocabulary.
//
// "streaming" is the model still writing the call's arguments and "running" is the tool executing.
// Both are one thing to a reader -- something is happening and no result exists yet -- so they
// collapse. The distinction matters to opencode and to nobody looking at a transcript.
const TOOL_STATES: Record<string, ToolState> = {
	completed: "ok",
	error: "error",
	running: "running",
	streaming: "running",
};

// readOpencodeTranscript turns opencode's messages into rows.
//
// `pending` is the approvals the runner is holding. A tool call named by one of them is shown as
// waiting rather than as running: opencode's own state for a suspended call is still "running",
// because from its point of view the tool has been started and has not come back. Only the
// controller knows the difference, and the difference is the whole approval UI.
export function readOpencodeTranscript(
	messages: unknown[],
	pending: { toolUseId?: string }[],
): TranscriptEntry[] {
	const waiting = new Set(
		pending
			.map((approval) => approval.toolUseId)
			.filter((id): id is string => id !== undefined),
	);

	const entries: TranscriptEntry[] = [];
	// Reversed: the server returns newest first and a transcript reads oldest first.
	for (const message of [...(messages as OpencodeMessage[])].reverse()) {
		// The runner forwards what the server returned without inspecting it, so this list is only
		// as well-formed as the wire was. One bad entry is not worth the transcript of a working
		// agent.
		if (typeof message !== "object" || message === null) {
			continue;
		}

		if (message.type === "user") {
			if (message.text !== undefined && message.text !== "") {
				entries.push({
					at: at(message.time?.created),
					kind: "prompt",
					text: message.text,
				});
			}

			continue;
		}
		if (message.type !== "assistant") {
			continue;
		}

		for (const part of message.content ?? []) {
			// The message's time as the fallback, because only tool parts carry their own. A text
			// part has none at all, and a row with no time renders as a row with no time -- which
			// is worse than the moment its turn began, and that is within a second of it anyway.
			entries.push(...readPart(part, waiting, message.time?.created));
		}

		// A turn that ended badly. Surfaced as its own row rather than folded into the last tool
		// call, because the failure is frequently about the turn -- a provider refusing, a context
		// limit -- and attaching it to whatever happened to run last would misattribute it.
		if (message.finish === "error") {
			entries.push({
				kind: "ended",
				reason: message.error?.message ?? "the turn failed",
			});
		}
	}

	return entries;
}

function readPart(
	part: OpencodePart,
	waiting: Set<string>,
	fallback: number | undefined,
): TranscriptEntry[] {
	if (part.type === "text") {
		return part.text === undefined || part.text === ""
			? []
			: [
					{
						at: at(part.time?.created ?? fallback),
						kind: "say",
						text: part.text,
					},
				];
	}

	if (part.type === "reasoning") {
		// Frequently empty: the provider returns its reasoning encrypted, and what arrives is a
		// blob this side cannot read. An empty thought row would be a row saying nothing.
		return part.text === undefined || part.text === ""
			? []
			: [
					{
						at: at(part.time?.created ?? fallback),
						kind: "thought",
						text: part.text,
					},
				];
	}

	if (part.type !== "tool" || part.id === undefined) {
		return [];
	}

	const status = part.state?.status ?? "running";

	return [
		{
			at: at(part.time?.created ?? fallback),
			endedAt: at(part.time?.completed),
			id: part.id,
			input: part.state?.input ?? {},
			kind: "tool",
			name: part.name ?? "tool",
			result: result(part),
			state: waiting.has(part.id)
				? "awaiting-approval"
				: (TOOL_STATES[status] ?? "running"),
		},
	];
}

// result is what the tool gave back, as text.
//
// opencode's content is a list that can also hold file references. Only the text is joined: a file
// part is a uri and a mime type, which is not something to paste into a transcript row.
function result(part: OpencodePart): string | undefined {
	const text = (part.state?.content ?? [])
		.filter((entry) => entry.type === "text")
		.map((entry) => entry.text ?? "")
		.join("");

	return text === "" ? undefined : text;
}

// at converts opencode's epoch milliseconds to the ISO string the rows carry.
function at(time: number | undefined): string | undefined {
	return time === undefined ? undefined : new Date(time).toISOString();
}
