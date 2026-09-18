// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBlockedAlerts } from "./use-blocked-alerts";

type Sent = { body?: string; tag?: string; title: string };

const sent: Sent[] = [];

function workspace(id: string, activity: string, status = "ready") {
	return { activity, hostname: `agent-${id}`, id, status };
}

// A stand-in for the browser's Notification, recording what would have been shown.
function installNotification(permission: NotificationPermission): void {
	class FakeNotification {
		static permission: NotificationPermission = permission;
		static requestPermission = vi.fn(async () => "granted" as const);

		constructor(title: string, options?: { body?: string; tag?: string }) {
			sent.push({ body: options?.body, tag: options?.tag, title });
		}
	}

	Object.defineProperty(window, "Notification", {
		configurable: true,
		value: FakeNotification,
		writable: true,
	});
}

beforeEach(() => {
	sent.length = 0;
	installNotification("granted");
});

afterEach(() => {
	// Testing Library only registers its own afterEach when vitest globals are enabled, which they
	// are not here, so unmounting is explicit.
	cleanup();
	document.title = "";
});

describe("useBlockedAlerts", () => {
	it("counts waiting agents in the tab title", () => {
		// The one signal that needs no permission and is visible from another tab, which is where
		// someone will be when an agent asks a question.
		renderHook(() =>
			useBlockedAlerts([workspace("a", "blocked"), workspace("b", "blocked")]),
		);

		expect(document.title).toContain("(2)");
	});

	it("leaves the title clean when nothing is waiting", () => {
		renderHook(() => useBlockedAlerts([workspace("a", "idle")]));

		expect(document.title).not.toContain("(");
	});

	it("announces a waiting agent once, not once per poll", () => {
		// The fleet list refetches every couple of seconds. A dialog left open for an hour must not
		// notify for an hour.
		const { rerender } = renderHook(({ list }) => useBlockedAlerts(list), {
			initialProps: { list: [workspace("a", "blocked")] },
		});

		rerender({ list: [workspace("a", "blocked")] });
		rerender({ list: [workspace("a", "blocked")] });

		expect(sent).toHaveLength(1);
		expect(sent[0]?.title).toContain("agent-a");
	});

	it("announces again after the agent is answered and asks something new", () => {
		// Forgetting on the way out is what makes the second question as visible as the first.
		const { rerender } = renderHook(({ list }) => useBlockedAlerts(list), {
			initialProps: { list: [workspace("a", "blocked")] },
		});

		rerender({ list: [workspace("a", "active")] });
		rerender({ list: [workspace("a", "blocked")] });

		expect(sent).toHaveLength(2);
	});

	it("tags by workspace so repeats replace rather than stack", () => {
		renderHook(() => useBlockedAlerts([workspace("a", "blocked")]));

		expect(sent[0]?.tag).toBe("workspace-a");
	});

	it("says nothing without permission", () => {
		installNotification("denied");

		renderHook(() => useBlockedAlerts([workspace("a", "blocked")]));

		expect(sent).toHaveLength(0);
		// The title still carries it, because that costs nothing and needs no consent.
		expect(document.title).toContain("(1)");
	});

	it("ignores a blocked agent on a workspace that is not ready", () => {
		// Activity is stale or meaningless before a workspace finishes provisioning, and a
		// notification about one would be noise nobody can act on.
		renderHook(() =>
			useBlockedAlerts([workspace("a", "blocked", "bootstrapping")]),
		);

		expect(sent).toHaveLength(0);
		expect(document.title).not.toContain("(");
	});

	it("offers to ask only when asking would do something", () => {
		installNotification("default");
		const { result } = renderHook(() => useBlockedAlerts([]));

		expect(result.current.permission).toBe("prompt");

		act(() => result.current.requestPermission());

		expect(
			(window.Notification as unknown as { requestPermission: () => void })
				.requestPermission,
		).toHaveBeenCalled();
	});
});
