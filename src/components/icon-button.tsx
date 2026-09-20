import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// IconVariant is the same vocabulary `Button` uses, minus the one step that has no meaning here.
//
// There is no primary icon button: an icon alone cannot carry the weight of being the obvious
// candidate in a view, and no call site has ever wanted one.
export type IconVariant = "secondary" | "tertiary";

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

// classes joins the shape, the variant and whatever the caller needs for placement.
function classes({ className, variant = "secondary" }: IconStyle): string {
	return ["icon-button", `is-${variant}`, className ?? ""]
		.filter((part) => part !== "")
		.join(" ");
}

// IconButton is a square control carrying an icon and nothing else.
//
// The label becomes both the accessible name and the tooltip, so the two cannot drift apart.
export function IconButton({
	disabled,
	onClick,
	...style
}: IconStyle & {
	disabled?: boolean;
	onClick?: () => void;
}): ReactNode {
	const { icon: Icon, label, size = 16, strokeWidth = 1.75 } = style;

	return (
		<button
			aria-label={label}
			className={classes(style)}
			disabled={disabled}
			onClick={onClick}
			title={label}
			type="button"
		>
			<Icon aria-hidden size={size} strokeWidth={strokeWidth} />
		</button>
	);
}

// IconLink is the same control for somewhere to go rather than something to do.
//
// It exists because the one navigating icon in the app used to hand-write `className="icon-button"`
// on a `<Link>`, which meant a change to the button reached every icon except that one. A link and
// a button are different elements for good reasons -- middle-click, the status bar, the keyboard --
// so this shares the appearance rather than pretending they are the same thing.
export function IconLink({
	to,
	...style
}: IconStyle & { to: string }): ReactNode {
	const { icon: Icon, label, size = 16, strokeWidth = 1.75 } = style;

	return (
		<Link aria-label={label} className={classes(style)} title={label} to={to}>
			<Icon aria-hidden size={size} strokeWidth={strokeWidth} />
		</Link>
	);
}
