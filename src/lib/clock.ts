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

// formatDuration renders a span the way this application has always rendered one: "31s" under a
// minute, "9m 22s" above it.
//
// No hours tier on purpose. `took` in the rail has produced "74m 12s" for a long provision since it
// was written, and a refresh of how the page looks is not the place to quietly start saying
// "1h 14m" instead. Add the tier deliberately, or not at all.
//
// Nothing for a negative or non-finite span. Both mean the two timestamps cannot be trusted, and a
// caller that renders no value at all is right more often than one that renders "0s".
export function formatDuration(ms: number): string | undefined {
	if (!Number.isFinite(ms) || ms < 0) {
		return undefined;
	}

	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}

	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// formatUptime renders a span that may run for days, for the meta band's "up 2h 22m".
//
// Separate from formatDuration because that one deliberately has no hours tier -- it is `took`,
// which has said "74m 12s" since it was written and should not start saying something else as a
// side effect of a visual refresh. This is a new call site with no history to preserve, and a
// container that has been up since yesterday reading "2410m 8s" is a number nobody can parse.
export function formatUptime(ms: number): string | undefined {
	if (!Number.isFinite(ms) || ms < 0) {
		return undefined;
	}

	const seconds = Math.floor(ms / 1000);
	if (seconds < 3600) {
		return formatDuration(ms);
	}

	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours < 24) {
		return `${hours}h ${minutes}m`;
	}

	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// provisionTook is how long a workspace took to come up, or nothing if it never did.
//
// Undefined rather than "0s" when there is no ready_at: it was never written before it was plumbed
// in, and every workspace older than that would otherwise claim to have been built instantly.
//
// One copy. It was written twice with two different bodies -- the rail inlined the arithmetic and
// the workspace route called formatDuration -- which is two places for the same sentence to start
// disagreeing about what "took" means.
export function provisionTook(
	createdAt?: string,
	readyAt?: string,
): string | undefined {
	if (createdAt === undefined || readyAt === undefined) {
		return undefined;
	}

	return formatDuration(Date.parse(readyAt) - Date.parse(createdAt));
}

// formatAge renders the same span in one unit, for a column that has room for three characters.
//
// The sidebar wants "how long has this been up" at a glance, next to a repository name that is
// already being clipped. Rounding down rather than to nearest: a workspace in its fifty-ninth
// minute reading "1h" claims a milestone it has not reached.
export function formatAge(ms: number): string | undefined {
	if (!Number.isFinite(ms) || ms < 0) {
		return undefined;
	}

	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	if (seconds < 3600) {
		return `${Math.floor(seconds / 60)}m`;
	}
	if (seconds < 86400) {
		return `${Math.floor(seconds / 3600)}h`;
	}

	return `${Math.floor(seconds / 86400)}d`;
}

// elapsedSince is the span between a stored timestamp and now, or nothing if it will not parse.
export function elapsedSince(
	iso?: string,
	now = Date.now(),
): number | undefined {
	if (iso === undefined || iso === "") {
		return undefined;
	}

	const at = Date.parse(iso);

	return Number.isNaN(at) ? undefined : now - at;
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
