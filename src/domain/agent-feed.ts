import type { TranscriptEntry } from "./transcript";

// ToolEntry is the one member of TranscriptEntry that carries a tool call.
export type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

// ThoughtEntry is the agent thinking out loud between two calls.
export type ThoughtEntry = Extract<TranscriptEntry, { kind: "thought" }>;

// FeedItem is one thing the conversation shows.
//
// Either an entry rendered on its own -- a prompt, an answer, the end of a turn -- or a run of
// activity folded into a single bordered group.
export type FeedItem =
	| { entry: TranscriptEntry; kind: "entry" }
	| { kind: "tools"; rows: (ThoughtEntry | ToolEntry)[] };

// groupFeed folds runs of agent activity into groups, leaving everything else alone.
//
// The flat transcript is what the runner emits and it is right to store it that way. It is the
// wrong thing to render: a question, fourteen indistinguishable tool rows, and an answer read as
// one undifferentiated column, and the two things worth reading were the first and last lines.
// A group draws a box around the middle and puts a count on it.
//
// Thoughts join the run rather than breaking it. They arrive between calls -- the agent says what
// it is about to do, does it, says what it found -- so treating them as a boundary would shatter
// one piece of work into three groups of one. They are activity, and they belong in the box with
// the rest of it.
//
// A run of thoughts alone is not a group. There is nothing to count, and a bordered box headed
// "tool calls 0" is a frame around an empty statement.
export function groupFeed(entries: TranscriptEntry[]): FeedItem[] {
	const items: FeedItem[] = [];
	let run: (ThoughtEntry | ToolEntry)[] = [];

	// flush closes the run in progress, as a group if it earned one and as loose rows if it did
	// not. Called at every boundary and once at the end, which is the whole reason it is a closure
	// rather than repeated three times.
	function flush() {
		if (run.length === 0) {
			return;
		}

		if (run.some((row) => row.kind === "tool")) {
			items.push({ kind: "tools", rows: run });
		} else {
			for (const row of run) {
				items.push({ entry: row, kind: "entry" });
			}
		}

		run = [];
	}

	for (const entry of entries) {
		if (entry.kind === "tool" || entry.kind === "thought") {
			run.push(entry);
			continue;
		}

		flush();
		items.push({ entry, kind: "entry" });
	}

	flush();

	return items;
}

// countTools is how many of a group's rows are calls rather than thinking.
//
// The header counts calls only. A thought is not something the agent did to the world, and
// including it would make "6" a number the reader cannot check against the rows they can see.
export function countTools(rows: (ThoughtEntry | ToolEntry)[]): number {
	return rows.filter((row) => row.kind === "tool").length;
}

// countErrors is how many of a group's calls failed.
//
// Surfaced on the header because it is the one thing worth knowing about a collapsed group. A run
// that went fine needs no reading; a run with a failure in it is the reason you opened the page.
export function countErrors(rows: (ThoughtEntry | ToolEntry)[]): number {
	return rows.filter((row) => row.kind === "tool" && row.state === "error")
		.length;
}
