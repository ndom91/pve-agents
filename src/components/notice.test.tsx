// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Notice, type NoticeProps, NoticeStack } from "./notice";

// Testing Library only registers its own afterEach with vitest globals enabled, which they are not.
afterEach(cleanup);

const BLOCKED: NoticeProps = {
	lead: "Waiting for you",
	rest: "the agent has asked a question.",
	severity: "amber",
};
const LOST: NoticeProps = {
	lead: "Ended holding unsaved work",
	severity: "red",
};
const PUSHED: NoticeProps = { lead: "Work pushed", severity: "green" };

describe("Notice", () => {
	it("keeps the severity out of the text", () => {
		// The icon and the fill carry it. A third copy in the ink is what makes one red notice read
		// as three different reds, and it is the rule most easily lost to a well-meaning tweak.
		const { container } = render(
			<Notice {...LOST} rest="the container is gone." />,
		);

		expect(container.querySelector(".notice")?.className).toContain("is-red");
		expect(container.querySelector(".notice-lead")?.className).not.toContain(
			"red",
		);
		expect(container.querySelector(".notice-rest")?.className).not.toContain(
			"red",
		);
	});

	it("is a strip unless told otherwise", () => {
		// The default placement, because most of what this says is workspace state that persists.
		const { container } = render(<Notice {...BLOCKED} />);

		expect(container.querySelector(".notice")?.className).toContain("is-strip");
	});

	it("announces itself, so a notice arriving is not silent", () => {
		render(<Notice {...BLOCKED} />);

		expect(screen.getByRole("status")).toBeDefined();
	});

	it("runs the action it offers", async () => {
		const onClick = vi.fn();
		render(<Notice {...BLOCKED} action={{ label: "Open diff", onClick }} />);

		await userEvent.click(screen.getByRole("button", { name: "Open diff" }));

		expect(onClick).toHaveBeenCalled();
	});
});

describe("NoticeStack", () => {
	it("renders nothing when nothing is true", () => {
		const { container } = render(<NoticeStack notices={[]} />);

		expect(container.textContent).toBe("");
	});

	it("shows the loudest and hides the rest behind a count", async () => {
		// Two strips is the ceiling: past that the header stops being chrome and starts being the
		// page. The counter is what enforces it, so a third notice costs a click rather than height.
		render(<NoticeStack notices={[PUSHED, BLOCKED, LOST]} />);

		expect(screen.getByText("Ended holding unsaved work")).toBeDefined();
		expect(screen.queryByText("Waiting for you")).toBeNull();
		expect(screen.queryByText("Work pushed")).toBeNull();

		await userEvent.click(
			screen.getByRole("button", { name: /2 more notices/ }),
		);

		expect(screen.getByText("Waiting for you")).toBeDefined();
		expect(screen.getByText("Work pushed")).toBeDefined();
	});

	it("ranks red over amber over green over neutral", () => {
		// Order in, order out: the caller lists whatever is true and does not have to think about
		// which of them wins.
		render(
			<NoticeStack
				notices={[
					{ lead: "n", severity: "neutral" },
					{ lead: "g", severity: "green" },
					{ lead: "a", severity: "amber" },
				]}
			/>,
		);

		expect(screen.getByText("a")).toBeDefined();
		expect(screen.queryByText("g")).toBeNull();
	});

	it("offers no counter for a single notice", () => {
		render(<NoticeStack notices={[BLOCKED]} />);

		expect(screen.queryByRole("button", { name: /more notice/ })).toBeNull();
	});
});
