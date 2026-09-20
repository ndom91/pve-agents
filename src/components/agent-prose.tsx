import { streamingMarkdownExtension } from "@tanstack/markdown/extensions/streaming";
import { Markdown } from "@tanstack/markdown/react";
import type { ReactNode } from "react";

import { CodeBlock } from "./code-block";
import { CopyButton } from "./copy-button";
import { Timestamp } from "./timestamp";

// AgentProse renders what the agent said, as markdown.
//
// It was already writing markdown — `**bold**`, bulleted lists, backticked paths — and the page was
// showing the asterisks. That is the whole reason this exists.
//
// TanStack Markdown rather than a general renderer, for one property above the others: **it escapes
// raw HTML and strips unsafe link and image URLs by default.** Everything here came out of a model
// that read a repository somebody else wrote, so the input is not trusted, and a renderer whose
// safe mode is opt-in would put that decision in the wrong place. It is also small — about 4.9 kB
// for the parser and 6.6 kB for the React adapter — and it renders React elements rather than an
// HTML string, so nothing reaches dangerouslySetInnerHTML.
//
// Alpha, at 0.0.15, and pinned exactly. The surface used is one component wide.
export function AgentProse({
	at,
	streaming = false,
	text,
}: {
	// When the agent said it. Absent for an answer from a runner installed before the runner
	// started stamping, which shows as no timestamp rather than as a wrong one.
	at?: string;
	streaming?: boolean;
	text: string;
}): ReactNode {
	return (
		<div className="agent-answer reveals">
			<div className={streaming ? "agent-prose is-streaming" : "agent-prose"}>
				{/* While a block is still being written, the parser is told so. Markdown half way
				    through is full of markers that are not yet markers — an unclosed fence, a
				    dangling list item — and the streaming profile renders those as the author
				    meant rather than as literal asterisks that vanish a keystroke later. */}
				<Markdown
					components={COMPONENTS}
					extensions={streaming ? STREAMING : undefined}
				>
					{text}
				</Markdown>
			</div>
			{/* No copy control on a half-written answer: it would put an unfinished sentence on
			    the clipboard, and the button appears a second later anyway when the block lands.
			    The row is still reserved so nothing shifts at that moment.
			
			    The markdown as the agent wrote it, not the rendered text. Somebody copying an
			    answer is almost always moving it somewhere that understands markdown — a commit
			    message, an issue, another prompt — and flattened prose has to be marked up again
			    by hand. */}
			<div className="agent-answer-actions">
				{/* Revealed with the copy button and by the same rule, because it answers the same
				    kind of question: something you want occasionally and never while reading. A
				    transcript with a time under every paragraph is a log rather than a
				    conversation. */}
				{streaming ? null : (
					<>
						<span className="agent-answer-at on-hover">
							<Timestamp iso={at} />
						</span>
						<CopyButton label="Copy this answer" text={text} />
					</>
				)}
			</div>
		</div>
	);
}

// Code renders both kinds of code the parser produces, which arrive as the same element.
//
// A fenced block is `<code class="language-bash">` inside a `<pre>`; an inline backtick is a bare
// `<code>` in the middle of a sentence. Telling them apart by that class matters: treating them
// alike turns every mention of `npm i` into a full-width highlighted block and the paragraph around
// it into rubble.
//
// A fence's language comes from the AST rather than being guessed, because the parser kept it.
// Highlighting is deliberately not this library's job, which is why the two compose.
function Code({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	const lang = /language-(\w+)/.exec(className ?? "")?.[1];
	if (lang === undefined && className === undefined) {
		return <code className="prose-code">{children}</code>;
	}

	return <CodeBlock code={String(children ?? "")} lang={lang} />;
}

// A fenced block arrives as <pre><code>, so `pre` passes through: the highlighter emits its own
// <pre>, and nesting one inside another is invalid markup that browsers render as a double box.
const COMPONENTS = {
	code: Code,
	pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
};

// Module scope: rebuilding it per render would hand the parser a new extension list on every
// token, which is the one place in this file that happens hundreds of times a turn.
const STREAMING = [streamingMarkdownExtension()];
