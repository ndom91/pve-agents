import { Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";

import { useTheme } from "../lib/use-theme";
import { IconButton } from "./icon-button";

// ThemeToggle switches the page between dark and light.
//
// One button rather than two, because there are two states: the icon shows what pressing it will
// give you, and the label says so. A segmented pair would spend twice the width to let somebody
// press the option that is already active.
export function ThemeToggle(): ReactNode {
	const { setTheme, theme } = useTheme();
	const next = theme === "dark" ? "light" : "dark";

	return (
		<IconButton
			icon={theme === "dark" ? Sun : Moon}
			label={`Switch to ${next} theme`}
			onClick={() => setTheme(next)}
			size={13}
			strokeWidth={1.2}
		/>
	);
}
