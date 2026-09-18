// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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
				tab="details"
				workspace={{ ip: "10.0.3.110", repository: "github.com/a/b" }}
			/>,
		);

		expect(screen.getByText("10.0.3.110")).toBeDefined();
		expect(screen.queryByText("the changes")).toBeNull();

		rerender(
			<WorkspaceRail
				changes={<p>the changes</p>}
				tab="diff"
				workspace={{ ip: "10.0.3.110", repository: "github.com/a/b" }}
			/>,
		);

		expect(screen.getByText("the changes")).toBeDefined();
		// The placement goes rather than being pushed below the fold: both want the full column.
		expect(screen.queryByText("10.0.3.110")).toBeNull();
	});
});
