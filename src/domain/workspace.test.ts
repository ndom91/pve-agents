import { describe, expect, it } from "vitest";

import { nextWorkspaceStatus, workspaceTargetForStatus } from "./workspace";

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
