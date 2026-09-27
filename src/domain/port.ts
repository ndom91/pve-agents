// What is listening inside a workspace, and whether a browser can reach it.

// Reach is how a listener can be opened, which follows from what it bound to. "direct" loads from
// the operator's machine now, because the workspace subnet routes there. "loopback" needs a forward.
export type Reach = "direct" | "loopback";

// ListeningPort is one row of the Ports tab.
export type ListeningPort = {
	// Absent when /proc/<pid>/cwd could not be read, rather than guessed.
	cwd?: string;
	// "node", "python3". Absent for a listener another user owns.
	process?: string;
	address: string;
	pid?: number;
	port: number;
	reach: Reach;
};

// OWN_INFRASTRUCTURE is what the controller itself runs as the agent user: opencode's server.
// System services need no entry here; readListeningPorts drops them by rule.
const OWN_INFRASTRUCTURE = new Set([39917]);

// LISTEN_PATTERN pulls the fields out of one `ss -tlnpH` row.
//
// Every shape in this regex came from real output rather than from the manual:
//
//   LISTEN 0 4096      0.0.0.0:22    0.0.0.0:*
//   LISTEN 0 5         0.0.0.0:5173  0.0.0.0:* users:(("python3",pid=726,fd=3))
//   LISTEN 0 4096 127.0.0.53%lo:53   0.0.0.0:*
//   LISTEN 0 100           [::1]:25     [::]:*
//
// The address is anything up to the last colon, because IPv6 is full of them and `%lo` scoping
// appears in the middle. The users field is optional.
const LISTEN_PATTERN =
	/^LISTEN\s+\d+\s+\d+\s+(?<address>\S+):(?<port>\d+)\s+\S+(?:\s+users:\(\("(?<process>[^"]+)",pid=(?<pid>\d+))?/;

// readListeningPorts turns `ss -tlnpH` into the rows worth showing.
//
// Anything with no process attributed to it is dropped, and that one rule replaces a deny-list.
// `ss` names the process only for the reading user's own, so a row with no `users:(…)` is one the
// agent did not start: sshd, postfix, systemd-resolved. A list of ports to hide would go stale
// every time the base image gained a service.
export function readListeningPorts(
	output: string,
	cwds: Record<number, string> = {},
): ListeningPort[] {
	const seen = new Set<number>();
	const ports: ListeningPort[] = [];

	for (const line of output.split("\n")) {
		const found = LISTEN_PATTERN.exec(line.trim());
		if (found?.groups === undefined || found.groups.process === undefined) {
			continue;
		}

		const port = Number(found.groups.port);
		if (OWN_INFRASTRUCTURE.has(port)) {
			continue;
		}

		// 127.0.0.53%lo is still loopback; the scope suffix helps nobody.
		const address = (found.groups.address ?? "").replace(/%.*$/, "");
		const pid =
			found.groups.pid === undefined ? undefined : Number(found.groups.pid);

		// One row per port: a server on both stacks appears as 0.0.0.0:3000 and [::]:3000.
		if (seen.has(port)) {
			continue;
		}
		seen.add(port);

		ports.push({
			address,
			cwd: pid === undefined ? undefined : cwds[pid],
			pid,
			port,
			process: found.groups.process,
			reach: reachOf(address),
		});
	}

	return ports.sort((a, b) => a.port - b.port);
}

// reachOf decides whether a bind address can be opened from outside the container.
//
// Everything that is not loopback counts as reachable. That is a fact about this deployment, where
// the workspace subnet routes from the operator's machine, not about containers in general.
export function reachOf(address: string): Reach {
	const bare = address.replace(/^\[|\]$/g, "");

	return bare === "::1" || bare.startsWith("127.") ? "loopback" : "direct";
}

// shortCwd is the working directory with the checkout's own path taken off the front.
//
// That prefix is on every row and tells none apart. Clipping it from the left with CSS
// `direction: rtl` was tried and moves the leading slash to the end.
export function shortCwd(cwd: string, root: string): string | undefined {
	if (cwd === "") {
		return undefined;
	}
	if (cwd === root) {
		// Named, because a blank cell reads as "unknown".
		return "repo root";
	}

	return cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : cwd;
}

// portUrl is where a directly reachable listener can be opened.
//
// The container's address rather than its bind address: a process on 0.0.0.0 answers on every
// interface, and "0.0.0.0:5173" is not somewhere a browser can go.
export function portUrl(ip: string, port: number): string {
	return `http://${ip}:${port}`;
}
