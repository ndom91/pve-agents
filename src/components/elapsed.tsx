import type { ReactNode } from "react";

import { elapsedSince, formatAge, formatDuration } from "../lib/clock";
import { useMounted } from "../lib/use-mounted";

// Elapsed is how long it has been since something, counted from now.
//
// Nothing until the component reaches the browser. "Now" on the server is the moment the HTML was
// built and "now" in the browser is the moment it was hydrated, and those are never the same
// number -- rendering either one would be a hydration mismatch over a value that is wrong by the
// time it is read anyway. One frame of absence costs less than a wrong duration.
//
// No timer either. Every caller sits inside a view the fleet or workspace query already polls, so
// the re-render that refreshes the data refreshes this with it. A second clock ticking beside that
// one would repaint the sidebar between polls to show the same thing.
export function Elapsed({
	of = "age",
	since,
}: {
	// "age" is one unit for a narrow column -- 9m. "duration" is the fuller form -- 9m 22s.
	of?: "age" | "duration";
	since?: string;
}): ReactNode {
	const mounted = useMounted();
	const ms = elapsedSince(since);
	if (!mounted || ms === undefined) {
		return null;
	}

	const shown = of === "age" ? formatAge(ms) : formatDuration(ms);

	return shown === undefined ? null : <span className="elapsed">{shown}</span>;
}
