import { describe, expect, it } from "vitest";

import {
	mapActivity,
	nextWorkspaceStatus,
	workspaceTargetForStatus,
} from "./workspace";

describe("nextWorkspaceStatus", () => {
	it("accepts the normal provision and destroy paths", () => {
		const cases = [
			["requested", "provisioning"],
			["provisioning", "booting"],
			["booting", "bootstrapping"],
			["bootstrapping", "registering"],
			["registering", "ready"],
			["ready", "destroying"],
			["destroying", "destroyed"],
		] as const;

		for (const [from, to] of cases) {
			const result = nextWorkspaceStatus(from, to);

			expect(result).toEqual({ ok: true, status: to });
		}
	});

	it("allows failure and explicit retry", () => {
		expect(nextWorkspaceStatus("booting", "failed")).toEqual({
			ok: true,
			status: "failed",
		});
		expect(nextWorkspaceStatus("failed", "provisioning")).toEqual({
			ok: true,
			status: "provisioning",
		});
	});

	it("rejects invalid transitions", () => {
		const result = nextWorkspaceStatus("requested", "ready");

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}

		expect(result.error.message).toBe(
			"workspace: cannot transition from requested to ready",
		);
	});
});

describe("workspaceTargetForStatus", () => {
	it("keeps normal lifecycle states present", () => {
		expect(workspaceTargetForStatus("ready")).toBe("present");
	});

	it("marks destruction lifecycle states destroyed", () => {
		expect(workspaceTargetForStatus("destroying")).toBe("destroyed");
		expect(workspaceTargetForStatus("destroyed")).toBe("destroyed");
	});
});

describe("mapActivity", () => {
	// Exported and tested directly because the stream uses it too, several times more often than
	// the observation pass does. A second copy of this mapping would be a way for the two to
	// disagree about what "done" means.
	it("maps every status a runner reports", () => {
		expect(mapActivity("working")).toBe("active");
		expect(mapActivity("blocked")).toBe("blocked");
		expect(mapActivity("idle")).toBe("idle");
		expect(mapActivity("done")).toBe("idle");
		expect(mapActivity("unknown")).toBe("unknown");
		expect(mapActivity("something-new")).toBe("unknown");
	});

	it("keeps blocked distinct from everything else", () => {
		// The controls for answering a dialog are gated on this value. Folding blocked into idle
		// would leave an agent waiting with no way to answer it.
		expect(mapActivity("blocked")).not.toBe(mapActivity("idle"));
		expect(mapActivity("blocked")).not.toBe(mapActivity("working"));
	});
});
