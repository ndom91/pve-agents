import { useCallback, useEffect, useState } from "react";

// Theme is what the page is painted in. No "system" member on purpose -- see below.
export type Theme = "dark" | "light";

// STORED is where a chosen theme lives between visits.
const STORED = "pve-agents.theme";

// useTheme reads and sets the theme, which lives on <html data-theme>.
//
// The attribute is the source of truth, not this hook. It is set by an inline script in the
// document head before first paint (see `__root.tsx`), because a theme applied by React runs after
// the browser has already painted the other one -- which is a white flash on every load for
// somebody who chose dark, the one group most likely to notice.
//
// So this reads what that script decided rather than deciding again, and the initial state is read
// in an effect rather than during render: the server has no document, and guessing produces a
// hydration mismatch on the one attribute the whole page hangs off.
//
// Two values, not three. A "system" setting sounds thorough and means the toggle has three
// positions, two of which look identical most of the time. Following the OS is what happens when
// nothing has been chosen; choosing is what the toggle is for.
export function useTheme(): { setTheme: (next: Theme) => void; theme: Theme } {
	const [theme, setState] = useState<Theme>("dark");

	useEffect(() => {
		setState(
			document.documentElement.dataset.theme === "light" ? "light" : "dark",
		);
	}, []);

	const setTheme = useCallback((next: Theme) => {
		document.documentElement.dataset.theme = next;
		setState(next);
		try {
			localStorage.setItem(STORED, next);
		} catch {
			// Private browsing, or storage full. The theme still applies for this visit; it just
			// will not be remembered, which is a better outcome than the toggle throwing.
		}
	}, []);

	return { setTheme, theme };
}
