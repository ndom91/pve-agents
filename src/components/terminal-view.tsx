import { FitAddon, init, Terminal } from "ghostty-web";
import { useEffect, useRef, useState } from "react";

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

			terminal.onData((data: string) => {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(data);
				}
			});

			teardown = () => {
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
			{state === "live" ? null : (
				<p className="detail-note">
					{state === "opening" ? "Opening a shell." : "The shell has ended."}
				</p>
			)}
		</div>
	);
}
