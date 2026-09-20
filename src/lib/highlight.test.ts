import { describe, expect, it } from "vitest";

import {
	language,
	languageOfOutput,
	languageOfPath,
	tokenise,
} from "./highlight";

describe("tokenise", () => {
	it("splits code into runs that cover the original exactly", () => {
		// The property that matters more than any colour: highlighting must not lose, reorder or
		// invent a character. A tool result is evidence, and evidence that has been edited on the
		// way to the screen is worse than no highlighting at all.
		for (const [code, lang] of [
			['ls -la && echo "hi"', "shell"],
			['{"a": [1, 2], "b": null}', "json"],
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the point — TS handles its own template strings, so this is the case worth covering
			["const x = `a${b}c`;\n// note", "ts"],
			["", "shell"],
		] as const) {
			expect(
				tokenise(code, lang)
					.map((token) => token.value)
					.join(""),
			).toBe(code);
		}
	});

	it("carries hostile input through as text rather than markup", () => {
		// Everything rendered here came out of a model that read somebody else's repository. The
		// caller builds React elements from these values, so the angle brackets stay characters.
		const code = "<img src=x onerror=alert(1)>";

		expect(
			tokenise(code, "shell")
				.map((token) => token.value)
				.join(""),
		).toBe(code);
	});

	it("falls back rather than throwing on a language nobody registered", () => {
		// Agent output is full of formats this does not know. A tool result must never be able to
		// break the page it is rendered into.
		expect(tokenise("some text", "brainfuck")).toEqual([
			{ value: "some text" },
		]);
	});
});

describe("language", () => {
	it("accepts the names a markdown fence actually uses", () => {
		expect(language("bash")).toBe("shell");
		expect(language("sh")).toBe("shell");
		expect(language("YAML")).toBe("yaml");
	});

	it("calls anything it does not know plaintext", () => {
		expect(language("brainfuck")).toBe("plaintext");
		expect(language(undefined)).toBe("plaintext");
		expect(language("")).toBe("plaintext");
	});
});

describe("languageOfPath", () => {
	it("reads the language off the suffix", () => {
		expect(languageOfPath("/workspace/repo/src/main.ts")).toBe("ts");
		expect(languageOfPath("/workspace/repo/README.md")).toBe("markdown");
		expect(languageOfPath("scripts/deploy.sh")).toBe("shell");
	});

	it("knows the files that carry their language in the name", () => {
		// A bare "Dockerfile" has no suffix at all, and suffix-only logic reads it as plaintext.
		expect(languageOfPath("Dockerfile")).toBe("dockerfile");
		expect(languageOfPath("deploy/Dockerfile.web")).toBe("dockerfile");
	});

	it("does not mistake a dotted directory for a suffix", () => {
		expect(languageOfPath("/home/agent/.agent-runner/runner")).toBe(
			"plaintext",
		);
	});
});

describe("languageOfOutput", () => {
	it("highlights a JSON body, which is the one guess worth making", () => {
		expect(languageOfOutput('{"name": "thing"}')).toBe("json");
		expect(languageOfOutput("\n  [1, 2, 3]\n")).toBe("json");
	});

	it("leaves ordinary command output alone", () => {
		// An `ls -la` listing and a test log are prose with punctuation in them. Highlighting them
		// as some language produces confetti, which is worse than plain text.
		expect(languageOfOutput("total 244\ndrwxr-xr-x 3 agent agent")).toBe(
			"plaintext",
		);
		expect(languageOfOutput("")).toBe("plaintext");
	});

	it("does not call something JSON just because it starts with a brace", () => {
		// A shell snippet, a log line with a JSON-ish prefix, a truncated body. Parsing is the
		// check, not the first character.
		expect(languageOfOutput('{"truncated": ')).toBe("plaintext");
		expect(languageOfOutput("{ for f in *; do echo $f; done }")).toBe(
			"plaintext",
		);
	});
});
