// Turning what the SDK says into what a person reads.
//
// The runner forwards SDK messages untouched, which is right: it should not decide what matters.
// That decision lives here, in one pure function, because it is the part most likely to be wrong
// and the part a test can actually hold still.
//
// The shape worth knowing: a transcript is mostly tool calls, and a tool call arrives in two
// pieces. The assistant asks for it in one message and the result comes back in a later *user*
// message, matched by id. Rendering them as two rows would show a page of requests followed by a
// page of answers, which is not what happened.

// ToolState is how far one tool call has got, in the vocabulary a reader cares about.
//
// Borrowed from Vercel's AI Elements, which is the one part of that library worth having here: it
// had already worked out the states, and inventing a fifth vocabulary for the same six facts would
// help nobody.
export type ToolState =
	| "awaiting-approval"
	| "denied"
	| "error"
	| "ok"
	| "running";

// TranscriptEntry is one row.
export type TranscriptEntry =
	| { at?: string; kind: "prompt"; text: string }
	| { at?: string; kind: "say"; text: string }
	| { at?: string; kind: "thought"; text: string }
	| { kind: "ended"; reason: string }
	| {
			// When the agent asked for the call, and when its result came back. Both are the
			// runner's own `controller_at`, read off the message that carried each half.
			//
			// The gap between them is not the tool's execution time to the millisecond -- it is
			// the time from the request being recorded to the result being recorded, which
			// includes whatever the runner was doing in between. It is what "how long did this
			// step take" means in a transcript, and it is the only answer this side has.
			//
			// Both optional: a runner installed before controller_at shipped stamps nothing, and a
			// call still running has no end yet.
			at?: string;
			endedAt?: string;
			id: string;
			input: Record<string, unknown>;
			kind: "tool";
			name: string;
			result?: string;
			state: ToolState;
	  };

// Block is the slice of an Anthropic content block this cares about.
type Block = {
	content?: unknown;
	id?: string;
	input?: Record<string, unknown>;
	is_error?: boolean;
	name?: string;
	text?: string;
	thinking?: string;
	tool_use_id?: string;
	type?: string;
};

// Message is the slice of an SDKMessage this cares about.
//
// Deliberately structural rather than the SDK's own union. That union has thirty-eight members,
// almost all of them about things this does not render, and importing it here would put a
// dependency on the SDK into the browser bundle to describe five fields.
type Message = {
	// Stamped by the runner as it records the message. Optional because a runner installed before
	// that shipped is still running, and its messages have no time at all.
	controller_at?: string;
	message?: { content?: unknown; role?: string };
	subtype?: string;
	type?: string;
};

// readTranscript folds SDK messages into rows, oldest first.
//
// Unknown message types are dropped rather than rendered as a placeholder. The union grows with
// every Claude Code release, and a page that shows "unsupported message" boxes for features it has
// no opinion about is worse than one that shows what it understands.
export function readTranscript(
	messages: unknown[],
	pending: { toolUseId?: string }[] = [],
): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];
	// Where each tool call landed, so its result can be written into the row that asked for it
	// rather than appended as a row of its own.
	const rows = new Map<string, Extract<TranscriptEntry, { kind: "tool" }>>();

	for (const raw of messages) {
		const message = raw as Message;
		const at = message.controller_at;
		const blocks = Array.isArray(message.message?.content)
			? (message.message.content as Block[])
			: [];

		if (message.type === "assistant") {
			for (const block of blocks) {
				if (block.type === "text" && block.text !== undefined) {
					entries.push({ at, kind: "say", text: block.text });
				}
				// Only when there is something to read.
				//
				// A thinking block often arrives with an empty `thinking` and nothing but a
				// signature: the reasoning is encrypted and the client is not meant to see it.
				// Rendering a "Thought" row for one is an affordance that cannot do anything, which
				// is exactly how it was reported — a disclosure that would not disclose.
				if (block.type === "thinking" && (block.thinking ?? "").trim() !== "") {
					entries.push({ at, kind: "thought", text: block.thinking ?? "" });
				}
				if (block.type === "tool_use" && block.id !== undefined) {
					const row: Extract<TranscriptEntry, { kind: "tool" }> = {
						at,
						id: block.id,
						input: block.input ?? {},
						kind: "tool",
						name: block.name ?? "tool",
						state: "running",
					};
					rows.set(block.id, row);
					entries.push(row);
				}
			}

			continue;
		}

		if (message.type === "user") {
			// A user message carrying tool results is the agent's own loop, not somebody typing.
			// Reading it as a prompt would put "[{type: tool_result...}]" on screen as though an
			// operator had said it.
			const results = blocks.filter((block) => block.type === "tool_result");
			if (results.length > 0) {
				for (const block of results) {
					const row =
						block.tool_use_id === undefined
							? undefined
							: rows.get(block.tool_use_id);
					if (row !== undefined) {
						row.endedAt = at;
						row.result = flatten(block.content);
						row.state = block.is_error === true ? "error" : "ok";
					}
				}

				continue;
			}

			const text = textOf(message.message?.content, blocks);
			if (text !== "") {
				entries.push({ at, kind: "prompt", text });
			}

			continue;
		}

		if (message.type === "result" && message.subtype !== "success") {
			// Only the unhappy ones. A turn that ended well needs no row: the last thing the agent
			// said is the answer, and "success" underneath it is noise on every single turn.
			entries.push({ kind: "ended", reason: message.subtype ?? "ended" });
		}
	}

	// A parked approval belongs on the row that is waiting for it, which is how it reads as a
	// question about a specific call rather than as a banner about the workspace.
	//
	// Matched by the tool_use id the SDK hands the callback, not by tool name. Name matching picked
	// the most recent call with that name, which is the wrong row the moment an agent runs two
	// Bash calls at once — and marks one as waiting while the one actually suspended looks busy.
	// An approval whose id matches nothing marks nothing, because a wrong row is worse than none.
	for (const request of pending) {
		const row =
			request.toolUseId === undefined ? undefined : rows.get(request.toolUseId);
		if (row !== undefined && row.state === "running") {
			row.state = "awaiting-approval";
		}
	}

	return entries;
}

// flatten turns a tool result into the text a row can show.
//
// Results arrive either as a string or as an array of blocks, and an image result has no text at
// all. Rendering [object Object] for the last case is the failure this exists to avoid.
function flatten(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	return (content as Block[])
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.filter((text) => text !== "")
		.join("\n");
}

function textOf(content: unknown, blocks: Block[]): string {
	if (typeof content === "string") {
		return content;
	}

	return blocks
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.filter((text) => text !== "")
		.join("\n");
}
