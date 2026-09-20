import { Markdown } from "@tanstack/markdown/react";
import type { ReactNode } from "react";

import { CodeBlock } from "./code-block";
import { CopyButton } from "./copy-button";

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
export function AgentProse({ text }: { text: string }): ReactNode {
	return (
		<div className="agent-answer">
			<div className="agent-prose">
				<Markdown components={COMPONENTS}>{text}</Markdown>
			</div>
			{/* The markdown as the agent wrote it, not the rendered text. Somebody copying an answer
			    is almost always moving it somewhere that understands markdown — a commit message, an
			    issue, another prompt — and flattened prose has to be marked up again by hand. */}
			<div className="agent-answer-actions">
				<CopyButton label="Copy this answer" text={text} />
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
