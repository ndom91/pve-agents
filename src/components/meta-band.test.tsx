// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MetaBand } from "./meta-band";

// Testing Library only registers its own afterEach with vitest globals enabled, which they are not.
afterEach(cleanup);

describe("MetaBand", () => {
	it("drops a fact with no value rather than printing an empty key", () => {
		// A workspace acquires these as it provisions, so a missing one means "not there yet". A
		// key with nothing beside it reads as a fault instead.
		render(
			<MetaBand facts={[{ key: "node", value: "nas" }, { key: "vmid" }]} />,
		);

		expect(screen.getByText("nas")).toBeDefined();
		expect(screen.queryByText("vmid")).toBeNull();
	});

	it("carries a notice among the facts, tinted by its severity", () => {
		// The third placement in the notices spec: a state that needs no decision becomes a fact
		// rather than a strip. The fill and the dot carry the severity, because at nineteen pixels
		// there is no room for an icon.
		const { container } = render(
			<MetaBand
				facts={[{ key: "node", value: "nas" }]}
				notices={[{ label: "unsaved work lost", severity: "red" }]}
			/>,
		);

		const chip = container.querySelector(".meta-band-notice");
		expect(chip?.textContent).toBe("unsaved work lost");
		expect(chip?.className).toContain("is-red");
	});

	it("draws no divider before a notice when there are no facts", () => {
		// A destroyed workspace has lost its placement, so the band can be nothing but the outcome.
		// A leading rule there would be a divider dividing one thing from the edge.
		const { container } = render(
			<MetaBand
				facts={[]}
				notices={[{ label: "work pushed", severity: "green" }]}
			/>,
		);

		expect(container.querySelector(".meta-band-sep")).toBeNull();
	});
});
