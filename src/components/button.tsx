import type { ReactNode } from "react";

// How loud a control is. What each one looks like is in styles.css, beside the values.
//
// "danger" is secondary's shape in red, for an action that cannot be undone. Named to match
// `IconVariant`'s member of the same name. Not "warning": `--warn` is the amber of the caveat bars.
export type ButtonVariant = "danger" | "primary" | "secondary" | "tertiary";

type ButtonProps = {
	children: ReactNode;
	// Layout only. Appearance is `variant`, so a new quiet button cannot arrive as a one-off class
	// that the next one then copies.
	className?: string;
	disabled?: boolean;
	onClick?: () => void;
	title?: string;
	type?: "button" | "submit";
	variant?: ButtonVariant;
};

// Button is every text control in the app.
//
// It exists because the buttons had drifted: the same control was mono and uppercase in one place
// and the body font in another, depending on which rule happened to reach it. Type belongs to the
// component rather than to whichever selector wins, so a new button looks right without anyone
// remembering to style it.
export function Button({
	children,
	className,
	disabled,
	onClick,
	title,
	type = "button",
	variant = "primary",
}: ButtonProps): ReactNode {
	const classes = ["button", `is-${variant}`, className ?? ""]
		.filter((part) => part !== "")
		.join(" ");

	return (
		<button
			className={classes}
			disabled={disabled}
			onClick={onClick}
			title={title}
			type={type}
		>
			{children}
		</button>
	);
}
