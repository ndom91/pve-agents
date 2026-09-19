import { describe, expect, it } from "vitest";

import { terminalSize } from "./terminal-socket";

// The size arrives in a query string and is interpolated into a shell command on the workspace, so
// it is bounded rather than trusted. These are the values that would otherwise get there.
describe("terminalSize", () => {
	it("takes a sensible size from the browser", () => {
		expect(terminalSize("120", 80)).toBe(120);
		expect(terminalSize("40", 24)).toBe(40);
	});

	it("falls back rather than trusting anything unparseable", () => {
		for (const raw of [null, "", "eighty", "NaN", "1e3"]) {
			expect(terminalSize(raw, 80)).toBe(80);
		}
	});

	it("refuses a size that is not a positive whole number", () => {
		for (const raw of ["0", "-1", "-999", "12.5"]) {
			expect(terminalSize(raw, 24)).toBe(24);
		}
	});

	it("caps an absurd size rather than passing it along", () => {
		// A million columns is not a terminal, it is an attempt to see what happens.
		expect(terminalSize("1000000", 80)).toBe(80);
		expect(terminalSize("1001", 80)).toBe(80);
		expect(terminalSize("1000", 80)).toBe(1000);
	});

	it("yields a number that cannot carry anything else into the command", () => {
		// The real protection. Whatever arrives, what reaches the shell is an integer.
		for (const raw of [
			"80; rm -rf /",
			"80 && curl evil",
			"$(whoami)",
			"`id`",
		]) {
			expect(Number.isInteger(terminalSize(raw, 80))).toBe(true);
		}
	});
});
