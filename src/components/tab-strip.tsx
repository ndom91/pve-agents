import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";

// Tab is one entry in the strip. The value is whatever the caller keys its panels on.
export type Tab<T> = { label: string; value: T };

// TabStrip is a row of labels where one is open.
//
// Shared by the workspace rail and the settings page, which is the whole reason it left the rail:
// the settings page needed the same control and the alternative was a second one that would drift.
//
// Presentational only. It holds no state and does not know what a tab contains -- which panel is
// mounted, and whether a closed one stays alive, are decisions that differ between the two callers
// and belong to them.
export function TabStrip<T>({
	current,
	onSelect,
	sameTab,
	tabs,
}: {
	current: T;
	onSelect?: (value: T) => void;
	// How to tell the open tab from the others. Defaults to identity, which is right for a string;
	// the rail keys on an object and passes its own.
	sameTab?: (a: T, b: T) => boolean;
	tabs: Tab<T>[];
}): ReactNode {
	const same = sameTab ?? ((a: T, b: T) => a === b);
	const bar = useRef<HTMLDivElement>(null);
	const underline = useRef<HTMLSpanElement>(null);

	// Move the underline under whichever tab is open.
	//
	// Measured from the DOM rather than computed from the labels, because the width of a tab is
	// whatever the font makes it. `animate` is false for the first placement and for a resize:
	// without suspending the transition there, the bar travels in from zero width at the left
	// edge every time the page loads or the rail is dragged.
	const place = useCallback((animate: boolean): void => {
		const strip = bar.current;
		const mark = underline.current;
		if (strip === null || mark === null) {
			return;
		}

		const active = strip.querySelector<HTMLElement>('[aria-selected="true"]');
		if (active === null) {
			return;
		}

		const previous = mark.style.transition;
		if (!animate) {
			mark.style.transition = "none";
		}
		// offsetLeft is already relative to the strip, and the bar is inside it, so both scroll
		// together. Subtracting scrollLeft here would compensate for the scroll twice.
		mark.style.transform = `translateX(${active.offsetLeft}px)`;
		mark.style.width = `${active.offsetWidth}px`;
		if (!animate) {
			// Flush the jump before the transition comes back, or it animates from the old place.
			void mark.offsetWidth;
			mark.style.transition = previous;
		}
	}, []);

	// The open tab changed, so travel. Also runs on mount, where there is nothing to travel from
	// and the layout effect places the bar before the browser paints.
	const placed = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `current` is the thing that moves it
	useLayoutEffect(() => {
		place(placed.current);
		placed.current = true;
	}, [current, place]);

	useEffect(() => {
		const strip = bar.current;
		if (strip === null) {
			return;
		}

		// A ResizeObserver rather than a window listener: the rail is a handle somebody drags, and
		// the window never changes size while they do it.
		const observer = new ResizeObserver(() => place(false));
		observer.observe(strip);
		return () => observer.disconnect();
	}, [place]);

	return (
		// Scrolls sideways rather than wrapping. Wrapping would change the strip's height as tabs
		// appear, moving everything below it.
		<div className="tabs t-tabs" ref={bar} role="tablist">
			<span aria-hidden className="t-tabs-pill" ref={underline} />
			{tabs.map(({ label, value }) => (
				<button
					aria-selected={same(current, value)}
					className="tab"
					key={label}
					onClick={() => onSelect?.(value)}
					role="tab"
					type="button"
				>
					{label}
				</button>
			))}
		</div>
	);
}
