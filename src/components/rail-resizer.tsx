import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";

import { RAIL_DEFAULT, RAIL_MIN } from "../lib/use-rail-width";

// KEYBOARD_STEP is how far one arrow press moves the edge. Large enough to get somewhere without
// holding the key for a minute, small enough to land where you meant.
const KEYBOARD_STEP = 32;

// RailResizer is the draggable edge between the centre and the rail.
//
// A separator rather than a button, because that is what it is, and the role brings arrow-key
// resizing with it for free. Worth having: a pointer drag is the obvious way to use this and the
// only way for anyone who cannot make one.
export function RailResizer({
	onResize,
	width,
}: {
	onResize: (width: number) => void;
	width: number;
}): ReactNode {
	function startDrag(event: ReactPointerEvent<HTMLDivElement>): void {
		const handle = event.currentTarget;
		const startX = event.clientX;
		const startWidth = width;

		// Captured so the drag survives the pointer leaving the handle, which it does immediately:
		// the handle is six pixels wide and the pointer is moving. Without this the rail would stop
		// following after the first few pixels.
		handle.setPointerCapture(event.pointerId);

		function move(moved: PointerEvent): void {
			// Leftwards is wider, because the rail is on the right and its left edge is what moves.
			onResize(startWidth + (startX - moved.clientX));
		}

		function stop(): void {
			handle.releasePointerCapture(event.pointerId);
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", stop);
			handle.removeEventListener("pointercancel", stop);
		}

		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", stop);
		handle.addEventListener("pointercancel", stop);
	}

	return (
		// The rule offers <hr>, which carries the separator role implicitly but means a thematic
		// break and cannot take focus. A focusable separator carrying aria-valuenow is the window
		// splitter pattern, and that is exactly what this is.
		// biome-ignore lint/a11y/useSemanticElements: a focusable splitter, not a rule
		<div
			aria-label="Resize the panel"
			aria-orientation="vertical"
			aria-valuemin={RAIL_MIN}
			aria-valuenow={Math.round(width)}
			className="rail-resizer"
			onDoubleClick={() => onResize(RAIL_DEFAULT)}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					onResize(width + KEYBOARD_STEP);
				}
				if (event.key === "ArrowRight") {
					event.preventDefault();
					onResize(width - KEYBOARD_STEP);
				}
			}}
			onPointerDown={startDrag}
			role="separator"
			tabIndex={0}
			title="Drag to resize, double-click to reset"
		/>
	);
}
