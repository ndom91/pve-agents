// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SwapText } from "./swap-text";

afterEach(cleanup);

// Real timers rather than fake ones. The swap waits on a setTimeout and then on two animation
// frames, and happy-dom's requestAnimationFrame is not driven by the fake clock — faking time
// left every assertion looking at a half-finished swap for reasons that had nothing to do with
// the component. The waits below are milliseconds.
async function settled(container: HTMLElement): Promise<void> {
	await waitFor(() => {
		expect(container.querySelector(".is-exit")).toBeNull();
		expect(container.querySelector(".is-enter-start")).toBeNull();
	});
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SwapText", () => {
	it("shows the value it was given", () => {
		render(<SwapText value="ready" />);

		expect(screen.getByText("ready")).toBeDefined();
	});

	it("lands on the new value and comes to rest", async () => {
		const { container, rerender } = render(<SwapText value="ready" />);

		rerender(<SwapText value="destroying" />);

		// At rest means carrying neither of the two classes that make it invisible.
		await settled(container);
		expect(screen.getByText("destroying")).toBeDefined();
	});

	it("survives a second change inside the first swap", async () => {
		// The bug this exists to prevent, and it was visible on every workspace. Destroying one
		// predicts "destroying" the moment the button is pressed and confirms a moment later,
		// both well inside the 150ms swap. The exit timer used to be cancelled by the second
		// change and never rescheduled, so the badge sat at opacity zero — an empty bordered box
		// — until the page was reloaded.
		const { container, rerender } = render(<SwapText value="ready" />);

		rerender(<SwapText value="destroying" />);
		await pause(20);
		rerender(<SwapText value="destroyed" />);

		await settled(container);
		expect(screen.getByText("destroyed")).toBeDefined();
	});

	it("survives a change on every frame of a swap", async () => {
		// The same failure with no gap at all to hide in.
		const { container, rerender } = render(<SwapText value="requested" />);

		for (const status of [
			"provisioning",
			"booting",
			"bootstrapping",
			"ready",
		]) {
			rerender(<SwapText value={status} />);
			await pause(5);
		}

		await settled(container);
		expect(screen.getByText("ready")).toBeDefined();
	});

	it("keeps the caller's own class alongside its own", () => {
		const { container } = render(<SwapText className="status" value="ready" />);

		const span = container.querySelector("span");
		expect(span?.className).toContain("status");
		expect(span?.className).toContain("t-text-swap");
	});
});
