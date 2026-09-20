import { TZDate } from "@date-fns/tz";
import { format, isValid } from "date-fns";

// Timestamps as a person reads them.
//
// Everything is stored and carried in UTC and that does not change: the database, the timeline and
// every API answer are UTC, because a stored local time is a value nobody can compare across two
// machines. This is the last step before the screen, and only that.
//
// date-fns rather than hand-cut strings. These used to be `iso.slice(11, 19)`, which is not a
// format but an assumption that the value is ISO, in UTC, and that the reader wants it that way --
// the first two happen to hold and the third never did.
//
// `@date-fns/tz` is here for the zone argument, which exists for two reasons and neither is a
// feature. A server render cannot know the browser's zone, so it renders UTC and the browser swaps
// after hydration; and a test can pin a zone, which is the only way to check any of this.

// UTC is what a server render shows, and what a test uses when the zone is beside the point.
export const UTC = "UTC";

// STAMP is a date and a time to the second. Milliseconds are noise in a column somebody reads
// rather than sorts, and the ISO "T" is a separator for machines.
const STAMP = "yyyy-MM-dd HH:mm:ss";

// TIME is the time alone, for a list where every row is the same day.
const TIME = "HH:mm:ss";

// formatStamp renders one instant as a date and a time, in the zone asked for.
export function formatStamp(iso?: string, zone?: string): string | undefined {
	return render(iso, STAMP, zone);
}

// formatTime renders one instant as a time, in the zone asked for.
export function formatTime(iso?: string, zone?: string): string | undefined {
	return render(iso, TIME, zone);
}

// render is the shared half: parse, move to the zone, format.
//
// Nothing for a value that will not parse, rather than "Invalid Date". A `Fact` treats absence as
// "not there yet" and renders no row at all, which is the honest answer for a timestamp this
// cannot read.
function render(
	iso: string | undefined,
	pattern: string,
	zone?: string,
): string | undefined {
	if (iso === undefined || iso === "") {
		return undefined;
	}

	// `TZDate` only when a zone is named. A plain Date formats in whatever zone the runtime is in,
	// which in the browser is the reader's own and is the entire point.
	const at = zone === undefined ? new Date(iso) : new TZDate(iso, zone);

	return isValid(at) ? format(at, pattern) : undefined;
}
