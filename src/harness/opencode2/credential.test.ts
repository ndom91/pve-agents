import { describe, expect, it } from "vitest";

import { readOpencodeCredential } from "./credential";

// The shape here is the real one, read off a live opencode2 server: the credential row's `value`
// column holds {type, methodID, access, refresh, expires, metadata} and the integration it belongs
// to lives in a separate column, which is why the envelope carries both.
const VALUE = {
	access: "not-a-real-access-token",
	expires: 1791034083235,
	metadata: { accountID: "00000000-0000-0000-0000-000000000000" },
	methodID: "chatgpt-headless",
	refresh: "not-a-real-refresh-token",
	type: "oauth",
};

describe("readOpencodeCredential", () => {
	it("reads an envelope and re-serialises the value for its text column", () => {
		const read = readOpencodeCredential(
			JSON.stringify({ integration: "openai", value: VALUE }),
		);

		expect(read).toEqual({
			credential: { integration: "openai", value: JSON.stringify(VALUE) },
			kind: "read",
		});
	});

	it("passes a value that is already a string straight through", () => {
		// A harvest can produce either, depending on whether the column was pasted as text or as
		// parsed JSON. Refusing one of them would be a rule about JSON, not about credentials.
		const read = readOpencodeCredential(
			JSON.stringify({ integration: "openai", value: JSON.stringify(VALUE) }),
		);

		expect(read).toMatchObject({
			credential: { value: JSON.stringify(VALUE) },
			kind: "read",
		});
	});

	it("refuses something that is not JSON, and says what one looks like", () => {
		// The operator is at a form when this runs. The alternative is that they find out an hour
		// later, from a workspace whose agent will not start and cannot say why.
		const read = readOpencodeCredential("sk-ant-oat01-wrong-agent-entirely");

		expect(read.kind).toBe("invalid");
		expect(read.kind === "invalid" && read.message).toContain("integration");
	});

	it("refuses an envelope with no integration to write it against", () => {
		expect(
			readOpencodeCredential(JSON.stringify({ value: VALUE })),
		).toMatchObject({ kind: "invalid" });
	});

	it("refuses an envelope with no value", () => {
		expect(
			readOpencodeCredential(JSON.stringify({ integration: "openai" })),
		).toMatchObject({ kind: "invalid" });
	});

	it("refuses an array, which is JSON and is not this", () => {
		expect(readOpencodeCredential("[1, 2]")).toMatchObject({ kind: "invalid" });
	});
});
