import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import { workspaceDetail } from "../db/workspace-repository";
import { AGENT_CWD } from "../domain/workspace-layout";
import { knownHostsPath } from "../services/ssh";
import { controllerAuth } from "./auth";
import { authorizeRequest } from "./authorize";
import { controllerDatabase, controllerRuntimeConfig } from "./controller";

// TERMINAL_PATH is where the browser opens a shell. One workspace per socket, named in the query.
const TERMINAL_PATH = "/api/terminal";

// attachTerminalSocket gives the browser a shell in a workspace.
//
// A fresh SSH session rather than the agent's own pane. Reading what an agent is doing and typing
// into the session it is working in are different things, and only the first is safe to offer
// beside a "run git log" prompt.
//
// `ssh -tt` rather than a pty library: the remote side allocates the tty, so there is no native
// module to build here and nothing new on the workspace template. The cost is that this channel
// carries no SIGWINCH, so the size is set once at connect and a browser resize does not follow.
export function attachTerminalSocket(server: Server): void {
	const sockets = new WebSocketServer({ noServer: true });

	server.on("upgrade", (request, socket, head) => {
		if (!isTerminal(request)) {
			// Somebody else's upgrade, or none of ours. Destroying it here would break any other
			// websocket the framework wants later.
			return;
		}

		void (async () => {
			const workspace = await permitted(request);
			if (workspace === undefined) {
				socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
				socket.destroy();

				return;
			}

			sockets.handleUpgrade(request, socket as Duplex, head, (connection) => {
				open(connection, workspace);
			});
		})();
	});
}

// Session is the workspace a socket was allowed to reach, at the size it asked for.
type Session = {
	address: string;
	cols: number;
	keyPath: string;
	rows: number;
	user: string;
};

// terminalSize reads a dimension the browser asked for, refusing anything absurd.
//
// It reaches a shell command, so it is bounded rather than trusted: a value from a query string
// has no business being interpolated into anything without a ceiling on it.
export function terminalSize(raw: string | null, fallback: number): number {
	// Digits only, rather than Number.parseInt, which is lenient in ways that are not dangerous but
	// are silently wrong: it reads "12.5" as 12 and "1e3" as 1, and would take the leading 80 from
	// "80; rm -rf /" and carry on as though the browser had asked a sensible question.
	if (raw === null || !/^\d+$/.test(raw)) {
		return fallback;
	}

	const value = Number(raw);

	return value > 0 && value <= 1000 ? value : fallback;
}

// permitted decides whether this upgrade may have a shell, and in which workspace.
//
// Reuses authorizeRequest, which already accepts either an API key header or a session cookie and
// is the same check every other endpoint goes through. An upgrade carries ordinary headers, so it
// can be handed over as an ordinary Request and there is no second auth path to keep true.
//
// Worth stating plainly: that function returns authorized when CONTROLLER_AUTH_SECRET is unset. A
// controller with no secret configured hands a shell to anyone who can reach it, on the same terms
// as it hands over every other page. Setting the secret is what closes it.
async function permitted(
	request: IncomingMessage,
): Promise<Session | undefined> {
	const config = controllerRuntimeConfig();
	const url = new URL(request.url ?? "/", "http://controller.invalid");

	const allowed = await authorizeRequest(
		new Request(`http://controller.invalid${request.url ?? "/"}`, {
			headers: new Headers(
				Object.entries(request.headers).flatMap(([name, value]) =>
					value === undefined
						? []
						: [
								[name, Array.isArray(value) ? value.join(",") : value] as [
									string,
									string,
								],
							],
				),
			),
		}),
		config,
		await controllerAuth(),
	);
	if (allowed.kind !== "authorized") {
		return undefined;
	}

	// The same guard the agent operations use, for the same reason: a workspace that is not ready
	// has no address, and a half-built container is not something to open a shell into.
	const id = url.searchParams.get("workspace") ?? "";
	const workspace = workspaceDetail(controllerDatabase(), id);
	const keyPath = config.WORKSPACE_SSH_KEY_PATH;
	if (
		workspace === undefined ||
		workspace.status !== "ready" ||
		workspace.ip === undefined ||
		keyPath === undefined
	) {
		return undefined;
	}

	return {
		address: workspace.ip,
		cols: terminalSize(url.searchParams.get("cols"), 80),
		keyPath,
		rows: terminalSize(url.searchParams.get("rows"), 24),
		user: config.WORKSPACE_SSH_USER,
	};
}

function isTerminal(request: IncomingMessage): boolean {
	return (request.url ?? "").split("?")[0] === TERMINAL_PATH;
}

// open runs one shell for the life of one socket.
function open(connection: import("ws").WebSocket, session: Session): void {
	// Where the shell records its own tty, so a later connection can resize it.
	//
	// `ssh -tt` gives no channel to the remote tty once the shell owns it, and anything sent down
	// the socket is typed at the prompt. So the shell writes its tty path here at startup, and a
	// resize is a second, short-lived ssh running stty against that path.
	//
	// Left behind when the session ends. Removing it would cost another connection per close, and
	// this is a disposable container whose /tmp goes with it.
	const ttyFile = `/tmp/.herdr-tty-${randomUUID()}`;

	const ssh = spawn(
		"ssh",
		[
			"-tt",
			"-i",
			session.keyPath,
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			`UserKnownHostsFile=${knownHostsPath(session.keyPath)}`,
			"-o",
			"LogLevel=ERROR",
			`${session.user}@${session.address}`,
			"--",
			// The size is set here rather than sent down the socket once the shell is running,
			// because anything sent that way is typed at the prompt and echoed: the first thing
			// an operator saw in their own terminal was `stty rows 80 cols 83`.
			//
			// Lands where the work is rather than in the home directory: a bare prompt in an
			// unfamiliar container tells you nothing about where you are.
			// TERM is set here because ssh forwards the one it finds locally, and the controller
			// runs as a systemd service with none: every paged command answered "WARNING: terminal
			// is not fully functional" and stopped for a keypress. The renderer is xterm-compatible,
			// so this is the honest value rather than a flattering one.
			`tty > ${ttyFile} 2>/dev/null; export TERM=xterm-256color; stty rows ${session.rows} cols ${session.cols} 2>/dev/null; cd ${AGENT_CWD} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`,
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);

	ssh.stdout.on("data", (chunk) => send(connection, chunk));
	// Merged rather than dropped: ssh reports a refused connection or a changed host key here, and
	// silence would leave a blank rectangle with no clue in it.
	ssh.stderr.on("data", (chunk) => send(connection, chunk));

	// Keystrokes arrive as binary and control messages as text, which is what keeps the two apart
	// without a prefix a person could type by accident.
	connection.on("message", (data, isBinary) => {
		if (isBinary) {
			ssh.stdin.write(Buffer.from(data as Buffer));

			return;
		}

		resize(session, ttyFile, String(data));
	});

	// Both directions, because either can end first: a closed tab has to kill the shell, and a
	// shell that exits has to close the tab's socket rather than leave it open forever.
	const stop = () => {
		if (!ssh.killed) {
			ssh.kill("SIGHUP");
		}
	};
	connection.on("close", stop);
	connection.on("error", stop);
	ssh.on("error", () => connection.close());
	ssh.on("close", () => connection.close());
}

// resize applies a new size to the running shell's tty.
//
// A separate connection rather than anything in band: the shell owns the tty, and the only way to
// reach it from outside is stty against its path. Failures are silent by design — a terminal that
// is the wrong size is a far smaller problem than one that interrupts what you were typing to
// complain about it.
function resize(session: Session, ttyFile: string, message: string): void {
	let asked: { cols?: unknown; rows?: unknown };
	try {
		asked = JSON.parse(message) as typeof asked;
	} catch {
		return;
	}

	const cols = terminalSize(String(asked.cols ?? ""), 0);
	const rows = terminalSize(String(asked.rows ?? ""), 0);
	if (cols === 0 || rows === 0) {
		return;
	}

	const apply = spawn(
		"ssh",
		[
			"-i",
			session.keyPath,
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			`UserKnownHostsFile=${knownHostsPath(session.keyPath)}`,
			"-o",
			"LogLevel=ERROR",
			`${session.user}@${session.address}`,
			"--",
			`stty -F "$(cat ${ttyFile})" rows ${rows} cols ${cols}`,
		],
		{ stdio: "ignore" },
	);
	apply.on("error", () => undefined);
}

function send(connection: import("ws").WebSocket, chunk: unknown): void {
	if (connection.readyState === 1) {
		connection.send(chunk as Buffer);
	}
}
