import { useCallback, useEffect, useState } from "react";

// RAIL_MIN is the width the placement facts were laid out for. Narrower than this and the values
// they exist to show start wrapping mid-address.
export const RAIL_MIN = 260;

// CENTRE_MIN is what the rail must leave behind. The terminal is the thing being watched, and a
// rail dragged over the top of it would be a worse view of both.
const CENTRE_MIN = 420;

const STORAGE_KEY = "herdr.rail-width";

// useRailWidth remembers how wide the operator dragged the rail.
//
// Kept because the width is a decision about the task in hand rather than about the page: someone
// widening the rail to read a diff means to keep reading diffs, and having it snap back on every
// navigation would make the handle not worth using.
export function useRailWidth(): {
	setWidth: (width: number) => void;
	width: number;
} {
	const [width, setStored] = useState(RAIL_MIN);

	// Read after mount rather than during render. localStorage does not exist on the server, and a
	// width restored during render would disagree with the markup the server sent.
	useEffect(() => {
		const saved = Number(window.localStorage.getItem(STORAGE_KEY));
		if (Number.isFinite(saved) && saved >= RAIL_MIN) {
			setStored(clamp(saved));
		}
	}, []);

	const setWidth = useCallback((next: number) => {
		const bounded = clamp(next);
		setStored(bounded);
		window.localStorage.setItem(STORAGE_KEY, String(bounded));
	}, []);

	return { setWidth, width };
}

// clamp keeps the rail between useful and rude.
function clamp(width: number): number {
	// Guarded because this runs on the first client render too, and a window narrower than both
	// minimums together would otherwise produce a maximum below the minimum.
	const available =
		typeof window === "undefined"
			? Number.POSITIVE_INFINITY
			: Math.max(RAIL_MIN, window.innerWidth - CENTRE_MIN);

	return Math.round(Math.min(Math.max(width, RAIL_MIN), available));
}
