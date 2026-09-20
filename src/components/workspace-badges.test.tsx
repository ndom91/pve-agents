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

	it("gives blocked its own tone, so it does not read as running normally", () => {
		// blocked is the one activity that needs a person. It is amber and alone in it, while a
		// ready workspace getting on with its work is green -- coloured for that reason rather than
		// for decoration.
		const { container } = render(
			<WorkspaceBadges activity="blocked" status="ready" />,
		);

		expect(container.querySelectorAll(".chip.is-green")).toHaveLength(1);
		expect(container.querySelectorAll(".chip.is-amber")).toHaveLength(1);
	});

	it("keeps a failed workspace red and a destroyed one quiet", () => {
		// Failure is the one lifecycle state worth interrupting for. A destroyed workspace is not a
		// problem, it is the resting state, so it takes the neutral fill rather than a warning one.
		const { container: failed } = render(
			<WorkspaceBadges activity="unknown" status="failed" />,
		);
		expect(failed.querySelector(".chip.is-red")).not.toBeNull();

		const { container: gone } = render(
			<WorkspaceBadges activity="unknown" status="destroyed" />,
		);
		expect(gone.querySelector(".chip.is-neutral")).not.toBeNull();
	});
});
