import type { ReactNode } from "react";

import { formatStamp, formatTime, UTC } from "../lib/clock";
import { useMounted } from "../lib/use-mounted";

// Timestamp shows one instant in the reader's own zone.
//
// The server cannot know that zone, so it renders UTC and the browser replaces it on mount. Both
// halves agree on the first paint, which is what hydration requires; the swap happens in the same
// tick as the effect and is not a frame anyone sees.
//
// `dateTime` carries the untouched ISO value either way, so the machine-readable answer is never
// the zone-shifted one.
export function Timestamp({
	iso,
	of = "stamp",
}: {
	iso?: string;
	// "time" for a list where every row is the same day; "stamp" where the date matters.
	of?: "stamp" | "time";
}): ReactNode {
	const mounted = useMounted();
	const zone = mounted ? undefined : UTC;
	const shown = of === "time" ? formatTime(iso, zone) : formatStamp(iso, zone);

	if (iso === undefined || shown === undefined) {
		return null;
	}

	return <time dateTime={iso}>{shown}</time>;
}
