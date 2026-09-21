// The scoped package, not the `radix-ui` umbrella: this app wants one primitive, and the umbrella
// pulls the whole set.
import * as Radix from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

// Tooltip is a label that appears beside a control on hover or keyboard focus.
//
// Radix rather than a hand-rolled one, for the part that is actually hard: a tooltip on the
// sidebar's settings button is two pixels from the window edge, and deciding to flip it to the
// other side is collision detection, not CSS. Radix ships no stylesheet of its own -- the look
// below is ours, in styles.css, like everything else -- and it styles through `data-side` and
// `data-state` attribute selectors, which is the same shape as the `[aria-selected]` and
// `[data-open]` rules already in that file.
//
// This exists as a wrapper rather than being used directly at each call site so that the five
// remaining `title` attributes elsewhere in the app have one thing to adopt, and so the delay and
// the offset are decided once.
export function Tooltip({
	children,
	label,
	side = "top",
}: {
	// The control being labelled. Must forward a ref and spread props -- a DOM element or a
	// component that passes them on -- because Radix attaches its listeners to it directly rather
	// than to a wrapper, so the trigger stays the same element the layout already positions.
	children: ReactNode;
	label: string;
	side?: "bottom" | "left" | "right" | "top";
}): ReactNode {
	return (
		<Radix.Root>
			<Radix.Trigger asChild>{children}</Radix.Trigger>
			<Radix.Portal>
				<Radix.Content className="tooltip" side={side} sideOffset={6}>
					{label}
				</Radix.Content>
			</Radix.Portal>
		</Radix.Root>
	);
}

// TooltipProvider carries the timings every tooltip in the app shares.
//
// Radix throws if a Tooltip mounts without one above it, which makes this a real requirement
// rather than a convenience -- it lives at the document root so every route has it, and a test
// rendering an IconButton on its own has to bring its own. That is a loud failure at mount rather
// than a silent one, which is the right trade for a hidden coupling.
//
// `skipDelayDuration` is the one worth knowing about: once any tooltip has opened, moving to a
// neighbouring trigger inside this window shows its tooltip at once rather than waiting again.
// The sidebar footer is four icon buttons in a row, and without it reading along them means four
// separate waits.
export function TooltipProvider({
	children,
}: {
	children: ReactNode;
}): ReactNode {
	return (
		<Radix.Provider delayDuration={500} skipDelayDuration={300}>
			{children}
		</Radix.Provider>
	);
}
