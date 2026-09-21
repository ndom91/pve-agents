// @vitest-environment happy-dom

import { cleanup, render as renderBare, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "./tooltip";
import { WorkspaceRail } from "./workspace-rail";

// Explicit cleanup. Testing Library only registers its own afterEach when vitest globals are
// enabled, and they are not here. Without this, renders accumulate in the document and a query
// finds the previous test's output, which passes for the wrong reason until a test happens to
// assert something is absent.
afterEach(cleanup);

// The rail's copy buttons are IconButtons, which carry a Radix tooltip, and Radix throws outright
// without a provider above it. The application has one at the document root; a test rendering a
// component on its own does not, so it brings its own.
function render(ui: Parameters<typeof renderBare>[0]) {
	return renderBare(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("WorkspaceRail", () => {
	it("shows the placement a workspace has reached", () => {
		// Also in the meta band under the top bar, and deliberately: the band is the glance you get
		// without opening anything, and this tab is the full record you come to when the glance was
		// not enough.
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

	it("keeps the ssh line, which the band cannot be read off by eye", () => {
		// Assembled by hand out of the address every time somebody wanted a shell outside the
		// browser, which is why it exists as a row of its own with a copy button.
		render(
			<WorkspaceRail workspace={{ ip: "10.0.3.110", repository: "a/b" }} />,
		);

		expect(screen.getByText("ssh agent@10.0.3.110")).toBeDefined();
	});

	it("omits what a workspace has not reached yet", () => {
		// These arrive as provisioning progresses, so a missing one means "not there yet". An empty
		// row would read as a problem instead of as nothing.
		render(<WorkspaceRail workspace={{ repository: "github.com/a/b" }} />);

		// By the rendered text, not by "SSH" -- that string only exists on the copy button's
		// aria-label, which queryByText does not match, so the assertion passed either way.
		expect(screen.queryByText(/ssh agent@/)).toBeNull();
		expect(screen.queryByText("VMID")).toBeNull();
		expect(screen.queryByText("Address")).toBeNull();
		expect(screen.getByText("Repository")).toBeDefined();
	});

	it("renders nothing at all for a workspace with no detail", () => {
		const { container } = render(<WorkspaceRail workspace={{}} />);

		expect(container.querySelectorAll("dd")).toHaveLength(0);
	});

	it("derives the branch a push would land on from the hostname", () => {
		// Taken from the same helper the push uses. A second copy of the prefix would keep passing
		// here and quietly stop matching the branch anybody could actually find on GitHub.
		render(<WorkspaceRail workspace={{ hostname: "agent-c824" }} />);

		expect(screen.getByText("pve-agents/agent-c824")).toBeDefined();
	});

	it("builds the ssh command nobody should have to assemble by hand", () => {
		render(<WorkspaceRail workspace={{ ip: "10.0.3.119" }} />);

		expect(screen.getByText("ssh agent@10.0.3.119")).toBeDefined();
	});

	it("says how long provisioning took, and stays quiet when it cannot", () => {
		render(
			<WorkspaceRail
				workspace={{
					createdAt: "2026-09-20T11:10:09.000Z",
					readyAt: "2026-09-20T11:11:36.000Z",
				}}
			/>,
		);

		// On the Progress header rather than in a row of its own, which is where the design puts
		// it and where it reads as a summary of the strip under it.
		expect(screen.getByText(/ready in 1m 27s/)).toBeDefined();

		// Every workspace created before ready_at was written has no ready_at, and "0s" would
		// claim those were built instantly rather than admitting it does not know.
		cleanup();
		render(
			<WorkspaceRail workspace={{ createdAt: "2026-09-20T11:10:09.000Z" }} />,
		);

		expect(screen.queryByText(/ready in/)).toBeNull();
		expect(screen.queryByText("0s")).toBeNull();
	});

	it("drops a group heading when every fact under it is absent", () => {
		// Identity has no rows on a workspace that never got a container, and a heading with
		// nothing under it reads as a panel that failed to load.
		const { container } = render(
			<WorkspaceRail workspace={{ repository: "github.com/a/b" }} />,
		);

		const headings = [...container.querySelectorAll(".rail-group")].filter(
			(group) => group.querySelector(".rail-fact") !== null,
		);

		expect(headings).toHaveLength(1);
		expect(headings[0]?.textContent).toContain("Source");
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

		expect(screen.getByText("ssh agent@10.0.3.110")).toBeDefined();
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
		expect(screen.queryByText("ssh agent@10.0.3.110")).toBeNull();
	});

	it("puts the actions under the diff and nowhere else", () => {
		// They act on what the diff lists, so under the timeline or the shell they would be a
		// control with no visible subject — and they would eat height the terminal wants.
		render(
			<WorkspaceRail
				actions={<p>the actions</p>}
				changes={<p>the list</p>}
				tab={{ kind: "diff" }}
				workspace={{}}
			/>,
		);

		expect(screen.getByText("the actions")).toBeDefined();

		cleanup();
		render(
			<WorkspaceRail
				actions={<p>the actions</p>}
				changes={<p>the list</p>}
				tab={{ kind: "timeline" }}
				timeline={<p>the history</p>}
				workspace={{}}
			/>,
		);

		expect(screen.queryByText("the actions")).toBeNull();
	});

	it("offers a timeline tab even for a workspace with no diff", () => {
		// A workspace that failed before it ever had a checkout still has a history, and that is
		// exactly when somebody goes looking for one. Tabs appear for the timeline alone.
		render(
			<WorkspaceRail
				tab={{ kind: "timeline" }}
				timeline={<p>the history</p>}
				workspace={{}}
			/>,
		);

		expect(screen.getByRole("tab", { name: "Timeline" })).toBeDefined();
		expect(screen.getByText("the history")).toBeDefined();
	});

	it("offers no diff tab when there is nothing to inspect", () => {
		// A destroyed container cannot be read, so the tab would answer nothing.
		render(
			<WorkspaceRail
				tab={{ kind: "timeline" }}
				timeline={<p>the history</p>}
				workspace={{}}
			/>,
		);

		expect(screen.queryByRole("tab", { name: "Diff" })).toBeNull();
	});

	it("shows one tab's content at a time", () => {
		render(
			<WorkspaceRail
				changes={<p>the list</p>}
				tab={{ kind: "timeline" }}
				timeline={<p>the history</p>}
				workspace={{}}
			/>,
		);

		expect(screen.getByText("the history")).toBeDefined();
		expect(screen.queryByText("the list")).toBeNull();
	});
});
