// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentChat } from "./agent-chat";

// Explicit cleanup, for the same reason the rail's tests carry it: Testing Library only registers
// its own afterEach when vitest globals are enabled, and they are not here.
afterEach(cleanup);

function assistant(text: string) {
	return {
		message: { content: [{ text, type: "text" }], role: "assistant" },
		type: "assistant",
	};
}

// happy-dom lays nothing out, so every box is zero and nothing clamps. These give the list a
// viewport and a content height, which is all the follow rule reads, and make scrollTop behave
// the way a browser's does: assigning past the end lands at the end.
//
// The clamp matters rather than being tidiness. The component follows by assigning scrollHeight,
// which in a browser means "as far down as this goes"; without clamping the test would assert on
// a scroll position no real browser can hold.
function measure(
	list: HTMLElement,
	{ height, scrollHeight }: { height: number; scrollHeight: number },
): void {
	const at = Math.min(list.scrollTop, Math.max(0, scrollHeight - height));

	Object.defineProperty(list, "clientHeight", {
		configurable: true,
		value: height,
	});
	Object.defineProperty(list, "scrollHeight", {
		configurable: true,
		value: scrollHeight,
	});

	let position = at;
	Object.defineProperty(list, "scrollTop", {
		configurable: true,
		get: () => position,
		set: (next: number) => {
			position = Math.min(
				Math.max(0, next),
				Math.max(0, scrollHeight - height),
			);
		},
	});
}

// bottom is the furthest down a list of this shape can be scrolled.
function bottom({
	height,
	scrollHeight,
}: {
	height: number;
	scrollHeight: number;
}): number {
	return scrollHeight - height;
}

function chat(messages: unknown[]) {
	return (
		<AgentChat
			approvals={[]}
			busy={false}
			link="attached"
			messages={messages}
			onDecide={() => {}}
		/>
	);
}

describe("AgentChat transcript scrolling", () => {
	it("follows the end while the reader is already at it", () => {
		const { container, rerender } = render(chat([assistant("one")]));
		const list = container.querySelector("ol");
		if (list === null) {
			throw new Error("no transcript");
		}

		// At the bottom of a 300px transcript in a 200px window.
		const before = { height: 200, scrollHeight: 300 };
		measure(list, before);
		list.scrollTop = bottom(before);

		const after = { height: 200, scrollHeight: 460 };
		measure(list, after);
		rerender(chat([assistant("one"), assistant("two")]));

		expect(list.scrollTop).toBe(bottom(after));
	});

	it("leaves a reader who has scrolled up where they are", () => {
		const { container, rerender } = render(chat([assistant("one")]));
		const list = container.querySelector("ol");
		if (list === null) {
			throw new Error("no transcript");
		}

		// Settle the stored height at 300 with the reader at the end of it.
		const settled = { height: 200, scrollHeight: 300 };
		measure(list, settled);
		list.scrollTop = bottom(settled);
		rerender(chat([assistant("one"), assistant("two")]));

		// Now scrolled well up, reading something older.
		list.scrollTop = 10;
		measure(list, { height: 200, scrollHeight: 500 });
		rerender(chat([assistant("one"), assistant("two"), assistant("three")]));

		expect(list.scrollTop).toBe(10);
	});

	it("does not need a scroll event to notice the reader has left the end", () => {
		// The bug this replaced. Following used to be decided by a ref that a scroll handler
		// wrote, and scroll events are delivered asynchronously: during a stream the next token
		// arrived before the handler ran, the effect read a stale "at the bottom", and the reader
		// was dragged back down by the thing they had just scrolled away from.
		//
		// No scroll event is dispatched anywhere in this test, which is the whole point.
		const { container, rerender } = render(chat([assistant("one")]));
		const list = container.querySelector("ol");
		if (list === null) {
			throw new Error("no transcript");
		}

		const settled = { height: 200, scrollHeight: 300 };
		measure(list, settled);
		list.scrollTop = bottom(settled);
		rerender(chat([assistant("one"), assistant("two")]));

		list.scrollTop = 0;
		measure(list, { height: 200, scrollHeight: 340 });
		rerender(chat([assistant("one"), assistant("two"), assistant("three")]));

		expect(list.scrollTop).toBe(0);
	});

	it("resumes following once the reader returns to the end", () => {
		const { container, rerender } = render(chat([assistant("one")]));
		const list = container.querySelector("ol");
		if (list === null) {
			throw new Error("no transcript");
		}

		const settled = { height: 200, scrollHeight: 300 };
		measure(list, settled);
		list.scrollTop = bottom(settled);
		rerender(chat([assistant("one"), assistant("two")]));

		// Away from the end, and left there by the next append.
		list.scrollTop = 0;
		measure(list, settled);
		rerender(chat([assistant("one"), assistant("two"), assistant("three")]));
		expect(list.scrollTop).toBe(0);

		// Back to the end by hand, and following again. A fourth entry rather than a changed
		// third: an append is what the transcript does, and it is the append this reacts to.
		list.scrollTop = bottom(settled);
		const grown = { height: 200, scrollHeight: 380 };
		measure(list, grown);
		rerender(
			chat([
				assistant("one"),
				assistant("two"),
				assistant("three"),
				assistant("four"),
			]),
		);

		expect(list.scrollTop).toBe(bottom(grown));
	});
});
