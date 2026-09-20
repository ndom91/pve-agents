import { describe, expect, it } from "vitest";

import { elapsedSince, formatAge, formatDuration, formatUptime } from "./clock";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatDuration", () => {
	it("gives seconds under a minute and minutes-and-seconds above", () => {
		expect(formatDuration(31 * SECOND)).toBe("31s");
		expect(formatDuration(9 * MINUTE + 22 * SECOND)).toBe("9m 22s");
	});

	it("keeps counting in minutes past an hour", () => {
		// Deliberate. This is `took` from the rail, which has rendered long provisions this way
		// since it was written; a visual refresh is not where that quietly changes.
		expect(formatDuration(74 * MINUTE + 12 * SECOND)).toBe("74m 12s");
	});

	it("refuses a span it cannot trust", () => {
		// Both mean the two timestamps disagree about which came first. No value is right more
		// often than "0s" is.
		expect(formatDuration(-1)).toBeUndefined();
		expect(formatDuration(Number.NaN)).toBeUndefined();
	});
});

describe("formatUptime", () => {
	it("matches formatDuration below an hour", () => {
		expect(formatUptime(9 * MINUTE + 22 * SECOND)).toBe("9m 22s");
	});

	it("rolls into hours, and then days", () => {
		// A container up since yesterday reading "2410m 8s" is a number nobody can parse.
		expect(formatUptime(2 * HOUR + 22 * MINUTE)).toBe("2h 22m");
		expect(formatUptime(3 * DAY + 4 * HOUR)).toBe("3d 4h");
	});
});

describe("formatAge", () => {
	it("gives one unit, rounded down", () => {
		// A workspace in its fifty-ninth minute reading "1h" claims a milestone it has not reached.
		expect(formatAge(45 * SECOND)).toBe("45s");
		expect(formatAge(59 * MINUTE + 59 * SECOND)).toBe("59m");
		expect(formatAge(2 * HOUR)).toBe("2h");
		expect(formatAge(3 * DAY + 23 * HOUR)).toBe("3d");
	});
});

describe("elapsedSince", () => {
	it("measures from the stamp to the now it is given", () => {
		const now = Date.parse("2026-09-21T00:10:00Z");

		expect(elapsedSince("2026-09-21T00:00:00Z", now)).toBe(10 * MINUTE);
	});

	it("has nothing to measure from an absent or unreadable stamp", () => {
		expect(elapsedSince(undefined)).toBeUndefined();
		expect(elapsedSince("")).toBeUndefined();
		expect(elapsedSince("not a date")).toBeUndefined();
	});
});
