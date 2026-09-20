import { useCallback, useState } from "react";

// OpenRows is which rows of a list are unfolded.
export type OpenRows = {
	isOpen: (key: string) => boolean;
	toggle: (key: string) => void;
};

// useOpenRows tracks which rows of an accordion are open.
//
// Several at once, which is the property both callers depend on and the reason this is a list
// rather than one key: comparing two changed files, or two seeded files, is the commonest reason to
// be looking at either list at all.
//
// Extracted after the second identical copy appeared. The first was a pattern; the second was nine
// lines of state machine written out twice and differing only in what the parameter was called.
export function useOpenRows(): OpenRows {
	const [open, setOpen] = useState<string[]>([]);

	const toggle = useCallback((key: string) => {
		setOpen((current) =>
			current.includes(key)
				? current.filter((candidate) => candidate !== key)
				: [...current, key],
		);
	}, []);

	const isOpen = useCallback((key: string) => open.includes(key), [open]);

	return { isOpen, toggle };
}
