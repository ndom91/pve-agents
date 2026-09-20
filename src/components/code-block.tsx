import type { ReactNode } from "react";

import { tokenise } from "../lib/highlight";

// CodeBlock renders code with the semantic classes styles.css colours.
//
// Built from tokens rather than from the highlighter's ready-made HTML string, so nothing an agent
// produced is ever handed to dangerouslySetInnerHTML. The library escapes correctly — checked
// against `<img src=x onerror=...>` — but a page that never asks the question cannot get the
// answer wrong later, and everything rendered here came out of a model or a command it ran.
export function CodeBlock({
	className,
	code,
	lang,
}: {
	className?: string;
	code: string;
	lang?: string;
}): ReactNode {
	return (
		<pre
			className={
				className === undefined ? "code-block" : `code-block ${className}`
			}
		>
			<code>
				{/* trimEnd, because a <pre> honours the newline a model or a shell put at the end
				    of its output and draws a blank line for it. Every thought in the transcript
				    was a box one line taller than its text. Leading space is left alone: it is
				    the first line's indentation. */}
				{tokenise(code.trimEnd(), lang).map((token, index) =>
					token.className === undefined ? (
						// A plain run. Keyed by position because the same word legitimately appears
						// many times in one block and tokens are never reordered.
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
	);
}
