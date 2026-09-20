import type { ReactNode } from "react";

import { SwapText } from "./swap-text";

// ChipTone is the four fills a chip comes in.
//
// Named for the colour rather than for a meaning, because the two columns a chip can carry --
// lifecycle status and agent activity -- map onto them differently and a shared name would have to
// lie about one of them. What each tone means is decided by the caller.
export type ChipTone = "amber" | "green" | "neutral" | "red";

// StatusChip is one piece of state: a dot, a word, a tinted fill and a tinted border.
//
// A chip is never a button. It reports; it does not offer. The destroy control beside these is the
// only thing in the bar that does something, and a chip that looked pressable would be competing
// with it.
export function StatusChip({
	label,
	tone,
}: {
	label: string;
	tone: ChipTone;
}): ReactNode {
	return (
		<span className={`chip is-${tone}`}>
			<span aria-hidden="true" className="chip-dot" />
			{/* The word swaps rather than being replaced. A workspace walks through five statuses
			    on its way to ready, and each of them landing between two frames is why somebody
			    watching a provision sees a chip that was apparently always saying this. */}
			<SwapText value={label} />
		</span>
	);
}
