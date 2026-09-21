import { describe, expect, it } from "vitest";

import type { ProvisionPhase } from "./workspace";
import { LIFECYCLE_STEPS, lifecycleReached } from "./workspace-lifecycle";

describe("lifecycleReached", () => {
	it("fills the strip for a ready workspace whatever its phase says", () => {
		// Rows written before provision_phase existed carry none at all, and they are as ready as
		// any other.
		expect(lifecycleReached("briefed", "ready")).toBe(6);
		expect(lifecycleReached(undefined, "ready")).toBe(6);
	});

	it("empties it once the container is gone", () => {
		// Not mid-provision. Over.
		expect(lifecycleReached("briefed", "destroyed")).toBe(0);
		expect(lifecycleReached("briefed", "destroying")).toBe(0);
	});

	it("counts a phase as the segment it completed", () => {
		expect(lifecycleReached("clone-submitted", "provisioning")).toBe(1);
		expect(lifecycleReached("clone-confirmed", "provisioning")).toBe(2);
		expect(lifecycleReached("booted", "provisioning")).toBe(3);
		expect(lifecycleReached("reachable", "provisioning")).toBe(4);
		expect(lifecycleReached("seeded", "provisioning")).toBe(5);
		expect(lifecycleReached("briefed", "provisioning")).toBe(6);
	});

	it("never goes backwards along the executor's own order", () => {
		// The one property worth asserting: the bar is read as progress, so a later phase must not
		// fill fewer segments than an earlier one. The order here is the switch in
		// workspace-provision-executor.ts, copied deliberately -- if that changes, this fails.
		const order: ProvisionPhase[] = [
			"clone-submitted",
			"clone-confirmed",
			"start-submitted",
			"booted",
			"addressed",
			"reachable",
			"bootstrapped",
			"checked-out",
			"seeded",
			"runner-started",
			"briefed",
		];

		const reached = order.map((phase) =>
			lifecycleReached(phase, "provisioning"),
		);

		expect(reached).toEqual([...reached].sort((a, b) => a - b));
		expect(reached.at(-1)).toBe(LIFECYCLE_STEPS.length);
	});

	it("treats a workspace with no phase, or an unknown one, as requested", () => {
		// It exists, which is the first segment. Zero would read as nothing having happened.
		expect(lifecycleReached(undefined, "requested")).toBe(1);
		// Cast, because the point of the case is a value the union does not contain: a row written
		// by a newer controller and read by an older one. The typing cannot prevent that -- it
		// describes what this build writes, not what is in the database -- which is why the
		// fallback survives despite looking unreachable.
		expect(
			lifecycleReached("something-new" as ProvisionPhase, "provisioning"),
		).toBe(1);
	});
});
