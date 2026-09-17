import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type IconButtonProps = {
	disabled?: boolean;
	icon: LucideIcon;
	// Always required. An icon on its own is unlabelled to a screen reader and ambiguous to anyone
	// who has not learned it, so the name is not optional the way a visible caption would be.
	label: string;
	onClick?: () => void;
};

// IconButton is a square control carrying an icon and nothing else.
//
// The label becomes both the accessible name and the tooltip, so the two cannot drift apart.
export function IconButton({
	disabled,
	icon: Icon,
	label,
	onClick,
}: IconButtonProps): ReactNode {
	return (
		<button
			aria-label={label}
			className="icon-button"
			disabled={disabled}
			onClick={onClick}
			title={label}
			type="button"
		>
			<Icon aria-hidden size={16} strokeWidth={1.75} />
		</button>
	);
}
