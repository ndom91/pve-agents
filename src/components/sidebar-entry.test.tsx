// @vitest-environment happy-dom

import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SidebarEntry } from "./sidebar-entry";
import { TooltipProvider } from "./tooltip";

// Explicit cleanup. Testing Library only registers its own afterEach when vitest globals are
// enabled, and they are not here.
afterEach(cleanup);

const WORKSPACE = {
	activity: "blocked",
	hostname: "agent-bd48",
	id: "bd48",
	repository: "https://github.com/ndom91/open-plan-annotator",
	status: "ready",
};

// SidebarEntry renders a Link, which needs a router in context. A memory router keeps that to one
// small helper rather than mocking the router itself, so the route path in the component is
// actually exercised.
function renderEntry(props: Parameters<typeof SidebarEntry>[0]) {
	// The entry's StatusDot carries a tooltip, and Radix throws without a provider above it. The
	// application has one at the document root; a component rendered on its own brings its own.
	const rootRoute = createRootRoute({
		component: () => (
			<TooltipProvider>
				<SidebarEntry {...props} />
			</TooltipProvider>
		),
	});
	const detailRoute = createRoute({
		component: () => null,
		getParentRoute: () => rootRoute,
		path: "/workspaces/$workspaceId",
	});

	return render(
		<RouterProvider
			router={createRouter({
				history: createMemoryHistory({ initialEntries: ["/"] }),
				routeTree: rootRoute.addChildren([detailRoute]),
			})}
		/>,
	);
}

describe("SidebarEntry", () => {
	it("links to the workspace it names", async () => {
		renderEntry({ workspace: WORKSPACE });

		const link = await screen.findByRole("link");
		expect(link.getAttribute("href")).toBe("/workspaces/bd48");
		expect(link.textContent).toContain("agent-bd48");
	});

	it("drops the host from the repository", async () => {
		// Every workspace here is on github.com, so repeating it in a narrow column spends space on
		// the one part that carries no information.
		renderEntry({ workspace: WORKSPACE });

		const link = await screen.findByRole("link");
		expect(link.textContent).toContain("ndom91/open-plan-annotator");
		expect(link.textContent).not.toContain("github.com");
	});

	it("shows the agent's state for a live workspace", async () => {
		// The dot is the colour; this is the word behind it. It is deliberately not laid out --
		// there is no room for it beside a title at this width -- but it has to be in the document,
		// because a status carried by colour alone is a status half the readers do not get.
		renderEntry({ workspace: WORKSPACE });

		expect(await screen.findByText("blocked")).toBeDefined();
	});

	it("omits the state dot in the destroyed group", async () => {
		// Every entry there is destroyed, so the dot would be a column of identical grey rather
		// than information -- and its hidden word a column of identical noise.
		renderEntry({
			showState: false,
			workspace: { ...WORKSPACE, activity: "unknown", status: "destroyed" },
		});

		await screen.findByRole("link");
		expect(screen.queryByText("destroyed")).toBeNull();
	});

	it("does not print the hostname twice on an unnamed workspace", async () => {
		// The title falls back to the container's name until the agent has named its own work. The
		// meta line below carries that name too, so without this the row reads "agent-bd48" on
		// both of its lines and the second one says nothing.
		renderEntry({ workspace: WORKSPACE });

		const link = await screen.findByRole("link");
		expect(link.textContent?.match(/agent-bd48/g)).toHaveLength(1);
	});

	it("keeps the hostname beside the repository once the work has a title", async () => {
		renderEntry({
			workspace: { ...WORKSPACE, title: "List available MCP servers" },
		});

		const link = await screen.findByRole("link");
		expect(link.textContent).toContain("List available MCP servers");
		expect(link.textContent).toContain("agent-bd48");
	});
});
