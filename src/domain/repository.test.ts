import { describe, expect, it } from "vitest";

import { branchPage, parseRepository, repositoryURL } from "./repository";

describe("parseRepository", () => {
	it("accepts the forms a person reasonably types", () => {
		for (const value of [
			"ndom91/open-plan-annotator",
			"github.com/ndom91/open-plan-annotator",
			"https://github.com/ndom91/open-plan-annotator",
			"https://github.com/ndom91/open-plan-annotator.git",
			"  github.com/ndom91/open-plan-annotator  ",
		]) {
			expect(parseRepository(value)).toEqual({
				kind: "parsed",
				name: "open-plan-annotator",
				owner: "ndom91",
			});
		}
	});

	it("refuses a host that is not github.com", () => {
		// The App's tokens are worthless elsewhere, so another host cannot be authenticated. It
		// could still be reached, and that is the part worth refusing: an internal address here
		// would have the controller's own network position used to fetch it.
		expect(parseRepository("evil.example.com/ndom91/repo").kind).toBe(
			"invalid",
		);
		expect(parseRepository("https://10.0.3.50/ndom91/repo").kind).toBe(
			"invalid",
		);
	});

	it("refuses credentials embedded in the value", () => {
		expect(
			parseRepository("https://user:token@github.com/ndom91/repo").kind,
		).toBe("invalid");
	});

	it("refuses path traversal", () => {
		// Both segments are interpolated into a clone URL, so ".." is not a name, it is a path.
		expect(parseRepository("../../etc/passwd").kind).toBe("invalid");
		expect(parseRepository("ndom91/..").kind).toBe("invalid");
		expect(parseRepository("../repo").kind).toBe("invalid");
	});

	it("refuses anything that is not exactly an owner and a name", () => {
		expect(parseRepository("ndom91").kind).toBe("invalid");
		expect(parseRepository("github.com/ndom91/repo/extra").kind).toBe(
			"invalid",
		);
		expect(parseRepository("").kind).toBe("invalid");
	});

	it("refuses characters GitHub would not accept anyway", () => {
		for (const value of [
			"ndom91/re po",
			"ndom91/repo;id",
			"ndom91/repo$(id)",
			"nd om91/repo",
		]) {
			expect(parseRepository(value).kind).toBe("invalid");
		}
	});
});

describe("repositoryURL", () => {
	it("never carries credentials", () => {
		const url = repositoryURL({ name: "open-plan-annotator", owner: "ndom91" });

		expect(url).toBe("https://github.com/ndom91/open-plan-annotator.git");
		expect(url).not.toContain("@");
	});
});

describe("branchPage", () => {
	it("keeps the slash that separates a branch's own path", () => {
		// Every workspace branch is `pve-agents/<hostname>`, and that slash belongs to the URL
		// GitHub expects. Escaping the branch whole would turn it into %2F and 404.
		expect(
			branchPage(
				{ name: "open-plan-annotator", owner: "ndom91" },
				"pve-agents/agent-c824",
			),
		).toBe(
			"https://github.com/ndom91/open-plan-annotator/tree/pve-agents/agent-c824",
		);
	});

	it("escapes what is inside a segment", () => {
		// Not a branch this controller creates, but the link is built from a stored value and a
		// `#` would silently truncate the URL at the fragment.
		expect(branchPage({ name: "repo", owner: "owner" }, "fix/#1 spaces")).toBe(
			"https://github.com/owner/repo/tree/fix/%231%20spaces",
		);
	});
});
