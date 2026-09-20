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
export default function TerminalView({ workspaceId }: { workspaceId: string }) {
	const host = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<"closed" | "live" | "opening">("opening");

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
			if (stopped) {
				return;
			}

			const terminal = new Terminal({
				// Matches the palette the rest of the application uses, so a shell does not arrive
				// as a black rectangle stapled to a green page.
				fontFamily: '"SF Mono", "Roboto Mono", monospace',
				fontSize: 12,
				theme: {
					background: "#10140f",
					cursor: "#d6e2cf",
					foreground: "#d6e2cf",
				},
			});
			const fit = new FitAddon();
			terminal.loadAddon(fit);
			terminal.open(element);
			fit.fit();

			// Start from an empty grid.
			//
			// A new Terminal in a new host element still came up holding the last session's
			// screen: leave a workspace, come back, and the previous `ls` output was there with a
			// fresh shell writing over it line by line -- a session that appeared to resume
			// halfway through something it had never run.
			//
			// The SSH session is gone the moment the socket closes and cannot be picked up again,
			// so the only honest thing to show is a clean one. `reset` rather than `clear`,
			// because the scrollback is part of what survived.
			terminal.reset();

			// The size travels with the connection so the remote tty is sized before the shell
			// starts. Sent afterwards it would be typed at the prompt and echoed back.
			const socket = new WebSocket(
				`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal` +
					`?workspace=${encodeURIComponent(workspaceId)}` +
					`&cols=${terminal.cols}&rows=${terminal.rows}`,
			);
			socket.binaryType = "arraybuffer";

			socket.addEventListener("open", () => setState("live"));
			socket.addEventListener("message", (event) => {
				terminal.write(
					typeof event.data === "string"
						? event.data
						: new Uint8Array(event.data as ArrayBuffer),
				);
			});
			socket.addEventListener("close", () => setState("closed"));

			// Binary, so the server can tell a keystroke from a control message without a prefix
			// somebody could type by accident.
			terminal.onData((data: string) => {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(new TextEncoder().encode(data));
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

			teardown = () => {
				clearTimeout(pending);
				observer.disconnect();
				socket.close();
				terminal.dispose();
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
