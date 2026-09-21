import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip } from "./tooltip";

// `Button`'s vocabulary without "primary": an icon alone cannot carry being the obvious candidate
// in a view, and no call site has wanted one. "danger" is here because one does -- destroy is the
// only irreversible control in the application and it needs a red outline, which arrived first as
// a doubled selector on the instance because a one-class override cannot beat the two classes this
// component always emits.
export type IconVariant = "danger" | "secondary" | "tertiary";

type IconStyle = {
	// Layout only: where the control sits, never how it looks.
	className?: string;
	icon: LucideIcon;
	// Always required. An icon on its own is unlabelled to a screen reader and ambiguous to anyone
	// who has not learned it, so the name is not optional the way a visible caption would be.
	label: string;
	size?: number;
	strokeWidth?: number;
	variant?: IconVariant;
};

function classes({ className, variant = "secondary" }: IconStyle): string {
	return ["icon-button", `is-${variant}`, className ?? ""]
		.filter((part) => part !== "")
		.join(" ");
}

// IconButton is a square control carrying an icon and nothing else.
//
// The label becomes both the accessible name and the tooltip, so the two cannot drift apart.
//
// The tooltip replaces the `title` attribute all three of these used to carry. `title` needed no
// JavaScript, which is the one thing it had going for it; against that it waits about a second,
// cannot be themed, renders in the operating system's own chrome rather than this application's,
// and never appears on a touch device at all. `aria-label` is unchanged and is still what a screen
// reader announces, so nothing about the accessible name depends on the tooltip rendering.
//
// `swapIcon` opts into the second icon. Both are mounted and stacked in one grid cell, and
// `swapped` decides which is lit: a cross-fade needs the outgoing icon still there to fade, which
// swapping one element's `icon` prop cannot give. Callers that never change icon pass neither and
// get a single glyph, as before.
export function IconButton({
	disabled,
	onClick,
	swapIcon: SwapIcon,
	swapStrokeWidth,
	swapped = false,
	...style
}: IconStyle & {
	disabled?: boolean;
	onClick?: () => void;
	swapIcon?: LucideIcon;
	swapStrokeWidth?: number;
	swapped?: boolean;
}): ReactNode {
	const { icon: Icon, label, size = 16, strokeWidth = 1.75 } = style;

	return (
		<Tooltip label={label}>
			<button
				aria-label={label}
				className={classes(style)}
				disabled={disabled}
				onClick={onClick}
				type="button"
			>
				{SwapIcon === undefined ? (
					<Icon aria-hidden size={size} strokeWidth={strokeWidth} />
				) : (
					<span className="t-icon-swap" data-state={swapped ? "b" : "a"}>
						<span className="t-icon" data-icon="a">
							<Icon aria-hidden size={size} strokeWidth={strokeWidth} />
						</span>
						<span className="t-icon" data-icon="b">
							<SwapIcon
								aria-hidden
								size={size}
								strokeWidth={swapStrokeWidth ?? strokeWidth}
							/>
						</span>
					</span>
				)}
			</button>
		</Tooltip>
	);
}

// IconLink is the same control for somewhere to go rather than something to do.
//
// The navigating icon used to hand-write `className="icon-button"` on a `<Link>`, so a change to
// the button reached every icon except that one. Still a `<Link>`, because middle-click, the
// status bar and the keyboard all depend on it being one.
export function IconLink({
	to,
	...style
}: IconStyle & { to: string }): ReactNode {
	const { icon: Icon, label, size = 16, strokeWidth = 1.75 } = style;

	return (
		<Tooltip label={label}>
			<Link aria-label={label} className={classes(style)} to={to}>
				<Icon aria-hidden size={size} strokeWidth={strokeWidth} />
			</Link>
		</Tooltip>
	);
}

// IconOutLink goes somewhere this application does not own.
//
// A plain anchor rather than the router's `Link`, which exists to navigate within this app and
// would try to match an external URL against the route tree.
//
// `noreferrer` as well as `noopener`: the two are often written as a pair out of habit, and here
// the first is the one doing work. Without it the destination is told which workspace page the
// operator came from, which names an internal host in somebody else's logs.
export function IconOutLink({
	href,
	...style
}: IconStyle & { href: string }): ReactNode {
	const { icon: Icon, label, size = 16, strokeWidth = 1.75 } = style;

	return (
		<Tooltip label={label}>
			<a
				aria-label={label}
				className={classes(style)}
				href={href}
				rel="noreferrer noopener"
				target="_blank"
			>
				<Icon aria-hidden size={size} strokeWidth={strokeWidth} />
			</a>
		</Tooltip>
	);
}
