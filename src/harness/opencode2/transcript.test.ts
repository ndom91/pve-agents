import { describe, expect, it } from "vitest";

import SESSION from "./session.fixture.json";
import { readOpencodeTranscript } from "./transcript";

// The fixture is a real session, captured from a live opencode2 server in a workspace: one prompt,
// a turn that reasoned and called `read`, and a turn that answered. Only the long tool output and
// the encrypted reasoning blob were trimmed, and nothing was reshaped.
//
// Recorded rather than written because this reader's whole job is to match a wire format nobody
// documents -- opencode's OpenAPI document describes these payloads as an opaque string. A
// hand-written fixture would only prove the reader matches my idea of the format.

describe("readOpencodeTranscript", () => {
	it("reads a real session oldest first", () => {
		// The server returns newest first. Getting this backwards puts the answer above the question
		// and is the kind of thing that looks like a UI bug for a week.
		const entries = readOpencodeTranscript(SESSION, []);

		expect(entries.map((entry) => entry.kind)).toEqual([
			"prompt",
			"tool",
			"say",
		]);
	});

	it("keeps the prompt as the operator typed it", () => {
		const [prompt] = readOpencodeTranscript(SESSION, []);

		expect(prompt).toMatchObject({
			kind: "prompt",
			text: "Read package.json in this repo and tell me the value of the name field. Keep it to one sentence.",
		});
	});

	it("carries the tool call's name, input and result", () => {
		const tool = readOpencodeTranscript(SESSION, []).find(
			(entry) => entry.kind === "tool",
		);

		expect(tool).toMatchObject({
			id: "call_fHYsylMOUkDFWc8khlPUOBuG",
			input: { limit: 50, path: "package.json" },
			name: "read",
			state: "ok",
		});
	});

	it("drops a reasoning part with nothing in it", () => {
		// The provider returns its reasoning encrypted, so `text` is empty and the content is a blob
		// this side cannot read. A thought row saying nothing is worse than no row.
		expect(
			readOpencodeTranscript(SESSION, []).some(
				(entry) => entry.kind === "thought",
			),
		).toBe(false);
	});

	it("times a text part from its message, since it carries none of its own", () => {
		const said = readOpencodeTranscript(SESSION, []).find(
			(entry) => entry.kind === "say",
		);

		expect(said?.at).toBe(new Date(1790170147557).toISOString());
	});

	it("shows a call as waiting when an approval is parked on it", () => {
		// opencode still calls a suspended call "running": it started the tool and has not heard
		// back. Only the controller knows a person is being asked, and that is the whole approval UI.
		const tool = readOpencodeTranscript(SESSION, [
			{ toolUseId: "call_fHYsylMOUkDFWc8khlPUOBuG" },
		]).find((entry) => entry.kind === "tool");

		expect(tool).toMatchObject({ state: "awaiting-approval" });
	});

	it("leaves other calls alone while one is waiting", () => {
		const tool = readOpencodeTranscript(SESSION, [
			{ toolUseId: "call_somethingelse" },
		]).find((entry) => entry.kind === "tool");

		expect(tool).toMatchObject({ state: "ok" });
	});

	it("gives a failed turn its own row, naming the reason", () => {
		// Its own row rather than folded into the last tool call: a turn usually fails for reasons
		// that are about the turn -- a provider refusing, a context limit -- and hanging that on
		// whatever ran last misattributes it. This is the real 426 the free tier returned.
		const entries = readOpencodeTranscript(
			[
				{
					content: [],
					error: {
						message:
							"Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier",
					},
					finish: "error",
					id: "msg_x",
					time: { created: 1790168976363 },
					type: "assistant",
				},
			],
			[],
		);

		expect(entries).toEqual([
			{
				kind: "ended",
				reason:
					"Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier",
			},
		]);
	});

	it("maps a running call to running and a failed one to error", () => {
		const entries = readOpencodeTranscript(
			[
				{
					content: [
						{
							id: "call_a",
							name: "bash",
							state: { input: {}, status: "streaming" },
							type: "tool",
						},
						{
							id: "call_b",
							name: "write",
							state: { input: {}, status: "error" },
							type: "tool",
						},
					],
					id: "msg_y",
					type: "assistant",
				},
			],
			[],
		);

		expect(
			entries.map((entry) => entry.kind === "tool" && entry.state),
		).toEqual(["running", "error"]);
	});

	it("survives a message shape it has never seen", () => {
		// The runner forwards whatever the server returns, and opencode is a beta that adds message
		// kinds. An unknown one is skipped rather than thrown on, because throwing here takes down
		// the transcript of a working agent.
		expect(
			readOpencodeTranscript([{ type: "summary" }, null, "nonsense"], []),
		).toEqual([]);
	});
});
