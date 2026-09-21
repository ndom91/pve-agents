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
		render(<WorkspaceBadges activity="blocked" status="ready" />);

		// Bound to the words, not just counted. Counting tones passes just as well if the two
		// mappings are swapped and a blocked agent goes green.
		expect(screen.getByText("ready").closest(".chip")?.className).toContain(
			"is-green",
		);
		expect(screen.getByText("blocked").closest(".chip")?.className).toContain(
			"is-amber",
		);
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

	it("draws one group with a divider when the bar asks for it", () => {
		// Two separate outlines beside the destroy button was three objects in a row meant to read
		// as two. The group is a borrowed shape, not a borrowed behaviour: nothing in it can be
		// set, so it stays spans inside a labelled group rather than becoming buttons.
		const { container } = render(
			<WorkspaceBadges activity="idle" status="ready" variant="group" />,
		);

		expect(container.querySelectorAll(".state-group")).toHaveLength(1);
		expect(container.querySelectorAll(".state-seg")).toHaveLength(2);
		expect(container.querySelector(".state-div")).not.toBeNull();
		expect(container.querySelector("button")).toBeNull();
	});

	it("fills only the lifecycle half of the group", () => {
		// Two filled halves would leave the pair with nothing to read first.
		const { container } = render(
			<WorkspaceBadges activity="idle" status="ready" variant="group" />,
		);

		expect(container.querySelectorAll(".state-seg.is-lead")).toHaveLength(1);
	});

	it("has no second half to divide before a workspace is ready", () => {
		const { container } = render(
			<WorkspaceBadges activity="unknown" status="booting" variant="group" />,
		);

		expect(container.querySelectorAll(".state-seg")).toHaveLength(1);
		expect(container.querySelector(".state-div")).toBeNull();
	});
});
