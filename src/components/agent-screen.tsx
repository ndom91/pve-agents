import Anser from "anser";
import type { CSSProperties, ReactNode } from "react";

// ScreenSpan is one run of text sharing a colour and weight.
export type ScreenSpan = {
	style: CSSProperties;
	text: string;
};

// parseScreen turns a terminal snapshot into styled runs of plain text.
//
// Deliberately not HTML. This is output from a coding agent working in a repository: it echoes file
// contents, diffs, and anything a prompt told it to print. Handing that to an HTML converter and
// dangerouslySetInnerHTML would let any repository script the controller's own origin, where the
// operator's session cookie lives. A token list carries strings, and React escapes strings.
//
// anser reports colours as "r, g, b" triplets, which is why they are wrapped rather than used
// directly, and drops sequences it does not understand instead of printing them as noise.
export function parseScreen(screen: string): ScreenSpan[] {
	return Anser.ansiToJson(screen, { json: true, remove_empty: true }).map(
		(chunk) => {
			const style: CSSProperties = {};
			if (chunk.fg !== null && chunk.fg !== undefined) {
				style.color = `rgb(${chunk.fg})`;
			}
			// Backgrounds are kept, not dropped. Claude Code draws its input box and selection with
			// them, so losing them loses the shape of the interface rather than only its colour.
			if (chunk.bg !== null && chunk.bg !== undefined) {
				style.backgroundColor = `rgb(${chunk.bg})`;
			}
			if (chunk.decoration === "bold") {
				style.fontWeight = 700;
			}
			if (chunk.decoration === "dim") {
				style.opacity = 0.6;
			}
			if (chunk.decoration === "italic") {
				style.fontStyle = "italic";
			}
			if (chunk.decoration === "underline") {
				style.textDecoration = "underline";
			}

			return { style, text: chunk.content };
		},
	);
}

// screenSize measures the terminal grid the agent drew on.
//
// Measured from the parsed text rather than the raw string: the escape sequences carrying colour
// occupy no columns on a terminal, and counting them would report a screen half as wide again as
// the one a person is looking at.
export function screenSize(spans: ScreenSpan[]): {
	cols: number;
	rows: number;
} {
	const lines = spans
		.map((span) => span.text)
		.join("")
		.split("\n");

	return {
		cols: lines.reduce((widest, line) => Math.max(widest, line.length), 1),
		rows: Math.max(lines.length, 1),
	};
}

// AgentScreen renders what the agent has on screen, with the colour it drew.
//
// The pane is a fixed grid, not a document: Herdr renders a viewport of a particular number of rows
// and columns, and there is no scrollback behind it because Claude Code draws on the alternate
// screen. So the box is sized to that grid rather than given a share of the window, which is what
// put a scrollbar on a screen that has nothing above or below it to scroll to. The measurements go
// out as custom properties and the stylesheet turns them into a size.
export function AgentScreen({ screen }: { screen: string }): ReactNode {
	const spans = parseScreen(screen);
	const { cols, rows } = screenSize(spans);

	return (
		<pre
			className="detail-screen"
			style={{ "--screen-cols": cols, "--screen-rows": rows } as CSSProperties}
		>
			{spans.map((span, index) => (
				// A terminal screen is a positional list, replaced wholesale on every update and
				// never reordered, so position is the identity. There is nothing else to key on:
				// the same text recurs all over a screen and spans carry no id.
				// biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
				<span key={index} style={span.style}>
					{span.text}
				</span>
			))}
		</pre>
	);
}
