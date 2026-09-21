// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogOut } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";

import { IconButton } from "./icon-button";
import { TooltipProvider } from "./tooltip";

afterEach(cleanup);

function iconButton() {
	return render(
		<TooltipProvider>
			<IconButton icon={LogOut} label="Sign out" />
		</TooltipProvider>,
	);
}

describe("IconButton tooltips", () => {
	it("names the control without a tooltip having to render", () => {
		// The tooltip is polish; the accessible name is not. Replacing `title` must not move the
		// name onto something that only exists on hover.
		iconButton();

		expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
	});

	it("carries no title attribute", () => {
		// The whole point of the change. Left in place it would show the operating system's own
		// slow, unstyleable bubble underneath ours.
		iconButton();

		expect(screen.getByRole("button").hasAttribute("title")).toBe(false);
	});

	it("shows the label on keyboard focus, not only on hover", async () => {
		// A tooltip that only answers to a pointer is one a keyboard never sees. Tabbed rather
		// than focused programmatically: Radix opens on focus-visible, which a scripted .focus()
		// does not produce.
		iconButton();
		await userEvent.tab();

		expect(await screen.findByRole("tooltip")).toBeDefined();
	});

	it("shows the label on hover", async () => {
		iconButton();
		await userEvent.hover(screen.getByRole("button"));

		expect(await screen.findByRole("tooltip")).toBeDefined();
	});
});
