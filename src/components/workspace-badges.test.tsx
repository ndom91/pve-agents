// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceBadges } from "./workspace-badges";

// Explicit cleanup. Testing Library only registers its own afterEach when vitest globals are
// enabled, and they are not here. Without this, renders accumulate in the document and a query
// finds the previous test's output, which passes for the wrong reason until a test happens to
// assert something is absent.
afterEach(cleanup);

describe("WorkspaceBadges", () => {
	it("shows what an agent is doing once there is an agent", () => {
		render(<WorkspaceBadges activity="blocked" status="ready" />);

		expect(screen.getByText("ready")).toBeDefined();
		expect(screen.getByText("blocked")).toBeDefined();
	});

	it("says nothing about activity before a workspace is ready", () => {
		// A workspace still being built has no agent, so "unknown" there reads as a problem rather
		// than as nothing having happened yet.
		render(<WorkspaceBadges activity="unknown" status="bootstrapping" />);

		expect(screen.getByText("bootstrapping")).toBeDefined();
		expect(screen.queryByText("unknown")).toBeNull();
	});

	it("carries the state in a class, so styling can distinguish blocked", () => {
		// blocked is the one activity that needs a person, and it is coloured differently for that
		// reason rather than for decoration.
		const { container } = render(
			<WorkspaceBadges activity="blocked" status="ready" />,
		);

		expect(container.querySelector(".activity-blocked")).not.toBeNull();
		expect(container.querySelector(".status-ready")).not.toBeNull();
	});
});
