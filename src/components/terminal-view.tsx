import { FitAddon, init, Terminal } from "ghostty-web";
import { Eraser } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { IconButton } from "./icon-button";
import { PanelNote, PanelSpinner } from "./panel-state";

// TerminalView is a shell in the workspace.
//
// ghostty-web rather than xterm.js: the same API, but the parser is Ghostty's own, compiled to
// WASM. The WASM arrives inlined in the bundle as a data URL, so there is no extra asset for the
// server to serve and nothing to get wrong in a deploy.
//
// Loaded on demand by its wrapper. It draws to a canvas and measures real glyphs, so it cannot be
// server-rendered, and it is the largest thing on a page most visits never open.
//
// The terminal is built once and kept; switching workspaces changes which shell is on the other end
// of it, not which terminal you are looking at. That distinction is worth about two and a half
// seconds: `dispose()` drops ghostty's cached WASM instance, so the next terminal has to load and
// compile the whole module again before it can show anything.
// terminalTheme reads the --terminal-* tokens off the element the shell will draw into.
//
// Resolved once, at construction, which is all ghostty asks for. If the theme is ever switched
// while a shell is open these will not follow -- and they should not: the terminal is deliberately
// theme-invariant, so the only thing that could change here is a token edit, which needs a reload
// anyway.
function terminalTheme(element: Element) {
	const style = getComputedStyle(element);
	const token = (name: string, fallback: string) =>
		style.getPropertyValue(name).trim() || fallback;

	return {
		background: token("--terminal-bg", "#0b0f0a"),
		cursor: token("--terminal-accent", "#b5cda9"),
		foreground: token("--terminal-bright", "#d6e2cf"),
	};
}

export default function TerminalView({
	hostname,
	ip,
	workspaceId,
}: {
	hostname?: string;
	ip?: string;
	workspaceId: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	// The terminal, and whichever socket is currently wired to it. Refs rather than state because
	// nothing renders from them: they are the machinery, not the picture.
	const screen = useRef<{ fit: FitAddon; terminal: Terminal } | null>(null);
	const wire = useRef<WebSocket | null>(null);
	const [state, setState] = useState<"closed" | "live" | "opening">("opening");
	// The grid the shell is actually running at, for the footer. Read off the terminal after each
	// fit rather than computed here: the fit addon owns that arithmetic and a second copy of it
	// would be a number that disagrees with the one the remote tty was told.
	const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);

	// Disposed once, when the page is finished with this terminal entirely.
	//
	// Deferred, because tearing one down is seconds of work inside the WASM and doing it inline
	// blocks the navigation that asked for it. Nothing reads it afterwards: the element it drew
	// into has already gone.
	useEffect(
		() => () => {
			const built = screen.current;
			screen.current = null;
			setTimeout(() => built?.terminal.dispose(), 0);
		},
		[],
	);

	useEffect(() => {
		const element = host.current;
		if (element === null) {
			return;
		}

		// Set by the cleanup below. The WASM has to load before a terminal can exist, and a tab
		// closed during that wait would otherwise leave a socket and a shell behind.
		let stopped = false;
		let teardown: () => void = () => {};

		void (async () => {
			await init();
			if (stopped || host.current === null) {
				return;
			}

			if (screen.current === null) {
				const terminal = new Terminal({
					// Matches the palette the rest of the application uses, so a shell does not
					// arrive as a black rectangle stapled to a green page.
					fontFamily: '"SF Mono", "Roboto Mono", monospace',
					fontSize: 12,
					// Bounded. Every line of it is memory the terminal has to free eventually, and
					// a workspace shell is for short commands rather than for reading a log in.
					scrollback: 1_000,
					// Read off the stylesheet rather than written here, so the shell's colours
					// stay in the token file with everything else. These are the one group that
					// does not change with the theme: the terminal stays dark in light mode, the
					// way an editor's integrated terminal does, because its colours are the
					// shell's and not the application's.
					theme: terminalTheme(element),
				});
				const fit = new FitAddon();
				terminal.loadAddon(fit);
				terminal.open(element);

				// Registered once, against whichever socket is current. Registering per connection
				// would stack a listener for every workspace visited, and each would send the same
				// keystroke again.
				terminal.onData((data: string) => {
					const live = wire.current;
					if (live?.readyState === WebSocket.OPEN) {
						live.send(new TextEncoder().encode(data));
					}
				});

				screen.current = { fit, terminal };
			}

			const { fit, terminal } = screen.current;

			// Sized first, so the clean screen below covers the grid the shell will run at.
			fit.fit();

			// A clean screen for a new shell, and both steps are load-bearing.
			//
			// `reset` drops the scrollback and the last session's modes by rebuilding the terminal
			// inside the WASM -- and the rebuilt one is handed a buffer the allocator has not
			// zeroed, so a brand-new Terminal on a brand-new canvas can come up already showing
			// the previous shell's output. `clear` writes ED2 through the parser, which erases the
			// cells that are really there rather than trusting them to be empty.
			terminal.reset();
			terminal.clear();
			setSize({ cols: terminal.cols, rows: terminal.rows });
			setState("opening");

			// The size travels with the connection so the remote tty is sized before the shell
			// starts. Sent afterwards it would be typed at the prompt and echoed back.
			const socket = new WebSocket(
				`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal` +
					`?workspace=${encodeURIComponent(workspaceId)}` +
					`&cols=${terminal.cols}&rows=${terminal.rows}`,
			);
			socket.binaryType = "arraybuffer";
			wire.current = socket;

			socket.addEventListener("open", () => setState("live"));
			socket.addEventListener("message", (event) => {
				// Only from the live shell. One terminal is shared across workspaces now, so a
				// message still in flight from the one being left would otherwise paint itself
				// into the screen belonging to the one being opened.
				if (wire.current !== socket) {
					return;
				}

				terminal.write(
					typeof event.data === "string"
						? event.data
						: new Uint8Array(event.data as ArrayBuffer),
				);
			});
			// Only while it is still the live one. A socket closed because the workspace changed
			// would otherwise report the shell that replaced it as ended.
			socket.addEventListener("close", () => {
				if (wire.current === socket) {
					setState("closed");
				}
			});

			// Refit when the rail is dragged, and tell the shell what happened.
			//
			// Debounced because a drag is a hundred resize events and each one costs a short-lived
			// ssh connection on the controller. The last size is the only one that matters.
			let pending: ReturnType<typeof setTimeout> | undefined;
			const observer = new ResizeObserver(() => {
				clearTimeout(pending);
				pending = setTimeout(() => {
					fit.fit();
					setSize({ cols: terminal.cols, rows: terminal.rows });
					if (socket.readyState === WebSocket.OPEN) {
						socket.send(
							JSON.stringify({ cols: terminal.cols, rows: terminal.rows }),
						);
					}
				}, 250);
			});
			observer.observe(element);

			// The shell goes; the terminal stays. That is the whole point of the split.
			teardown = () => {
				clearTimeout(pending);
				observer.disconnect();
				socket.close();
			};
		})();

		return () => {
			stopped = true;
			teardown();
		};
	}, [workspaceId]);

	return (
		<div className="terminal-view">
			{/* Who, and the one control that acts on the screen rather than on the shell. Where it
			    is runs along the footer. The working directory is in neither, because this side
			    cannot know it: the cwd lives inside the shell and only the prompt has it. */}
			<div className="panel-bar terminal-bar">
				<span
					aria-hidden="true"
					className={state === "live" ? "terminal-led is-live" : "terminal-led"}
				/>
				<span className="terminal-who">
					{hostname === undefined ? "agent" : `agent@${hostname}`}
				</span>
				<IconButton
					className="terminal-tool"
					disabled={state !== "live"}
					icon={Eraser}
					label="Clear the screen"
					// The screen, not the session. The shell keeps running and whatever it prints
					// next lands on a clean page; nothing is sent to the far side.
					onClick={() => screen.current?.terminal.clear()}
					size={12}
					strokeWidth={1.1}
					variant="tertiary"
				/>
			</div>

			<div className="terminal-host" ref={host} />
			{/* Over the host rather than under it. ghostty measures real glyphs against the
			    element's own box, so the host has to keep its size while the WASM loads; laying
			    the wait on top is what leaves that box alone. */}
			{state === "live" ? null : (
				<div className="terminal-overlay">
					{state === "opening" ? (
						<PanelSpinner label="Opening a shell." />
					) : (
						<PanelNote>The shell has ended.</PanelNote>
					)}
				</div>
			)}

			{/* Whether there is a shell on the other end, where it is, and how to leave it. */}
			<div className="terminal-foot">
				<span className="terminal-foot-state">
					<span
						aria-hidden="true"
						className={
							state === "live" ? "terminal-led is-live" : "terminal-led"
						}
					/>
					{state === "live"
						? "attached"
						: state === "opening"
							? "attaching"
							: "detached"}
				</span>
				<span aria-hidden="true" className="terminal-foot-sep" />
				<span className="terminal-foot-where">
					{[
						ip,
						size === undefined || size === null
							? undefined
							: `${size.cols}\u00d7${size.rows}`,
					]
						.filter((part) => part !== undefined)
						.join(" \u00b7 ")}
				</span>
				<span className="terminal-foot-hint">
					<kbd className="prompt-key">&#8963;C</kbd> detach
				</span>
			</div>
		</div>
	);
}
