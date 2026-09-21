// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LifecycleStrip } from "./lifecycle-strip";

afterEach(cleanup);

describe("LifecycleStrip", () => {
	it("is a progressbar with a value, not six decorative spans", () => {
		// The reason this component exists: the fleet row had a copy of the markup without the
		// role or the labels, so the home screen's strip said nothing to a screen reader while the
		// identical strip in the panel was announced. Nothing stopped that recurring until now.
		render(<LifecycleStrip phase="booted" status="provisioning" />);

		const bar = screen.getByRole("progressbar");
		expect(bar.getAttribute("aria-valuenow")).toBe("3");
		expect(bar.getAttribute("aria-valuemax")).toBe("6");
		expect(bar.getAttribute("aria-label")).toContain("booted");
	});

	it("fills one segment per step reached", () => {
		const { container } = render(
			<LifecycleStrip phase="seeded" status="provisioning" />,
		);

		expect(container.querySelectorAll(".lifecycle-seg")).toHaveLength(6);
		expect(container.querySelectorAll(".lifecycle-seg.is-done")).toHaveLength(
			5,
		);
	});

	it("does not name a step it has not reached", () => {
		// `LIFECYCLE_STEPS[Math.max(0, -1)]` is "requested", so a strip at zero announced itself
		// as having completed the first step.
		render(<LifecycleStrip status="destroyed" />);

		const label = screen.getByRole("progressbar").getAttribute("aria-label");
		expect(label).toContain("not started");
		expect(label).not.toContain("requested");
	});
});
