import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { IconButton } from "./icon-button";

// CONFIRM_MS is how long the tick stays up after a copy.
//
// Long enough to be seen, short enough that the button is ready again before anyone wants it. The
// clipboard gives no other feedback at all: without this, clicking appears to do nothing.
const CONFIRM_MS = 1_500;

// CopyButton puts text on the clipboard and says that it did.
//
// An IconButton for the appearance, and its own component for the rest: which icon, for how long,
// and what the accessible name says while the tick is up. A caller should not have to own a timer
// to copy a paragraph.
export function CopyButton({
	label,
	text,
}: {
	label: string;
	text: string;
}): ReactNode {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

	// A component unmounted inside the confirmation window — a page navigated away from, a
	// transcript replaced by a reconnect — would otherwise have its timer fire against nothing.
	useEffect(() => () => clearTimeout(timer.current), []);

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Denied permission, or an insecure context where the API does not exist. Nothing to
			// recover: the tick simply does not appear, which is the honest report.
			return;
		}

		setCopied(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
	}

	return (
		<IconButton
			className="copy-button"
			icon={copied ? Check : Copy}
			// The name changes with the state, so a screen reader is told the copy happened rather
			// than being left with a button whose label never reacts.
			label={copied ? "Copied" : label}
			onClick={() => void copy()}
			size={14}
			strokeWidth={copied ? 2 : 1.75}
			variant="tertiary"
		/>
	);
}
