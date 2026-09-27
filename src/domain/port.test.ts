import { describe, expect, it } from "vitest";

import { portUrl, reachOf, readListeningPorts, shortCwd } from "./port";

// Captured from `ss -tlnpH` in a real workspace, as the agent user, with two python servers started
// by hand -- one on 0.0.0.0 and one on loopback. Everything else is what a fresh container runs on
// its own, and the whole point of keeping it here is that six of these eight rows are noise.
const REAL = `LISTEN 0      4096         0.0.0.0:22   0.0.0.0:*
LISTEN 0      5            0.0.0.0:5173 0.0.0.0:* users:(("python3",pid=726,fd=3))
LISTEN 0      100        127.0.0.1:25   0.0.0.0:*
LISTEN 0      4096   127.0.0.53%lo:53   0.0.0.0:*
LISTEN 0      5          127.0.0.1:5174 0.0.0.0:* users:(("python3",pid=727,fd=3))
LISTEN 0      4096      127.0.0.54:53   0.0.0.0:*
LISTEN 0      100            [::1]:25      [::]:*
LISTEN 0      4096            [::]:22      [::]:*`;

describe("readListeningPorts", () => {
	it("keeps only what the agent started", () => {
		// The rule that replaces a deny-list. ss attributes a process only for the reading user's
		// own, so sshd, postfix and systemd-resolved arrive with no users:(…) field and drop out
		// without anybody having to name them.
		expect(readListeningPorts(REAL).map((p) => p.port)).toEqual([5173, 5174]);
	});

	it("reads the process and pid off the row", () => {
		const [first] = readListeningPorts(REAL);

		expect(first).toMatchObject({
			address: "0.0.0.0",
			pid: 726,
			port: 5173,
			process: "python3",
		});
	});

	it("separates what a browser can reach from what it cannot", () => {
		const reaches = Object.fromEntries(
			readListeningPorts(REAL).map((p) => [p.port, p.reach]),
		);

		expect(reaches).toEqual({ 5173: "direct", 5174: "loopback" });
	});

	it("attaches a working directory when one was read", () => {
		const [first] = readListeningPorts(REAL, { 726: "/workspace/repo" });

		expect(first?.cwd).toBe("/workspace/repo");
	});

	it("leaves the directory absent rather than guessing", () => {
		// /proc/<pid>/cwd is readable only by the owner, and a process can exit between the listing
		// and the read. Absent says "not known"; a default would say something false.
		expect(readListeningPorts(REAL)[0]?.cwd).toBeUndefined();
	});

	it("shows a dual-stack server once", () => {
		// A server on both stacks is two rows and one thing to open.
		const both = `LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=9,fd=3))
LISTEN 0 511 [::]:3000 [::]:* users:(("node",pid=9,fd=4))`;

		expect(readListeningPorts(both)).toHaveLength(1);
	});

	it("hides the harness's own server", () => {
		// opencode's loopback API runs as the agent, so the ownership rule does not catch it. It is
		// the harness talking to itself and there is nothing for an operator to open.
		const ours = `LISTEN 0 511 127.0.0.1:39917 0.0.0.0:* users:(("opencode2",pid=5,fd=3))`;

		expect(readListeningPorts(ours)).toEqual([]);
	});

	it("drops the scope suffix the kernel puts on a link-local address", () => {
		const scoped = `LISTEN 0 4096 127.0.0.53%lo:5300 0.0.0.0:* users:(("thing",pid=3,fd=3))`;

		expect(readListeningPorts(scoped)[0]).toMatchObject({
			address: "127.0.0.53",
			reach: "loopback",
		});
	});

	it("sorts by port, so the list does not reorder as processes restart", () => {
		const jumbled = `LISTEN 0 5 0.0.0.0:8080 0.0.0.0:* users:(("a",pid=1,fd=3))
LISTEN 0 5 0.0.0.0:3000 0.0.0.0:* users:(("b",pid=2,fd=3))`;

		expect(readListeningPorts(jumbled).map((p) => p.port)).toEqual([
			3000, 8080,
		]);
	});

	it("survives output it has never seen", () => {
		expect(readListeningPorts("")).toEqual([]);
		expect(readListeningPorts("something else entirely")).toEqual([]);
	});
});

describe("reachOf", () => {
	it("calls every loopback form loopback", () => {
		for (const address of ["127.0.0.1", "127.0.0.53", "::1", "[::1]"]) {
			expect(reachOf(address)).toBe("loopback");
		}
	});

	it("calls a wildcard or a real address direct", () => {
		// True because this deployment's workspace subnet routes from the operator's machine,
		// checked with curl against a live container rather than assumed.
		for (const address of ["0.0.0.0", "[::]", "10.0.3.100"]) {
			expect(reachOf(address)).toBe("direct");
		}
	});
});

describe("shortCwd", () => {
	const ROOT = "/workspace/repo";

	it("names the checkout itself rather than leaving the cell blank", () => {
		// An empty cell reads as "we could not tell", and this is the most ordinary answer there
		// is: the dev server was started where the repository is.
		expect(shortCwd("/workspace/repo", ROOT)).toBe("repo root");
	});

	it("drops the prefix every row shares", () => {
		expect(shortCwd("/workspace/repo/apps/web", ROOT)).toBe("apps/web");
	});

	it("leaves a path outside the checkout whole", () => {
		expect(shortCwd("/tmp/scratch", ROOT)).toBe("/tmp/scratch");
	});

	it("does not mistake a sibling directory for a child", () => {
		// /workspace/repo-two starts with the root as a string and is not inside it.
		expect(shortCwd("/workspace/repo-two", ROOT)).toBe("/workspace/repo-two");
	});
});

describe("portUrl", () => {
	it("uses the container's address, not the one it bound", () => {
		// A process on 0.0.0.0 answers on every interface, and 0.0.0.0 is not somewhere a browser
		// can go.
		expect(portUrl("10.0.3.100", 5173)).toBe("http://10.0.3.100:5173");
	});
});
