// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceRail } from "./workspace-rail";

// Explicit cleanup. Testing Library only registers its own afterEach when vitest globals are
// enabled, and they are not here. Without this, renders accumulate in the document and a query
// finds the previous test's output, which passes for the wrong reason until a test happens to
// assert something is absent.
afterEach(cleanup);

describe("WorkspaceRail", () => {
	it("shows the placement a workspace has reached", () => {
		render(
			<WorkspaceRail
				workspace={{
					ip: "10.0.3.110",
					node: "nas",
					repository: "github.com/ndom91/open-plan-annotator",
					vmid: 400,
				}}
			/>,
		);

		expect(screen.getByText("10.0.3.110")).toBeDefined();
		expect(screen.getByText("400")).toBeDefined();
		expect(screen.getByText("nas")).toBeDefined();
	});

	it("omits what a workspace has not reached yet", () => {
		// These arrive as provisioning progresses, so a missing one means "not there yet". An empty
		// row would read as a problem instead of as nothing.
		render(<WorkspaceRail workspace={{ repository: "github.com/a/b" }} />);

		expect(screen.queryByText("VMID")).toBeNull();
		expect(screen.queryByText("Address")).toBeNull();
		expect(screen.getByText("Repository")).toBeDefined();
	});

	it("renders nothing at all for a workspace with no detail", () => {
		const { container } = render(<WorkspaceRail workspace={{}} />);

		expect(container.querySelectorAll("dd")).toHaveLength(0);
	});

	it("offers no diff tab for a workspace that has nothing to show in one", () => {
		// A workspace still provisioning has no changes to list, and a tab that answers nothing is
		// worse than no tab.
		render(<WorkspaceRail workspace={{ repository: "github.com/a/b" }} />);

		expect(screen.queryByRole("tab", { name: "Diff" })).toBeNull();
	});

	it("shows the placement until the diff tab is chosen, and then the diff", () => {
		const { rerender } = render(
			<WorkspaceRail
				changes={<p>the changes</p>}
				tab={{ kind: "details" }}
				workspace={{ ip: "10.0.3.110", repository: "github.com/a/b" }}
			/>,
		);

		expect(screen.getByText("10.0.3.110")).toBeDefined();
		expect(screen.queryByText("the changes")).toBeNull();

		rerender(
			<WorkspaceRail
				changes={<p>the changes</p>}
				tab={{ kind: "diff" }}
				workspace={{ ip: "10.0.3.110", repository: "github.com/a/b" }}
			/>,
		);

		expect(screen.getByText("the changes")).toBeDefined();
		// The placement goes rather than being pushed below the fold: both want the full column.
		expect(screen.queryByText("10.0.3.110")).toBeNull();
	});

	it("gives an opened file a tab of its own, named for the file", () => {
		render(
			<WorkspaceRail
				changes={<p>the list</p>}
				file={<p>the file</p>}
				files={["src/deep/nested/package.json"]}
				tab={{ kind: "file", path: "src/deep/nested/package.json" }}
				workspace={{}}
			/>,
		);

		// The name, not the path: a full path would make every tab as wide as the rail.
		expect(screen.getByRole("tab", { name: "package.json" })).toBeDefined();
		expect(screen.getByText("the file")).toBeDefined();
		expect(screen.queryByText("the list")).toBeNull();
	});

	it("closes a file tab by its own path, not by its name", async () => {
		// Two files can share a name. Closing by what is printed on the tab would shut the wrong one.
		const onClose = vi.fn();
		render(
			<WorkspaceRail
				changes={<p>the list</p>}
				files={["a/config.ts", "b/config.ts"]}
				onClose={onClose}
				tab={{ kind: "file", path: "b/config.ts" }}
				workspace={{}}
			/>,
		);

		await userEvent.click(
			screen.getByRole("button", { name: "Close b/config.ts" }),
		);

		expect(onClose).toHaveBeenCalledWith("b/config.ts");
	});

	it("keeps the actions in place whichever tab is open", () => {
		// They act on the workspace rather than on a file, so they do not belong inside a tab.
		for (const tab of [
			{ kind: "diff" } as const,
			{ kind: "file", path: "a.ts" } as const,
		]) {
			cleanup();
			render(
				<WorkspaceRail
					actions={<p>the actions</p>}
					changes={<p>the list</p>}
					file={<p>the file</p>}
					files={["a.ts"]}
					tab={tab}
					workspace={{}}
				/>,
			);

			expect(screen.getByText("the actions")).toBeDefined();
		}
	});
});
