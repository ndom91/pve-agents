import { describe, expect, it } from "vitest";

import { readSeedPath, resolveSeedPath } from "./seed-file";

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
