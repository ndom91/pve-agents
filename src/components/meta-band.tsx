import type { ReactNode } from "react";

// MetaBand is the row of machine facts under a screen's title bar.
//
// The refresh's signature element, and the reason the right panel's Placement group is shorter than
// it was: node, vmid, address and branch are what you reach for when something has gone wrong, and
// they used to be readable only with the panel open. Here they are always on screen, in one 32px
// strip, sunk a level so they read as chrome rather than as content.
//
// Facts with no value yet are dropped rather than rendered empty. A workspace acquires these as it
// provisions, so a missing one means "not there yet", and a key with nothing beside it reads as a
// fault.
export function MetaBand({
	facts,
	tail,
}: {
	facts: { key: string; value?: string }[];
	// The "how long / how many" summary, pushed to the far right.
	tail?: ReactNode;
}): ReactNode {
	const shown = facts.filter(
		(fact) => fact.value !== undefined && fact.value !== "",
	);

	return (
		<div className="meta-band">
			{shown.map((fact, index) => (
				<div className="meta-band-item" key={fact.key}>
					{/* The divider belongs to the item that follows it, so the first item does not
					    start with one and nothing has to know which item is last. */}
					{index === 0 ? null : (
						<span aria-hidden="true" className="meta-band-sep" />
					)}
					<span className="meta-band-key">{fact.key}</span>
					<span className="meta-band-val">{fact.value}</span>
				</div>
			))}
			<span className="meta-band-spacer" />
			{tail === undefined ? null : (
				<span className="meta-band-tail">{tail}</span>
			)}
		</div>
	);
}
