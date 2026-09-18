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
	const rootRoute = createRootRoute({
		component: () => <SidebarEntry {...props} />,
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
		renderEntry({ workspace: WORKSPACE });

		expect(await screen.findByText("blocked")).toBeDefined();
	});

	it("omits badges in the destroyed group", async () => {
		// Every entry there says "destroyed", so the badge would be a column of identical words
		// rather than information.
		renderEntry({
			showBadges: false,
			workspace: { ...WORKSPACE, activity: "unknown", status: "destroyed" },
		});

		await screen.findByRole("link");
		expect(screen.queryByText("destroyed")).toBeNull();
	});
});
