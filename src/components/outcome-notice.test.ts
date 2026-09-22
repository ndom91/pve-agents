import { describe, expect, it } from "vitest";

import { outcomeItem } from "./outcome-notice";

describe("outcomeItem", () => {
	it("says nothing when nothing happened to the work", () => {
		// A workspace that was never given anything to do. A neutral "changes discarded" here would
		// be a claim about work that never existed.
		expect(outcomeItem({ events: [] })).toEqual([]);
	});

	it("is green for work that reached a branch", () => {
		const [item] = outcomeItem({
			events: [
				{
					eventType: "workspace.pushed",
					message: "pushed to pve-agents/agent-04fb",
				},
			],
			repository: "github.com/ndom91/pve-agents",
		});

		expect(item).toEqual({ label: "work pushed", severity: "green" });
	});

	it("is red for work that ended without leaving the container", () => {
		// The only outcome where something is gone and nobody can get it back, so it is the only
		// one that reads as a warning rather than a report.
		const [item] = outcomeItem({ events: [], unsavedWork: true });

		expect(item?.severity).toBe("red");
	});

	it("is neutral for work thrown away on purpose", () => {
		// Deliberate, so it is a report rather than a warning.
		const [item] = outcomeItem({
			events: [{ eventType: "workspace.discarded", message: "discarded" }],
		});

		expect(item?.severity).toBe("neutral");
	});

	it("prefers a push over the stored unsaved-work flag", () => {
		// The flag is a cached observation and a push is a fact. A workspace that pushed and was
		// then flagged by a check that could not see the branch is safe, and calling it lost is the
		// more alarming of the two possible mistakes.
		const [item] = outcomeItem({
			events: [
				{ eventType: "workspace.pushed", message: "pushed to some/branch" },
			],
			unsavedWork: true,
		});

		expect(item?.severity).toBe("green");
	});
});
