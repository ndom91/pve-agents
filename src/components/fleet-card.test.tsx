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

import { FleetCard } from "./fleet-card";

afterEach(cleanup);

function workspace(
	over: Partial<Parameters<typeof FleetCard>[0]["workspace"]>,
) {
	return {
		activity: "idle",
		hostname: "agent-8d1f",
		id: "8d1f",
		repository: "github.com/ndom91/open-plan-annotator",
		status: "ready",
		...over,
	};
}

// A real router, because the card is a Link and renders nothing useful without one.
async function show(over: Parameters<typeof workspace>[0] = {}) {
	const root = createRootRoute();
	const index = createRoute({
		component: () => <FleetCard workspace={workspace(over)} />,
		getParentRoute: () => root,
		path: "/",
	});
	const detail = createRoute({
		component: () => null,
		getParentRoute: () => root,
		path: "/workspaces/$workspaceId",
	});
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: root.addChildren([index, detail]),
	});

	render(<RouterProvider router={router as never} />);
	await screen.findByRole("link");
}

describe("FleetCard", () => {
	it("leads with the purpose rather than the hostname", async () => {
		// agent-8d1f distinguishes two workspaces and says nothing about either. Somebody scanning
		// the fleet wants to know which of these is the one they asked to fix the login bug.
		await show({ purpose: "Fix the login redirect loop" });

		const card = screen.getByRole("link");
		const purpose =
			card.textContent?.indexOf("Fix the login redirect loop") ?? -1;
		const host = card.textContent?.indexOf("agent-8d1f") ?? -1;

		expect(purpose).toBeGreaterThanOrEqual(0);
		expect(purpose).toBeLessThan(host);
	});

	it("says so when a workspace was given no purpose", async () => {
		await show({ purpose: "   " });

		expect(screen.getByText("No purpose supplied")).toBeDefined();
	});

	it("flags unsaved work only when it is known to exist", async () => {
		// The flag is true, false, or absent, and absent means nobody has looked yet. Claiming
		// either answer from that would be inventing a fact on a tile.
		await show({ unsavedWork: true });
		expect(screen.getByText("unsaved")).toBeDefined();

		cleanup();
		await show({ unsavedWork: undefined });
		expect(screen.queryByText("unsaved")).toBeNull();

		cleanup();
		await show({ unsavedWork: false });
		expect(screen.queryByText("unsaved")).toBeNull();
	});

	it("shows no activity for a workspace that has no agent yet", async () => {
		// Deferred to WorkspaceBadges, which already refuses to report activity before ready. The
		// assertion is here because the card is where somebody would notice "unknown" and read it
		// as a fault.
		await show({ activity: "unknown", status: "booting" });

		expect(screen.getByText("booting")).toBeDefined();
		expect(screen.queryByText("unknown")).toBeNull();
	});
});
