import { describe, expect, it } from "vitest";

import { claudeSeed } from "./bootstrap";

describe("claudeSeed", () => {
	it("trusts the directory the agent will actually run in", () => {
		// Trust is recorded per directory, so seeding it for the wrong path leaves the dialog in
		// place and the agent blocked.
		expect(JSON.parse(claudeSeed("/workspace/repo"))).toEqual({
			hasCompletedOnboarding: true,
			projects: { "/workspace/repo": { hasTrustDialogAccepted: true } },
		});
	});
});
