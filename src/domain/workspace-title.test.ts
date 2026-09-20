import { describe, expect, it } from "vitest";

import { MAX_TITLE, readTitle } from "./workspace-title";

describe("readTitle", () => {
	it("keeps a title that is already one", () => {
		expect(readTitle("Fix the flaky login test")).toBe(
			"Fix the flaky login test",
		);
	});

	it("unwraps the quotes a model puts round its whole answer", () => {
		// Asking for a title and getting `"A title"` is the single commonest way this comes back
		// wrong, and quotes in a sidebar read as part of the name.
		expect(readTitle('"Fix the flaky login test"')).toBe(
			"Fix the flaky login test",
		);
		expect(readTitle("'Fix the login test'")).toBe("Fix the login test");
	});

	it("keeps a quoted phrase inside a title", () => {
		// Only a matched pair wrapping the whole string is the model's packaging. One in the
		// middle is the title.
		expect(readTitle('Rename the "purpose" field')).toBe(
			'Rename the "purpose" field',
		);
	});

	it("drops the full stop a model adds out of habit", () => {
		expect(readTitle("Fix the flaky login test.")).toBe(
			"Fix the flaky login test",
		);
	});

	it("keeps punctuation that is doing work", () => {
		// A question and an ellipsis both mean something. Only the habitual full stop goes.
		expect(readTitle("Why is the login test flaky?")).toBe(
			"Why is the login test flaky?",
		);
		expect(readTitle("Still investigating...")).toBe("Still investigating...");
	});

	it("flattens an answer that came back as more than one line", () => {
		// A model that returns a heading and then a sentence would otherwise become a two-line
		// heading, which is not what the layout expects.
		expect(readTitle("Fix the login test\n\nIt fails intermittently.")).toBe(
			"Fix the login test It fails intermittently",
		);
	});

	it("caps a paragraph rather than letting it into the sidebar", () => {
		const long = readTitle("a".repeat(400));

		expect(long?.length).toBe(MAX_TITLE);
		expect(long?.endsWith("…")).toBe(true);
	});

	it("answers nothing for what cannot be a name", () => {
		// Absent is a state the rest of the system has an answer for: fall back to the hostname.
		for (const value of [undefined, "", "   ", '""', "."]) {
			expect(readTitle(value)).toBeUndefined();
		}
	});
});
