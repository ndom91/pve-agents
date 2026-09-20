import type { ReactNode } from "react";

// SectionHead is a label, a hairline that runs to the edge, and optionally something on the right.
//
// STYLE.md calls this the application's main structural device, and it is: the sidebar's two
// groups, the rail's four, and the home screen's three are all this. A bold heading or a boxed
// panel title would each be a second way of saying the same thing, which is what the refresh is
// removing.
//
// The rule is a plain element rather than a border on the label, because it has to start after the
// text and stop at whatever is on the right -- a border would run under both.
export function SectionHead({
	count,
	label,
	trailing,
}: {
	// A number on the far right. Zero is rendered; absent is not, which is the difference between
	// "none of these" and "this group does not count things".
	count?: number;
	label: string;
	// Anything other than a count on the right: a status, a duration. Wins over `count`.
	trailing?: ReactNode;
}): ReactNode {
	return (
		<div className="section-head">
			<span className="section-head-label">{label}</span>
			<span className="section-head-rule" />
			{trailing ??
				(count === undefined ? null : (
					<span className="section-head-count">{count}</span>
				))}
		</div>
	);
}
