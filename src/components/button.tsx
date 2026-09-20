import type { ReactNode } from "react";

// ButtonVariant is how loud a control is, in three steps.
//
// Primary is the accent fill and there should be one obvious candidate per view. Secondary is the
// same shape outlined rather than filled. Tertiary carries neither, for a control that should be
// available without competing with the thing beside it.
export type ButtonVariant = "primary" | "secondary" | "tertiary";

type ButtonProps = {
	children: ReactNode;
	// Layout only: where the button sits, never how it looks. Appearance is `variant`, so a new
	// quiet button cannot arrive as a one-off class that the next one then copies.
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
