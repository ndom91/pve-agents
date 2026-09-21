import { describe, expect, it } from "vitest";

import { outcomeNotice } from "./outcome-notice";

describe("outcomeNotice", () => {
	it("says nothing when nothing happened to the work", () => {
		// A workspace that was never given anything to do. A neutral "changes discarded" here would
		// be a claim about work that never existed.
		expect(outcomeNotice({ events: [] })).toEqual([]);
	});

	it("is green for work that reached a branch, and offers it", () => {
		// The branch used to be a link inside the sentence. A strip clips its text, so the link is
		// the action instead, where it cannot be clipped away.
		const [notice] = outcomeNotice({
			events: [
				{
					eventType: "workspace.pushed",
					message: "pushed to pve-agents/agent-04fb",
				},
			],
			repository: "github.com/ndom91/pve-agents",
		});

		expect(notice?.severity).toBe("green");
		expect(notice?.lead).toBe("Work pushed");
		expect(notice?.action?.label).toBe("Open branch");
	});

	it("offers no branch to open when the repository has no web address", () => {
		// A link that 404s is worse than a branch name, which at least says what to go and look for.
		const [notice] = outcomeNotice({
			events: [
				{ eventType: "workspace.pushed", message: "pushed to some/branch" },
			],
		});

		expect(notice?.severity).toBe("green");
		expect(notice?.action).toBeUndefined();
	});

	it("is red for work that ended without leaving the container", () => {
		// The one outcome where something is gone and nobody can get it back, so it is the only one
		// that outranks everything else in the stack.
		const [notice] = outcomeNotice({ events: [], unsavedWork: true });

		expect(notice?.severity).toBe("red");
		expect(notice?.action).toBeUndefined();
	});

	it("is neutral for work thrown away on purpose", () => {
		// Deliberate, so it is a report rather than a warning.
		const [notice] = outcomeNotice({
			events: [{ eventType: "workspace.discarded", message: "discarded" }],
		});

		expect(notice?.severity).toBe("neutral");
	});
});
