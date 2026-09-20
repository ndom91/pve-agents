import type { ReactNode } from "react";

// What a rail tab shows when it has no content yet, or none at all.
//
// The rail is tall, and a tab that is waiting or empty is mostly space. A single sentence against
// its top-left corner reads as a caption for content that failed to arrive rather than as the
// state of the tab, which is what it is. These centre it instead.

// PanelCentre puts one small thing in the middle of whatever height the panel has.
export function PanelCentre({ children }: { children: ReactNode }): ReactNode {
	return <div className="panel-centre">{children}</div>;
}

// PanelNote is a tab's answer in words.
//
// "warn" is for answers that mean there may be work here this tab cannot show. Muted is the wrong
// colour for those: somebody deciding whether to destroy a workspace reads a grey card as
// "nothing to see".
export function PanelNote({
	children,
	tone = "muted",
}: {
	children: ReactNode;
	tone?: "muted" | "warn";
}): ReactNode {
	return (
		<PanelCentre>
			<p className={`panel-note panel-note-${tone}`}>{children}</p>
		</PanelCentre>
	);
}

// PanelSpinner is a wait with no prose attached.
//
// Labelled rather than captioned. "Loading the terminal." under a turning ring is the ring said
// twice, but a screen reader is told nothing by the ring alone, so the sentence moves to the
// label instead of disappearing.
export function PanelSpinner({ label }: { label: string }): ReactNode {
	return (
		<PanelCentre>
			{/* <output> rather than a span with role="status": it carries that role already, and
			    the label is the only thing here a screen reader can read. */}
			<output aria-label={label} className="panel-spinner" />
		</PanelCentre>
	);
}
