// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChangesActions } from "./changes-actions";
import { TooltipProvider } from "./tooltip";

// Testing Library only registers its own afterEach with vitest globals enabled, which they are not.
afterEach(cleanup);

// The push button carries a tooltip now, and Radix throws without a provider above it.
function actions(props: Partial<Parameters<typeof ChangesActions>[0]> = {}) {
	return (
		<TooltipProvider>
			<ChangesActions
				discarding={false}
				files={files(1)}
				note=""
				onDiscard={() => undefined}
				onPush={() => undefined}
				pushing={false}
				suggestedMessage="Add a thing"
				unpushed={0}
				{...props}
			/>
		</TooltipProvider>
	);
}

describe("ChangesActions", () => {
	it("offers nothing when there is nothing to act on", () => {
		// A push button above an unchanged checkout is an invitation to an empty commit.
		const { container } = render(actions({ files: [], unpushed: 0 }));

		expect(container.textContent).toBe("");
	});

	it("still offers a push when the work is committed but unpushed", async () => {
		// The dead end this panel exists to avoid. A push that fails leaves a clean tree and a
		// commit that exists nowhere else; hiding the button there held the workspace with no way
		// to act on it.
		const onPush = vi.fn();
		render(actions({ files: [], onPush, unpushed: 1 }));

		await userEvent.click(
			screen.getByRole("button", { name: /commit and push/i }),
		);

		expect(onPush).toHaveBeenCalled();
	});

	it("offers no discard when there is nothing in the tree to discard", () => {
		// Discard resets the working tree. Against an unpushed commit it would do nothing, and a
		// button that does nothing beside one that destroys work is worse than absent.
		render(actions({ files: [], unpushed: 2 }));

		expect(screen.queryByRole("button", { name: /discard/i })).toBeNull();
	});

	it("does not discard on the first click", async () => {
		// The one action here that destroys work, so it takes two deliberate clicks.
		const onDiscard = vi.fn();
		render(actions({ files: files(2), onDiscard }));

		await userEvent.click(screen.getByRole("button", { name: /discard/i }));

		expect(onDiscard).not.toHaveBeenCalled();
	});

	it("names how many files the discard will destroy", async () => {
		// A confirmation that always says the same thing stops being read. The count is what makes
		// this one worth a second of attention.
		render(actions({ files: files(3) }));

		await userEvent.click(screen.getByRole("button", { name: /discard/i }));

		expect(screen.getByRole("button", { name: /3 files/ })).toBeDefined();
	});

	it("disarms when the tree changes underneath the confirmation", async () => {
		// A confirmation armed against three files must not still be live once there are five,
		// because the number is the entire reason for asking.
		const { rerender } = render(actions({ files: files(3) }));
		await userEvent.click(screen.getByRole("button", { name: /discard/i }));
		expect(screen.getByRole("button", { name: /3 files/ })).toBeDefined();

		rerender(actions({ files: files(5) }));

		expect(screen.queryByRole("button", { name: /3 files/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Discard changes" }),
		).toBeDefined();
	});

	it("disarms when the files change but the count does not", async () => {
		// The list is re-read every fifteen seconds. An agent that deleted one file and created
		// another leaves a count that never moved, and a confirmation armed against the old set
		// would still be live against work nobody had looked at.
		const { rerender } = render(actions({ files: files(2) }));
		await userEvent.click(screen.getByRole("button", { name: /discard/i }));
		// Proves the arming happened, so the assertion below cannot pass by never having armed.
		expect(screen.getByRole("button", { name: /2 files/ })).toBeDefined();

		rerender(
			actions({
				files: [
					{ path: "src/file-0.ts", status: "modified" },
					{ path: "src/something-else.ts", status: "untracked" },
				],
			}),
		);

		expect(
			screen.getByRole("button", { name: "Discard changes" }),
		).toBeDefined();
	});

	it("offers the purpose as the commit message", () => {
		// Better than an empty box: the purpose is already the sentence describing what the agent
		// was asked to do.
		render(actions({ suggestedMessage: "Add a thing" }));

		expect(screen.getByDisplayValue("Add a thing")).toBeDefined();
	});

	it("labels the message field, which arrives pre-filled", () => {
		// A placeholder is only read when a field is empty, and this one is pre-filled with the
		// workspace's purpose. Queried by its label rather than its placeholder, so the assertion
		// fails if the label is removed or stops being associated with the input.
		render(actions({ suggestedMessage: "Add a thing" }));

		expect(
			(screen.getByLabelText(/commit message/i) as HTMLInputElement).value,
		).toBe("Add a thing");
	});

	it("refuses to push an empty commit message", async () => {
		const onPush = vi.fn();
		render(actions({ onPush, suggestedMessage: "   " }));

		await userEvent.click(
			screen.getByRole("button", { name: /commit and push/i }),
		);

		expect(onPush).not.toHaveBeenCalled();
	});
});

function files(count: number) {
	return Array.from({ length: count }, (_value, index) => ({
		path: `src/file-${index}.ts`,
		status: "modified" as const,
	}));
}
