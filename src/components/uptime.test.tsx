// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Uptime } from "./uptime";

afterEach(cleanup);

// An hour before "now", whenever the test runs.
const READY = new Date(Date.now() - 3_600_000).toISOString();
const CREATED = new Date(Date.now() - 7_200_000).toISOString();

describe("Uptime", () => {
	it("stops counting once the container is gone", () => {
		// The rule this component exists for. It lived in the meta band and not in the rail's own
		// copy, so the same workspace stopped counting in one place and kept going in the other.
		for (const status of ["destroyed", "destroying"]) {
			const { container } = render(
				<Uptime workspace={{ createdAt: CREATED, readyAt: READY, status }} />,
			);
			expect(container.textContent).toBe("");
			cleanup();
		}
	});

	it("counts from ready, because up means reachable", () => {
		render(
			<Uptime
				workspace={{ createdAt: CREATED, readyAt: READY, status: "ready" }}
			/>,
		);

		// One hour since ready, two since created. Reading the larger number would mean counting
		// the provision as uptime.
		expect(screen.getByText(/^up/)).toBeDefined();
		expect(screen.queryByText(/2h/)).toBeNull();
	});

	it("says what it is waiting on before there is an uptime to report", () => {
		render(<Uptime workspace={{ createdAt: CREATED, status: "booting" }} />);

		expect(screen.getByText(/^waiting/)).toBeDefined();
	});
});
