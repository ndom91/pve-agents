import { describe, expect, it } from "vitest";

import { countErrors, countTools, groupFeed } from "./agent-feed";
import type { TranscriptEntry } from "./transcript";

function tool(
	name: string,
	state: "error" | "ok" | "running" = "ok",
): TranscriptEntry {
	return { id: name, input: {}, kind: "tool", name, state };
}

const THOUGHT: TranscriptEntry = { kind: "thought", text: "thinking" };
const PROMPT: TranscriptEntry = { kind: "prompt", text: "do the thing" };
const SAY: TranscriptEntry = { kind: "say", text: "done" };

describe("groupFeed", () => {
	it("folds a run of calls into one group", () => {
		const items = groupFeed([PROMPT, tool("a"), tool("b"), SAY]);

		expect(items.map((item) => item.kind)).toEqual(["entry", "tools", "entry"]);
		expect(items[1]).toEqual({
			kind: "tools",
			rows: [tool("a"), tool("b")],
		});
	});

	it("keeps a thought inside the run rather than splitting it", () => {
		// The agent says what it is about to do, does it, says what it found. Treating the middle
		// as a boundary would shatter one piece of work into three groups of one.
		const items = groupFeed([tool("a"), THOUGHT, tool("b")]);

		expect(items).toHaveLength(1);
		expect(items[0]).toEqual({
			kind: "tools",
			rows: [tool("a"), THOUGHT, tool("b")],
		});
	});

	it("does not group thinking on its own", () => {
		// Nothing to count. A bordered box headed "tool calls 0" is a frame around an empty
		// statement.
		const items = groupFeed([PROMPT, THOUGHT, SAY]);

		expect(items.map((item) => item.kind)).toEqual(["entry", "entry", "entry"]);
	});

	it("starts a new group after anything that is not activity", () => {
		const items = groupFeed([tool("a"), SAY, tool("b")]);

		expect(items.map((item) => item.kind)).toEqual(["tools", "entry", "tools"]);
	});

	it("closes a run that reaches the end of the transcript", () => {
		// The common live case: the agent is still working, so the last thing in the list is a
		// call rather than an answer.
		const items = groupFeed([PROMPT, tool("a")]);

		expect(items).toHaveLength(2);
		expect(items[1].kind).toBe("tools");
	});

	it("keeps an empty transcript empty", () => {
		expect(groupFeed([])).toEqual([]);
	});
});

describe("countTools and countErrors", () => {
	it("counts calls but not thinking", () => {
		const rows = [tool("a"), THOUGHT, tool("b")] as never;

		expect(countTools(rows)).toBe(2);
	});

	it("counts only the calls that failed", () => {
		const rows = [tool("a"), tool("b", "error"), tool("c", "running")] as never;

		expect(countErrors(rows)).toBe(1);
	});
});
