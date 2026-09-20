// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { readTail } from "./agent-tail";

// The tail is what the agent is writing right now. Its whole job is to be replaced at the right
// moment: too late and a paragraph appears twice, too early and the text flickers out and back.
describe("readTail", () => {
	function delta(kind: "text" | "thinking", text: string) {
		return {
			message: {
				event: { delta: { [kind]: text, type: `${kind}_delta` } },
				type: "stream_event",
			},
			type: "message" as const,
		};
	}

	it("accumulates a block as it is written", () => {
		let tail = readTail(undefined, delta("text", "Hello"));
		tail = readTail(tail, delta("text", " there"));

		expect(tail).toEqual({ kind: "say", text: "Hello there" });
	});

	it("starts a new block when the agent stops thinking and starts writing", () => {
		// The change of kind is the boundary. Running the two together would put an agent's
		// reasoning and its answer in the same paragraph.
		let tail = readTail(undefined, delta("thinking", "weighing it up"));
		tail = readTail(tail, delta("text", "The answer is"));

		expect(tail).toEqual({ kind: "say", text: "The answer is" });
	});

	it("clears the tail when the completed block arrives", () => {
		// The transcript now holds it. Leaving the tail up shows the same paragraph twice.
		const tail = readTail(undefined, delta("text", "Hello"));

		expect(
			readTail(tail, {
				message: { message: { content: [] }, type: "assistant" },
				type: "message",
			}),
		).toBeUndefined();
	});

	it("clears the tail on a snapshot, which has no half-written block in it", () => {
		const tail = readTail(undefined, delta("text", "Hello"));

		expect(
			readTail(tail, {
				approvals: [],
				cwd: "/workspace/repo",
				messages: [],
				permissionMode: "auto",
				status: "idle",
				type: "snapshot",
			}),
		).toBeUndefined();
	});

	it("ignores the deltas that are not worth watching", () => {
		// A tool call's arguments assembling character by character, and the signature on a
		// thinking block. Neither reads as anything at this size.
		for (const kind of ["input_json", "signature"]) {
			expect(
				readTail(undefined, {
					message: {
						event: { delta: { partial_json: "{", type: `${kind}_delta` } },
						type: "stream_event",
					},
					type: "message",
				}),
			).toBeUndefined();
		}
	});

	it("leaves the tail alone for events that say nothing about it", () => {
		const tail = readTail(undefined, delta("text", "Hello"));

		expect(readTail(tail, { status: "working", type: "status" })).toBe(tail);
	});
});
