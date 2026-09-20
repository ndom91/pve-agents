import type { ReactNode } from "react";

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

	return (
		// Scrolls sideways rather than wrapping. Wrapping would change the strip's height as tabs
		// appear, moving everything below it.
		<div className="tabs" role="tablist">
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
