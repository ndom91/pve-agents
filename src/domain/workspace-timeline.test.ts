import { describe, expect, it } from "vitest";

import type { TimelineEvent } from "./workspace-timeline";
import { groupTimeline } from "./workspace-timeline";

let next = 1;
function event(
	createdAt: string,
	eventType = "workspace.booted",
): TimelineEvent {
	next += 1;
	return { createdAt, eventType, id: next, message: eventType };
}

describe("groupTimeline", () => {
	it("nests everything that landed in the same second under the first of them", () => {
		// Provisioning writes several at once -- addressed, reachable, bootstrapped, checked-out.
		// As four rows each repeating one timestamp, that is four copies of the same fact.
		const items = groupTimeline([
			event("2026-09-20T22:41:50.100Z", "workspace.booted"),
			event("2026-09-20T22:41:50.140Z", "workspace.addressed"),
			event("2026-09-20T22:41:50.190Z", "workspace.reachable"),
			event("2026-09-20T22:42:02.000Z", "workspace.seeded"),
		]);

		expect(items).toHaveLength(2);
		expect(items[0].lead.eventType).toBe("workspace.booted");
		expect(items[0].nested.map((e) => e.eventType)).toEqual([
			"workspace.addressed",
			"workspace.reachable",
		]);
		expect(items[1].nested).toEqual([]);
	});

	it("carries the gap since the previous moment", () => {
		const items = groupTimeline([
			event("2026-09-20T22:41:38.000Z"),
			event("2026-09-20T22:41:45.000Z"),
			event("2026-09-20T22:41:50.000Z"),
		]);

		expect(items.map((item) => item.sincePrevious)).toEqual([
			undefined,
			7000,
			5000,
		]);
	});

	it("measures the gap from lead to lead, not from the last nested event", () => {
		// Otherwise a moment made of five events reports the gap after its tail, and the strip
		// claims a wait that never happened.
		const items = groupTimeline([
			event("2026-09-20T22:41:50.000Z"),
			event("2026-09-20T22:41:50.900Z"),
			event("2026-09-20T22:42:02.000Z"),
		]);

		expect(items[1].sincePrevious).toBe(12000);
	});

	it("says nothing rather than something negative when events run backwards", () => {
		// "+-3s" is worse than no delta.
		const items = groupTimeline([
			event("2026-09-20T22:41:50.000Z"),
			event("2026-09-20T22:41:40.000Z"),
		]);

		expect(items[1].sincePrevious).toBeUndefined();
	});

	it("never groups on a stamp it could not read", () => {
		const items = groupTimeline([event("not a date"), event("not a date")]);

		expect(items).toHaveLength(2);
		expect(items[1].sincePrevious).toBeUndefined();
	});

	it("keeps an empty history empty", () => {
		expect(groupTimeline([])).toEqual([]);
	});
});
