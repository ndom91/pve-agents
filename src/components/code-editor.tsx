import { type ReactNode, useRef } from "react";

import { tokenise } from "../lib/highlight";

// CodeEditor is a textarea you can see the colours through.
//
// A transparent <textarea> laid exactly over a <pre> holding the highlighted text. The caret,
// selection, undo stack and every keyboard behaviour come from the textarea, because they are the
// things a real one gets right and a reimplementation gets wrong. Only the colours are ours.
//
// The highlighting is the application's own `tokenise`, so an edited file is coloured by the same
// engine and the same `.th-*` palette as every other code surface here. `@tanstack/highlight` has
// no editor of its own -- its React entry point builds props for a read-only block -- and the
// editors that do ship one bring a second highlighter with a second theme.
//
// Synchronous highlighting is what makes this viable at all: `tokenise` returns on the same tick,
// so the backdrop is redrawn with the keystroke rather than a frame behind it.
//
// THE FAILURE MODE, because it is not obvious and it is the only one: if the two layers disagree
// about anything affecting text metrics, the caret drifts from the glyphs, and the further into the
// file you type the worse it gets. Font, size, line height, letter spacing, padding, border width,
// wrapping and tab size are therefore set once in `.code-editor` and inherited by both children,
// never set on each.
export function CodeEditor({
	label,
	lang,
	onChange,
	value,
}: {
	label: string;
	lang?: string;
	onChange: (value: string) => void;
	value: string;
}): ReactNode {
	const backdrop = useRef<HTMLPreElement>(null);

	return (
		<div className="code-editor">
			<pre aria-hidden className="code-editor-ink" ref={backdrop}>
				<code>
					{/* A trailing newline, so the backdrop keeps its last line when the text ends on
					    one. Without it the highlighted layer is a line shorter than the textarea and
					    the bottom of the file scrolls out of alignment. */}
					{tokenise(`${value}\n`, lang).map((token, index) =>
						token.className === undefined ? (
							// biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
							<span key={index}>{token.value}</span>
						) : (
							// biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
							<span className={`th-token th-${token.className}`} key={index}>
								{token.value}
							</span>
						),
					)}
				</code>
			</pre>
			<textarea
				aria-label={label}
				autoCapitalize="off"
				autoCorrect="off"
				className="code-editor-input"
				onChange={(event) => onChange(event.target.value)}
				// The two layers scroll as one. The textarea is the one with the scrollbar; the
				// backdrop follows it and has none of its own.
				onScroll={(event) => {
					if (backdrop.current !== null) {
						backdrop.current.scrollTop = event.currentTarget.scrollTop;
						backdrop.current.scrollLeft = event.currentTarget.scrollLeft;
					}
				}}
				spellCheck={false}
				value={value}
			/>
		</div>
	);
}
