import { FitAddon, init, Terminal } from "ghostty-web";
import { useEffect, useRef, useState } from "react";

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
export default function TerminalView({ workspaceId }: { workspaceId: string }) {
	const host = useRef<HTMLDivElement>(null);
	// The terminal, and whichever socket is currently wired to it. Refs rather than state because
	// nothing renders from them: they are the machinery, not the picture.
	const screen = useRef<{ fit: FitAddon; terminal: Terminal } | null>(null);
	const wire = useRef<WebSocket | null>(null);
	const [state, setState] = useState<"closed" | "live" | "opening">("opening");

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
					theme: {
						background: "#10140f",
						cursor: "#d6e2cf",
						foreground: "#d6e2cf",
					},
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

			// A clean screen for a new shell.
			//
			// Whatever is up there was drawn by a session that has ended and cannot be picked up
			// again -- it went with its socket. Left alone, the old output stays while the new
			// shell writes over it from the top, which reads as a session resuming halfway through
			// something it never ran. `reset` rather than `clear`, because the scrollback is part
			// of what would otherwise survive.
			terminal.reset();
			// `reset` empties the buffer but leaves the last frame on the canvas, so the previous
			// workspace's banner sat there until something happened to repaint. Refitting forces
			// that repaint, and has to come after the reset rather than before it.
			fit.fit();
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
		</div>
	);
}
