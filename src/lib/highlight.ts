import { createHighlighter } from "@tanstack/highlight/core";
import { css } from "@tanstack/highlight/languages/css";
import { diff } from "@tanstack/highlight/languages/diff";
import { dockerfile } from "@tanstack/highlight/languages/dockerfile";
import { go } from "@tanstack/highlight/languages/go";
import { html } from "@tanstack/highlight/languages/html";
import { js } from "@tanstack/highlight/languages/js";
import { json } from "@tanstack/highlight/languages/json";
import { jsx } from "@tanstack/highlight/languages/jsx";
import { markdown } from "@tanstack/highlight/languages/markdown";
import { plaintext } from "@tanstack/highlight/languages/plaintext";
import { python } from "@tanstack/highlight/languages/python";
import { shell } from "@tanstack/highlight/languages/shell";
import { sql } from "@tanstack/highlight/languages/sql";
import { toml } from "@tanstack/highlight/languages/toml";
import { ts } from "@tanstack/highlight/languages/ts";
import { tsx } from "@tanstack/highlight/languages/tsx";
import { yaml } from "@tanstack/highlight/languages/yaml";

// One highlighter for the whole application.
//
// TanStack Highlight rather than Shiki, which is the obvious alternative and is already in the
// bundle underneath `@pierre/diffs`. Three reasons it is not reused here: it needs an async init
// before it can highlight anything, which a transcript row appearing mid-stream cannot wait for;
// it emits inline colours, so a theme is baked into the markup rather than taken from this
// application's own custom properties; and the copy inside the diff renderer lives in a shadow
// root that nothing outside can reach.
//
// This one is synchronous, knows only the languages registered below, and emits *semantic* class
// names — `th-keyword`, `th-string` — which `styles.css` colours from the same palette as
// everything else. Around 6 kB gzipped for this set.
//
// Alpha, at 0.1.0, and pinned exactly like everything else here for the reason AGENTS.md records.
// The surface used is two calls wide, so the cost of it moving is small and visible.
const highlighter = createHighlighter({
	// Anything unrecognised comes out as one unstyled run rather than throwing. Agent output is
	// full of formats nobody registered, and a tool result must never be able to break the page it
	// is rendered into.
	fallbackLanguage: "plaintext",
	languages: [
		css,
		diff,
		dockerfile,
		go,
		html,
		js,
		json,
		jsx,
		markdown,
		plaintext,
		python,
		shell,
		sql,
		toml,
		ts,
		tsx,
		yaml,
	],
});

// HighlightToken is one run of text and the semantic class it belongs to.
export type HighlightToken = { className?: string; value: string };

// tokenise splits code into styled runs.
//
// Tokens rather than the library's ready-made HTML string, so the caller renders React elements
// and no part of an agent's output is ever handed to dangerouslySetInnerHTML. The library does
// escape correctly — verified against `<img src=x onerror=...>` — but not needing to trust that is
// better than trusting it.
export function tokenise(code: string, lang?: string): HighlightToken[] {
	return highlighter.highlight(code, { lang: language(lang) }).tokens;
}

// EXTENSIONS maps a file suffix to a registered language.
//
// Only the ones that differ from the suffix itself; `.ts`, `.json`, `.css` and friends already
// name their language, and listing them again would be a second place to keep correct.
const EXTENSIONS: Record<string, string> = {
	bash: "shell",
	cjs: "js",
	htm: "html",
	markdown: "markdown",
	md: "markdown",
	mjs: "js",
	mts: "ts",
	patch: "diff",
	py: "python",
	sh: "shell",
	yml: "yaml",
	zsh: "shell",
};

// language resolves whatever a caller has to a language the highlighter knows.
export function language(name?: string): string {
	if (name === undefined || name === "") {
		return "plaintext";
	}

	const lower = name.toLowerCase();
	const mapped = EXTENSIONS[lower] ?? lower;

	return highlighter.listLanguages().includes(mapped) ? mapped : "plaintext";
}

// languageOfPath reads a language off a file path.
export function languageOfPath(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	// Dockerfile and Makefile carry their language in the name rather than a suffix, and a bare
	// "Dockerfile" has no dot at all.
	if (name.toLowerCase().startsWith("dockerfile")) {
		return "dockerfile";
	}

	const dot = name.lastIndexOf(".");

	return dot === -1 ? "plaintext" : language(name.slice(dot + 1));
}

// languageOfOutput guesses a language for a tool's output, which carries no label at all.
//
// Deliberately only the one guess worth making. A `cat package.json` or an API response is JSON
// and reads far better highlighted; an `ls -la` listing or a test log is prose with punctuation in
// it, and guessing a language for that produces confetti rather than meaning. So: JSON when it
// really is JSON, plaintext otherwise.
export function languageOfOutput(output: string): string {
	const trimmed = output.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
		return "plaintext";
	}

	try {
		JSON.parse(trimmed);

		return "json";
	} catch {
		return "plaintext";
	}
}
