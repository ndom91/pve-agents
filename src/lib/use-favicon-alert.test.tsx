// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useFaviconAlert } from "./use-favicon-alert";

afterEach(cleanup);

// happy-dom has no canvas and loads no images, so the badge itself cannot be drawn here — the
// hook returns early and leaves the icon alone. What is worth testing is everything around that
// drawing, because it is the part that can stick: an icon left marked after the question was
// answered is a tab that lies until it is reloaded.
function Harness({ waiting }: { waiting: boolean }) {
	useFaviconAlert(waiting);
	return null;
}

function icon(): HTMLLinkElement {
	const link = document.createElement("link");
	link.rel = "icon";
	link.href = "/icon1.png";
	document.head.append(link);
	return link;
}

afterEach(() => {
	for (const link of document.querySelectorAll('link[rel~="icon"]')) {
		link.remove();
	}
});

describe("useFaviconAlert", () => {
	it("leaves the icon alone while nothing is waiting", () => {
		const link = icon();
		const before = link.href;

		render(<Harness waiting={false} />);

		expect(link.href).toBe(before);
	});

	it("puts the icon back when the waiting stops", () => {
		const link = icon();
		const before = link.href;

		const { rerender } = render(<Harness waiting={true} />);
		link.href = "data:image/png;base64,marked";
		rerender(<Harness waiting={false} />);

		expect(link.href).toBe(before);
	});

	it("puts the icon back when the page goes away mid-alert", () => {
		const link = icon();
		const before = link.href;

		const { unmount } = render(<Harness waiting={true} />);
		link.href = "data:image/png;base64,marked";
		unmount();

		expect(link.href).toBe(before);
	});

	it("does nothing at all when the document declares no icon", () => {
		expect(() => render(<Harness waiting={true} />)).not.toThrow();
	});
});
