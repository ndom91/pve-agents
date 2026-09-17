import type { ReactNode } from "react";

type ButtonProps = {
	children: ReactNode;
	className?: string;
	disabled?: boolean;
	onClick?: () => void;
	title?: string;
	type?: "button" | "submit";
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
}: ButtonProps): ReactNode {
	return (
		<button
			className={className === undefined ? "button" : `button ${className}`}
			disabled={disabled}
			onClick={onClick}
			title={title}
			type={type}
		>
			{children}
		</button>
	);
}
