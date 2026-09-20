// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useOpenRows } from "./use-open-rows";

describe("useOpenRows", () => {
	it("keeps several rows open at once", () => {
		// The property both callers exist for. Comparing two changed files, or two seeded files, is
		// the commonest reason to be looking at either list, and a single-open accordion would
		// close the one you were reading.
		const { result } = renderHook(() => useOpenRows());

		act(() => {
			result.current.toggle("a");
		});
		act(() => {
			result.current.toggle("b");
		});

		expect(result.current.isOpen("a")).toBe(true);
		expect(result.current.isOpen("b")).toBe(true);
	});

	it("closes one row without disturbing the others", () => {
		const { result } = renderHook(() => useOpenRows());

		act(() => {
			result.current.toggle("a");
		});
		act(() => {
			result.current.toggle("b");
		});
		act(() => {
			result.current.toggle("a");
		});

		expect(result.current.isOpen("a")).toBe(false);
		expect(result.current.isOpen("b")).toBe(true);
	});

	it("reports a row nobody has touched as closed", () => {
		const { result } = renderHook(() => useOpenRows());

		expect(result.current.isOpen("never-opened")).toBe(false);
	});
});
