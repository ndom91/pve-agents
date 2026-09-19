import { describe, expect, it } from "vitest";

import { readTranscript } from "./agent-transcript";

// The shapes below are taken from a real session on agent-aabd rather than invented: the agent was
// asked to read a README, and the messages it produced are what the UI has to survive.
function assistant(...content: unknown[]) {
	return { message: { content, role: "assistant" }, type: "assistant" };
}

function user(content: unknown) {
	return { message: { content, role: "user" }, type: "user" };
}

describe("readTranscript", () => {
	it("puts a tool result on the row that asked for it", () => {
		// The failure this exists to prevent. A call and its result arrive in two messages, so
		// rendering each as a row gives a page of requests followed by a page of answers, which is
		// not the order anything happened in.
		const entries = readTranscript([
			assistant({
				id: "toolu_1",
				input: { file_path: "/workspace/repo/README.md" },
				name: "Read",
				type: "tool_use",
			}),
			user([
				{ content: "1\t# hello", tool_use_id: "toolu_1", type: "tool_result" },
			]),
		]);

		expect(entries).toEqual([
			{
				id: "toolu_1",
				input: { file_path: "/workspace/repo/README.md" },
				kind: "tool",
				name: "Read",
				result: "1\t# hello",
				state: "ok",
			},
		]);
	});

	it("does not read the agent's own tool results as something a person said", () => {
		// Tool results come back as *user* messages. Treating them as prompts puts a wall of JSON
		// on screen attributed to the operator.
		const entries = readTranscript([
			user([
				{ content: "output", tool_use_id: "toolu_1", type: "tool_result" },
			]),
		]);

		expect(entries).toEqual([]);
	});

	it("keeps a real prompt, whether it arrived as a string or as blocks", () => {
		expect(readTranscript([user("do the thing")])).toEqual([
			{ kind: "prompt", text: "do the thing" },
		]);
		expect(
			readTranscript([user([{ text: "do the thing", type: "text" }])]),
		).toEqual([{ kind: "prompt", text: "do the thing" }]);
	});

	it("marks a failed tool call as an error rather than a result", () => {
		const entries = readTranscript([
			assistant({ id: "t1", input: {}, name: "Bash", type: "tool_use" }),
			user([
				{
					content: "command not found",
					is_error: true,
					tool_use_id: "t1",
					type: "tool_result",
				},
			]),
		]);

		expect(entries[0]).toMatchObject({ state: "error" });
	});

	it("reads a result made of blocks rather than printing an object", () => {
		// An image result has no text at all, and the naive version rendered "[object Object]".
		const entries = readTranscript([
			assistant({ id: "t1", input: {}, name: "Read", type: "tool_use" }),
			user([
				{
					content: [
						{ text: "line one", type: "text" },
						{ source: {}, type: "image" },
						{ text: "line two", type: "text" },
					],
					tool_use_id: "t1",
					type: "tool_result",
				},
			]),
		]);

		expect(entries[0]).toMatchObject({ result: "line one\nline two" });
	});

	it("separates thinking from what the agent actually said", () => {
		const entries = readTranscript([
			assistant(
				{ thinking: "weighing it up", type: "thinking" },
				{ text: "here is the answer", type: "text" },
			),
		]);

		expect(entries).toEqual([
			{ kind: "thought", text: "weighing it up" },
			{ kind: "say", text: "here is the answer" },
		]);
	});

	it("says nothing about a turn that ended well", () => {
		// "success" under every single turn is noise. The last thing the agent said is the answer.
		expect(readTranscript([{ subtype: "success", type: "result" }])).toEqual(
			[],
		);
	});

	it("reports a turn that ended badly, because silence would look like an answer", () => {
		expect(
			readTranscript([{ subtype: "error_max_turns", type: "result" }]),
		).toEqual([{ kind: "ended", reason: "error_max_turns" }]);
	});

	it("marks the call a parked approval is waiting on", () => {
		// So the question reads as being about a specific call rather than as a banner about the
		// workspace, which is the whole reason the old answer-key row was hard to act on.
		const entries = readTranscript(
			[assistant({ id: "t1", input: {}, name: "Write", type: "tool_use" })],
			[{ id: "a1", input: {}, toolName: "Write" }],
		);

		expect(entries[0]).toMatchObject({ state: "awaiting-approval" });
	});

	it("ignores message types it has no opinion about", () => {
		// The SDK union has thirty-eight members and grows every release. A page full of
		// "unsupported message" boxes is worse than one that shows what it understands.
		expect(
			readTranscript([
				{ subtype: "init", type: "system" },
				{ event: {}, type: "stream_event" },
				{ type: "something_added_next_release" },
			]),
		).toEqual([]);
	});
});
