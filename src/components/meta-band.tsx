import type { ReactNode } from "react";
import { Fragment } from "react";

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
	facts: {
		key: string;
		// A dot between the key and the value, for a fact that is a switch rather than a
		// measurement. Green when the thing is on; the decorative grey when it is not, because an
		// off worker is a state somebody chose rather than a failure.
		tone?: "off" | "on";
		value?: string;
	}[];
	// The "how long / how many" summary, pushed to the far right.
	tail?: ReactNode;
}): ReactNode {
	const shown = facts.filter(
		(fact) => fact.value !== undefined && fact.value !== "",
	);

	return (
		<div className="meta-band">
			{shown.map((fact, index) => (
				// The divider is a sibling of the items rather than a child of one, so the row's
				// own gap sets the space either side of it. Nested, it could only ever be given a
				// margin on one side, and it sat flush against the value before it.
				<Fragment key={fact.key}>
					{index === 0 ? null : (
						<span aria-hidden="true" className="meta-band-sep" />
					)}
					<div className="meta-band-item">
						<span className="meta-band-key">{fact.key}</span>
						{fact.tone === undefined ? null : (
							<span
								aria-hidden="true"
								className={`meta-band-dot is-${fact.tone}`}
							/>
						)}
						<span className="meta-band-val">{fact.value}</span>
					</div>
				</Fragment>
			))}
			<span className="meta-band-spacer" />
			{tail === undefined ? null : (
				<span className="meta-band-tail">{tail}</span>
			)}
		</div>
	);
}
