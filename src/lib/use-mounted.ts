import { useEffect, useState } from "react";

// useMounted reports whether the component has reached the browser.
//
// The tree and diff renderers both draw into shadow DOM, and both offer server preloading on the
// condition that the server and the client agree exactly on every option that affects first
// markup. A mismatch is not a partial merge: it produces a hydration failure or a silently wrong
// first state. Nothing here is visible on first paint, so waiting for the client costs nothing and
// removes the whole class of problem.
export function useMounted(): boolean {
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	return mounted;
}
