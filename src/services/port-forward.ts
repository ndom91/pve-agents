import { spawn } from "node:child_process";

import { knownHostsPath, type SshTarget } from "./ssh";

// Publishing a container's loopback port on the controller.
//
// Only loopback listeners need this. A server on 0.0.0.0 is already reachable from the operator's
// machine, because the workspace subnet routes there -- see the Ports tab.

// FIRST and LAST bound the range the controller allocates from.
//
// High and well clear of anything a person would choose, so a forward cannot collide with the
// controller's own port or with something an operator started by hand on the same host.
const FIRST = 20_000;
const LAST = 29_999;

// Forward is one published port.
export type Forward = {
	// The port on the controller, which is not the port in the container. Two workspaces both
	// running Vite on 5173 cannot both be 5173 here, so the controller side is allocated and the
	// row shows both numbers.
	allocated: number;
	port: number;
	workspaceId: string;
};

type Entry = Forward & { stop: () => void };

// The live forwards, by workspace and container port.
//
// In memory rather than a table, deliberately. A forward is a child process of this controller: it
// dies when the controller restarts, so a record that outlived the restart would describe tunnels
// that no longer exist and hand out links that cannot connect.
const FORWARDS = new Map<string, Entry>();

function key(workspaceId: string, port: number): string {
	return `${workspaceId}:${port}`;
}

// forwardsFor lists what is currently published for one workspace.
export function forwardsFor(workspaceId: string): Forward[] {
	return [...FORWARDS.values()]
		.filter((entry) => entry.workspaceId === workspaceId)
		.map(({ allocated, port, workspaceId: id }) => ({
			allocated,
			port,
			workspaceId: id,
		}));
}

// allocate finds a free controller port.
//
// Linear from the bottom of the range rather than random, so the numbers a person sees stay small
// and stable across a session. Ten thousand of them and one workspace uses a handful, so the scan
// is never long.
function allocate(): number | undefined {
	const taken = new Set([...FORWARDS.values()].map((entry) => entry.allocated));
	for (let port = FIRST; port <= LAST; port += 1) {
		if (!taken.has(port)) {
			return port;
		}
	}

	return undefined;
}

// startForward publishes one container port on the controller.
//
// Idempotent: asking twice for the same port returns the forward already running rather than
// starting a second one against the same pair, which would fail to bind and leave the first
// looking broken.
//
// `-N` because there is no command to run, only the tunnel. Binding `0.0.0.0` on this side is what
// makes it reachable from the operator's machine at all -- and is the reason this is an explicit
// act with a Stop button rather than something the tab does on open. It publishes a dev server to
// the whole network with nothing in front of it.
export function startForward(
	workspaceId: string,
	target: SshTarget,
	port: number,
): Forward | { message: string } {
	const existing = FORWARDS.get(key(workspaceId, port));
	if (existing !== undefined) {
		const { allocated, port: container, workspaceId: id } = existing;

		return { allocated, port: container, workspaceId: id };
	}

	const allocated = allocate();
	if (allocated === undefined) {
		return { message: "no free port to forward to" };
	}

	const ssh = spawn(
		"ssh",
		[
			"-i",
			target.keyPath,
			"-N",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"ExitOnForwardFailure=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			`UserKnownHostsFile=${knownHostsPath(target.keyPath)}`,
			"-o",
			"LogLevel=ERROR",
			"-L",
			`0.0.0.0:${allocated}:127.0.0.1:${port}`,
			`${target.user}@${target.address}`,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);

	// Forgotten when it dies, whatever killed it: the container going away, the network, or Stop.
	// A registry holding a dead child would keep offering a link to nothing and would never free
	// its allocated port.
	const forget = () => {
		FORWARDS.delete(key(workspaceId, port));
	};
	ssh.on("exit", forget);
	ssh.on("error", forget);
	ssh.stderr?.on("data", (chunk: Buffer) => {
		process.stderr.write(`forward ${workspaceId}:${port}: ${String(chunk)}`);
	});

	FORWARDS.set(key(workspaceId, port), {
		allocated,
		port,
		stop: () => {
			if (!ssh.killed) {
				ssh.kill("SIGTERM");
			}
		},
		workspaceId,
	});

	return { allocated, port, workspaceId };
}

// stopForward takes one down.
export function stopForward(workspaceId: string, port: number): void {
	const entry = FORWARDS.get(key(workspaceId, port));
	entry?.stop();
	FORWARDS.delete(key(workspaceId, port));
}

// stopWorkspaceForwards takes down everything published for one workspace.
//
// Called when a workspace is destroyed. Without it the tunnels survive their container and the
// controller holds ssh processes retrying against an address that no longer answers.
export function stopWorkspaceForwards(workspaceId: string): void {
	for (const entry of FORWARDS.values()) {
		if (entry.workspaceId === workspaceId) {
			stopForward(workspaceId, entry.port);
		}
	}
}
