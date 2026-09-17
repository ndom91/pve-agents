import { describe, expect, it } from "vitest";

import { parseScreen } from "./agent-screen";

// ESC spelled out rather than embedded, so the fixtures stay readable in a diff and cannot be
// mangled by an editor that strips control characters.
const ESC = "";

describe("parseScreen", () => {
	it("keeps a truecolor foreground", () => {
		// Claude Code emits 24-bit colour, which is what makes a diff's red actually red.
		const spans = parseScreen(`${ESC}[38;2;215;119;87mClaude Code${ESC}[0m`);

		expect(spans[0]?.text).toBe("Claude Code");
		expect(spans[0]?.style.color).toBe("rgb(215, 119, 87)");
	});

	it("keeps a background, rather than only the text colour", () => {
		// The input box and selection are drawn with backgrounds. Dropping them would lose the
		// shape of the interface, not just its colour.
		const spans = parseScreen(`${ESC}[48;2;55;55;55mTest${ESC}[0m`);

		expect(spans[0]?.style.backgroundColor).toBe("rgb(55, 55, 55)");
	});

	it("carries bold through as weight", () => {
		const spans = parseScreen(`${ESC}[1mheading${ESC}[0m`);

		expect(spans[0]?.style.fontWeight).toBe(700);
	});

	it("leaves text with no sequences alone", () => {
		const spans = parseScreen("plain output\nsecond line");

		expect(spans.map((span) => span.text).join("")).toBe(
			"plain output\nsecond line",
		);
	});

	it("treats markup in agent output as text", () => {
		// The reason this parses to spans instead of HTML. The agent prints file contents and
		// anything a prompt asked for; if that reached the DOM as markup, any repository could
		// script the controller's origin, where the operator's session cookie lives.
		const spans = parseScreen('<script>alert("x")</script>');

		expect(spans.map((span) => span.text).join("")).toBe(
			'<script>alert("x")</script>',
		);
		// Still a string in a span, which React escapes. Nothing here is markup.
		expect(typeof spans[0]?.text).toBe("string");
	});

	it("does not print sequences it cannot interpret", () => {
		// A viewport snapshot is mostly SGR, but anything else must be dropped rather than shown
		// as garbage in the middle of the screen.
		const spans = parseScreen(`${ESC}[2Jcleared`);

		expect(spans.map((span) => span.text).join("")).not.toContain("[2J");
	});
});
