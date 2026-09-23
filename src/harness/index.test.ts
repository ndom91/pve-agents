import { describe, expect, it } from "vitest";

import { anyHarnessMerges } from "./index";

describe("anyHarnessMerges", () => {
	it("merges the file claude-code writes for itself", () => {
		// ~/.claude.json holds the onboarding and trust-dialog flags that bootstrapAgentHome puts
		// there, so a seeded copy landing on top would take them away and the agent would stall on
		// a first-run prompt with nobody to answer it.
		expect(anyHarnessMerges(".claude.json")).toBe(true);
	});

	it("does not merge an opencode config, because nothing writes one", () => {
		// Merging exists to protect a file the workspace wrote itself. A provisioned workspace has
		// an empty ~/.config/opencode and no config file anywhere under $HOME, so there is nothing
		// to protect -- and a merged destination is validated with JSON.parse, which would refuse a
		// commented opencode.jsonc. That is the format's entire reason for existing.
		expect(anyHarnessMerges(".config/opencode/opencode.json")).toBe(false);
		expect(anyHarnessMerges(".config/opencode/opencode.jsonc")).toBe(false);
	});

	it("says no to an ordinary file", () => {
		expect(anyHarnessMerges("CLAUDE.md")).toBe(false);
	});
});
