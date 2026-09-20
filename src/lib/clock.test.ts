import { describe, expect, it } from "vitest";

import { formatStamp, formatTime, UTC } from "./clock";

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
