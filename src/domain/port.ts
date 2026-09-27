// What is listening inside a workspace, and whether a browser can reach it.

// Reach is how a listener can be opened, which follows entirely from what it bound to.
//
// "direct" means the operator's own machine can load it now: the workspace subnet is routable from
// there, so a listener on 0.0.0.0 or on the container's own address needs nothing built. "loopback"
// is reachable only from inside the container and needs a forward first.
export type Reach = "direct" | "loopback";

// ListeningPort is one row of the Ports tab.
export type ListeningPort = {
	// The directory the process was started in, when it can be read. Absent rather than guessed:
	// /proc/<pid>/cwd is a symlink only the owner may follow, and a process that exits between the
	// listing and the read leaves nothing behind.
	cwd?: string;
	// What bound it, as the kernel spells it -- "node", "python3". Absent for a listener owned by
	// another user, which is how the filter below finds them.
	process?: string;
	address: string;
	pid?: number;
	port: number;
	reach: Reach;
};

// OWN_INFRASTRUCTURE is what this controller put in the container itself.
//
// Short on purpose, and it does not list sshd, postfix or systemd-resolved. Those are filtered by a
// rule rather than a list -- see readListeningPorts -- which is what keeps this from becoming a
// catalogue of everything a base image happens to run.
//
// opencode's server is here because it genuinely does run as the agent user: it is the harness
// talking to itself on loopback, and an operator has no reason to open it.
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
// appears in the middle. The users field is optional: it is absent for every listener the reading
// user does not own, which is the single most useful fact in the whole line.
const LISTEN_PATTERN =
	/^LISTEN\s+\d+\s+\d+\s+(?<address>\S+):(?<port>\d+)\s+\S+(?:\s+users:\(\("(?<process>[^"]+)",pid=(?<pid>\d+))?/;

// readListeningPorts turns `ss -tlnpH` into the rows worth showing.
//
// Anything with no process attributed to it is dropped, and that one rule replaces a deny-list.
// `ss` reports the owning process only for the reading user's own processes, so a listener with no
// `users:(…)` is one the agent did not start -- sshd, postfix, systemd-resolved. Six of the eight
// rows in a fresh workspace are exactly that, and none of them is ever what somebody opened this
// tab to find.
//
// The alternative, a list of ports to hide, would need editing every time the base image gained a
// service, and would be wrong for a while first.
export function readListeningPorts(
	output: string,
	cwds: Record<number, string> = {},
): ListeningPort[] {
	const seen = new Set<string>();
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

		// The scope suffix on a link-local address is the kernel's, not an operator's: 127.0.0.53%lo
		// is still loopback and showing the %lo helps nobody.
		const address = (found.groups.address ?? "").replace(/%.*$/, "");
		const pid =
			found.groups.pid === undefined ? undefined : Number(found.groups.pid);

		// One row per port. A server bound to both stacks appears twice -- 0.0.0.0:3000 and
		// [::]:3000 -- and they are one thing to open.
		const key = String(port);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

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
// Everything that is not loopback is treated as reachable, including 0.0.0.0 and the container's
// own address. That is true because the workspace subnet routes from the operator's machine -- a
// fact about this deployment, confirmed by curl against a real container, rather than something
// generally true of containers.
export function reachOf(address: string): Reach {
	const bare = address.replace(/^\[|\]$/g, "");

	return bare === "127.0.0.1" || bare === "::1" || bare.startsWith("127.")
		? "loopback"
		: "direct";
}

// shortCwd is the working directory with the checkout's own path taken off the front.
//
// Every server worth listing runs somewhere under /workspace/repo, so that prefix is on every row
// and distinguishes none of them -- and the part that does, the last segment or two, was the part
// being clipped.
//
// The alternative was clipping from the left with `direction: rtl`, which does something worse
// than truncate: it moves the leading slash to the end, so /workspace/repo rendered as
// "workspace/repo/". Shortening the string is the fix; the CSS trick was treating the symptom.
export function shortCwd(cwd: string, root: string): string | undefined {
	if (cwd === "") {
		return undefined;
	}
	if (cwd === root) {
		// The checkout itself. Named rather than blank, because an empty cell reads as "unknown"
		// and this is the most ordinary answer there is.
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
