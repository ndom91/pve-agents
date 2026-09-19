// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { ChangedFile } from "../services/workspace-changes";
import { ChangesAccordion } from "./changes-accordion";

// Testing Library only registers its own afterEach with vitest globals enabled, which they are not.
afterEach(cleanup);

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
			<ChangesAccordion files={files} workspaceId="w1" />
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
});
