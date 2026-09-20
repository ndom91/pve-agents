import { describe, expect, it } from "vitest";

import {
	mergesIntoExisting,
	readSeedContent,
	readSeedPath,
	resolveSeedPath,
} from "./seed-file";

describe("readSeedPath", () => {
	it("refuses a path that steps outside the root it claims", () => {
		// The whole reason roots exist. A "home" file writing to /etc is the one outcome this
		// validation is for, and the container cannot catch it because it resolves the path itself.
		for (const path of ["../etc/passwd", "a/../../b", ".."]) {
			expect(readSeedPath("home", path).kind).toBe("invalid");
		}
	});

	it("allows a file whose name merely begins with dots", () => {
		// Checked segment by segment rather than as a substring, so "..config" is a filename and
		// not an escape.
		expect(readSeedPath("home", "..config").kind).toBe("valid");
	});

	it("refuses an absolute destination that is not absolute", () => {
		expect(readSeedPath("absolute", "etc/hosts")).toEqual({
			kind: "invalid",
			message: "an absolute destination must start with /",
		});
	});

	it("refuses a relative root given an absolute path", () => {
		// Otherwise "home" plus "/etc/hosts" reads as a home file and writes to /etc, which is the
		// silent version of the thing the absolute root exists to make explicit.
		expect(readSeedPath("repo", "/etc/hosts").kind).toBe("invalid");
	});

	it("refuses newlines and nulls, which do not survive the trip", () => {
		// A newline ends the line the path is written on; a null truncates it in the shell.
		for (const path of ["a\nb", "a\0b", "a\rb"]) {
			expect(readSeedPath("home", path).kind).toBe("invalid");
		}
	});

	it("accepts the destinations this feature exists for", () => {
		expect(readSeedPath("home", ".claude/settings.json").kind).toBe("valid");
		expect(readSeedPath("repo", "CLAUDE.md").kind).toBe("valid");
		expect(readSeedPath("absolute", "/etc/agent.conf").kind).toBe("valid");
	});
});

describe("resolveSeedPath", () => {
	it("shows the operator where a file lands before they save it", () => {
		expect(resolveSeedPath("home", ".claude/settings.json")).toBe(
			"$HOME/.claude/settings.json",
		);
		expect(resolveSeedPath("repo", "CLAUDE.md")).toBe(
			"/workspace/repo/CLAUDE.md",
		);
		expect(resolveSeedPath("absolute", "/etc/agent.conf")).toBe(
			"/etc/agent.conf",
		);
	});
});

describe("readSeedContent", () => {
	it("holds ~/.claude.json to being a JSON object", () => {
		// It is merged into the file the workspace already wrote, and a string or an array cannot
		// be merged into an object. Caught here so the failure names the shape.
		expect(readSeedContent("home", ".claude.json", "[1, 2]").kind).toBe(
			"invalid",
		);
		expect(readSeedContent("home", ".claude.json", '"hello"').kind).toBe(
			"invalid",
		);
		expect(readSeedContent("home", ".claude.json", "null").kind).toBe(
			"invalid",
		);
	});

	it("names the parse error, because that is what the operator has to fix", () => {
		const result = readSeedContent("home", ".claude.json", '{"a": 1,}');

		expect(result.kind).toBe("invalid");
		expect(result.kind === "invalid" && result.message).toContain(
			"not valid JSON",
		);
	});

	it("accepts an object", () => {
		expect(
			readSeedContent("home", ".claude.json", '{"mcpServers": {}}').kind,
		).toBe("valid");
	});

	it("says nothing about any other destination", () => {
		// Refusing to save a shell script because it is not JSON would be a rule about the wrong
		// thing. Only the merged destination has to parse.
		expect(readSeedContent("repo", "CLAUDE.md", "# not json").kind).toBe(
			"valid",
		);
		expect(
			readSeedContent("home", ".claude/settings.json", "not json").kind,
		).toBe("valid");
		expect(readSeedContent("absolute", "/etc/thing", "{{{").kind).toBe("valid");
	});

	it("only treats .claude.json at the home root as the merged one", () => {
		// A file of the same name in the checkout is an ordinary file. The one the workspace
		// wrote, and the only one worth protecting, lives in $HOME.
		expect(mergesIntoExisting("home", ".claude.json")).toBe(true);
		expect(mergesIntoExisting("repo", ".claude.json")).toBe(false);
		expect(mergesIntoExisting("home", ".claude/settings.json")).toBe(false);
	});
});
