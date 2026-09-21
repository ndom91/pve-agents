import { describe, expect, it } from "vitest";

import {
	elapsedBetween,
	elapsedSince,
	formatAge,
	formatDuration,
	formatSpan,
	formatStamp,
	formatStep,
	formatTime,
	UTC,
} from "./clock";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatStamp", () => {
	it("moves the instant into the zone it is asked for", () => {
		// The whole point. The database holds UTC; a person in Berlin should not have to add two
		// hours in their head to tell whether a workspace was built this morning.
		const iso = "2026-09-20T07:29:19.000Z";

		expect(formatStamp(iso, UTC)).toBe("2026-09-20 07:29:19");
		expect(formatStamp(iso, "Europe/Berlin")).toBe("2026-09-20 09:29:19");
		expect(formatStamp(iso, "America/Los_Angeles")).toBe("2026-09-20 00:29:19");
	});

	it("carries a zone change across the date, not just the clock", () => {
		// Late UTC is the next day in Tokyo. Showing the time alone would have been wrong here in
		// a way nobody would notice until they compared two rows.
		expect(formatStamp("2026-09-20T23:30:00.000Z", "Asia/Tokyo")).toBe(
			"2026-09-21 08:30:00",
		);
	});

	it("answers nothing for a value it cannot read", () => {
		// Rather than "Invalid Date". A Fact treats absence as "not there yet" and renders no row,
		// which is the honest outcome for a timestamp this cannot parse.
		for (const value of [undefined, "", "not a date"]) {
			expect(formatStamp(value, UTC)).toBeUndefined();
		}
	});
});

describe("formatTime", () => {
	it("uses a 24-hour clock, including at midnight", () => {
		// `hour12: false` reports midnight as 24 in some engines, which is why this is pinned.
		expect(formatTime("2026-09-20T00:00:00.000Z", UTC)).toBe("00:00:00");
		expect(formatTime("2026-09-20T13:41:02.000Z", UTC)).toBe("13:41:02");
	});
});

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

describe("formatSpan", () => {
	it("matches formatDuration below an hour", () => {
		expect(formatSpan(9 * MINUTE + 22 * SECOND)).toBe("9m 22s");
	});

	it("rolls into hours, and then days", () => {
		// A container up since yesterday reading "2410m 8s" is a number nobody can parse.
		expect(formatSpan(2 * HOUR + 22 * MINUTE)).toBe("2h 22m");
		expect(formatSpan(3 * DAY + 4 * HOUR)).toBe("3d 4h");
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

describe("formatStep", () => {
	it("keeps one decimal below ten seconds", () => {
		// The range almost every tool call lands in. Whole seconds turn "0.3s, 0.9s, 1.1s" into
		// "0s, 1s, 1s", which is a column that has stopped saying anything.
		expect(formatStep(300)).toBe("0.3s");
		expect(formatStep(900)).toBe("0.9s");
		expect(formatStep(1100)).toBe("1.1s");
		expect(formatStep(9900)).toBe("9.9s");
	});

	it("hands over to formatDuration once the decimal is noise", () => {
		expect(formatStep(31 * SECOND)).toBe("31s");
		expect(formatStep(9 * MINUTE + 22 * SECOND)).toBe("9m 22s");
	});

	it("refuses a span it cannot trust", () => {
		expect(formatStep(-1)).toBeUndefined();
		expect(formatStep(Number.NaN)).toBeUndefined();
	});
});

describe("elapsedBetween", () => {
	it("measures two recorded instants", () => {
		expect(
			elapsedBetween("2026-09-21T10:00:00.000Z", "2026-09-21T10:00:02.500Z"),
		).toBe(2500);
	});

	it("has nothing to measure from a missing or unreadable end", () => {
		// A tool call still running has no end, and a runner from before controller_at stamps
		// neither. Both render an empty column rather than a duration of zero.
		expect(
			elapsedBetween("2026-09-21T10:00:00.000Z", undefined),
		).toBeUndefined();
		expect(
			elapsedBetween(undefined, "2026-09-21T10:00:00.000Z"),
		).toBeUndefined();
		expect(elapsedBetween("nope", "2026-09-21T10:00:00.000Z")).toBeUndefined();
	});

	it("says nothing rather than something negative", () => {
		expect(
			elapsedBetween("2026-09-21T10:00:02.000Z", "2026-09-21T10:00:00.000Z"),
		).toBeUndefined();
	});
});
