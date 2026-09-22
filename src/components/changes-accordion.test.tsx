// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangedFile } from "../services/workspace-changes";

// The discard reaches a server function, which does not exist in a test. Mocked at that boundary
// so what is asserted is the arming, which is the part that stops work being lost.
const discardWorkspaceFile = vi.fn(async (_input: unknown) => ({
	kind: "done" as const,
}));

vi.mock("../server/agent.functions", () => ({
	discardWorkspaceFile: (input: unknown) => discardWorkspaceFile(input),
}));

const { ChangesAccordion } = await import("./changes-accordion");
const { TooltipProvider } = await import("./tooltip");

// Testing Library only registers its own afterEach with vitest globals enabled, which they are not.
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

// A client per render, so one test's cache cannot answer another's question. Retries off because a
// query here reaches a server function that does not exist in a test: what is being checked is
// which rows mount a diff at all, not what the diff says.
function accordion(files: ChangedFile[]) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			{/* The bar's reload control is an IconButton, and those carry a Radix tooltip that
			    throws without a provider above it. The application has one at the document root;
			    a component rendered on its own has to bring its own. */}
			<TooltipProvider>
				<ChangesAccordion files={files} workspaceId="w1" />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

describe("ChangesAccordion", () => {
	it("starts every row folded away", () => {
		// The point of the list is to be readable at a glance. Unfolding everything would cost a
		// read of every file to show a page nobody has asked a question of yet.
		render(accordion([{ path: "README.md", status: "modified" }]));

		expect(
			screen.getByRole("button", { expanded: false, name: /README\.md/ }),
		).toBeDefined();
	});

	it("unfolds a row on click and folds it again on a second click", async () => {
		render(accordion([{ path: "README.md", status: "modified" }]));

		const row = screen.getByRole("button", { name: /README\.md/ });
		await userEvent.click(row);

		expect(row.getAttribute("aria-expanded")).toBe("true");

		await userEvent.click(row);

		expect(row.getAttribute("aria-expanded")).toBe("false");
	});

	it("holds two rows open at once", async () => {
		// The whole reason this replaced a tab per file. Comparing two changes is the commonest
		// reason to be here, and the tabs made it a switch back and forth.
		render(
			accordion([
				{ path: "a.ts", status: "modified" },
				{ path: "b.ts", status: "added" },
			]),
		);

		await userEvent.click(screen.getByRole("button", { name: /a\.ts/ }));
		await userEvent.click(screen.getByRole("button", { name: /b\.ts/ }));

		expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(2);
	});

	it("names a row by its whole path, not by its file name", async () => {
		// Two files can share a name. On a tab that needed a hover to tell apart; here it is read.
		render(
			accordion([
				{ path: "src/a/config.ts", status: "modified" },
				{ path: "src/b/config.ts", status: "modified" },
			]),
		);

		await userEvent.click(
			screen.getByRole("button", { name: /src\/b\/config\.ts/ }),
		);

		expect(
			screen.getByRole("button", {
				expanded: true,
				name: /src\/b\/config\.ts/,
			}),
		).toBeDefined();
		expect(
			screen.getByRole("button", {
				expanded: false,
				name: /src\/a\/config\.ts/,
			}),
		).toBeDefined();
	});

	it("totals the line counts across the list", () => {
		// Summed here rather than reported by the server, so the number in the bar and the numbers
		// under it cannot drift apart.
		const { container } = render(
			accordion([
				{ added: 96, path: "a.ts", removed: 0, status: "added" },
				{ added: 26, path: "b.ts", removed: 18, status: "modified" },
			]),
		);

		const bar = container.querySelector(".panel-bar .change-stat");
		expect(bar?.textContent).toBe("+122−18");
	});

	it("prints nothing where git could not count", () => {
		// A binary file. "+0 −0" would say it changed in no way, which is a different claim from
		// "there are no lines here to count".
		const { container } = render(
			accordion([
				{ added: 3, path: "a.ts", removed: 1, status: "modified" },
				{ path: "logo.png", status: "modified" },
			]),
		);

		const rows = [...container.querySelectorAll(".change-row")];
		expect(rows[0]?.querySelector(".change-stat")?.textContent).toBe("+3−1");
		expect(rows[1]?.querySelector(".change-stat")).toBeNull();
	});

	it("shows no total when nothing in the list could be counted", () => {
		const { container } = render(
			accordion([{ path: "logo.png", status: "modified" }]),
		);

		expect(container.querySelector(".panel-bar .change-stat")).toBeNull();
	});

	it("arms the per-file discard before it will fire", async () => {
		// git cannot undo either branch of this: a tracked file is restored from HEAD and an
		// untracked one is deleted outright. A hover-revealed control that acts on one click is a
		// mis-click away from losing work, so the first click only arms it.
		render(accordion([{ path: "package.json", status: "modified" }]));

		const discard = screen.getByRole("button", { name: "Discard changes" });
		await userEvent.click(discard);

		expect(discardWorkspaceFile).not.toHaveBeenCalled();
		// And it names the file once armed, so the second click is against something specific
		// rather than against a generic warning nobody reads.
		expect(
			screen.getByRole("button", { name: "Discard package.json?" }),
		).toBeDefined();
	});

	it("discards on the second click", async () => {
		render(accordion([{ path: "package.json", status: "modified" }]));

		await userEvent.click(
			screen.getByRole("button", { name: "Discard changes" }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Discard package.json?" }),
		);

		expect(discardWorkspaceFile).toHaveBeenCalledWith({
			data: { id: "w1", path: "package.json" },
		});
	});
});
