import {
	CircleCheck,
	CircleX,
	Info,
	type LucideIcon,
	TriangleAlert,
	X,
} from "lucide-react";
import { type ReactNode, useState } from "react";

// How loud a notice is. Four, reusing the signal colours already in the system.
//
// No blue. It appears nowhere else in this application except real terminal output, and a hue that
// means "informational" is a hue somebody then has to explain.
export type NoticeSeverity = "neutral" | "green" | "amber" | "red";

// Where a notice lives, which is decided by how long it lasts and whether it asks for a decision.
//
// "strip" is workspace-level state that persists: it sits under the meta band in the band's own
// register, so it reads as chrome rather than as the first message in the feed. One line, and it
// drops the mono heading.
//
// "block" is for a notice that needs more than one line or offers a real choice. It lives in the
// column and scrolls away with it, and it is the only placement that keeps the heading.
export type NoticePlacement = "block" | "strip";

const ICONS: Record<NoticeSeverity, LucideIcon> = {
	amber: TriangleAlert,
	green: CircleCheck,
	neutral: Info,
	red: CircleX,
};

// Loudest first. The order `NoticeStack` shows them in, and the order it collapses them by.
const ORDER: NoticeSeverity[] = ["red", "amber", "green", "neutral"];

// NoticeAction is the one thing a notice can offer beyond saying something.
export type NoticeAction = { label: string; onClick: () => void };

export type NoticeProps = {
	// Never more than one in a strip: a 34px line with two controls on it is a toolbar.
	action?: NoticeAction;
	// The sentence. `lead` is the state, `rest` is the consequence -- rendered primary and muted
	// respectively, and never coloured. The icon and the fill carry the severity, which is what
	// keeps one red notice from being three different reds.
	lead: string;
	onDismiss?: () => void;
	placement?: NoticePlacement;
	rest?: ReactNode;
	severity: NoticeSeverity;
};

// Notice is one thing that is true about a workspace.
export function Notice({
	action,
	lead,
	onDismiss,
	placement = "strip",
	rest,
	severity,
}: NoticeProps): ReactNode {
	const Icon = ICONS[severity];

	// <output> rather than a div with role="status": it carries that role already, and a notice
	// appearing is exactly the kind of change a screen reader should be told about.
	return (
		<output className={`notice is-${severity} is-${placement}`}>
			<Icon aria-hidden className="notice-icon" size={13} strokeWidth={1.5} />
			<div className="notice-text">
				{placement === "block" ? (
					<strong className="notice-lead">{lead}</strong>
				) : (
					<span className="notice-lead">{lead}</span>
				)}
				{rest === undefined ? null : (
					<span className="notice-rest">{rest}</span>
				)}
			</div>
			{action === undefined ? null : (
				<button
					className="notice-action"
					onClick={action.onClick}
					type="button"
				>
					{action.label}
				</button>
			)}
			{onDismiss === undefined ? null : (
				<button
					aria-label="Dismiss"
					className="notice-dismiss"
					onClick={onDismiss}
					type="button"
				>
					<X aria-hidden size={13} strokeWidth={1.5} />
				</button>
			)}
		</output>
	);
}

// NoticeStack shows the loudest notice and hides the rest behind a count.
//
// Two strips is the ceiling: past that the header stops being chrome and starts being the page. A
// counter rather than a scroll is what enforces it -- the third notice costs a click, so nothing
// grows the header by being added to it.
//
// Callers pass whichever notices are currently true, in any order.
export function NoticeStack({
	notices,
}: {
	notices: NoticeProps[];
}): ReactNode {
	const [open, setOpen] = useState(false);

	if (notices.length === 0) {
		return null;
	}

	const ranked = [...notices].sort(
		(a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity),
	);
	const [loudest, ...rest] = ranked;
	if (loudest === undefined) {
		return null;
	}

	return (
		<>
			<Notice {...loudest} />
			{rest.length === 0 ? null : (
				<>
					{open
						? rest.map((notice) => <Notice key={notice.lead} {...notice} />)
						: null}
					<button
						aria-expanded={open}
						className="notice-more"
						onClick={() => setOpen(!open)}
						type="button"
					>
						<span
							aria-hidden
							className={`notice-more-dot is-${rest[0]?.severity ?? "neutral"}`}
						/>
						{rest.length === 1
							? "1 more notice"
							: `${rest.length} more notices`}
					</button>
				</>
			)}
		</>
	);
}
