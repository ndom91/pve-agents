// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChangesPanel } from "./changes-panel";

// Testing Library only registers its own afterEach with vitest globals enabled, which they are not.
afterEach(cleanup);

function panel(props: Partial<Parameters<typeof ChangesPanel>[0]> = {}) {
	return (
		<ChangesPanel
			changes={{ files: [], kind: "changes" }}
			discarding={false}
			note=""
			onClose={() => undefined}
			onDiscard={() => undefined}
			onPush={() => undefined}
			onSelect={() => undefined}
			pushing={false}
			suggestedMessage="Add a thing"
			{...props}
		/>
	);
}

describe("ChangesPanel", () => {
	it("says the agent changed nothing rather than showing an empty tree", () => {
		render(panel());

		expect(screen.getByText(/has not changed anything/)).toBeDefined();
	});

	it("reports a workspace it could not read instead of claiming it is clean", () => {
		// The same distinction the reaper turns on. An empty tree here would read as "nothing to
		// save" for a workspace nobody could actually inspect.
		render(
			panel({ changes: { kind: "failed", message: "workspace refused" } }),
		);

		expect(screen.getByText("workspace refused")).toBeDefined();
		expect(screen.queryByText(/has not changed anything/)).toBeNull();
	});

	it("does not discard on the first click", async () => {
		// The one action here that destroys work, so it takes two deliberate clicks.
		const onDiscard = vi.fn();
		render(panel({ changes: files(2), onDiscard }));

		await userEvent.click(screen.getByRole("button", { name: /discard/i }));

		expect(onDiscard).not.toHaveBeenCalled();
	});

	it("names how many files the discard will destroy", async () => {
		// A confirmation that always says the same thing stops being read. The count is what makes
		// this one worth a second of attention.
		render(panel({ changes: files(3) }));

		await userEvent.click(screen.getByRole("button", { name: /discard/i }));

		expect(screen.getByRole("button", { name: /3 files/ })).toBeDefined();
	});

	it("disarms when the tree changes underneath the confirmation", async () => {
		// A confirmation armed against three files must not still be live once there are five,
		// because the number is the entire reason for asking.
		const { rerender } = render(panel({ changes: files(3) }));
		await userEvent.click(screen.getByRole("button", { name: /discard/i }));
		expect(screen.getByRole("button", { name: /3 files/ })).toBeDefined();

		rerender(panel({ changes: files(5) }));

		expect(screen.queryByRole("button", { name: /3 files/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Discard changes" }),
		).toBeDefined();
	});

	it("disarms when the files change but the count does not", async () => {
		// The list is re-read every fifteen seconds. An agent that deleted one file and created
		// another leaves a count that never moved, and a confirmation armed against the old set
		// would still be live against work nobody had looked at.
		const { rerender } = render(panel({ changes: files(2) }));
		await userEvent.click(screen.getByRole("button", { name: /discard/i }));
		// Proves the arming happened, so the assertion below cannot pass by never having armed.
		expect(screen.getByRole("button", { name: /2 files/ })).toBeDefined();

		rerender(
			panel({
				changes: {
					files: [
						{ path: "src/file-0.ts", status: "modified" },
						{ path: "src/something-else.ts", status: "untracked" },
					],
					kind: "changes",
				},
			}),
		);

		expect(
			screen.getByRole("button", { name: "Discard changes" }),
		).toBeDefined();
	});

	it("shows the file beside the tree rather than somewhere else", async () => {
		// The diff used to take over the centre, which meant reading a change cost you the sight of
		// the terminal and a click to get it back.
		render(
			panel({
				changes: files(1),
				diff: <p>the diff</p>,
				selected: "src/file-0.ts",
			}),
		);

		expect(screen.getByText("the diff")).toBeDefined();
		expect(screen.getByText("src/file-0.ts")).toBeDefined();
	});

	it("shows no diff area until a file is chosen", () => {
		render(panel({ changes: files(1), diff: <p>the diff</p> }));

		expect(screen.queryByText("the diff")).toBeNull();
	});

	it("closes the file without touching the changes", async () => {
		const onClose = vi.fn();
		render(
			panel({
				changes: files(1),
				diff: <p>the diff</p>,
				onClose,
				selected: "src/file-0.ts",
			}),
		);

		await userEvent.click(
			screen.getByRole("button", { name: /close the file/i }),
		);

		expect(onClose).toHaveBeenCalled();
	});

	it("offers the purpose as the commit message", () => {
		// Better than an empty box: the purpose is already the sentence describing what the agent
		// was asked to do.
		render(panel({ changes: files(1), suggestedMessage: "Add a thing" }));

		expect(screen.getByDisplayValue("Add a thing")).toBeDefined();
	});

	it("refuses to push an empty commit message", async () => {
		const onPush = vi.fn();
		render(panel({ changes: files(1), onPush, suggestedMessage: "   " }));

		const push = screen.getByRole("button", { name: /commit and push/i });
		await userEvent.click(push);

		expect(onPush).not.toHaveBeenCalled();
	});
});

function files(count: number) {
	return {
		files: Array.from({ length: count }, (_value, index) => ({
			path: `src/file-${index}.ts`,
			status: "modified" as const,
		})),
		kind: "changes" as const,
	};
}
