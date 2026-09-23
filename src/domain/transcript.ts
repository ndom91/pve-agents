// The rows a transcript is made of, whatever produced them.
//
// Deliberately in the domain rather than beside a harness: this is the shape every harness has to
// reach, and it is the reason the feed, the tool groups and the approval rows do not know which
// agent they are rendering. A harness's own wire format stops at its `readTranscript`.

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
