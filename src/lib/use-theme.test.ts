import { describe, expect, it } from "vitest";

import { THEME_BOOT } from "../routes/__root";
import { THEME_KEY } from "./use-theme";

describe("theme persistence", () => {
	it("the boot script reads the key the hook writes", () => {
		// Two copies of one string in two files, and nothing else ties them together. Change
		// either and nothing fails: the toggle still works for the session and silently stops
		// persisting across reloads, which you only notice by reloading.
		expect(THEME_BOOT).toContain(THEME_KEY);
	});

	it("the boot script only ever assigns a theme it recognises", () => {
		// It writes straight onto document.documentElement.dataset, so a poisoned localStorage
		// value must not reach the attribute the whole stylesheet hangs off.
		expect(THEME_BOOT).toContain("t!=='light'&&t!=='dark'");
	});

	it("falls back rather than throwing where storage is unavailable", () => {
		// Reading localStorage throws outright in some privacy modes, and a throw here would take
		// the document with it before anything had rendered.
		expect(THEME_BOOT).toContain("catch");
	});
});
