import type { ReactNode } from "react";

// Option is one choice. The same `{ label, value }` shape as `Tab`, so the two controls that take a
// list of things to pick between describe them the same way.
export type Option<T extends string> = { label: string; value: T };

// Select is a dropdown that looks like the rest of the application.
//
// It exists because the first `<select>` in this codebase arrived wearing the platform's own
// appearance next to fields wearing ours: a different border, a different arrow, and a bright blue
// focus ring where everything else has a soft green one.
//
// The value is typed to the union it came from rather than `string`, so a caller reading the change
// does not have to cast its own option back out of the event.
export function Select<T extends string>({
	disabled,
	id,
	onChange,
	options,
	value,
}: {
	disabled?: boolean;
	// Paired with the caption's `htmlFor`. Explicit rather than relying on a wrapping <label>: a
	// linter cannot see a control through a component, and neither can anyone reading the caller.
	id: string;
	onChange: (value: T) => void;
	options: readonly Option<T>[];
	value: T;
}): ReactNode {
	return (
		<select
			className="select"
			disabled={disabled}
			id={id}
			onChange={(event) => onChange(event.target.value as T)}
			value={value}
		>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	);
}
