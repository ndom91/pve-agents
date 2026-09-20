import { type ReactNode, useEffect, useState } from "react";

// FALLBACK_MS is used when the stylesheet has not answered.
//
// Reading --text-swap-dur keeps the exit's length and the class's length the same value rather
// than two that have to be edited together. getPropertyValue returns "" before the stylesheet is
// applied and during server rendering, which is what this covers.
const FALLBACK_MS = 150;

// SwapText replaces its own text by animating the old one out and the new one in.
//
// A status word that changes while somebody is looking at it — requested to provisioning to ready,
// idle to active to blocked — is the one place on this page where a value changes without anything
// else moving. Swapped in place, the change is visible; replaced between two frames, it is a word
// that was simply always the other word.
//
// The three phases are the transitions.dev sequence: exit, then swap the text while it is
// invisible and jump to the entry position with no transition, then a forced reflow before
// releasing it so the browser has two states to tween between rather than one.
export function SwapText({
	className,
	value,
}: {
	className?: string;
	value: string;
}): ReactNode {
	const [shown, setShown] = useState(value);
	const [phase, setPhase] = useState<"enter-start" | "exit" | "rest">("rest");

	useEffect(() => {
		if (value === shown || phase !== "rest") {
			return;
		}

		const duration =
			Number.parseFloat(
				getComputedStyle(document.documentElement).getPropertyValue(
					"--text-swap-dur",
				),
			) || FALLBACK_MS;

		setPhase("exit");
		const timer = setTimeout(() => {
			setShown(value);
			setPhase("enter-start");
		}, duration);

		return () => clearTimeout(timer);
	}, [phase, shown, value]);

	// Leaving the entry position, one painted frame after arriving at it.
	//
	// Two frames rather than a reflow read, because the state that has to be painted first is one
	// React has only just been told about: forcing layout here would measure the DOM as it is now,
	// which is before the jump. The second callback runs after the browser has drawn the first.
	useEffect(() => {
		if (phase !== "enter-start") {
			return;
		}

		let inner = 0;
		const outer = requestAnimationFrame(() => {
			inner = requestAnimationFrame(() => setPhase("rest"));
		});

		return () => {
			cancelAnimationFrame(outer);
			cancelAnimationFrame(inner);
		};
	}, [phase]);

	const state =
		phase === "rest" ? "" : phase === "exit" ? " is-exit" : " is-enter-start";

	return (
		<span className={`${className ?? ""} t-text-swap${state}`.trim()}>
			{shown}
		</span>
	);
}
